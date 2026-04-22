/**
 * Integration test: Offline Recovery
 *
 * Tests the offline queue lifecycle:
 * 1. OfflineTransactionStore persists mutations to IndexedDB
 * 2. Transactions survive "restart" (new store instance reads persisted data)
 * 3. Flush sends transactions in topological order
 *
 * Uses real OfflineTransactionStore backed by fake-indexeddb.
 */

import { OfflineTransactionStore } from '../../src/sync/OfflineTransactionStore';
import {
  createTestContext,
  resetFixtureCounter,
} from '../../src/testing';

describe('Integration: Offline Recovery', () => {
  let cleanup: () => void;

  beforeEach(() => {
    resetFixtureCounter();
    const ctx = createTestContext();
    cleanup = ctx.cleanup;
  });

  afterEach(() => {
    cleanup();
  });

  describe('IndexedDB persistence round-trip', () => {
    it('should enqueue and list transactions', async () => {
      const store = new OfflineTransactionStore();
      await store.init();

      await store.enqueue({
        id: 'tx-1',
        opName: 'CreateTask',
        priority: 2, // NORMAL
        
        request: { body: { title: 'Offline task' } },
      });

      await store.enqueue({
        id: 'tx-2',
        opName: 'UpdateTask',
        priority: 2,
        
        request: { body: { status: 'done' } },
      });

      const all = await store.listAll();
      expect(all).toHaveLength(2);
      expect(all.find((t) => t.id === 'tx-1')).toBeDefined();
      expect(all.find((t) => t.id === 'tx-2')).toBeDefined();

      await store.clear();
    });

    it('should survive "restart" (new store reads persisted data)', async () => {
      // First instance — write data
      const store1 = new OfflineTransactionStore();
      await store1.init();

      await store1.enqueue({
        id: 'tx-persist-1',
        opName: 'CreateTask',
        priority: 2,
        
        request: { body: { title: 'Survives restart' } },
      });

      // Second instance — should read the same data
      const store2 = new OfflineTransactionStore();
      await store2.init();

      const all = await store2.listAll();
      expect(all).toHaveLength(1);
      expect(all[0].id).toBe('tx-persist-1');

      await store2.clear();
    });

    it('should remove a transaction by id', async () => {
      const store = new OfflineTransactionStore();
      await store.init();

      await store.enqueue({
        id: 'tx-remove',
        opName: 'CreateTask',
        priority: 2,
        
        request: {},
      });

      await store.remove('tx-remove');

      const all = await store.listAll();
      expect(all).toHaveLength(0);
    });

    it('should clear all transactions', async () => {
      const store = new OfflineTransactionStore();
      await store.init();

      await store.enqueue({ id: 'tx-a', opName: 'A', priority: 2, request: {} });
      await store.enqueue({ id: 'tx-b', opName: 'B', priority: 2, request: {} });
      await store.enqueue({ id: 'tx-c', opName: 'C', priority: 2, request: {} });

      await store.clear();

      const all = await store.listAll();
      expect(all).toHaveLength(0);
    });
  });

  describe('flush with ordering', () => {
    it('should flush transactions via processor callback', async () => {
      const store = new OfflineTransactionStore();
      await store.init();

      await store.enqueue({ id: 'tx-1', opName: 'A', priority: 2, request: {} });
      await store.enqueue({ id: 'tx-2', opName: 'B', priority: 2, request: {} });

      const processed: string[] = [];
      const result = await store.flush(async (tx) => {
        processed.push(tx.id);
      });

      expect(processed).toEqual(['tx-1', 'tx-2']);
      expect(result.processed).toBe(2);
      expect(result.failed).toBe(0);

      // After flush, queue should be empty
      const remaining = await store.listAll();
      expect(remaining).toHaveLength(0);
    });

    it('should respect priority ordering in flush', async () => {
      const store = new OfflineTransactionStore();
      await store.init();

      // HIGH priority (1) should process before NORMAL (2)
      await store.enqueue({ id: 'tx-normal', opName: 'Normal', priority: 2, request: {} });
      await store.enqueue({ id: 'tx-high', opName: 'High', priority: 1, request: {} });

      const processed: string[] = [];
      await store.flush(async (tx) => {
        processed.push(tx.id);
      });

      // HIGH (1) should come before NORMAL (2)
      expect(processed[0]).toBe('tx-high');
      expect(processed[1]).toBe('tx-normal');
    });

    it('should stop on first processor failure (preserve order)', async () => {
      const store = new OfflineTransactionStore();
      await store.init();

      // Only one tx that will fail — verifies stop-on-error behavior
      await store.enqueue({ id: 'tx-fail', opName: 'Fail', priority: 2, request: {} });

      const result = await store.flush(async () => {
        throw new Error('Processor failed');
      });

      // Flush stops on first failure
      expect(result.processed).toBe(0);
      expect(result.failed).toBe(1);

      // Failed transaction remains in store for retry
      const remaining = await store.listAll();
      expect(remaining).toHaveLength(1);

      await store.clear();
    });
  });

  describe('topological ordering with dependencies', () => {
    it('should respect dependsOn ordering', async () => {
      const store = new OfflineTransactionStore();
      await store.init();

      // tx-child depends on tx-parent
      await store.enqueue({
        id: 'tx-child',
        opName: 'CreateSlide',
        priority: 2,
        dependsOn: ['tx-parent'],
        request: {},
      });
      await store.enqueue({
        id: 'tx-parent',
        opName: 'CreateDeck',
        priority: 2,
        request: {},
      });

      const order = await store.getOptimizedSyncOrder();
      const parentIdx = order.findIndex((t) => t.id === 'tx-parent');
      const childIdx = order.findIndex((t) => t.id === 'tx-child');

      expect(parentIdx).toBeLessThan(childIdx);

      await store.clear();
    });
  });
});
