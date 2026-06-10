/**
 * THE sync-position structure — one typed object for "where is this client
 * in the global delta order", replacing five scattered private counters
 * (`lastSeenSyncId` on the queue, `highestProcessedSyncId` + `lastAckedId`
 * on the store, ad-hoc acked watermarks, `max()` calls at snapshot sites).
 *
 * Three facts with DIFFERENT advance disciplines — flattening them was the
 * historical bug source, so the structure models them explicitly:
 *
 *   - `persisted` — the resume/ack cursor. Advances ONLY after deltas have
 *     committed to IndexedDB (the Replicache "lastMutationID read in the
 *     same transaction as the client view" rule — see SyncWebSocket.sendAck).
 *     This is what reconnect catch-up sends; it must never run ahead of
 *     durable state or the server skips deltas that never landed.
 *
 *   - `applied` — the in-memory cursor: the last delta APPLIED to the
 *     object pool. Drives delta dedup/replay guards. May run ahead of
 *     `persisted` (pool applies before the IDB flush) and behind receipt
 *     (bootstrap-queued deltas are received but not yet applied).
 *
 *   - `acked` — the highest server watermark ACKED to this client's OWN
 *     commits. An ack at N means the server applied our write at N; the
 *     optimistic pool already reflects it, so for entities we wrote we have
 *     logically read through N even before the stream echo arrives.
 *
 * One derived read: `readFloor` = max(applied, acked) — the ONLY value
 * snapshots/claims may stamp as `readAt`. The bare stream cursor made a
 * claim taken right after an ack-confirmed write stale against that write's
 * own delta; the bare ack would be wrong for read-only clients. Per-entity
 * correct: a foreign change to an entity we just wrote necessarily lands
 * ABOVE our ack and still stale-rejects.
 *
 * The Zod schema IS the state shape — the class holds exactly one
 * `SyncPositionSnapshot` and applies monotonic merges to it, so
 * snapshot/restore are identity-shaped and the schema is the single gate
 * for anything loaded from disk (`parseSyncPosition`; a corrupted stored
 * cursor "ahead of reality" is an existing, known failure mode).
 */

import { z } from 'zod';

export const syncPositionSchema = z.object({
  /** Resume/ack cursor — advances only after IDB persistence. */
  persisted: z.number().int().nonnegative(),
  /** In-memory cursor — last delta applied to the pool. */
  applied: z.number().int().nonnegative(),
  /** Highest server watermark acked to this client's own commits. */
  acked: z.number().int().nonnegative(),
});

export type SyncPositionSnapshot = z.infer<typeof syncPositionSchema>;

/**
 * PERSISTENCE DESIGN: only the `persisted` cursor is stored durably (as
 * `WorkspaceMetadata.lastSyncId`, written by Database after each IDB delta
 * commit and gated on load through `syncPositionSchema.shape.persisted` in
 * `Database.requiredBootstrap`). Persisting `applied`/`acked` would be
 * meaningless: on resume the pool is rebuilt FROM the persisted state, so
 * the correct restore is exactly `advancePersisted(storedCursor)` — which
 * implies `applied`, while `acked` starts at 0 (a dead session's acks carry
 * no read authority; the offline queue re-acks its own replays).
 */

/** Validate a persisted/foreign value into a position snapshot. */
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

/** The live position. One instance per client (owned by SyncClient); the
 *  three producers advance their own fact, consumers read. */
export class SyncPosition {
  #state = ZERO;

  /** Current state — the schema shape, frozen-by-copy. */
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

  /** THE value snapshots/claims stamp as `readAt`. */
  get readFloor(): number {
    return Math.max(this.#state.applied, this.#state.acked);
  }

  /** Deltas through `syncId` have COMMITTED to IndexedDB. Persisting
   *  implies applied — the flush path applies before/with persisting. */
  advancePersisted(syncId: number): void {
    this.#state = advance(this.#state, { persisted: syncId, applied: syncId });
  }

  /** A delta was APPLIED to the in-memory pool. */
  advanceApplied(syncId: number): void {
    this.#state = advance(this.#state, { applied: syncId });
  }

  /** The server acked one of OUR commits at this watermark. */
  noteAck(lastSyncId: number | undefined): void {
    if (lastSyncId !== undefined) this.#state = advance(this.#state, { acked: lastSyncId });
  }

  /** Restore from a VALIDATED snapshot (e.g. IDB resume). Monotonic. */
  restore(snapshot: SyncPositionSnapshot): void {
    this.#state = advance(this.#state, snapshot);
  }
}
