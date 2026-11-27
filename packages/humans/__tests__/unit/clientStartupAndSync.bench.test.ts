/** @jest-environment node */

/**
 * Client wire-delta parsing, startup/bootstrap materialization, and 20k catch-up
 * apply benchmark (ABL-1653).
 *
 * Exercises the real production classes:
 *  - SyncWebSocket wire-delta parsing (20,000 server-shaped deltas)
 *  - parseBootstrapResponse (1k / 10k full snapshots, 20k partial deltas)
 *  - Database.bootstrapFromServer + SyncClient.applyBootstrapDataToPool (1k / 10k rows, IDB & in-memory)
 *  - SyncClient.hydrateFromDatabase (1k / 10k rows from IDB)
 *  - 20,000-delta catch-up apply via deltaPipeline + Database.processDeltaBatch + SyncClient.applyDeltaBatchToPool
 */

import { performance } from 'node:perf_hooks';
import { afterEach, describe, expect, it } from '@jest/globals';
import { LoadStrategy, PropertyType } from '@abloatai/transaction/types';
import { ModelRegistry, setActiveRegistry, clearActiveRegistry } from '../../src/local/ModelRegistry.js';
import { DEFER_MODEL_OBSERVABILITY, Model } from '../../src/local/Model.js';
import { InstanceCache } from '../../src/local/InstanceCache.js';
import { Database } from '../../src/local/Database.js';
import { SyncClient } from '../../src/local/SyncClient.js';
import { BootstrapFetcher, type BootstrapData } from '../../src/local/sync/BootstrapFetcher.js';
import { type SyncDelta } from '../../src/local/sync/SyncWebSocket.js';
import { parseWireDeltaOrNull } from '../../src/local/sync/parseWireDelta.js';
import { parseBootstrapResponse } from '../../src/local/sync/schemas.js';
import {
  deduplicateDeltas,
  flushPendingDeltas,
  persistDeltaFrame,
  type DeltaPipelineContext,
} from '../../src/local/sync/deltaPipeline.js';
import { initRuntime, resetRuntime } from '../../src/local/context.js';
import {
  noopLogger,
  browserOnlineStatus,
  defaultSessionErrorDetector,
  emptyConfig,
} from '../../src/local/RuntimeContext.js';
import { ClaimLog } from '../../src/local/coordination/ClaimLog.js';

const ISSUE_FIELDS = [
  'title',
  'description',
  'status',
  'priority',
  'teamId',
  'projectId',
  'assigneeId',
  'organizationId',
  'createdBy',
  'sortOrder',
] as const;

const COMMENT_FIELDS = [
  'body',
  'issueId',
  'authorId',
  'organizationId',
] as const;

const LABEL_FIELDS = [
  'name',
  'color',
  'teamId',
  'organizationId',
] as const;

function makeDynamicBenchModel(modelName: string, fields: readonly string[]) {
  return class extends Model {
    private readonly _modelName = modelName;

    constructor(data?: Record<string, unknown>) {
      super(data);
      const defer = Reflect.get(data ?? {}, DEFER_MODEL_OBSERVABILITY) === true;
      (this as { _isConstructing?: boolean })._isConstructing = true;
      for (const field of fields) {
        if (!(field in this)) {
          (this as Record<string, unknown>)[field] = data?.[field] ?? undefined;
        }
      }
      if (defer) this.deferObservability();
      else this.makeObservable();
      (this as { _isConstructing?: boolean })._isConstructing = false;
    }

    override getModelName(): string {
      return this._modelName;
    }
  };
}

const BenchIssue = makeDynamicBenchModel('Issue', ISSUE_FIELDS);
const BenchComment = makeDynamicBenchModel('Comment', COMMENT_FIELDS);
const BenchLabel = makeDynamicBenchModel('Label', LABEL_FIELDS);

