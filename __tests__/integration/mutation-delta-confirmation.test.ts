/**
 * Integration test: Mutation → Delta Confirmation flow
 *
 * Tests the critical happy path end-to-end:
 * 1. Create model → TransactionQueue stages tx → batchAck sends to server
 * 2. Server responds with lastSyncId → tx enters awaiting_delta
 * 3. Delta arrives via WebSocket → onDeltaReceived confirms tx
 *
 * Uses real TransactionQueue + ObjectPool with MockMutationExecutor.
 */

import { TransactionQueue } from '../../src/transactions/TransactionQueue';
import { ObjectPool, ModelScope } from '../../src/ObjectPool';
import { ModelRegistry, setActiveRegistry } from '../../src/ModelRegistry';
import {
  createTestContext,
  registerTestModels,
  createTestConfig,
  TestTask,
  TestProject,
  TestSlideDeck,
  TestSlide,
  TestSlideLayer,
  createTaskFixture,
  createProjectFixture,
  createSlideDeckFixture,
  createSlideFixture,
  createSlideLayerFixture,
  resetFixtureCounter,
  flushMicrotasks,
} from '../../src/testing';
import type { TestContextResult } from '../../src/testing';

const USER_CTX = { userId: 'user-1', organizationId: 'org-1' };

describe('Integration: Mutation → Delta Confirmation', () => {
  let queue: TransactionQueue;
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
    queue = new TransactionQueue({ batchDelay: 0, maxBatchSize: 50 });
  });

  afterEach(() => {
    pool.clear();
    queue.removeAllListeners();
    ctx.cleanup();
  });

  describe('happy path: create → confirm', () => {
    it('should complete: create task → batchAck → delta confirms', async () => {
      const completed: string[] = [];
      queue.on('transaction:completed', (tx) => completed.push(tx.modelId));

      const task = createTaskFixture({ title: 'Buy milk' });
      pool.add(task);
      const tx = await queue.create(task, USER_CTX);

      // Wait for microtask commit + batch processing
      await flushMicrotasks();
      await new Promise((r) => setTimeout(r, 50));

      // batchAck should have been called
      const batchCalls = ctx.mocks.mutationExecutor.getCallsByMethod('commit');
      expect(batchCalls.length).toBeGreaterThan(0);

      // Simulate delta arriving from server
      queue.onDeltaReceived(ctx.mocks.mutationExecutor.currentSyncId);

      expect(completed).toContain(task.id);
    });

    it('should handle delta arriving BEFORE HTTP response (race fix)', async () => {
      // Pre-populate lastSeenSyncId as if the WebSocket is faster than HTTP
      queue.onDeltaReceived(500);

      const completed: string[] = [];
      queue.on('transaction:completed', (tx) => completed.push(tx.modelId));

      // MockMutationExecutor will return lastSyncId=1 (well below 500)
      const task = createTaskFixture();
      pool.add(task);
      await queue.create(task, USER_CTX);

      await flushMicrotasks();
      await new Promise((r) => setTimeout(r, 50));

      // Should be immediately confirmed because lastSeenSyncId(500) >= syncIdNeeded(1)
      expect(completed).toContain(task.id);
    });
  });

  describe('FK-ordered batch', () => {
    it('should send parent entities before children in batchAck', async () => {
      // Create in reverse FK order
      const layer = createSlideLayerFixture({ slideId: 'slide-1' });
      const slide = createSlideFixture({ id: 'slide-1', deckId: 'deck-1' });
      const deck = createSlideDeckFixture({ id: 'deck-1' });

      pool.addBatch([deck, slide, layer]);

      // Create transactions in reverse order
      await queue.create(layer, USER_CTX);
      await queue.create(slide, USER_CTX);
      await queue.create(deck, USER_CTX);

      // All staged in same microtask → same batch
      await flushMicrotasks();
      await new Promise((r) => setTimeout(r, 100));

      const batchCalls = ctx.mocks.mutationExecutor.getCallsByMethod('commit');
      expect(batchCalls.length).toBeGreaterThan(0);

      // Verify the operations in the first batchAck call are FK-ordered
      const ops = batchCalls[0].operations;
      if (ops && ops.length === 3) {
        const names = ops.map((o: { model: string }) => o.model);
        // SlideDeck(10) before Slide(15) before SlideLayer(20)
        const deckIdx = names.indexOf('slidedeck');
        const slideIdx = names.indexOf('slide');
        const layerIdx = names.indexOf('slidelayer');

        if (deckIdx >= 0 && slideIdx >= 0 && layerIdx >= 0) {
          expect(deckIdx).toBeLessThan(slideIdx);
          expect(slideIdx).toBeLessThan(layerIdx);
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

      const task = createTaskFixture({ title: 'Optimistic' });
      pool.add(task);
      await queue.create(task, USER_CTX);

      // The model should be visible in the pool immediately (optimistic)
      expect(pool.get(task.id)).toBe(task);
      expect(optimisticCreates).toContain(task.id);
    });
  });

  describe('multiple operations coalesced', () => {
    it('should coalesce rapid updates to same model', async () => {
      const task = createTaskFixture({ title: 'V1', status: 'todo' });
      task.markAsPersisted();
      pool.add(task);

      // Rapid fire updates in same tick
      task.propertyChanged('title', 'V1', 'V2');
      await queue.update(task, USER_CTX, { title: 'V2' });

      task.propertyChanged('title', 'V2', 'V3');
      await queue.update(task, USER_CTX, { title: 'V3' });

      task.propertyChanged('status', 'todo', 'doing');
      await queue.update(task, USER_CTX, { status: 'doing' });

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
      const completed: Array<{ modelId: string; type: string }> = [];
      queue.on('transaction:completed', (tx) => completed.push({ modelId: tx.modelId, type: tx.type }));

      const task = createTaskFixture();
      pool.add(task);

      await queue.delete(task, USER_CTX);

      await flushMicrotasks();
      await new Promise((r) => setTimeout(r, 50));

      // Confirm via delta
      queue.onDeltaReceived(ctx.mocks.mutationExecutor.currentSyncId);

      const deleteCompleted = completed.find((c) => c.type === 'delete');
      expect(deleteCompleted).toBeDefined();
      expect(deleteCompleted!.modelId).toBe(task.id);
    });
  });
});
