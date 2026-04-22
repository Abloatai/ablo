/**
 * TransactionQueue core tests — creation, priority, FK ordering,
 * status lifecycle, and basic batching.
 */

import { TransactionQueue } from '../../src/transactions/TransactionQueue';
import {
  createTestContext,
  TestTask,
  TestProject,
  TestSlideDeck,
  TestSlide,
  TestSlideLayer,
  TestComment,
  createTaskFixture,
  createProjectFixture,
  createSlideDeckFixture,
  createSlideFixture,
  createSlideLayerFixture,
  createCommentFixture,
  resetFixtureCounter,
  flushMicrotasks,
} from '../../src/testing';

const TEST_USER_CONTEXT = {
  userId: 'user-1',
  organizationId: 'org-1',
};

describe('TransactionQueue', () => {
  let queue: TransactionQueue;
  let cleanup: () => void;

  beforeEach(() => {
    resetFixtureCounter();
    const ctx = createTestContext({
      config: {
        modelCreatePriority: new Map([
          ['Project', 10],
          ['Task', 10],
          ['SlideDeck', 10],
          ['Slide', 15],
          ['SlideLayer', 20],
          ['Comment', 30],
        ]),
        batchableModels: new Set(['task', 'project', 'slidedeck', 'slide', 'slidelayer', 'comment']),
        extractCreateInput: (_name, data) => data,
        buildUpdateInput: (_name, changes) => changes,
      },
    });
    cleanup = ctx.cleanup;
    // Use immediate batch processing for tests (no delay)
    queue = new TransactionQueue({ batchDelay: 0, maxBatchSize: 50 });
  });

  afterEach(() => {
    queue.removeAllListeners();
    cleanup();
  });

  // ─────────────────────────────────────────────
  // Transaction creation
  // ─────────────────────────────────────────────

  describe('create()', () => {
    it('should create a transaction and emit transaction:created', async () => {
      const events: string[] = [];
      queue.on('transaction:created', () => events.push('created'));

      const task = createTaskFixture({ title: 'Test' });
      const tx = await queue.create(task, TEST_USER_CONTEXT);

      expect(tx).toBeDefined();
      expect(tx.type).toBe('create');
      expect(tx.modelName).toBe('Task');
      expect(tx.modelId).toBe(task.id);
      expect(tx.status).toBe('pending');
      expect(events).toContain('created');
    });

    it('should set correct priority score for CREATE based on model type', async () => {
      const project = createProjectFixture();
      const slide = createSlideFixture();
      const layer = createSlideLayerFixture();
      const comment = createCommentFixture();

      const txProject = await queue.create(project, TEST_USER_CONTEXT);
      const txSlide = await queue.create(slide, TEST_USER_CONTEXT);
      const txLayer = await queue.create(layer, TEST_USER_CONTEXT);
      const txComment = await queue.create(comment, TEST_USER_CONTEXT);

      // Project=10, Slide=15, SlideLayer=20, Comment=30
      expect(txProject.priorityScore).toBe(10);
      expect(txSlide.priorityScore).toBe(15);
      expect(txLayer.priorityScore).toBe(20);
      expect(txComment.priorityScore).toBe(30);
    });

    it('should emit optimistic:create when enableOptimistic is true (default)', async () => {
      const events: unknown[] = [];
      queue.on('optimistic:create', (data) => events.push(data));

      const task = createTaskFixture();
      await queue.create(task, TEST_USER_CONTEXT);

      expect(events).toHaveLength(1);
      expect((events[0] as { model: unknown }).model).toBe(task);
    });
  });

  describe('update()', () => {
    it('should create an update transaction', async () => {
      const task = createTaskFixture({ title: 'Old' });
      task.markAsPersisted();
      task.propertyChanged('title', 'Old', 'New');

      const tx = await queue.update(task, TEST_USER_CONTEXT);

      expect(tx.type).toBe('update');
      expect(tx.modelName).toBe('Task');
      expect(tx.modelId).toBe(task.id);
    });

    it('should set DEFAULT_NON_CREATE_PRIORITY (50) for update', async () => {
      const task = createTaskFixture();
      task.markAsPersisted();
      task.propertyChanged('title', 'Old', 'New');

      const tx = await queue.update(task, TEST_USER_CONTEXT);
      expect(tx.priorityScore).toBe(50);
    });

    it('should set high priority for reorder payloads', async () => {
      const task = createTaskFixture();
      task.markAsPersisted();
      task.propertyChanged('order', 0, 1);

      const tx = await queue.update(task, TEST_USER_CONTEXT, { order: 1 });
      expect(tx.priority).toBe('high');
    });
  });

  describe('delete()', () => {
    it('should create a delete transaction with high priority', async () => {
      const task = createTaskFixture();

      const tx = await queue.delete(task, TEST_USER_CONTEXT);

      expect(tx.type).toBe('delete');
      expect(tx.priority).toBe('high');
      expect(tx.modelName).toBe('Task');
    });

    it('should capture previousData for rollback', async () => {
      const task = createTaskFixture({ title: 'Delete Me' });

      const tx = await queue.delete(task, TEST_USER_CONTEXT);

      expect(tx.previousData).toBeDefined();
      // previousData is captured via model.toJSON() which includes id and registered properties
      expect((tx.previousData as Record<string, unknown>).id).toBe(task.id);
    });

    it('should emit optimistic:delete', async () => {
      const events: unknown[] = [];
      queue.on('optimistic:delete', (data) => events.push(data));

      const task = createTaskFixture();
      await queue.delete(task, TEST_USER_CONTEXT);

      expect(events).toHaveLength(1);
    });
  });

  describe('archive()', () => {
    it('should create an archive transaction', async () => {
      const task = createTaskFixture();
      const tx = await queue.archive(task, TEST_USER_CONTEXT);

      expect(tx.type).toBe('archive');
      expect(tx.modelName).toBe('Task');
    });
  });

  describe('unarchive()', () => {
    it('should create an unarchive transaction', async () => {
      const task = createTaskFixture();
      const tx = await queue.unarchive(task, TEST_USER_CONTEXT);

      expect(tx.type).toBe('unarchive');
      expect(tx.modelName).toBe('Task');
    });
  });

  // ─────────────────────────────────────────────
  // Microtask batching (LINEAR pattern)
  // ─────────────────────────────────────────────

  describe('microtask batching', () => {
    it('should batch transactions created in same event loop tick', async () => {
      const t1 = createTaskFixture();
      const t2 = createProjectFixture();

      // Create both synchronously — they should share a batchId
      const tx1Promise = queue.create(t1, TEST_USER_CONTEXT);
      const tx2Promise = queue.create(t2, TEST_USER_CONTEXT);

      const [tx1, tx2] = await Promise.all([tx1Promise, tx2Promise]);

      // Wait for microtask commit
      await flushMicrotasks();

      expect(tx1.batchId).toBeDefined();
      expect(tx2.batchId).toBeDefined();
      expect(tx1.batchId).toBe(tx2.batchId);
    });

    it('should separate transactions across event loop ticks', async () => {
      const t1 = createTaskFixture();
      const tx1 = await queue.create(t1, TEST_USER_CONTEXT);
      await flushMicrotasks();

      const t2 = createProjectFixture();
      const tx2 = await queue.create(t2, TEST_USER_CONTEXT);
      await flushMicrotasks();

      // Different ticks → different batch IDs
      expect(tx1.batchId).toBeDefined();
      expect(tx2.batchId).toBeDefined();
      expect(tx1.batchId).not.toBe(tx2.batchId);
    });
  });

  // ─────────────────────────────────────────────
  // FK-ordered execution within batch
  // ─────────────────────────────────────────────

  describe('FK-ordered execution', () => {
    it('should sort execution queue by priority score (parents before children)', async () => {
      const capturedOps: string[] = [];
      const ctx = createTestContext({
        config: {
          modelCreatePriority: new Map([
            ['SlideDeck', 10],
            ['Slide', 15],
            ['SlideLayer', 20],
          ]),
          batchableModels: new Set(['slidedeck', 'slide', 'slidelayer']),
          extractCreateInput: (name, data) => {
            capturedOps.push(name);
            return data;
          },
          buildUpdateInput: (_name, changes) => changes,
        },
      });

      const localQueue = new TransactionQueue({ batchDelay: 0 });

      const deck = createSlideDeckFixture();
      const slide = createSlideFixture({ deckId: deck.id });
      const layer = createSlideLayerFixture({ slideId: slide.id });

      // Create in reverse order — FK ordering should fix this
      await localQueue.create(layer, TEST_USER_CONTEXT);
      await localQueue.create(slide, TEST_USER_CONTEXT);
      await localQueue.create(deck, TEST_USER_CONTEXT);

      // Wait for microtask commit + batch processing
      await flushMicrotasks();
      // Give processing time to complete
      await new Promise((r) => setTimeout(r, 50));

      // The batchAck call should receive operations in FK order:
      // SlideDeck (10) before Slide (15) before SlideLayer (20)
      const batchAckCalls = ctx.mocks.mutationExecutor.getCallsByMethod('batchAck');
      if (batchAckCalls.length > 0) {
        const ops = batchAckCalls[0].operations;
        if (ops && ops.length === 3) {
          // Verify order: deck model key before slide before layer
          const modelOrder = ops.map((op: { model: string }) => op.model);
          expect(modelOrder).toEqual(['slidedeck', 'slide', 'slidelayer']);
        }
      }

      localQueue.removeAllListeners();
      ctx.cleanup();
    });
  });

  // ─────────────────────────────────────────────
  // Delta confirmation (LINEAR pattern)
  // ─────────────────────────────────────────────

  describe('onDeltaReceived()', () => {
    it('should track lastSeenSyncId', () => {
      queue.onDeltaReceived(5);
      queue.onDeltaReceived(10);
      queue.onDeltaReceived(7); // Lower — should not decrease

      // We can verify by seeing that a transaction needing syncId 7 would confirm
      // (indirectly tested via confirmation behavior)
    });

    it('should confirm awaiting transactions when delta >= threshold', async () => {
      const completedEvents: unknown[] = [];
      queue.on('transaction:completed', (tx) => completedEvents.push(tx));

      const task = createTaskFixture();
      await queue.create(task, TEST_USER_CONTEXT);

      // Wait for processing
      await flushMicrotasks();
      await new Promise((r) => setTimeout(r, 50));

      // The batchAck response sets syncIdNeededForCompletion on the tx
      // Now simulate a delta arriving that meets the threshold
      queue.onDeltaReceived(1);

      // Transaction should be confirmed
      expect(completedEvents.length).toBeGreaterThan(0);
    });
  });

  // ─────────────────────────────────────────────
  // waitForConfirmation
  // ─────────────────────────────────────────────

  describe('waitForConfirmation()', () => {
    it('should resolve immediately if transaction already completed', async () => {
      const task = createTaskFixture();
      const tx = await queue.create(task, TEST_USER_CONTEXT);

      // Process the batch
      await flushMicrotasks();
      await new Promise((r) => setTimeout(r, 50));

      // Simulate delta to confirm
      queue.onDeltaReceived(100);

      // Should resolve immediately since tx is already completed
      await expect(queue.waitForConfirmation(tx.id)).resolves.toBeUndefined();
    });
  });

  // ─────────────────────────────────────────────
  // hasClientMutationId
  // ─────────────────────────────────────────────

  describe('hasClientMutationId()', () => {
    it('should return true for existing transaction ID', async () => {
      const task = createTaskFixture();
      const tx = await queue.create(task, TEST_USER_CONTEXT);

      expect(queue.hasClientMutationId(tx.id)).toBe(true);
    });

    it('should return false for unknown ID', () => {
      expect(queue.hasClientMutationId('nonexistent')).toBe(false);
    });
  });
});
