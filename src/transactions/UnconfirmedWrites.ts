/**
 * Tracks the transactions this client has applied locally but the server has
 * not yet confirmed, so their echoes can be recognized when they return over
 * the sync stream. When a change is made optimistically, the client updates
 * its own state at once; the server later broadcasts the same change as a sync
 * delta stamped with the originating `transactionId`. This tracker lets the
 * receive path recognize that delta as its own echo and skip re-applying it,
 * since the optimistic write already reflects it. Without this discriminator
 * the apply path would re-apply the confirmation on top of state that may have
 * changed since, producing a visible flicker.
 *
 * An entry is added with {@link markPending} and drained either by
 * {@link consumeEcho} when the matching delta arrives, or by
 * {@link drainOnRollback} when the originating transaction is cancelled.
 *
 * The set is bounded by `maxSize` to guard against unbounded growth if
 * transactions are somehow never confirmed and never rolled back. When the
 * bound is reached the oldest id is evicted first, since the backing Map
 * iterates in insertion order. Eviction carries no correctness risk for the
 * client that made the write, whose local state already reflects the change;
 * the only cost is that a later echo of the evicted transaction is applied as
 * if it were a foreign change, at worst a single redundant re-set.
 */

export interface UnconfirmedWritesOptions {
  /**
   * The maximum number of unconfirmed transaction ids to track. Once this many
   * are held, adding another evicts the oldest. Defaults to 10,000, which
   * leaves ample headroom even for a client with many tabs open during a large
   * bulk edit.
   */
  maxSize?: number;
}

export interface UnconfirmedWritesMetrics {
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

export class UnconfirmedWrites {
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

  constructor(options: UnconfirmedWritesOptions = {}) {
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
   * Reports whether an incoming delta is this client's own echo, draining the
   * entry if so. Returns true when the id was being tracked, signalling the
   * caller to skip re-applying the change because the optimistic write already
   * reflects it; returns false for a change that originated elsewhere, which
   * should be applied normally.
   *
   * The check and drain are combined into one call so the receive path cannot
   * accidentally treat two deltas carrying the same id, arriving in one batch,
   * as separate echoes.
   */
  consumeEcho(transactionId: string | null | undefined): boolean {
    if (!transactionId) return false;
    if (!this.ids.has(transactionId)) return false;
    this.ids.delete(transactionId);
    this._hits += 1;
    return true;
  }

  /**
   * Drains the entry for a transaction that was rolled back before the server
   * confirmed it. No echo will ever arrive for a cancelled transaction, so
   * without this the pending entry would leak. Rollbacks are counted separately
   * from confirmed echoes, so a rise in rollbacks relative to hits can flag
   * network or server trouble.
   */
  drainOnRollback(transactionId: string): void {
    if (this.ids.delete(transactionId)) {
      this._rollbacks += 1;
    }
  }

  getMetrics(): Readonly<UnconfirmedWritesMetrics> {
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
