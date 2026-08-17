/**
 * The log position each pooled row is known to reflect — the client-side
 * companion of the server's per-row watermark (`ModelListEvidence.stamp`).
 *
 * A row's copy in the pool moves through four doors, and every one of them
 * names the log position it delivers: the ordered delta stream (the delta's
 * id), the acknowledgement of this client's own commit (`lastSyncId`), a
 * bootstrap snapshot (its `lastSyncId`), and a server read (the row's evidence
 * stamp). Recording that position per row is what lets a later snapshot be
 * judged. A snapshot taken at position P cannot carry anything the log did not
 * hold at P, so when the pooled copy already reflects a position beyond P the
 * snapshot is stale for that row and is left unapplied. Deltas repair every
 * peer change a skipped snapshot would have carried; nothing repairs a
 * snapshot that regresses this client's own confirmed write, because own
 * echoes are suppressed on apply — which is why the rule errs toward keeping
 * the resident copy.
 *
 * The row's `updatedAt` is not consulted. It is an application field the
 * server never stamps and the client fabricates when a row arrives without one,
 * so it orders nothing; the log does.
 *
 * Positions are `sync_deltas` ids, the same space as {@link LogPosition}. Zero
 * and `undefined` mean "no evidence" and never advance a row.
 */

export class RowWatermarks {
  readonly #positions = new WeakMap<object, number>();

  /** Record that `row`'s pooled copy reflects the log at least through `position`. */
  advance(row: object, position: number | undefined): void {
    if (position === undefined || !(position > 0)) return;
    const known = this.#positions.get(row);
    if (known === undefined || position > known) this.#positions.set(row, position);
  }

  /** The highest log position `row` is known to reflect, if the client has any evidence. */
  of(row: object): number | undefined {
    return this.#positions.get(row);
  }

  /**
   * Whether the pooled copy of `row` is known to be ahead of a snapshot that
   * reflects the log through `snapshotPosition`. `snapshotPosition` is a lower
   * bound: the position the snapshot provably includes (a row's evidence stamp,
   * a bootstrap's `lastSyncId`, or the client's own read floor at the moment
   * the read was issued — the server had at least that much when it answered).
   * A snapshot with no known position is never judged stale.
   */
  isAheadOf(row: object, snapshotPosition: number | undefined): boolean {
    if (snapshotPosition === undefined) return false;
    const known = this.#positions.get(row);
    return known !== undefined && known > snapshotPosition;
  }
}
