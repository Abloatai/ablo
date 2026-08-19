/**
 * The three log positions a connected client owns.
 *
 * Each field is a {@link logPositionSchema}, the one position type, and the
 * field name says who is claiming what: `applied` is what arrival processed,
 * `persisted` is what local storage durably holds IN DELIVERED ORDER, and
 * `acked` is what the server has been told. They are the same kind of number
 * as the server's heads and cursors, and deliberately not comparable to them
 * without saying which owner you mean. See the owner table on
 * `@abloatai/transaction/syncLog/contract`.
 */

import { z } from 'zod';
import { logPositionSchema } from '@abloatai/transaction/syncLog/contract';

export const logPositionSnapshotSchema = z.object({
  persisted: logPositionSchema,
  applied: logPositionSchema,
  acked: logPositionSchema,
});

export type LogPositionSnapshot = z.infer<typeof logPositionSnapshotSchema>;

export interface LogPositionPort {
  readonly persisted: number;
  readonly applied: number;
  readonly acked: number;
  readonly readFloor: number;
  snapshot(): LogPositionSnapshot;
  advancePersisted(syncId: number): void;
  advanceApplied(syncId: number): void;
  noteAck(lastSyncId: number | undefined): void;
  restore(snapshot: LogPositionSnapshot): void;
}

export function parseLogPosition(value: unknown): LogPositionSnapshot | null {
  const result = logPositionSnapshotSchema.safeParse(value);
  return result.success ? result.data : null;
}

const ZERO: LogPositionSnapshot = { persisted: 0, applied: 0, acked: 0 };

function advance(
  state: LogPositionSnapshot,
  next: Partial<LogPositionSnapshot>,
): LogPositionSnapshot {
  return {
    persisted: Math.max(state.persisted, next.persisted ?? 0),
    applied: Math.max(state.applied, next.applied ?? 0),
    acked: Math.max(state.acked, next.acked ?? 0),
  };
}

export class LogPosition implements LogPositionPort {
  #state = ZERO;

  snapshot(): LogPositionSnapshot {
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

  get readFloor(): number {
    return Math.max(this.#state.applied, this.#state.acked);
  }

  advancePersisted(syncId: number): void {
    this.#state = advance(this.#state, {
      persisted: syncId,
      applied: syncId,
    });
  }

  advanceApplied(syncId: number): void {
    this.#state = advance(this.#state, { applied: syncId });
  }

  noteAck(lastSyncId: number | undefined): void {
    if (lastSyncId !== undefined) {
      this.#state = advance(this.#state, { acked: lastSyncId });
    }
  }

  restore(snapshot: LogPositionSnapshot): void {
    this.#state = advance(this.#state, snapshot);
  }
}
