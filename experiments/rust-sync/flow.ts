import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { deduplicateDeltas, enqueueDelta, flushPendingDeltas, persistDeltaFrame } from '../../packages/humans/src/local/sync/deltaPipeline.js';
import { resetDrainProfile, drainProfileSnapshot } from '../../packages/humans/src/local/sync/drainProfile.js';
import { SyncWebSocket } from '../../packages/humans/src/local/sync/SyncWebSocket.js';
import { ModelRegistry, setActiveRegistry, clearActiveRegistry } from '../../packages/humans/src/local/ModelRegistry.js';
import { Model, DEFER_MODEL_OBSERVABILITY } from '../../packages/humans/src/local/Model.js';
import { InstanceCache } from '../../packages/humans/src/local/InstanceCache.js';
import { Database } from '../../packages/humans/src/local/Database.js';
import { SyncClient } from '../../packages/humans/src/local/SyncClient.js';
import { BootstrapFetcher } from '../../packages/humans/src/local/sync/BootstrapFetcher.js';
import { LoadStrategy, PropertyType } from '@abloatai/transaction/types';
import { createTestContext } from '../../packages/humans/src/local/testing/mocks/MockSyncContext.js';

export { deduplicateDeltas };
const fields = ['title', 'status', 'organizationId', 'createdBy'];
class Item extends Model {
  constructor(data: any) {
    super(data);
    Reflect.set(this, '_isConstructing', true);
    for (const field of fields) Reflect.set(this, field, data?.[field]);
    if (Reflect.get(data ?? {}, DEFER_MODEL_OBSERVABILITY)) this.deferObservability();
    Reflect.set(this, '_isConstructing', false);
  }
  override getModelName() { return 'Item'; }
}

