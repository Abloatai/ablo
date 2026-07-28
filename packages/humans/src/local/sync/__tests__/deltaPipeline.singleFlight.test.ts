import {
  applyDeltaFrame,
  flushPendingDeltas,
  type DeltaPipelineContext,
} from '../deltaPipeline.js';
import type { SyncDelta } from '../SyncWebSocket.js';

function delta(id: number): SyncDelta {
  return {
    id,
    actionType: 'I',
    modelName: 'Task',
    modelId: `task-${id}`,
    data: { id: `task-${id}` },
    syncGroups: [],
    createdAt: new Date().toISOString(),
  };
}

describe('delta pipeline single-flight drain', () => {
  it('detaches the active batch and serially drains a frame received while persistence awaits', async () => {
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let calls = 0;
    let concurrent = 0;
    let maxConcurrent = 0;
    let applied = 0;
    let persisted = 0;
    const processedIds: number[][] = [];

    const ctx: DeltaPipelineContext = {
      pendingDeltas: [],
      batchTimer: null,
      bootstrapDeltaQueue: null,
      smartSyncOptions: { batchingDelay: 10, maxBatchSize: 100, applySliceDeltas: 600 },
      get highestProcessedSyncId() { return applied; },
      get lastAckedId() { return persisted; },
      onDeltaReceived: jest.fn(),
      advanceApplied: (syncId) => { applied = Math.max(applied, syncId); },
      advancePersisted: (syncId) => { persisted = Math.max(persisted, syncId); },
      processDeltaBatch: jest.fn(async (deltas) => {
        calls += 1;
        concurrent += 1;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        processedIds.push(deltas.map((item) => item.syncId ?? 0));
        if (calls === 1) await firstBlocked;
        concurrent -= 1;
        return {
          results: [],
          persistedSyncId: Math.max(...deltas.map((item) => item.syncId ?? 0)),
        };
      }),
      applyDeltaBatchToPool: jest.fn(),
      acknowledge: jest.fn(),
      objectPool: {
        get: () => undefined,
        add: jest.fn(),
        remove: jest.fn(() => true),
        clear: jest.fn(),
      },
      getStateFields: () => [],
      isCustomEntity: () => false,
      createCustomEntity: () => null,
      deduplicateDeltas: (deltas) => deltas,
      flushPendingDeltas: () => flushPendingDeltas(ctx),
      handleFlushError: jest.fn(),
      handleSyncGroupChange: jest.fn(async () => undefined),
      handleGroupRemoved: jest.fn(async () => undefined),
      forceFullRebootstrap: jest.fn(),
      cascadeCancelTransactionsForDeletedParent: jest.fn(),
    };

    applyDeltaFrame(ctx, [delta(1)]);
    expect(ctx.pendingDeltas).toHaveLength(0);

    applyDeltaFrame(ctx, [delta(2)]);
    expect(ctx.pendingDeltas.map((item) => item.id)).toEqual([2]);

    const completion = ctx.flushPendingDeltas();
    releaseFirst();
    await completion;

    expect(processedIds).toEqual([[1], [2]]);
    expect(maxConcurrent).toBe(1);
    expect(ctx.pendingDeltas).toEqual([]);
    expect(ctx.acknowledge).toHaveBeenCalledTimes(2);
    expect(persisted).toBe(2);
  });
});
