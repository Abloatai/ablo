/**
 * Sync-group revocation failure handling (T1.21).
 *
 * The 'G'/'S' handlers run fire-and-forget AFTER the applied watermark has
 * advanced — the delta is never re-delivered. A rejected handler used to be
 * a permanently-silent unhandled rejection, leaving REVOKED rows cached (a
 * failed security clear). Pins the new contract:
 *
 *  1. `enqueueDelta` attaches a `.catch` to both handlers; on failure it
 *     logs a consumer-worded error, clears the in-memory pool, and forces a
 *     full re-bootstrap.
 *  2. A malformed (unparseable JSON) 'G'/'S' payload in the groupChange leaf
 *     degrades to the legacy clear path — it never throws out of the
 *     pipeline.
 */
import { enqueueDelta, type DeltaPipelineContext } from '../deltaPipeline.js';
import {
  handleSyncGroupChange,
  handleGroupRemoved,
  type GroupChangeContext,
} from '../groupChange.js';
import type { SyncDelta } from '../SyncWebSocket.js';
import { createTestContext } from '../../testing/mocks/MockSyncContext.js';
import type { TestContextResult } from '../../testing/mocks/MockSyncContext.js';
import type { Logger } from '../../interfaces/index.js';

const flushMicrotasks = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

function makeDelta(actionType: 'G' | 'S', data: SyncDelta['data']): SyncDelta {
  return {
    id: 42,
    actionType,
    modelName: 'SyncGroup',
    modelId: 'group-1',
    data,
    syncGroups: [],
    createdAt: new Date().toISOString(),
  };
}

interface PipelineHarness {
  ctx: DeltaPipelineContext;
  clear: jest.Mock;
  forceFullRebootstrap: jest.Mock;
}

function makePipelineCtx(overrides: {
  handleSyncGroupChange?: (delta: SyncDelta) => Promise<void>;
  handleGroupRemoved?: (delta: SyncDelta) => Promise<void>;
}): PipelineHarness {
  const clear = jest.fn();
  const forceFullRebootstrap = jest.fn();
  const ctx: DeltaPipelineContext = {
    pendingDeltas: [],
    batchTimer: null,
    bootstrapDeltaQueue: null,
    smartSyncOptions: { batchingDelay: 10, maxBatchSize: 100, applySliceDeltas: 600 },
    highestProcessedSyncId: 0,
    lastAckedId: 0,
    onDeltaReceived: jest.fn(),
    advanceApplied: jest.fn(),
    advancePersisted: jest.fn(),
    processDeltaBatch: jest.fn(async () => ({ results: [], persistedSyncId: 0 })),
    applyDeltaBatchToPool: jest.fn(),
    acknowledge: jest.fn(),
    objectPool: {
      get: () => undefined,
      add: jest.fn(),
      remove: jest.fn(() => true),
      clear,
    },
    getStateFields: () => [],
    isCustomEntity: () => false,
    createCustomEntity: () => null,
    deduplicateDeltas: (deltas) => deltas,
    flushPendingDeltas: jest.fn(async () => undefined),
    handleFlushError: jest.fn(),
    handleSyncGroupChange:
      overrides.handleSyncGroupChange ?? jest.fn(async () => undefined),
    handleGroupRemoved:
      overrides.handleGroupRemoved ?? jest.fn(async () => undefined),
    forceFullRebootstrap,
    cascadeCancelTransactionsForDeletedParent: jest.fn(),
  };
  return { ctx, clear, forceFullRebootstrap };
}

