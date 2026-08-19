/**
 * LogPosition — the one structure for the client's place in the delta
 * order. Pins the three advance disciplines, the derived `readFloor`
 * (claims' `readAt` source), monotonicity, and the schema gate for
 * anything restored from disk.
 */

import {
  LogPosition,
  parseLogPosition,
  logPositionSnapshotSchema,
} from '../../logPosition.js';

describe('LogPosition', () => {
  it('starts at zero with a schema-valid snapshot', () => {
    const p = new LogPosition();
    expect(p.snapshot()).toEqual({ persisted: 0, applied: 0, acked: 0 });
    expect(logPositionSnapshotSchema.safeParse(p.snapshot()).success).toBe(true);
  });

  it('readFloor = max(applied, acked) — the ack-then-claim race fix', () => {
    const p = new LogPosition();
    // Own write acked at 7 before any stream delta applied: a claim taken
    // now must stamp readAt 7, not 0 — else it's stale against its own write.
    p.noteAck(7);
    expect(p.readFloor).toBe(7);
    // Stream catches up past the ack — applied wins.
    p.advanceApplied(9);
    expect(p.readFloor).toBe(9);
  });

  it('persisting implies applied, but applying never implies persisted', () => {
    const p = new LogPosition();
    p.advancePersisted(5);
    expect(p.applied).toBe(5);
    expect(p.persisted).toBe(5);
    p.advanceApplied(8); // pool ahead of IDB — the normal in-flight state
    expect(p.applied).toBe(8);
    expect(p.persisted).toBe(5); // resume cursor stays durable-only
  });

  it('every cursor is monotonic — stale ids are no-ops', () => {
    const p = new LogPosition();
    p.advanceApplied(10);
    p.advanceApplied(3);
    p.advancePersisted(2);
    p.noteAck(10);
    p.noteAck(1);
    expect(p.snapshot()).toEqual({ persisted: 2, applied: 10, acked: 10 });
  });

  it('restore() merges monotonically from a validated snapshot', () => {
    const p = new LogPosition();
    p.advanceApplied(20);
    p.restore({ persisted: 5, applied: 5, acked: 12 }); // older applied loses
    expect(p.snapshot()).toEqual({ persisted: 5, applied: 20, acked: 12 });
  });

  it('the persisted-cursor field gates corrupted IDB resume state (Database load path)', () => {
    // Database.requiredBootstrap parses `metadata.lastSyncId` through this
    // exact schema field; invalid → undefined → caller falls back to 0
    // (full bootstrap). `|| 0` previously let a NEGATIVE cursor through.
    const field = logPositionSnapshotSchema.shape.persisted;
    expect(field.safeParse(42).data).toBe(42);
    expect(field.safeParse(-5).data).toBeUndefined();
    expect(field.safeParse(3.7).data).toBeUndefined();
    expect(field.safeParse('99').data).toBeUndefined();
    expect(field.safeParse(undefined).data).toBeUndefined();
  });

  it('parseLogPosition gates corrupted disk state', () => {
    expect(parseLogPosition({ persisted: 5, applied: 5, acked: 0 })).toEqual({
      persisted: 5,
      applied: 5,
      acked: 0,
    });
    expect(parseLogPosition({ persisted: -1, applied: 5, acked: 0 })).toBeNull();
    expect(parseLogPosition({ persisted: 'NaN' })).toBeNull();
    expect(parseLogPosition(null)).toBeNull();
  });
});
