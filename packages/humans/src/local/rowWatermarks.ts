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
 * peer change a skipped snapshot would have carried. Acknowledgements also
 * retain their written fields, so older catch-up rows can contribute peer
 * fields without replacing a more recently confirmed local value.
 *
 * The row's `updatedAt` is not consulted. It is an application field the
 * server never stamps and the client fabricates when a row arrives without one,
 * so it orders nothing; the log does.
 *
 * Positions are `sync_deltas` ids, the same space as {@link LogPosition}. Zero
 * and `undefined` mean "no evidence" and never advance a row.
 */

import { snapshotJsonValue } from '@abloatai/transaction/utils/json';

interface RowPosition {
  position: number;
  serverPosition: number;
  writes?: Map<string, { position: number; value: unknown }>;
}

export class RowWatermarks {
  readonly #rows = new WeakMap<object, RowPosition>();

  /** Record that `row`'s pooled copy reflects the log at least through `position`. */
  advance(row: object, position: number | undefined): void {
    if (position === undefined || !(position > 0)) return;
    const known = this.#rows.get(row);
    if (known) {
      known.position = Math.max(known.position, position);
      known.serverPosition = Math.max(known.serverPosition, position);
    } else this.#rows.set(row, { position, serverPosition: position });
  }

  /** An ack proves only its written fields, not the peer fields in an earlier row. */
  acknowledge(row: object, position: number, data: Record<string, unknown>): void {
    if (!(position > 0)) return;
    const known: RowPosition = this.#rows.get(row) ?? { position, serverPosition: 0 };
    known.position = Math.max(known.position, position);
    const writes = known.writes ??= new Map();
    for (const [field, value] of Object.entries(data)) {
      if ((writes.get(field)?.position ?? 0) > position) continue;
      writes.set(field, { position, value: snapshotJsonValue(value) });
    }
    this.#rows.set(row, known);
  }

  /** Keep confirmed fields stable while still accepting other fields from catch-up. */
  project(row: object, data: Record<string, unknown>, position: number | undefined): Record<string, unknown> {
    const known = this.#rows.get(row);
    if (!known?.writes || position === undefined || !(position > 0) ||
      data.deletedAt != null || data.archivedAt != null || data.isActive === false) return data;
    const projected = { ...data };
    for (const [field, write] of known.writes) {
      if (position < known.serverPosition) {
        // A fresher stream/read already reached this row after the ack.
        projected[field] = Reflect.get(row, field);
      } else if (position < write.position) {
        projected[field] = write.value;
      } else if (Object.hasOwn(data, field)) {
        known.writes.set(field, { position, value: snapshotJsonValue(data[field]) });
      }
    }
    return projected;
  }

  /** The highest log position `row` is known to reflect, if the client has any evidence. */
  of(row: object): number | undefined {
    return this.#rows.get(row)?.position;
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
    const known = this.of(row);
    return known !== undefined && known > snapshotPosition;
  }
}