describe('enqueueDelta — revocation handler failure fallback', () => {
  let testCtx: TestContextResult;
  let errorLog: jest.Mock;

  beforeEach(() => {
    errorLog = jest.fn();
    const logger: Logger = {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: errorLog,
    };
    testCtx = createTestContext({ logger });
  });

  afterEach(() => {
    testCtx.cleanup();
  });

  it("escalates a failed 'S' (group removed) clear: logs + pool clear + full re-bootstrap", async () => {
    const harness = makePipelineCtx({
      handleGroupRemoved: async () => {
        throw new Error('IDB clear failed');
      },
    });

    const enqueued = enqueueDelta(harness.ctx, makeDelta('S', '{"group":"team:1"}'));
    expect(enqueued).toBe(false);
    await flushMicrotasks();

    expect(harness.clear).toHaveBeenCalledTimes(1);
    expect(harness.forceFullRebootstrap).toHaveBeenCalledTimes(1);
    expect(errorLog).toHaveBeenCalledTimes(1);
    expect(String(errorLog.mock.calls[0][0])).toContain('resetting local data');
  });

  it("escalates a failed 'G' (group change) handler the same way", async () => {
    const harness = makePipelineCtx({
      handleSyncGroupChange: async () => {
        throw new Error('metadata write failed');
      },
    });

    enqueueDelta(harness.ctx, makeDelta('G', '{"removedGroups":["team:1"],"addedGroups":[]}'));
    await flushMicrotasks();

    expect(harness.clear).toHaveBeenCalledTimes(1);
    expect(harness.forceFullRebootstrap).toHaveBeenCalledTimes(1);
    expect(errorLog).toHaveBeenCalledTimes(1);
  });

  it('does not escalate when the handler succeeds', async () => {
    const harness = makePipelineCtx({});
    enqueueDelta(harness.ctx, makeDelta('S', '{"group":"team:1"}'));
    await flushMicrotasks();

    expect(harness.clear).not.toHaveBeenCalled();
    expect(harness.forceFullRebootstrap).not.toHaveBeenCalled();
    expect(errorLog).not.toHaveBeenCalled();
  });
});

describe('groupChange — malformed payloads degrade to the legacy clear', () => {
  let testCtx: TestContextResult;

  beforeEach(() => {
    testCtx = createTestContext();
  });

  afterEach(() => {
    testCtx.cleanup();
  });

  function makeGroupCtx(): {
    ctx: GroupChangeContext;
    dbClear: jest.Mock;
    poolClear: jest.Mock;
    forceFullRebootstrap: jest.Mock;
  } {
    const dbClear = jest.fn(async () => undefined);
    const poolClear = jest.fn();
    const forceFullRebootstrap = jest.fn();
    const ctx: GroupChangeContext = {
      database: {
        clear: dbClear,
        getWorkspaceMetadata: jest.fn(async () => null),
        updateWorkspaceMetadata: jest.fn(async () => undefined),
        markRequiresFullBootstrap: jest.fn(),
      },
      objectPool: { clear: poolClear },
      getSubscribedSyncGroups: () => [],
      getCurrentSyncGroups: () => null,
      getBootstrapMode: () => 'full',
      disconnectWebSocket: jest.fn(),
      emitConnectionEvent: jest.fn(),
      handleGroupAdded: jest.fn(async () => undefined),
      computeUpdatedSyncGroups: () => [],
      forceFullRebootstrap,
    };
    return { ctx, dbClear, poolClear, forceFullRebootstrap };
  }

  it("handleGroupRemoved: unparseable JSON clears + re-bootstraps instead of throwing", async () => {
    const { ctx, dbClear, poolClear, forceFullRebootstrap } = makeGroupCtx();

    await expect(
      handleGroupRemoved(ctx, makeDelta('S', '{not json')),
    ).resolves.toBeUndefined();

    expect(dbClear).toHaveBeenCalledTimes(1);
    expect(poolClear).toHaveBeenCalledTimes(1);
    expect(forceFullRebootstrap).toHaveBeenCalledTimes(1);
  });

  it('handleSyncGroupChange: unparseable JSON clears + re-bootstraps instead of throwing', async () => {
    const { ctx, dbClear, poolClear, forceFullRebootstrap } = makeGroupCtx();

    await expect(
      handleSyncGroupChange(ctx, makeDelta('G', '{{{')),
    ).resolves.toBeUndefined();

    expect(dbClear).toHaveBeenCalledTimes(1);
    expect(poolClear).toHaveBeenCalledTimes(1);
    expect(forceFullRebootstrap).toHaveBeenCalledTimes(1);
  });

  it('handleGroupRemoved: a well-formed payload keeps the targeted path (no full clear regression)', async () => {
    const { ctx, dbClear, poolClear, forceFullRebootstrap } = makeGroupCtx();

    await handleGroupRemoved(ctx, makeDelta('S', JSON.stringify({ group: 'team:1' })));

    // 'S' still performs its security clear + re-bootstrap by design.
    expect(dbClear).toHaveBeenCalledTimes(1);
    expect(poolClear).toHaveBeenCalledTimes(1);
    expect(forceFullRebootstrap).toHaveBeenCalledTimes(1);
    expect(ctx.database.updateWorkspaceMetadata).toHaveBeenCalledWith({
      subscribedSyncGroups: [],
    });
  });
});