function installBenchRuntime(): void {
  initRuntime({
    logger: noopLogger,
    observability: new ClaimLog(),
    onlineStatus: browserOnlineStatus,
    sessionErrorDetector: defaultSessionErrorDetector,
    config: emptyConfig,
    getModelMetadata: () => undefined,
    mutationExecutor: {
      commit: () =>
        Promise.resolve({
          lastSyncId: 0,
          status: 'confirmed' as const,
          statusAt: '2026-08-05T10:00:00.000Z',
        }),
      executeCreate: () => Promise.resolve(),
      executeUpdate: () => Promise.resolve(null),
      executeDelete: () => Promise.resolve(),
      executeArchive: () => Promise.resolve(),
      executeUnarchive: () => Promise.resolve(),
    },
  });
}

function createBenchRegistry(): ModelRegistry {
  const registry = new ModelRegistry({
    validateOnRegister: false,
    allowLateReferences: true,
  });
  registry.registerModel('Issue', BenchIssue, { loadStrategy: LoadStrategy.instant });
  for (const field of ISSUE_FIELDS) {
    registry.registerProperty('Issue', field, {
      type: PropertyType.property,
      optional: true,
      indexed: field === 'teamId' || field === 'status',
    });
  }
  registry.registerModel('Comment', BenchComment, { loadStrategy: LoadStrategy.instant });
  for (const field of COMMENT_FIELDS) {
    registry.registerProperty('Comment', field, {
      type: PropertyType.property,
      optional: true,
      indexed: field === 'issueId',
    });
  }
  registry.registerModel('Label', BenchLabel, { loadStrategy: LoadStrategy.instant });
  for (const field of LABEL_FIELDS) {
    registry.registerProperty('Label', field, {
      type: PropertyType.property,
      optional: true,
      indexed: field === 'teamId',
    });
  }
  setActiveRegistry(registry);
  return registry;
}

function buildSnapshot(totalRows: number): BootstrapData {
  const labelCount = Math.max(10, Math.floor(totalRows * 0.05));
  const commentCount = Math.floor(totalRows * 0.35);
  const issueCount = totalRows - labelCount - commentCount;
  const createdAt = '2026-11-26T10:00:00.000Z';

  const issues = new Array<Record<string, unknown>>(issueCount);
  for (let i = 0; i < issueCount; i++) {
    issues[i] = {
      id: `issue-${i}`,
      title: `Issue #${i}: sync engine startup latency benchmark`,
      description: `Detailed description payload for issue ${i} in team-${i % 10}`,
      status: i % 3 === 0 ? 'done' : i % 3 === 1 ? 'in_progress' : 'todo',
      priority: i % 4,
      teamId: `team-${i % 10}`,
      projectId: `proj-${i % 5}`,
      assigneeId: `user-${i % 20}`,
      organizationId: 'org-bench',
      createdBy: `user-${i % 20}`,
      sortOrder: i * 10,
      createdAt,
      updatedAt: createdAt,
    };
  }

  const comments = new Array<Record<string, unknown>>(commentCount);
  for (let i = 0; i < commentCount; i++) {
    comments[i] = {
      id: `comment-${i}`,
      body: `Comment body #${i} discussing benchmark progress`,
      issueId: `issue-${i % issueCount}`,
      authorId: `user-${i % 20}`,
      organizationId: 'org-bench',
      createdAt,
      updatedAt: createdAt,
    };
  }

  const labels = new Array<Record<string, unknown>>(labelCount);
  for (let i = 0; i < labelCount; i++) {
    labels[i] = {
      id: `label-${i}`,
      name: `label-${i}`,
      color: '#ff6600',
      teamId: `team-${i % 10}`,
      organizationId: 'org-bench',
      createdAt,
      updatedAt: createdAt,
    };
  }

  return {
    type: 'full',
    lastSyncId: totalRows,
    models: {
      Issue: issues,
      Comment: comments,
      Label: labels,
    },
    timestamp: 1764151200000,
  };
}

