/**
 * AreaOfInterestManager — client-side hysteresis + prominence policy over
 * the `update_subscription` read primitive.
 *
 * Game netcode never thrashes its area-of-interest on a boundary: a cell
 * you walk out of stays subscribed for a margin before it's dropped
 * (hysteresis), and "important" entities stay relevant from farther away
 * (prominence). This manager applies both to Ablo sync groups:
 *
 *   - `enter(group)` / `leave(group)` move read interest as the user opens
 *     and closes entities (decks, sheets, docs). A `leave` does NOT
 *     immediately unsubscribe — the group goes WARM with a TTL and stays
 *     in the effective set. Re-entering within the window is a no-op
 *     (already subscribed → no bootstrap), and only when the warm TTL
 *     lapses does the group actually drop. This is the boundary hysteresis
 *     that turns deck-tab flipping from a re-bootstrap storm into a
 *     cache hit.
 *
 *   - `pin(group)` / `unpin(group)` express prominence: a group that holds
 *     an active claim (write-claim) is pinned and never goes warm or
 *     expires while pinned. The claim machinery is the prominence oracle —
 *     the row two agents are fighting over stays subscribed regardless of
 *     navigation.
 *
 *   - `baseGroups` are permanent infrastructure scopes (e.g. `org:<id>`,
 *     `user:<id>`) that are always in the effective set.
 *
 * The effective set is recomputed and diffed against what was last sent;
 * the transport's `update_subscription` is only called when it actually
 * changes, so hysteresis genuinely suppresses network churn rather than
 * just deferring it.
 *
 * Transport-agnostic: it depends only on {@link SubscriptionTransport},
 * which `SyncWebSocket` satisfies structurally. `now` and the sweep timer
 * are injectable so the policy is deterministic under test.
 */

/** The single capability this manager needs from the connection. */
export interface SubscriptionTransport {
  /**
   * Replace the connection's read interest with the COMPLETE group set.
   * Resolves with the server's effective set (which the manager treats as
   * authoritative for its next diff).
   */
  updateSubscription(
    syncGroups: ReadonlyArray<string>,
  ): Promise<{ syncGroups: string[] }>;
}

export interface AreaOfInterestOptions {
  /** Connection to drive. `SyncWebSocket` satisfies this structurally. */
  transport: SubscriptionTransport;
  /**
   * Groups always present in the effective set (e.g. `org:<id>`,
   * `user:<id>`). Never warm, never expired.
   */
  baseGroups?: ReadonlyArray<string>;
  /**
   * How long a `leave`-ed group stays subscribed before it actually drops.
   * This is the hysteresis margin. Default 30s.
   */
  warmTtlMs?: number;
  /**
   * Maximum number of warm (left-but-still-subscribed) groups. Under heavy
   * navigation — opening and closing many entities quickly — warm groups
   * would otherwise pile up until each TTL lapses, inflating the connection's
   * subscription set. When the cap is exceeded, the LEAST-recently-warmed
   * group is evicted immediately (dropped) instead of waiting for its TTL.
   * This is the bounded relevant-set discipline from game netcode. Default 16.
   */
  maxWarm?: number;
  /**
   * Auto-run the warm-expiry sweep on this cadence. Set `0` to disable and
   * drive {@link AreaOfInterestManager.sweep} yourself (tests do this).
   * Default = `warmTtlMs` (checks about once per margin).
   */
  sweepIntervalMs?: number;
  /** Clock injection point for deterministic tests. Default `Date.now`. */
  now?: () => number;
  /**
   * Schedule a periodic callback. Default wraps `setInterval`/
   * `clearInterval`. Injected so tests avoid real timers.
   */
  scheduler?: (fn: () => void, intervalMs: number) => () => void;
}

