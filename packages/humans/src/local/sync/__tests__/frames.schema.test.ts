/**
 * Wire commit-frame schema contract — pins `wireCommitOperationSchema` /
 * `commitPayloadSchema` (wire/frames.ts) to the shapes real traffic sends
 * today (buildCommitFrame is the SDK's single serialize boundary) and to the
 * rejections the server relies on (`commit_operation_invalid` ingest gate):
 * a string `readAt` must never reach the stale-guard SQL again.
 */

import {
  wireCommitOperationSchema,
  commitPayloadSchema,
  commitMessageSchema,
} from '@abloatai/transaction/wire/frames';
import { buildCommitFrame } from '../commitFrames.js';
import { MAX_READ_SET_ENTRIES } from '@abloatai/transaction/coordination/schema';

describe('wireCommitOperationSchema', () => {
  it('accepts every op shape the SDK sends today (buildCommitFrame output)', () => {
    const frame = buildCommitFrame(
      [
        { type: 'CREATE', model: 'tasks', id: 't1', input: { title: 'x' } },
        {
          type: 'UPDATE',
          model: 'tasks',
          id: 't1',
          input: { title: 'y' },
          transactionId: 'mut_1',
          readAt: 42,
          onStale: 'notify',
        },
        { type: 'DELETE', model: 'tasks', id: 't1' },
        { type: 'ARCHIVE', model: 'tasks', id: 't2' },
        { type: 'UNARCHIVE', model: 'tasks', id: 't2' },
      ],
      'tx_batch',
    );
    for (const op of frame.payload.operations) {
      const parsed = wireCommitOperationSchema.safeParse(op);
      expect(parsed.success).toBe(true);
    }
  });

  it('accepts the HTTP-normalized shape (explicit nulls)', () => {
    expect(
      wireCommitOperationSchema.safeParse({
        type: 'UPDATE',
        model: 'tasks',
        id: 't1',
        input: { status: 'done' },
        transactionId: null,
        readAt: null,
        onStale: null,
      }).success,
    ).toBe(true);
  });

  it('preserves claim identity beside its fencing token', () => {
    const frame = buildCommitFrame([{
      type: 'UPDATE',
      model: 'tasks',
      id: 't1',
      input: { status: 'done' },
      claimId: 'claim-1',
      fenceToken: 7,
    }], 'tx-claimed');

    expect(frame.payload.operations[0]).toMatchObject({
      claimId: 'claim-1',
      fenceToken: 7,
    });
    expect(commitMessageSchema.safeParse(frame).success).toBe(true);
  });

  it('declares the previously-undeclared `bypass` (boolean | null)', () => {
    expect(
      wireCommitOperationSchema.safeParse({ type: 'UPDATE', model: 'tasks', id: 't1', bypass: true })
        .success,
    ).toBe(true);
    expect(
      wireCommitOperationSchema.safeParse({ type: 'UPDATE', model: 'tasks', id: 't1', bypass: null })
        .success,
    ).toBe(true);
    expect(
      wireCommitOperationSchema.safeParse({ type: 'UPDATE', model: 'tasks', id: 't1', bypass: 'yes' })
        .success,
    ).toBe(false);
  });

  it('rejects a string readAt and names the field path', () => {
    const parsed = wireCommitOperationSchema.safeParse({
      type: 'UPDATE',
      model: 'tasks',
      id: 't1',
      readAt: '42',
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.some((i) => i.path.join('.') === 'readAt')).toBe(true);
    }
  });

  it('rejects unknown op types and missing model', () => {
    expect(
      wireCommitOperationSchema.safeParse({ type: 'create', model: 'tasks' }).success,
    ).toBe(false);
    expect(wireCommitOperationSchema.safeParse({ type: 'CREATE' }).success).toBe(false);
  });

  it('rejects an invalid onStale mode', () => {
    expect(
      wireCommitOperationSchema.safeParse({
        type: 'UPDATE',
        model: 'tasks',
        id: 't1',
        onStale: 'clobber',
      }).success,
    ).toBe(false);
  });
});

