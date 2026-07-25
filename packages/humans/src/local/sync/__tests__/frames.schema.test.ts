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
  it('accepts the full payload the SDK sends (reads)', () => {
    const frame = buildCommitFrame(
      [{ type: 'UPDATE', model: 'tasks', id: 't1', input: { a: 1 }, readAt: 7 }],
      'tx_batch',
      [
        { model: 'tasks', id: 't2', readAt: 5, onStale: 'reject' },
        { group: 'deck:abc', readAt: 5 },
      ],
    );
    expect(commitPayloadSchema.safeParse(frame.payload).success).toBe(true);
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
