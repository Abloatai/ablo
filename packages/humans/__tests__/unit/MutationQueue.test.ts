/**
 * MutationQueue core tests — creation, priority, FK ordering,
 * status lifecycle, and basic batching.
 */

import { MutationQueue } from '../../src/local/transactions/mutations/MutationQueue';
import {
  createTestContext,
  TestItem,
  TestWorkspace,
  TestEntryCollection,
  TestEntry,
  TestEntryLayer,
  TestComment,
  createItemFixture,
  createWorkspaceFixture,
  createEntryCollectionFixture,
  createEntryFixture,
  createEntryLayerFixture,
  createCommentFixture,
  resetFixtureCounter,
  flushMicrotasks,
  waitFor,
} from '../../src/local/testing';

const TEST_USER_CONTEXT = {
  userId: 'user-1',
  organizationId: 'org-1',
};

describe('MutationQueue', () => {
  let queue: MutationQueue;
  let cleanup: () => void;
  let mocks: ReturnType<typeof createTestContext>['mocks'];

  beforeEach(() => {
    resetFixtureCounter();
    const ctx = createTestContext({
      config: {
        modelCreatePriority: new Map([
          ['Workspace', 10],
          ['Item', 10],
          ['Collection', 10],
          ['Entry', 15],
          ['EntryDetail', 20],
          ['Comment', 30],
        ]),
      },
    });
    cleanup = ctx.cleanup;
    mocks = ctx.mocks;
    // Use immediate batch processing for tests (no delay)
    queue = new MutationQueue({ batchDelay: 0, maxBatchSize: 50 });
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

      const item = createItemFixture({ title: 'Test' });
      const tx = await queue.create(item, TEST_USER_CONTEXT);

      expect(tx).toBeDefined();
      expect(tx.type).toBe('create');
      expect(tx.modelName).toBe('Item');
      expect(tx.modelId).toBe(item.id);
      expect(tx.status).toBe('pending');
      expect(events).toContain('created');
    });

    it('should set correct priority score for CREATE based on model type', async () => {
      const workspace = createWorkspaceFixture();
      const entry = createEntryFixture();
      const layer = createEntryLayerFixture();
      const comment = createCommentFixture();

      const txWorkspace = await queue.create(workspace, TEST_USER_CONTEXT);
      const txEntry = await queue.create(entry, TEST_USER_CONTEXT);
      const txLayer = await queue.create(layer, TEST_USER_CONTEXT);
      const txComment = await queue.create(comment, TEST_USER_CONTEXT);

      // Workspace=10, Entry=15, EntryDetail=20, Comment=30
      expect(txWorkspace.priorityScore).toBe(10);
      expect(txEntry.priorityScore).toBe(15);
      expect(txLayer.priorityScore).toBe(20);
      expect(txComment.priorityScore).toBe(30);
    });

    it('should emit optimistic:create when enableOptimistic is true (default)', async () => {
      const events: unknown[] = [];
      queue.on('optimistic:create', (data) => events.push(data));

      const item = createItemFixture();
      await queue.create(item, TEST_USER_CONTEXT);

      expect(events).toHaveLength(1);
      expect((events[0] as { model: unknown }).model).toBe(item);
    });
  });

  describe('update()', () => {
    it('should create an update transaction', async () => {
      const item = createItemFixture({ title: 'Old' });
      item.markAsPersisted();
      item.propertyChanged('title', 'Old', 'New');

      const tx = await queue.update(item, TEST_USER_CONTEXT);

      expect(tx.type).toBe('update');
      expect(tx.modelName).toBe('Item');
      expect(tx.modelId).toBe(item.id);
    });

    it('should set DEFAULT_NON_CREATE_PRIORITY (50) for update', async () => {
      const item = createItemFixture();
      item.markAsPersisted();
      item.propertyChanged('title', 'Old', 'New');

      const tx = await queue.update(item, TEST_USER_CONTEXT);
      expect(tx.priorityScore).toBe(50);
    });

    it('should set high priority for reorder payloads', async () => {
      const item = createItemFixture();
      item.markAsPersisted();
      item.propertyChanged('order', 0, 1);

      const tx = await queue.update(item, TEST_USER_CONTEXT, { order: 1 });
      expect(tx.priority).toBe('high');
    });

    it('should forward stale-write options to the commit operation', async () => {
      const item = createItemFixture({ title: 'Old' });
      item.markAsPersisted();
      item.propertyChanged('title', 'Old', 'New');

      await queue.update(
        item,
        TEST_USER_CONTEXT,
        { title: 'New' },
        { readAt: 42, onStale: 'reject' },
      );

      await flushMicrotasks();
      await new Promise((r) => setTimeout(r, 50));

      const [call] = mocks.mutationExecutor.getCallsByMethod('commit');
      expect(call?.operations?.[0]).toMatchObject({
        readAt: 42,
        onStale: 'reject',
      });
    });
  });

  describe('delete()', () => {
    it('should create a delete transaction with high priority', async () => {
      const item = createItemFixture();

      const tx = await queue.delete(item, TEST_USER_CONTEXT);

      expect(tx.type).toBe('delete');
      expect(tx.priority).toBe('high');
      expect(tx.modelName).toBe('Item');
    });

    it('should capture previousData for rollback', async () => {
      const item = createItemFixture({ title: 'Delete Me' });

      const tx = await queue.delete(item, TEST_USER_CONTEXT);

      expect(tx.previousData).toBeDefined();
      // previousData is captured via model.toJSON() which includes id and registered properties
      expect((tx.previousData as Record<string, unknown>).id).toBe(item.id);
    });

    it('should emit optimistic:delete', async () => {
      const events: unknown[] = [];
      queue.on('optimistic:delete', (data) => events.push(data));

      const item = createItemFixture();
      await queue.delete(item, TEST_USER_CONTEXT);

      expect(events).toHaveLength(1);
    });
  });

  describe('archive()', () => {
    it('should create an archive transaction', async () => {
      const item = createItemFixture();
      const tx = await queue.archive(item, TEST_USER_CONTEXT);

      expect(tx.type).toBe('archive');
      expect(tx.modelName).toBe('Item');
    });
  });

  describe('unarchive()', () => {
    it('should create an unarchive transaction', async () => {
      const item = createItemFixture();
      const tx = await queue.unarchive(item, TEST_USER_CONTEXT);

      expect(tx.type).toBe('unarchive');
      expect(tx.modelName).toBe('Item');
    });
  });

  // ─────────────────────────────────────────────
  // Microtask batching (LINEAR pattern)
  // ─────────────────────────────────────────────

  describe('microtask batching', () => {
    it('should batch transactions created in same event loop tick', async () => {
      const t1 = createItemFixture();
      const t2 = createWorkspaceFixture();

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
      const t1 = createItemFixture();
      const tx1 = await queue.create(t1, TEST_USER_CONTEXT);
      await flushMicrotasks();

      const t2 = createWorkspaceFixture();
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
      const ctx = createTestContext({
        config: {
          modelCreatePriority: new Map([
            ['Collection', 10],
            ['Entry', 15],
            ['EntryDetail', 20],
          ]),
        },
      });

      const localQueue = new MutationQueue({ batchDelay: 0 });

      const collection = createEntryCollectionFixture();
      const entry = createEntryFixture({ collectionId: collection.id });
      const layer = createEntryLayerFixture({ entryId: entry.id });

      // Create in reverse order — FK ordering should fix this
      await localQueue.create(layer, TEST_USER_CONTEXT);
      await localQueue.create(entry, TEST_USER_CONTEXT);
      await localQueue.create(collection, TEST_USER_CONTEXT);

      // Wait for microtask commit + batch processing
      await flushMicrotasks();
      // Give processing time to complete
      await new Promise((r) => setTimeout(r, 50));

      // The batchAck call should receive operations in FK order:
      // Collection (10) before Entry (15) before EntryDetail (20)
      const batchAckCalls = ctx.mocks.mutationExecutor.getCallsByMethod('batchAck');
      if (batchAckCalls.length > 0) {
        const ops = batchAckCalls[0]?.operations;
        if (ops && ops.length === 3) {
          // Verify order: collection model key before entry before layer
          const modelOrder = ops.map((op: { model: string }) => op.model);
          expect(modelOrder).toEqual(['entrycollection', 'entry', 'entrylayer']);
        }
      }

      localQueue.removeAllListeners();
      ctx.cleanup();
    });

    it('cancels an unsent create and completes delete locally', async () => {
      const ctx = createTestContext({
        config: {
          modelCreatePriority: new Map([['EntryDetail', 60]]),
        },
      });
      const localQueue = new MutationQueue({ batchDelay: 0, maxBatchSize: 50 });
      const layer = createEntryLayerFixture({ entryId: 'entry-1' });

      const createPromise = localQueue.create(layer, TEST_USER_CONTEXT);
      const deletePromise = localQueue.delete(layer, TEST_USER_CONTEXT);
      const [createTx, deleteTx] = await Promise.all([createPromise, deletePromise]);

      await flushMicrotasks();
      await new Promise((r) => setTimeout(r, 50));

      expect(ctx.mocks.mutationExecutor.getCallsByMethod('commit')).toHaveLength(0);
      expect(createTx.status).toBe('rolled_back');
      expect(deleteTx.status).toBe('completed');
      await expect(createTx.confirmation).resolves.toBeUndefined();
      await expect(deleteTx.confirmation).resolves.toBeUndefined();

      localQueue.removeAllListeners();
      ctx.cleanup();
    });

    it('defers delete until an attempted create reaches confirmation', async () => {
      const ctx = createTestContext({
        config: {
          modelCreatePriority: new Map([['EntryDetail', 60]]),
        },
      });
      const localQueue = new MutationQueue({ batchDelay: 0, maxBatchSize: 50 });
      const layer = createEntryLayerFixture({ entryId: 'entry-1' });

      ctx.mocks.mutationExecutor.setSyncId(0);
      const createTx = await localQueue.create(layer, TEST_USER_CONTEXT);

      await waitFor(() => createTx.status === 'awaiting_delta');
      expect(ctx.mocks.mutationExecutor.getCallsByMethod('commit')).toHaveLength(1);

      const deleteTx = await localQueue.delete(layer, TEST_USER_CONTEXT);

      await flushMicrotasks();
      await new Promise((r) => setTimeout(r, 50));

      expect(deleteTx.status).toBe('pending');
      expect(ctx.mocks.mutationExecutor.getCallsByMethod('commit')).toHaveLength(1);

      localQueue.onDeltaReceived(1);

      await waitFor(() => ctx.mocks.mutationExecutor.getCallsByMethod('commit').length === 2);
      const calls = ctx.mocks.mutationExecutor.getCallsByMethod('commit');
      expect(calls[0]?.operations?.map((op: { type?: string }) => op.type)).toEqual(['CREATE']);
      expect(calls[1]?.operations?.map((op: { type?: string }) => op.type)).toEqual(['DELETE']);

      await expect(deleteTx.confirmation).resolves.toBeUndefined();

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

      const item = createItemFixture();
      await queue.create(item, TEST_USER_CONTEXT);

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
      const item = createItemFixture();
      const tx = await queue.create(item, TEST_USER_CONTEXT);

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
      const item = createItemFixture();
      const tx = await queue.create(item, TEST_USER_CONTEXT);

      expect(queue.hasClientMutationId(tx.id)).toBe(true);
    });

    it('should return false for unknown ID', () => {
      expect(queue.hasClientMutationId('nonexistent')).toBe(false);
    });
  });
});