function setsEqual(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

export class AreaOfInterestManager {
  private readonly transport: SubscriptionTransport;
  private readonly baseGroups: ReadonlySet<string>;
  private readonly warmTtlMs: number;
  private readonly maxWarm: number;
  private readonly now: () => number;

  /** Groups currently in view (open entities). */
  private readonly active = new Set<string>();
  /** Claim-pinned groups — prominence; never warm/expire while pinned. */
  private readonly pinned = new Set<string>();
  /** Left-but-warm groups → epoch-ms at which they drop. */
  private readonly warm = new Map<string, number>();

  /** Last set the transport confirmed — the diff baseline. */
  private lastSent = new Set<string>();

  /** Coalescing state so concurrent mutations collapse into one in-flight call. */
  private inFlight: Promise<void> | null = null;
  private dirty = false;

  private readonly cancelSweep: (() => void) | null;

  constructor(options: AreaOfInterestOptions) {
    this.transport = options.transport;
    this.baseGroups = new Set(options.baseGroups ?? []);
    this.warmTtlMs = options.warmTtlMs ?? 30_000;
    this.maxWarm = options.maxWarm ?? 16;
    this.now = options.now ?? (() => Date.now());

    const sweepInterval = options.sweepIntervalMs ?? this.warmTtlMs;
    if (sweepInterval > 0) {
      const schedule =
        options.scheduler ??
        ((fn, ms) => {
          const handle = setInterval(fn, ms);
          return () => clearInterval(handle);
        });
      this.cancelSweep = schedule(() => {
        void this.sweep();
      }, sweepInterval);
    } else {
      this.cancelSweep = null;
    }
  }

  /**
   * Move a group into the warm set with a fresh TTL, maintaining LRU order
   * and the `maxWarm` cap. JS `Map` preserves insertion order, so deleting
   * then re-setting moves the group to the most-recently-warmed position;
   * eviction then drops from the front (oldest). Base/pinned groups never
   * warm — callers guard before calling this.
   */
  private warmGroup(group: string): void {
    this.warm.delete(group);
    this.warm.set(group, this.now() + this.warmTtlMs);
    while (this.warm.size > this.maxWarm) {
      const oldest = this.warm.keys().next().value;
      if (oldest === undefined) break;
      this.warm.delete(oldest);
    }
  }

  /** The effective read set: base ∪ active ∪ pinned ∪ (warm not yet expired). */
  private desiredGroups(): Set<string> {
    const now = this.now();
    const desired = new Set<string>(this.baseGroups);
    for (const g of this.active) desired.add(g);
    for (const g of this.pinned) desired.add(g);
    for (const [g, expiry] of this.warm) {
      if (expiry > now) desired.add(g);
    }
    return desired;
  }

  /** Bring a group into view. Cancels any warm timer for it. Idempotent. */
  enter(group: string): Promise<void> {
    this.warm.delete(group);
    this.active.add(group);
    return this.reconcile();
  }

  /**
   * Leave a group. It does not drop immediately — it goes warm for
   * `warmTtlMs` (unless pinned, in which case it stays via the pin).
   * Re-entering within the window is free.
   */
  leave(group: string): Promise<void> {
    this.active.delete(group);
    if (!this.pinned.has(group) && !this.baseGroups.has(group)) {
      this.warmGroup(group);
    }
    return this.reconcile();
  }

  /** Pin a group (active claim / prominence). Never warm or expires while pinned. */
  pin(group: string): Promise<void> {
    this.warm.delete(group);
    this.pinned.add(group);
    return this.reconcile();
  }

  /**
   * Unpin a group. If it's not currently in view, it transitions to warm
   * (so dropping a claim gets the same hysteresis as closing a tab) rather
   * than dropping instantly.
   */
  unpin(group: string): Promise<void> {
    this.pinned.delete(group);
    if (!this.active.has(group) && !this.baseGroups.has(group)) {
      this.warmGroup(group);
    }
    return this.reconcile();
  }

  /**
   * Drop warm groups whose TTL has lapsed and reconcile. Auto-invoked on
   * the sweep timer; call manually (with an injected `now`) in tests.
   */
  sweep(): Promise<void> {
    const now = this.now();
    for (const [g, expiry] of this.warm) {
      if (expiry <= now) this.warm.delete(g);
    }
    return this.reconcile();
  }

  /** The set the manager believes is subscribed (post-confirmation). */
  effectiveGroups(): string[] {
    return [...this.lastSent];
  }

  /**
   * Re-assert the full desired set against the transport, forgetting what
   * was previously confirmed. Call after a reconnect: a fresh
   * `SyncWebSocket` instance starts from the connect-time URL groups, so
   * the manager's `lastSent` diff baseline is stale. Clearing it forces
   * one `update_subscription` that re-establishes the live interest on the
   * new socket.
   *
   * Resetting `lastSent` makes the next reconcile unconditionally re-push
   * the current desired set (one `update_subscription` frame) so the fresh
   * socket's server-side index matches local interest, even if warm/pinned
   * groups drifted across the disconnect window. The connect-time URL
   * already carries the last-acked set, so this is a correction frame, not
   * the primary mechanism.
   */
  resync(): Promise<void> {
    this.lastSent = new Set();
    return this.reconcile();
  }

  /** Stop the sweep timer. The connection is unaffected. */
  dispose(): void {
    this.cancelSweep?.();
  }

  /**
   * Push the desired set to the transport iff it differs from the last
   * confirmed set. Coalesces concurrent mutations: if a call is already in
   * flight, mark dirty and let the in-flight loop pick up the newest state
   * — so a burst of enter/leave collapses into the minimum number of
   * `update_subscription` round-trips.
   */
  private reconcile(): Promise<void> {
    if (this.inFlight) {
      this.dirty = true;
      return this.inFlight;
    }
    if (setsEqual(this.desiredGroups(), this.lastSent)) {
      return Promise.resolve();
    }
    this.inFlight = (async () => {
      try {
        do {
          this.dirty = false;
          const target = this.desiredGroups();
          if (setsEqual(target, this.lastSent)) break;
          try {
            const result = await this.transport.updateSubscription([...target]);
            this.lastSent = new Set(result.syncGroups);
          } catch {
            // Transport unavailable (offline / socket not open) or the
            // server rejected the set. Interest is SOFT state — never throw
            // out of enter/leave/sweep for an expected transient. Leave
            // `lastSent` unchanged so the diff persists; `resync()` on the
            // next `connected` re-pushes the then-current desired set,
            // which is what recovers "interest changed while offline."
            break;
          }
        } while (this.dirty);
      } finally {
        this.inFlight = null;
      }
    })();
    return this.inFlight;
  }
}