// Ponytail: this measures the actual headless receive path, not server/WAL,
// real network, browser IDB, or React. Add those environments before extrapolating.
export async function fullFlow(serializedFrames: string[], rows: number, profile = false) {
  const registry = new ModelRegistry({ validateOnRegister: false, allowLateReferences: true });
  registry.registerModel('Item', Item, { loadStrategy: LoadStrategy.instant });
  for (const field of fields) registry.registerProperty('Item', field, { type: PropertyType.property, optional: true });
  setActiveRegistry(registry);
  const runtime = createTestContext();
  const db = new Database(registry, new BootstrapFetcher({ baseUrl: 'https://example.invalid' }), { inMemory: true });
  await db.open({ participantId: 'bench', participantKind: 'user', organizationId: 'org-bench', projectId: 'bench', branchId: 'bench', branchRoot: false });
  const pool = new InstanceCache({ maxSize: rows + 100, useWeakRefs: false }, registry);
  const client = new SyncClient(pool, db);
  let applied = 0, persisted = 0, ack = 0, notifications = 0;
  const enrich = (_name: string, data: any) => data;
  client.on('models:changed', () => notifications++);
  const ctx: any = {
    pendingDeltas: [], batchTimer: null, bootstrapDeltaQueue: null,
    smartSyncOptions: { batchingDelay: 10, maxBatchSize: 1300, applySliceDeltas: 600 },
    get highestProcessedSyncId() { return applied; }, get lastAckedId() { return persisted; },
    onDeltaReceived: (id: number, tx?: string, correlation?: string) => client.onDeltaReceived(id, tx, correlation),
    advanceApplied: (id: number) => { applied = Math.max(applied, id); },
    advancePersisted: (id: number) => { persisted = Math.max(persisted, id); },
    processDeltaBatch: (deltas: any[]) => db.processDeltaBatch(deltas),
    applyDeltaBatchToPool: (results: any[]) => client.applyDeltaBatchToPool(results, enrich),
    projectDeltaBatchForPool: (results: any[]) => client.projectDeltaBatchForPool(results),
    acknowledge: (id: number) => { assert.ok(id >= ack); ack = id; },
    objectPool: pool, isCustomEntity: () => false, createCustomEntity: () => null,
    deduplicateDeltas, flushPendingDeltas: () => flushPendingDeltas(ctx),
    handleFlushError: (error: unknown) => { throw error; },
    handleSyncGroupChange: async () => {}, handleGroupRemoved: async () => {},
    forceFullRebootstrap: () => {}, cascadeCancelTransactionsForDeletedParent: () => {},
  };
  // Call the actual transport normalization/validation leaf without opening a socket.
  const parser = Object.create(SyncWebSocket.prototype);
  try {
    const seed = Array.from({ length: rows }, (_, i) => ({ syncId: i + 1, actionType: 'I' as const, modelName: 'Item', modelId: `row-${i}`, data: { id: `row-${i}`, title: 'seed', status: 'todo', organizationId: 'org-bench', createdBy: 'user-bench' } }));
    client.applyDeltaBatchToPool((await db.processDeltaBatch(seed)).results, enrich);
    resetDrainProfile();
    notifications = 0;
    const start = performance.now();
    for (const wire of serializedFrames) {
      const frame = JSON.parse(wire).map((raw: unknown) => parser.normalizeWireDelta(raw));
      assert.ok(frame.every(Boolean));
      await persistDeltaFrame(ctx, frame);
    }
    const wallMs = performance.now() - start;
    const stages = drainProfileSnapshot();
    if (profile) assert.equal(stages.batches, serializedFrames.length);
    // Validate every final row, not merely the final cursor or one witness.
    const expected = new Map<string, any>();
    for (const wire of serializedFrames) for (const delta of deduplicateDeltas(JSON.parse(wire))) expected.set(delta.modelId, delta.data);
    for (const [id, data] of expected) {
      assert.equal(Reflect.get(pool.peek(id)!, 'title'), data.title);
      assert.equal((await db.getStore('Item')!.get(id))?.title, data.title);
    }
    const max = Math.max(...JSON.parse(serializedFrames.at(-1)!).map((d: any) => d.id));
    assert.equal(ack, max); assert.equal(persisted, max); assert.ok(notifications > 0);
    return { wallMs, stages, ack, notifications, rowsChecked: expected.size };
  } finally {
    client.dispose(); pool.stopGC(); pool.clear(); await db.close();
    runtime.cleanup(); clearActiveRegistry();
  }
}

// Failure and revocation behavior remain in JS, outside the index-only candidate.
export async function boundaryChecks() {
  const runtime = createTestContext();
  try {
    const parser = Object.create(SyncWebSocket.prototype);
    assert.equal(parser.normalizeWireDelta({ id: 1, actionType: 'INVALID' }), null);
    const error = new Error('persistence failed');
    const delta = { id: 1, actionType: 'U', modelName: 'Item', modelId: 'a', data: {}, syncGroups: [], createdAt: '' };
    let ack = 0, cleared = 0, reset = 0;
    const ctx: any = {
      pendingDeltas: [delta], batchTimer: null, bootstrapDeltaQueue: null,
      highestProcessedSyncId: 0, lastAckedId: 0, stagePlugins: [],
      smartSyncOptions: { applySliceDeltas: 600 }, deduplicateDeltas,
      isCustomEntity: () => false, processDeltaBatch: async () => { throw error; },
      acknowledge: () => ack++, onDeltaReceived: () => {}, advanceApplied: () => {},
      handleGroupRemoved: async () => { throw error; },
      objectPool: { clear: () => cleared++ }, forceFullRebootstrap: () => reset++,
    };
    await assert.rejects(flushPendingDeltas(ctx), e => e === error);
    assert.equal(ack, 0); assert.deepEqual(ctx.pendingDeltas, [delta]);
    assert.equal(enqueueDelta(ctx, { ...delta, actionType: 'S' }), false);
    await Promise.resolve(); await Promise.resolve();
    assert.equal(cleared, 1); assert.equal(reset, 1);
  } finally { runtime.cleanup(); clearActiveRegistry(); }
}