function buildServerWireDeltas(count: number, startId = 1): Record<string, unknown>[] {
  const createdAt = '2026-11-26T10:00:00.000Z';
  const out = new Array<Record<string, unknown>>(count);
  for (let i = 0; i < count; i++) {
    const id = startId + i;
    const isUpdate = i >= count / 2;
    const entityIndex = isUpdate ? i - count / 2 : i;
    out[i] = {
      id,
      actionType: isUpdate ? 'U' : 'I',
      modelName: 'Issue',
      modelId: `issue-${entityIndex}`,
      data: isUpdate
        ? {
            id: `issue-${entityIndex}`,
            status: 'done',
            priority: (i + 1) % 4,
            updatedAt: createdAt,
          }
        : {
            id: `issue-${entityIndex}`,
            title: `Issue #${entityIndex}`,
            description: `Description for issue ${entityIndex}`,
            status: 'todo',
            priority: i % 4,
            teamId: `team-${entityIndex % 10}`,
            projectId: `proj-${entityIndex % 5}`,
            assigneeId: `user-${entityIndex % 20}`,
            organizationId: 'org-bench',
            createdBy: `user-${entityIndex % 20}`,
            sortOrder: entityIndex * 10,
            createdAt,
            updatedAt: createdAt,
          },
      previousData: null,
      syncGroups: ['org:org-bench', `team:team-${entityIndex % 10}`],
      transactionId: null,
      projectId: 'proj-default',
      createdBy: { kind: 'user', id: `user-${entityIndex % 20}` },
      actor: { kind: 'user', id: `user-${entityIndex % 20}` },
      onBehalfOf: null,
      capabilityId: null,
      confirmationState: 'auto',
      createdAt,
    };
  }
  return out;
}

const identityEnrich = (_name: string, data: Record<string, unknown>) => data;

let dbCounter = 0;
function uniqueIdentity() {
  dbCounter += 1;
  return {
    organizationId: `org-bench-${dbCounter}`,
    participantId: `user-bench-${dbCounter}`,
    participantKind: 'user',
    projectId: null,
    branchId: 'main',
    branchRoot: true,
    syncGroups: ['org:org-bench'],
    operations: [],
  };
}

