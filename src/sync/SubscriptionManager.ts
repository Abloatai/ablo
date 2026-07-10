/**
 * Decides which sync groups a connection subscribes to as the user navigates,
 * and pushes each change through the {@link SubscriptionTransport}'s
 * `update_subscription` call. It smooths two kinds of churn so that opening and
 * closing entities does not turn into a storm of subscription changes.
 *
 * The first is hysteresis. Calling {@link SubscriptionManager.leave | leave}
 * on a group does not unsubscribe it right away; the group stays subscribed for
 * a grace period — its warm window — and drops only once that window lapses.
 * Re-entering within the window costs nothing, since the group was never
 * dropped, so rapid back-and-forth navigation becomes a cache hit rather than a
 * repeated bootstrap.
 *
 * The second is prominence. A group that holds an active write claim is pinned
 * (see {@link SubscriptionManager.pin | pin}) and stays subscribed regardless
 * of navigation, so a row someone is actively editing never loses its live
 * updates. The `baseGroups` are permanent scopes that are always subscribed.
 *
 * The manager recomputes the full desired set on every change, diffs it against
 * the set the transport last confirmed, and calls `update_subscription` only
 * when the set actually changes — so the smoothing suppresses network traffic
 * rather than merely deferring it. It depends only on
 * {@link SubscriptionTransport}, which {@link SyncWebSocket} satisfies. The
 * clock and the sweep timer are injectable so the policy is deterministic under
 * test.
 */

/** The single capability this manager needs from the connection. */
export interface SubscriptionTransport {
  /**
   * Replaces the connection's read interest with the complete group set. This
   * is a full replace, not an incremental add or remove. Resolves with the
   * effective set the server applied, which the manager treats as authoritative
   * for its next diff.
   */
  updateSubscription(
    syncGroups: readonly string[],
  ): Promise<{ syncGroups: string[] }>;
}

export interface SubscriptionManagerOptions {
  /** Connection to drive. `SyncWebSocket` satisfies this structurally. */
  transport: SubscriptionTransport;
  /**
   * Groups always present in the effective set (e.g. `org:<id>`,
   * `user:<id>`). Never warm, never expired.
   */
  baseGroups?: readonly string[];
  /**
   * How long a `leave`-ed group stays subscribed before it actually drops.
   * This is the hysteresis margin. Default 30s.
   */
  warmTtlMs?: number;
  /**
   * The maximum number of warm (left but still subscribed) groups. Under heavy
   * navigation, warm groups would otherwise pile up until each one's window
   * lapses, inflating the connection's subscription set. When the cap is
   * exceeded, the least-recently-warmed group is dropped immediately instead of
   * waiting for its window. Default 16.
   */
  maxWarm?: number;
  /**
   * Auto-run the warm-expiry sweep on this cadence. Set `0` to disable and
   * drive {@link SubscriptionManager.sweep} yourself (tests do this).
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

export class SubscriptionManager {
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

  constructor(options: SubscriptionManagerOptions) {
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
          return () => { clearInterval(handle); };
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
   * Re-asserts the full desired set against the transport, forgetting what was
   * previously confirmed. Call this after a reconnect: a fresh
   * {@link SyncWebSocket} starts from the sync groups named in the connect-time
   * URL, so the manager's diff baseline no longer reflects the new socket.
   * Clearing that baseline makes the next reconcile push one
   * `update_subscription` frame that re-establishes the current interest —
   * including any warm or pinned groups that drifted while the connection was
   * down. The connect-time URL already carries the last-acknowledged set, so
   * this is a correction, not the primary mechanism.
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
            // Transport unavailable (offline, or socket not open) or the
            // server rejected the set. Read interest is soft state, so enter,
            // leave, and sweep never throw for an expected transient failure.
            // Leaving `lastSent` unchanged keeps the pending diff; `resync()`
            // on the next successful connect re-pushes the then-current desired
            // set, which recovers any interest that changed while offline.
            break;
          }
          // A concurrent reconcile() arriving during the await above sets
          // `this.dirty` back to true (the coalescing path near line 245).
          // TypeScript's intra-closure flow analysis can't see that cross-
          // invocation mutation and reads this as always-false, but the loop
          // is genuinely reentrant.
          // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
        } while (this.dirty);
      } finally {
        this.inFlight = null;
      }
    })();
    return this.inFlight;
  }
}
