/**
 * Records where this client stands in the global delta order. It is a single
 * typed object holding three related but distinct positions, each with its own
 * rule for when it may advance. Keeping them separate is deliberate: collapsing
 * them into one counter is a classic source of sync bugs.
 *
 *   - `persisted` — the resume cursor. It advances only after deltas have
 *     committed to durable local storage. This is the value reconnect catch-up
 *     sends to the server, so it must never run ahead of what actually landed
 *     on disk; otherwise the server would skip deltas the client never stored.
 *
 *   - `applied` — the in-memory cursor: the last delta applied to the object
 *     pool. It drives the guards that deduplicate and reject replayed deltas.
 *     It may run ahead of `persisted`, because the pool is updated before the
 *     flush to disk, and behind what has merely been received, because
 *     bootstrap-queued deltas arrive before they are applied.
 *
 *   - `acked` — the highest server position acknowledged for this client's own
 *     commits. An acknowledgement at N means the server applied our write at N;
 *     the optimistic pool already reflects it, so for the entities we wrote we
 *     have effectively read through N even before the echo returns on the
 *     stream.
 *
 * One value is derived: `readFloor` is the greater of `applied` and `acked`,
 * and is the only position a snapshot or claim should stamp as its read point.
 * Using the raw stream cursor alone would make a claim taken right after a
 * confirmed write look stale against that write's own delta; using the raw
 * acknowledgement alone would be wrong for read-only clients. The maximum is
 * correct per entity, because a competing change to an entity we just wrote
 * necessarily lands above our acknowledgement and still rejects as stale.
 *
 * The validation schema is the state shape: the class holds exactly one
 * {@link SyncPositionSnapshot} and merges monotonically into it, so snapshot
 * and restore share that shape and {@link parseSyncPosition} is the single gate
 * for anything loaded from disk — a corrupted cursor stored "ahead of reality"
 * being a known failure mode.
 */

import { z } from 'zod';

export const syncPositionSchema = z.object({
  /** The resume cursor; advances only after deltas persist to durable local storage. */
  persisted: z.number().int().nonnegative(),
  /** The in-memory cursor: the last delta applied to the object pool. */
  applied: z.number().int().nonnegative(),
  /** The highest server position acknowledged for this client's own commits. */
  acked: z.number().int().nonnegative(),
});

export type SyncPositionSnapshot = z.infer<typeof syncPositionSchema>;

/**
 * Only the `persisted` cursor is stored durably; `applied` and `acked` are
 * not. On resume the object pool is rebuilt from the persisted state, so the
 * correct restore is simply to advance `persisted` to the stored value, which
 * also implies `applied`. `acked` starts at zero, because a past session's
 * acknowledgements carry no read authority and the offline queue
 * re-acknowledges its own replays.
 */

/**
 * Validates an untrusted value, such as one loaded from disk, into a position
 * snapshot, or returns null when it does not match the schema.
 */
export function parseSyncPosition(value: unknown): SyncPositionSnapshot | null {
  const result = syncPositionSchema.safeParse(value);
  return result.success ? result.data : null;
}

const ZERO: SyncPositionSnapshot = { persisted: 0, applied: 0, acked: 0 };

/** Monotonic merge: each cursor only ever moves forward. */
function advance(
  state: SyncPositionSnapshot,
  next: Partial<SyncPositionSnapshot>,
): SyncPositionSnapshot {
  return {
    persisted: Math.max(state.persisted, next.persisted ?? 0),
    applied: Math.max(state.applied, next.applied ?? 0),
    acked: Math.max(state.acked, next.acked ?? 0),
  };
}

/**
 * The live sync position: one instance per client. Three producers each
 * advance their own cursor, and consumers read the result.
 */
export class SyncPosition {
  #state = ZERO;

  /** Returns a copy of the current state in the schema's shape. */
  snapshot(): SyncPositionSnapshot {
    return { ...this.#state };
  }

  get persisted(): number {
    return this.#state.persisted;
  }

  get applied(): number {
    return this.#state.applied;
  }

  get acked(): number {
    return this.#state.acked;
  }

  /** The position a snapshot or claim stamps as its read point: the greater of `applied` and `acked`. */
  get readFloor(): number {
    return Math.max(this.#state.applied, this.#state.acked);
  }

  /**
   * Records that deltas through `syncId` have committed to durable local
   * storage. This also advances `applied`, since the flush applies each delta
   * before or as it persists.
   */
  advancePersisted(syncId: number): void {
    this.#state = advance(this.#state, { persisted: syncId, applied: syncId });
  }

  /** Records that a delta was applied to the in-memory object pool. */
  advanceApplied(syncId: number): void {
    this.#state = advance(this.#state, { applied: syncId });
  }

  /** Records that the server acknowledged one of this client's commits at the given position. */
  noteAck(lastSyncId: number | undefined): void {
    if (lastSyncId !== undefined) this.#state = advance(this.#state, { acked: lastSyncId });
  }

  /** Restores from an already-validated snapshot, for example on resume from disk. The merge is monotonic. */
  restore(snapshot: SyncPositionSnapshot): void {
    this.#state = advance(this.#state, snapshot);
  }
}