describe('ABL-1653 client wire-parse, bootstrap & 20k catch-up benchmark', () => {
  afterEach(() => {
    clearActiveRegistry();
    resetRuntime();
  });

  it('benchmarks wire delta parsing (20,000 deltas)', () => {
    installBenchRuntime();
    const rawDeltas = buildServerWireDeltas(20_000);
    // Warmup
    for (let i = 0; i < 1_000; i++) parseWireDeltaOrNull(rawDeltas[i]);

    const t0 = performance.now();
    let accepted = 0;
    for (const raw of rawDeltas) {
      if (parseWireDeltaOrNull(raw) !== null) accepted++;
    }
    const wallMs = performance.now() - t0;
    expect(accepted).toBe(20_000);

    const rowsPerSec = Math.round((20_000 / wallMs) * 1000);
    console.log(
      `[BENCH] wire-parse 20,000 deltas: ${wallMs.toFixed(2)} ms (${((wallMs * 1000) / 20_000).toFixed(2)} µs/delta, ${rowsPerSec.toLocaleString()} deltas/s)`,
    );
  }, 60_000);

  it('benchmarks parseBootstrapResponse (1k & 10k full, 20k partial)', () => {
    installBenchRuntime();
    const snap1k = buildSnapshot(1_000);
    const snap10k = buildSnapshot(10_000);
    const partial20k = {
      type: 'partial',
      lastSyncId: 20_000,
      deltas: buildServerWireDeltas(20_000),
      deltaCount: 20_000,
      timestamp: 1764151200000,
    };

    // Warmup
    parseBootstrapResponse(snap1k);

    const t1 = performance.now();
    const p1 = parseBootstrapResponse(snap1k);
    const ms1k = performance.now() - t1;

    const t2 = performance.now();
    const p10 = parseBootstrapResponse(snap10k);
    const ms10k = performance.now() - t2;

    const t3 = performance.now();
    const p20 = parseBootstrapResponse(partial20k);
    const ms20k = performance.now() - t3;

    expect(p1.type).toBe('full');
    expect(p10.type).toBe('full');
    expect(p20.deltas?.length).toBe(20_000);

    console.log(
      `[BENCH] parseBootstrapResponse: 1k=${ms1k.toFixed(2)} ms | 10k=${ms10k.toFixed(2)} ms | 20k-partial=${ms20k.toFixed(2)} ms`,
    );
  }, 60_000);

  it('benchmarks 1,000-row & 10,000-row initial bootstrap materialization (IDB + Pool + Hydrate)', async () => {
    for (const size of [1_000, 10_000] as const) {
      installBenchRuntime();
      const registry = createBenchRegistry();
      const snapshot = buildSnapshot(size);

      // Stub BootstrapFetcher.fetchBootstrap to return snapshot directly (isolating client cost)
      const fetcher = new BootstrapFetcher({ baseUrl: 'http://bench.local/api' });
      fetcher.fetchBootstrap = () => Promise.resolve(snapshot);

      const db = new Database(registry, fetcher, { inMemory: false });
      await db.open(uniqueIdentity());
      const pool = new InstanceCache({ maxSize: size + 1_000, gcInterval: 0, useWeakRefs: true }, registry);
      pool.registerForeignKey('Issue', 'teamId');
      pool.registerForeignKey('Comment', 'issueId');
      const client = new SyncClient(pool, db);

      // 1. Database.bootstrapFromServer (IDB write)
      const tDbStart = performance.now();
      const bootResult = await db.bootstrapFromServer(
        { type: 'full', modelsToLoad: ['Issue', 'Comment', 'Label'], lastSyncId: 0, syncGroups: ['org:org-bench'] },
        ['org:org-bench'],
      );
      const dbMs = performance.now() - tDbStart;
      expect(bootResult.modelsStored).toBe(size);

      // 2. SyncClient.applyBootstrapDataToPool (cold pool materialization)
      const tPoolStart = performance.now();
      const poolStats = client.applyBootstrapDataToPool(bootResult.bootstrapData);
      const poolMs = performance.now() - tPoolStart;
      expect(poolStats.added).toBe(size);
      expect(pool.size).toBe(size);

      // 3. SyncClient.applyBootstrapDataToPool (warm re-bootstrap over existing pool)
      const tWarmStart = performance.now();
      const warmStats = client.applyBootstrapDataToPool(bootResult.bootstrapData);
      const warmMs = performance.now() - tWarmStart;
      expect(warmStats.added).toBe(0);
      expect(warmStats.updated).toBe(size);

      // 4. SyncClient.hydrateFromDatabase (cold restart from IDB into fresh pool)
      const pool2 = new InstanceCache({ maxSize: size + 1_000, gcInterval: 0, useWeakRefs: true }, registry);
      pool2.registerForeignKey('Issue', 'teamId');
      pool2.registerForeignKey('Comment', 'issueId');
      const client2 = new SyncClient(pool2, db);
      const tHydrateStart = performance.now();
      await client2.hydrateFromDatabase();
      const hydrateMs = performance.now() - tHydrateStart;
      expect(pool2.size).toBe(size);

      const totalColdMs = dbMs + poolMs;
      console.log(
        `[BENCH] bootstrap ${size.toLocaleString()} rows: dbWrite=${dbMs.toFixed(1)} ms | poolCold=${poolMs.toFixed(1)} ms | totalCold=${totalColdMs.toFixed(1)} ms (${Math.round((size / totalColdMs) * 1000).toLocaleString()} rows/s) | poolWarm=${warmMs.toFixed(1)} ms | idbHydrate=${hydrateMs.toFixed(1)} ms`,
      );

      client.dispose();
      client2.dispose();
      pool.stopGC();
      pool2.stopGC();
      pool.clear();
      pool2.clear();
      await db.close();
      clearActiveRegistry();
      resetRuntime();
    }
  }, 120_000);

  it('benchmarks 20,000-delta catch-up apply (inMemory and fake-indexeddb)', async () => {
    for (const inMemory of [true, false] as const) {
      installBenchRuntime();
      const registry = createBenchRegistry();
      const fetcher = new BootstrapFetcher({ baseUrl: 'http://bench.local/api' });
      const db = new Database(registry, fetcher, { inMemory });
      await db.open(uniqueIdentity());
      const pool = new InstanceCache({ maxSize: 12_000, gcInterval: 0, useWeakRefs: true }, registry);
      pool.registerForeignKey('Issue', 'teamId');
      const client = new SyncClient(pool, db);

      const rawDeltas = buildServerWireDeltas(20_000);

      let highestProcessedSyncId = 0;
      let lastAckedId = 0;
      let persistMs = 0;
      let poolApplyMs = 0;

      const ctx: DeltaPipelineContext = {
        pendingDeltas: [],
        batchTimer: null,
        bootstrapDeltaQueue: null,
        smartSyncOptions: {
          batchingDelay: 16,
          maxBatchSize: 500,
          applySliceDeltas: 600,
        },
        get highestProcessedSyncId() {
          return highestProcessedSyncId;
        },
        get lastAckedId() {
          return lastAckedId;
        },
        onDeltaReceived: (syncId, txId, corrId) => {
          client.onDeltaReceived(syncId, txId, corrId);
        },
        advanceApplied: (syncId) => {
          if (syncId > highestProcessedSyncId) highestProcessedSyncId = syncId;
        },
        advancePersisted: (syncId) => {
          if (syncId > lastAckedId) lastAckedId = syncId;
        },
        processDeltaBatch: async (deltas) => {
          const s = performance.now();
          const res = await db.processDeltaBatch(deltas);
          persistMs += performance.now() - s;
          return res;
        },
        applyDeltaBatchToPool: (results) => {
          const s = performance.now();
          client.applyDeltaBatchToPool(results, identityEnrich);
          poolApplyMs += performance.now() - s;
        },
        projectDeltaBatchForPool: (results) => client.projectDeltaBatchForPool(results),
        acknowledge: () => undefined,
        objectPool: pool,
        isCustomEntity: () => false,
        createCustomEntity: () => null,
        deduplicateDeltas,
        flushPendingDeltas: () => flushPendingDeltas(ctx),
        handleFlushError: (err) => {
          throw err instanceof Error ? err : new Error(String(err));
        },
        handleSyncGroupChange: () => Promise.resolve(),
        handleGroupRemoved: () => Promise.resolve(),
        forceFullRebootstrap: () => undefined,
        cascadeCancelTransactionsForDeletedParent: () => undefined,
      };

      // Deliver deltas in 128-delta chunks (matching server replay page size).
      // fake-indexeddb uses an O(N) array scan per low-cardinality index update;
      // use 2,000 deltas on fake-indexeddb and full 20,000 deltas on inMemory.
      const totalDeltas = inMemory ? 20_000 : 2_000;
      const runDeltas = inMemory ? rawDeltas : buildServerWireDeltas(totalDeltas);
      const CHUNK_SIZE = 128;
      const t0 = performance.now();
      let parseMs = 0;
      for (let offset = 0; offset < runDeltas.length; offset += CHUNK_SIZE) {
        const tParse = performance.now();
        const chunk: SyncDelta[] = [];
        const end = Math.min(offset + CHUNK_SIZE, runDeltas.length);
        for (let j = offset; j < end; j++) {
          const parsed = parseWireDeltaOrNull(runDeltas[j]);
          if (parsed) chunk.push(parsed);
        }
        parseMs += performance.now() - tParse;
        await persistDeltaFrame(ctx, chunk);
      }
      const totalMs = performance.now() - t0;

      expect(lastAckedId).toBe(totalDeltas);
      expect(pool.size).toBe(totalDeltas / 2);
      const witness = pool.get(`issue-${totalDeltas / 2 - 1}`);
      expect(witness?.getField('status')).toBe('done');

      const label = inMemory ? 'inMemory' : 'fake-indexeddb';
      console.log(
        `[BENCH] ${totalDeltas.toLocaleString()}-delta catch-up (${label}, 128-row chunks): total=${totalMs.toFixed(1)} ms (parse=${parseMs.toFixed(1)} ms, persist=${persistMs.toFixed(1)} ms, poolApply=${poolApplyMs.toFixed(1)} ms, ${Math.round((totalDeltas / totalMs) * 1000).toLocaleString()} deltas/s)`,
      );

      client.dispose();
      pool.stopGC();
      pool.clear();
      await db.close();
      clearActiveRegistry();
      resetRuntime();
    }
  }, 180_000);
});
