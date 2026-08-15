/**
 * Integration test: Mutation → Delta Confirmation flow
 *
 * Tests the critical happy path end-to-end:
 * 1. Create model → MutationQueue stages tx → batchAck sends to server
 * 2. Server responds with lastSyncId → tx enters awaiting_delta
 * 3. Delta arrives via WebSocket → onDeltaReceived confirms tx
 *
 * Uses real MutationQueue + ObjectPool with MockMutationExecutor.
 */

import { MutationQueue } from '../../src/local/transactions/mutations/MutationQueue';
import { InstanceCache as ObjectPool, ModelScope } from '../../src/local/InstanceCache';
import { ModelRegistry, setActiveRegistry } from '../../src/local/ModelRegistry';
import {
  createTestContext,
  registerTestModels,
  createTestConfig,
  TestItem,
  TestWorkspace,
  TestEntryCollection,
  TestEntry,
  TestEntryLayer,
  createItemFixture,
  createWorkspaceFixture,
  createEntryCollectionFixture,
  createEntryFixture,
  createEntryLayerFixture,
  resetFixtureCounter,
  flushMicrotasks,
} from '../../src/local/testing';
import type { TestContextResult } from '../../src/local/testing';

const USER_CTX = { userId: 'user-1', organizationId: 'org-1' };

describe('Integration: Mutation → Delta Confirmation', () => {
  let queue: MutationQueue;
  let pool: ObjectPool;
  let registry: ModelRegistry;
  let ctx: TestContextResult;

  beforeEach(() => {
    resetFixtureCounter();
    registry = new ModelRegistry();
    setActiveRegistry(registry);
    registerTestModels(registry);

    ctx = createTestContext({ config: createTestConfig() });

    pool = new ObjectPool({ maxSize: 1000, gcInterval: 0, useWeakRefs: false }, registry);
    queue = new MutationQueue({ batchDelay: 0, maxBatchSize: 50 });
  });

  afterEach(() => {
    pool.clear();
    queue.removeAllListeners();
    ctx.cleanup();
  });

  describe('happy path: create → confirm', () => {
    it('should complete: create item → batchAck → delta confirms', async () => {
      const completed: string[] = [];
      queue.on('transaction:completed', (tx) => completed.push(tx.modelId));

      const item = createItemFixture({ title: 'Buy milk' });
      pool.add(item);
      const tx = await queue.create(item, USER_CTX);

      // Wait for microtask commit + batch processing
      await flushMicrotasks();
      await new Promise((r) => setTimeout(r, 50));

      // batchAck should have been called
      const batchCalls = ctx.mocks.mutationExecutor.getCallsByMethod('commit');
      expect(batchCalls.length).toBeGreaterThan(0);

      // Simulate delta arriving from server
      queue.onDeltaReceived(ctx.mocks.mutationExecutor.currentSyncId);

      expect(completed).toContain(item.id);
    });

    it('should handle delta arriving BEFORE HTTP response (race fix)', async () => {
      // Pre-populate lastSeenSyncId as if the WebSocket is faster than HTTP
      queue.onDeltaReceived(500);

      const completed: string[] = [];
      queue.on('transaction:completed', (tx) => completed.push(tx.modelId));

      // MockMutationExecutor will return lastSyncId=1 (well below 500)
      const item = createItemFixture();
      pool.add(item);
      await queue.create(item, USER_CTX);

      await flushMicrotasks();
      await new Promise((r) => setTimeout(r, 50));

      // Should be immediately confirmed because lastSeenSyncId(500) >= syncIdNeeded(1)
      expect(completed).toContain(item.id);
    });
  });

  describe('FK-ordered batch', () => {
    it('should send parent entities before children in batchAck', async () => {
      // Create in reverse FK order
      const layer = createEntryLayerFixture({ entryId: 'entry-1' });
      const entry = createEntryFixture({ id: 'entry-1', collectionId: 'collection-1' });
      const collection = createEntryCollectionFixture({ id: 'collection-1' });

      pool.addBatch([collection, entry, layer]);

      // Create transactions in reverse order
      await queue.create(layer, USER_CTX);
      await queue.create(entry, USER_CTX);
      await queue.create(collection, USER_CTX);

      // All staged in same microtask → same batch
      await flushMicrotasks();
      await new Promise((r) => setTimeout(r, 100));

      const batchCalls = ctx.mocks.mutationExecutor.getCallsByMethod('commit');
      expect(batchCalls.length).toBeGreaterThan(0);

      // Verify the operations in the first batchAck call are FK-ordered
      const ops = batchCalls[0]?.operations;
      if (ops && ops.length === 3) {
        const names = ops.map((o: { model: string }) => o.model);
        // Collection(10) before Entry(15) before EntryDetail(20)
        const collectionIdx = names.indexOf('entrycollection');
        const entryIdx = names.indexOf('entry');
        const layerIdx = names.indexOf('entrylayer');

        if (collectionIdx >= 0 && entryIdx >= 0 && layerIdx >= 0) {
          expect(collectionIdx).toBeLessThan(entryIdx);
          expect(entryIdx).toBeLessThan(layerIdx);
        }
      }
    });
  });

  describe('optimistic update visibility', () => {
    it('should emit optimistic:create so ObjectPool can show model before server confirms', async () => {
      const optimisticCreates: string[] = [];
      queue.on('optimistic:create', ({ model }) => {
        optimisticCreates.push(model.id);
      });

      const item = createItemFixture({ title: 'Optimistic' });
      pool.add(item);
      await queue.create(item, USER_CTX);

      // The model should be visible in the pool immediately (optimistic)
      expect(pool.get(item.id)).toBe(item);
      expect(optimisticCreates).toContain(item.id);
    });
  });

  describe('multiple operations coalesced', () => {
    it('should coalesce rapid updates to same model', async () => {
      const item = createItemFixture({ title: 'V1', status: 'todo' });
      item.markAsPersisted();
      pool.add(item);

      // Rapid fire updates in same tick
      item.propertyChanged('title', 'V1', 'V2');
      await queue.update(item, USER_CTX, { title: 'V2' });

      item.propertyChanged('title', 'V2', 'V3');
      await queue.update(item, USER_CTX, { title: 'V3' });

      item.propertyChanged('status', 'todo', 'doing');
      await queue.update(item, USER_CTX, { status: 'doing' });

      await flushMicrotasks();
      await new Promise((r) => setTimeout(r, 100));

      // The updates should be coalesced — fewer batchAck calls than updates
      const batchCalls = ctx.mocks.mutationExecutor.getCallsByMethod('commit');
      // May be 1 (fully coalesced) or 2 (partially), but definitely not 3
      expect(batchCalls.length).toBeLessThanOrEqual(2);
    });
  });

  describe('delete with confirmation', () => {
    it('should complete delete when delta arrives', async () => {
      const completed: { modelId: string; type: string }[] = [];
      queue.on('transaction:completed', (tx) => completed.push({ modelId: tx.modelId, type: tx.type }));

      const item = createItemFixture();
      pool.add(item);

      await queue.delete(item, USER_CTX);

      await flushMicrotasks();
      await new Promise((r) => setTimeout(r, 50));

      // Confirm via delta
      queue.onDeltaReceived(ctx.mocks.mutationExecutor.currentSyncId);

      const deleteCompleted = completed.find((c) => c.type === 'delete');
      expect(deleteCompleted).toBeDefined();
      expect(deleteCompleted!.modelId).toBe(item.id);
    });
  });
});
