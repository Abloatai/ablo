import { z } from 'zod';

export const logPositionSchema = z.object({
  persisted: z.number().int().nonnegative(),
  applied: z.number().int().nonnegative(),
  acked: z.number().int().nonnegative(),
});

export type LogPositionSnapshot = z.infer<typeof logPositionSchema>;

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
  const result = logPositionSchema.safeParse(value);
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
