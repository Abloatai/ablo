/**
 * OptimisticEchoTracker — receive-layer reconciliation primitive.
 *
 * Tracks the set of transaction ids the client has applied locally
 * but the server has not yet confirmed. When a sync delta arrives
 * carrying a `transactionId` the tracker recognizes, the pool
 * mutation is suppressed (the optimistic write already reflects it).
 * Drained when the matching delta echo lands or when the originating
 * transaction is rolled back.
 *
 * Architectural framing: see
 * `apps/sync-server/docs/OPTIMISTIC_RECONCILIATION.md`. This is the
 * "discriminator at the apply layer" the doc names — without it the
 * authoritative-layer apply path blindly re-applies confirmations on
 * top of whatever optimistic state has since diverged, producing the
 * chart-delete flicker.
 *
 * Bounded by `maxSize` to defend against runaway growth from a
 * pathological "transactions never confirmed and never rolled back"
 * loop. When the bound is hit, the OLDEST id is evicted (FIFO via
 * insertion-ordered Map). Eviction means a future echo of that
 * transaction will be applied as a foreign mutation — no correctness
 * risk for the originating tab (the pool already reflects the local
 * write); the worst case is a single redundant pool re-set.
 */

export interface OptimisticEchoTrackerOptions {
  /**
   * Hard upper bound on tracked ids. FIFO eviction beyond this. The
   * default of 10_000 covers a 200-tab user mid-bulk-edit (each tab
   * tracking dozens of unconfirmed transactions) with two orders of
   * magnitude of headroom.
   */
  maxSize?: number;
}

export interface OptimisticEchoMetrics {
  /** Total ids currently tracked. */
  size: number;
  /** Cumulative ids ever added since construction. */
  totalAdded: number;
  /** Cumulative successful echo matches (delta arrived → drained). */
  hits: number;
  /** Cumulative explicit rollback drains (transaction never made it). */
  rollbacks: number;
  /** Cumulative ids evicted due to maxSize pressure. */
  evictions: number;
}

const DEFAULT_MAX_SIZE = 10_000;

export class OptimisticEchoTracker {
  // Map (not Set) for O(1) FIFO eviction via insertion order.
  // Value is unused; Map.keys() iterates in insertion order so
  // `keys().next()` yields the oldest id.
  private readonly ids = new Map<string, true>();
  private readonly maxSize: number;

  // Metrics — internal counters; exposed via `getMetrics()`. Kept
  // numeric (not BigInt) since cumulative-since-page-load fits well
  // under Number.MAX_SAFE_INTEGER for any realistic session.
  private _totalAdded = 0;
  private _hits = 0;
  private _rollbacks = 0;
  private _evictions = 0;

  constructor(options: OptimisticEchoTrackerOptions = {}) {
    this.maxSize = options.maxSize ?? DEFAULT_MAX_SIZE;
  }

  /**
   * Mark a transaction as locally-applied. The next sync delta with a
   * matching `transactionId` will be recognized as the server's
   * confirmation of this same write. Idempotent — repeated calls with
   * the same id are no-ops.
   */
  markPending(transactionId: string): void {
    if (this.ids.has(transactionId)) return;
    if (this.ids.size >= this.maxSize) {
      const oldest = this.ids.keys().next().value;
      if (oldest !== undefined) {
        this.ids.delete(oldest);
        this._evictions += 1;
      }
    }
    this.ids.set(transactionId, true);
    this._totalAdded += 1;
  }

  /**
   * If the id is currently tracked, drain it and return true (signal
   * to the caller: this is an echo, skip the pool mutation).
   * Otherwise return false (foreign mutation, apply normally).
   *
   * Combined check+drain into one method to make the receive-path
   * idiom hard to misuse: a separate `has` then `drain` would race
   * if multiple deltas with the same id arrived in the same batch.
   */
  consumeEcho(transactionId: string | null | undefined): boolean {
    if (!transactionId) return false;
    if (!this.ids.has(transactionId)) return false;
    this.ids.delete(transactionId);
    this._hits += 1;
    return true;
  }

  /**
   * Drain on rollback. The transaction was cancelled before a server
   * confirmation arrived — no echo will ever come, so the pending
   * entry would otherwise leak. Counts as a separate metric category
   * so a spike of `rollbacks` (vs `hits`) signals network or
   * server-side health issues.
   */
  drainOnRollback(transactionId: string): void {
    if (this.ids.delete(transactionId)) {
      this._rollbacks += 1;
    }
  }

  getMetrics(): Readonly<OptimisticEchoMetrics> {
    return {
      size: this.ids.size,
      totalAdded: this._totalAdded,
      hits: this._hits,
      rollbacks: this._rollbacks,
      evictions: this._evictions,
    };
  }

  clear(): void {
    this.ids.clear();
  }
}
