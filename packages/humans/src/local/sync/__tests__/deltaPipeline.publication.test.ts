import { persistDeltaFrame, clearPendingPublications, flushPendingDeltas, type DeltaPipelineContext } from '../deltaPipeline.js';
import type { AppliedChange } from '../../../plugin.js';
import type { SyncDelta } from '../SyncWebSocket.js';

const delta: SyncDelta = { id: 1, actionType: 'U', modelName: 'Document', modelId: 'row', data: { body: 'accepted' },
  operation: { kind: 'text', field: 'body', id: 'edit', epoch: 'epoch', version: 1 }, syncGroups: [], createdAt: new Date().toISOString() };

function context() {
  let durable = false;
  const apply = jest.fn();
  const acknowledge = jest.fn();
  const ctx: DeltaPipelineContext = {
    pendingDeltas: [], batchTimer: null, bootstrapDeltaQueue: null,
    smartSyncOptions: { batchingDelay: 10, maxBatchSize: 100, applySliceDeltas: 1 }, highestProcessedSyncId: 0, lastAckedId: 0,
    onDeltaReceived: jest.fn(), advanceApplied: jest.fn(), advancePersisted: jest.fn(), acknowledge,
    processDeltaBatch: async () => {
      const result: AppliedChange = { action: durable ? 'verify' : 'update', modelName: 'Document', modelId: 'row', syncId: 1,
        ...(durable ? {} : { data: { body: 'accepted' } }) };
      durable = true;
      return { results: [result], persistedSyncId: 1 };
    },
    applyDeltaBatchToPool: apply,
    objectPool: { peek: () => undefined, add: jest.fn(), remove: () => true, clear: jest.fn() },
    isCustomEntity: () => false, createCustomEntity: () => null, deduplicateDeltas: (deltas) => deltas,
    flushPendingDeltas: () => flushPendingDeltas(ctx), handleFlushError: jest.fn(), handleSyncGroupChange: async () => undefined,
    handleGroupRemoved: async () => undefined, forceFullRebootstrap: jest.fn(), cascadeCancelTransactionsForDeletedParent: jest.fn(),
  };
  return { ctx, apply, acknowledge };
}

test('a failed preparation retries the persisted change rather than acknowledging a verify without publication', async () => {
  const { ctx, apply, acknowledge } = context();
  let blocked = true;
  ctx.applyPreparedDeltaBatch = async (changes, publish) => {
    if (blocked) throw new Error('history unavailable');
    publish(changes); return true;
  };
  ctx.pendingDeltas = [delta];
  await expect(flushPendingDeltas(ctx)).rejects.toThrow('history unavailable');
  expect(apply).not.toHaveBeenCalled();
  expect(acknowledge).not.toHaveBeenCalled();
  blocked = false;
  await flushPendingDeltas(ctx);
  expect(apply.mock.calls[0]?.[0]).toEqual([expect.objectContaining({ action: 'update', data: { body: 'accepted' }, operation: delta.operation })]);
  expect(acknowledge).toHaveBeenCalledWith(1);
});

test('a security clear cancels a detached prepared frame without exposing or acknowledging it', async () => {
  const { ctx, apply, acknowledge } = context();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let started!: () => void;
  const preparing = new Promise<void>((resolve) => { started = resolve; });
  ctx.applyPreparedDeltaBatch = async (changes, publish) => { started(); await gate; publish(changes); return true; };
  ctx.pendingDeltas = [delta];
  const applying = flushPendingDeltas(ctx);
  await preparing;
  clearPendingPublications(ctx);
  release();
  await applying;
  expect(apply).not.toHaveBeenCalled();
  expect(acknowledge).not.toHaveBeenCalled();
  expect(ctx.pendingDeltas).toEqual([]);
});

test('a security clear drops a persisted frame held after a failed projection', async () => {
  const { ctx, apply } = context();
  ctx.applyPreparedDeltaBatch = async () => { throw new Error('unproved context'); };
  ctx.pendingDeltas = [delta];
  await expect(flushPendingDeltas(ctx)).rejects.toThrow('unproved context');
  clearPendingPublications(ctx);
  ctx.applyPreparedDeltaBatch = undefined;
  await persistDeltaFrame(ctx, [delta]);
  // Persistence already consumed the old frame, so its ordinary verify cannot resurrect it.
  expect(apply.mock.calls.flatMap(([changes]) => changes).every((change) => change.action === 'verify')).toBe(true);
  expect(apply).toHaveBeenCalledTimes(1);
});

test('a persistence failure after a security clear cannot requeue revoked deltas', async () => {
  const { ctx, apply, acknowledge } = context();
  let fail!: (error: Error) => void;
  ctx.processDeltaBatch = () => new Promise((_resolve, reject) => { fail = reject; });
  ctx.pendingDeltas = [delta];
  const applying = flushPendingDeltas(ctx);
  clearPendingPublications(ctx);
  fail(new Error('cleared transaction'));
  await applying;
  expect(ctx.pendingDeltas).toEqual([]);
  expect(apply).not.toHaveBeenCalled();
  expect(acknowledge).not.toHaveBeenCalled();
});
