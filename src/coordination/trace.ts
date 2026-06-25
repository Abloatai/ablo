/**
 * Claim log — the easy way to SEE agents colliding.
 *
 * The engine emits the claim lifecycle (`acquired → queued → granted → lost /
 * rejected / expired`) and the notify-instead-of-abort stale-write collision
 * through two seams: human `logger` lines (visible with `new Ablo({ debug: true })`)
 * and structured `observability.captureClaim` / `captureConflict` calls.
 *
 * This is the third, evals-shaped path: hand a {@link ClaimLog} to
 * `Ablo({ observability })`, run your scenario, then read back an ordered list
 * you can print for eyeballing or `collisions()` for assertions.
 */

import type {
  SyncObservabilityProvider,
  ClaimEvent,
  ConflictEvent,
} from '../interfaces/index.js';

// ─────────────────────────────────────────────
// Formatters — one readable line per event. Shared by the WS logger seam and
// the log so console output and log output never drift.
// ─────────────────────────────────────────────

/** A claim state change as one quiet, greppable line. */
export function formatClaim(e: ClaimEvent): string {
  const target = e.model && e.id ? `${e.model}/${e.id}` : e.claimId ?? 'unknown target';
  const scope = e.field ? `#${e.field}` : '';
  const pos = e.position !== undefined ? ` [pos ${e.position}]` : '';
  const actor = e.actor
    ? `${e.actor}${e.participantKind ? ` (${e.participantKind})` : ''}`
    : '';
  // `rejected`/`lost` name the BLOCKING holder; the rest name us (or no one).
  const by = actor
    ? e.phase === 'rejected' || e.phase === 'lost'
      ? ` — held by ${actor}`
      : ` — by ${actor}`
    : '';
  const why = e.reason ? `: ${e.reason}` : '';
  return `claim ${e.phase}: ${target}${scope}${pos}${by}${why}`;
}

/** A notify-instead-of-abort stale write as one readable line. */
export function formatConflict(e: ConflictEvent): string {
  const rows = e.rows.map((r) => `${r.model}/${r.id}(${r.fields.join(',')})`).join(', ');
  return `conflict: tx ${e.clientTxId} — ${e.rows.length} row(s) changed underneath${rows ? `: ${rows}` : ''}`;
}

// ─────────────────────────────────────────────
// Log — collect → inspect / assert
// ─────────────────────────────────────────────

/** One ordered entry in a {@link ClaimLog}. */
export interface ClaimLogEntry {
  /** Monotonic order index — deterministic, clock-free, eval-friendly. */
  readonly seq: number;
  /** The same one-line text the console and breadcrumb seams emit. */
  readonly line: string;
  /** A collision worth flagging: a rejected/lost claim or a stale write. */
  readonly collision: boolean;
  readonly claim?: ClaimEvent;
  readonly conflict?: ConflictEvent;
}

/**
 * Collects the claim lifecycle + stale-write collisions into an ordered list.
 *
 * @example
 * ```ts
 * const log = new ClaimLog();
 * const ablo = new Ablo({ schema, apiKey, observability: log });
 * // …run the agents…
 * console.log(`${log}`);                 // pretty timeline for eyeballing
 * expect(log.collisions()).toHaveLength(0); // assert no one stepped on anyone
 * ```
 *
 * Implements the full {@link SyncObservabilityProvider} (every method it does not
 * care about is an inert no-op), so it drops straight into the `observability`
 * slot with no adapter.
 */
export class ClaimLog implements SyncObservabilityProvider {
  // Immutable list: a NEW array reference on every change. This is what lets
  // `useSyncExternalStore(log.onChange, () => log.entries)` detect updates —
  // it compares snapshots by reference, so an in-place push would never render.
  private rows: readonly ClaimLogEntry[] = [];
  private seq = 0;
  private readonly listeners = new Set<() => void>();

  /** Cap the buffer so a long-running session can't grow unbounded. */
  constructor(private readonly max = 1_000) {}

  // —— the two seams we record ——

  captureClaim(claim: ClaimEvent): void {
    this.add({
      line: formatClaim(claim),
      collision: claim.phase === 'rejected' || claim.phase === 'lost',
      claim,
    });
  }

  captureConflict(conflict: ConflictEvent): void {
    this.add({ line: formatConflict(conflict), collision: true, conflict });
  }

  // —— reactivity ——

  /**
   * Fire `listener` every time an event lands. Returns an unsubscribe fn. Same
   * contract as `ablo.claims.onChange` — drop it into `useSyncExternalStore` in
   * React or `autorun` in MobX to render a live activity feed.
   *
   * @example
   * ```tsx
   * const log = useMemo(() => new ClaimLog(), []);
   * const entries = useSyncExternalStore(log.onChange, () => log.entries);
   * return <ul>{entries.map((e) => <li key={e.seq}>{e.line}</li>)}</ul>;
   * ```
   */
  readonly onChange = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  // —— inspection ——

  /** The full ordered list. Stable reference until the next event lands. */
  get entries(): readonly ClaimLogEntry[] {
    return this.rows;
  }

  /** Only the collisions: rejected/lost claims + stale writes. */
  collisions(): readonly ClaimLogEntry[] {
    return this.rows.filter((e) => e.collision);
  }

  /** Drop everything — useful between scenarios in one process. */
  clear(): void {
    this.rows = [];
    this.seq = 0;
    this.notify();
  }

  /** Printable: one event per line, collisions marked. */
  toString(): string {
    if (this.rows.length === 0) return 'claim log: (empty)';
    const w = String(this.rows.length).length;
    return this.rows
      .map((e) => `${String(e.seq).padStart(w)}  ${e.collision ? '⚠ ' : '  '}${e.line}`)
      .join('\n');
  }

  private add(entry: Omit<ClaimLogEntry, 'seq'>): void {
    const next = [...this.rows, { seq: this.seq++, ...entry }];
    this.rows = next.length > this.max ? next.slice(next.length - this.max) : next;
    this.notify();
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }

  // —— inert provider surface (this log only cares about claims) ——

  setContext(): void {}
  setConnectionState(): void {}
  breadcrumb(): void {}
  captureRollback(): void {}
  captureTransactionFailure(): void {}
  captureBootstrapFailure(): void {}
  captureReconciliation(): void {}
  captureDeltaRetryExhausted(): void {}
  captureWebSocketError(): void {}
  captureOfflineFlushFailure(): void {}
  captureSelfHealing(): void {}
  captureCommitZeroSyncId(): void {}
  startSpan<T>(_name: string, _op: string, fn: () => T): T {
    return fn();
  }
  startSpanAsync<T>(_name: string, _op: string, fn: () => Promise<T>): Promise<T> {
    return fn();
  }
}