describe('commitPayloadSchema', () => {
  it('preserves the full ReadSet projections the SDK sends', () => {
    const frame = buildCommitFrame(
      [{ type: 'UPDATE', model: 'tasks', id: 't1', input: { a: 1 }, readAt: 7 }],
      'tx_batch',
      [
        { model: 'tasks', id: 't2', readAt: 5, onStale: 'reject' },
        { group: 'deck:abc', readAt: 5 },
      ],
      [
        { model: 'reports', id: 'r1', readAt: 4, onStale: 'notify' },
        { group: 'report:abc', readAt: 4, onStale: 'reject' },
      ],
    );
    expect(commitPayloadSchema.safeParse(frame.payload).success).toBe(true);
    expect(frame.payload.reads).toEqual([
      { model: 'tasks', id: 't2', readAt: 5, onStale: 'reject' },
      { group: 'deck:abc', readAt: 5 },
    ]);
    expect(frame.payload.track).toEqual([
      { model: 'reports', id: 'r1', readAt: 4, onStale: 'notify' },
      { group: 'report:abc', readAt: 4, onStale: 'reject' },
    ]);
  });

  it('does not collapse explicit empty or null projections into omission', () => {
    const empty = buildCommitFrame([], 'tx-empty', [], []);
    expect(empty.payload).toMatchObject({ reads: [], track: [] });

    const cleared = buildCommitFrame([], 'tx-null', null, null);
    expect(cleared.payload).toMatchObject({ reads: null, track: null });
  });

  it('caps the combined ReadSet projection at one canonical limit', () => {
    const dependency = (index: number) => ({
      model: 'tasks',
      id: `task-${index}`,
      readAt: index,
    });
    const reads = Array.from(
      { length: MAX_READ_SET_ENTRIES / 2 },
      (_, index) => dependency(index),
    );
    const track = Array.from(
      { length: MAX_READ_SET_ENTRIES / 2 },
      (_, index) => dependency(index + reads.length),
    );
    expect(commitPayloadSchema.safeParse({
      operations: [], clientTxId: 'at-limit', reads, track,
    }).success).toBe(true);
    expect(commitPayloadSchema.safeParse({
      operations: [], clientTxId: 'over-limit',
      reads: [...reads, dependency(MAX_READ_SET_ENTRIES)],
      track,
    }).success).toBe(false);
  });

  it('rejects a payload without clientTxId and names the offending op index', () => {
    expect(
      commitPayloadSchema.safeParse({ operations: [] }).success,
    ).toBe(false);
    const parsed = commitPayloadSchema.safeParse({
      operations: [
        { type: 'CREATE', model: 'tasks', id: 't1' },
        { type: 'UPDATE', model: 'tasks', id: 't1', readAt: 'stale-string' },
      ],
      clientTxId: 'tx',
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(
        parsed.error.issues.some((i) => i.path.slice(0, 3).join('.') === 'operations.1.readAt'),
      ).toBe(true);
    }
  });
});

describe('commitMessageSchema', () => {
  it('accepts the complete frame produced by the SDK serialize boundary', () => {
    const frame = buildCommitFrame(
      [{ type: 'UPDATE', model: 'tasks', id: 't1', input: { title: 'done' } }],
      'tx_1',
    );

    expect(commitMessageSchema.parse(frame)).toEqual(frame);
  });

  it('rejects the wrong frame type and reports nested payload failures', () => {
    const frame = buildCommitFrame(
      [{ type: 'UPDATE', model: 'tasks', id: 't1' }],
      'tx_1',
    );
    expect(commitMessageSchema.safeParse({ ...frame, type: 'mutation' }).success).toBe(false);

    const parsed = commitMessageSchema.safeParse({
      ...frame,
      payload: {
        ...frame.payload,
        operations: [{ ...frame.payload.operations[0], readAt: 'stale-string' }],
      },
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(
        parsed.error.issues.some(
          (issue) => issue.path.join('.') === 'payload.operations.0.readAt',
        ),
      ).toBe(true);
    }
  });
});
