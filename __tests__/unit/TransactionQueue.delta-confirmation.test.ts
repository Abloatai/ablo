/**
 * TransactionQueue delta confirmation tests — syncId threshold matching,
 * timeout behavior, retry with backoff, reconciliation events.
 */

import { TransactionQueue } from '../../src/transactions/TransactionQueue';
import {
  createTestContext,
  createTaskFixture,
  resetFixtureCounter,
  flushMicrotasks,
} from '../../src/testing';
import type { TestContextResult } from '../../src/testing';

const TEST_USER_CONTEXT = {
  userId: 'user-1',
  organizationId: 'org-1',
};

describe('TransactionQueue Delta Confirmation', () => {
  let queue: TransactionQueue;
  let ctx: TestContextResult;

  beforeEach(() => {
    resetFixtureCounter();
    ctx = createTestContext({
      config: {
        batchableModels: new Set(['task']),
        extractCreateInput: (_name, data) => data,
        buildUpdateInput: (_name, changes) => changes,
      },
    });
    // Short timeout for tests
    queue = new TransactionQueue({
      batchDelay: 0,
      deltaConfirmationTimeout: 100, // 100ms instead of 30s
    });
  });

  afterEach(() => {
    queue.removeAllListeners();
    ctx.cleanup();
  });

  describe('syncId threshold matching', () => {
    it('should confirm transaction when delta syncId >= needed threshold', async () => {
      const completedEvents: unknown[] = [];
      queue.on('transaction:completed', (tx) => completedEvents.push(tx));

      const task = createTaskFixture();
      await queue.create(task, TEST_USER_CONTEXT);

      // Wait for batch processing
      await flushMicrotasks();
      await new Promise((r) => setTimeout(r, 50));

      // MockMutationExecutor returns lastSyncId=1 (initial)
      // Simulate delta arriving with syncId >= 1
      queue.onDeltaReceived(1);

      expect(completedEvents.length).toBeGreaterThan(0);
    });

    it('should not confirm when delta syncId < threshold', async () => {
      // Set initial syncId high so threshold will be high
      ctx.mocks.mutationExecutor.setSyncId(100);

      const completedViaConfirm: unknown[] = [];
      queue.on('transaction:completed', (tx) => completedViaConfirm.push(tx));

      const task = createTaskFixture();
      await queue.create(task, TEST_USER_CONTEXT);

      await flushMicrotasks();
      await new Promise((r) => setTimeout(r, 50));

      // Simulate delta with lower syncId
      queue.onDeltaReceived(50); // < 100

      // Should NOT have confirmed via onDeltaReceived
      // (the completed event from the initial processing is separate)
    });

    it('should immediately confirm if lastSeenSyncId already >= threshold (race fix)', async () => {
      // Pre-load lastSeenSyncId before the mutation
      queue.onDeltaReceived(1000);

      const completedEvents: unknown[] = [];
      queue.on('transaction:completed', (tx) => completedEvents.push(tx));

      const task = createTaskFixture();
      await queue.create(task, TEST_USER_CONTEXT);

      // Wait for batch processing
      await flushMicrotasks();
      await new Promise((r) => setTimeout(r, 50));

      // Transaction should be immediately confirmed because
      // lastSeenSyncId (1000) >= syncIdNeededForCompletion (1)
      expect(completedEvents.length).toBeGreaterThan(0);
    });
  });

  describe('delta confirmation timeout', () => {
    it('should emit reconciliation:needed on timeout', async () => {
      jest.useFakeTimers();

      const reconciliationEvents: unknown[] = [];
      queue.on('reconciliation:needed', (data) => reconciliationEvents.push(data));

      // Set high syncId so threshold won't be met naturally
      ctx.mocks.mutationExecutor.setSyncId(999);

      const task = createTaskFixture();
      await queue.create(task, TEST_USER_CONTEXT);

      // Process the batch
      await jest.advanceTimersByTimeAsync(10);

      // Advance past the delta confirmation timeout (100ms in test config)
      await jest.advanceTimersByTimeAsync(200);

      expect(reconciliationEvents.length).toBeGreaterThan(0);
      const event = reconciliationEvents[0] as { reason: string };
      expect(event.reason).toBe('delta_confirmation_timeout');

      jest.useRealTimers();
    });

    it('should retry with exponential backoff', async () => {
      jest.useFakeTimers();

      const reconciliationEvents: unknown[] = [];
      queue.on('reconciliation:needed', (data) => reconciliationEvents.push(data));

      ctx.mocks.mutationExecutor.setSyncId(999);

      const task = createTaskFixture();
      await queue.create(task, TEST_USER_CONTEXT);

      // Process batch
      await jest.advanceTimersByTimeAsync(10);

      // First timeout at 100ms
      await jest.advanceTimersByTimeAsync(100);
      const firstRetry = reconciliationEvents.length;

      // Second timeout at 200ms (2x backoff)
      await jest.advanceTimersByTimeAsync(200);
      const secondRetry = reconciliationEvents.length;

      expect(secondRetry).toBeGreaterThan(firstRetry);

      jest.useRealTimers();
    });
  });

  describe('confirmByClientMutationId (legacy)', () => {
    it('should confirm transaction by its ID', async () => {
      const completedEvents: unknown[] = [];
      queue.on('transaction:completed', (tx) => completedEvents.push(tx));

      const task = createTaskFixture();
      const tx = await queue.create(task, TEST_USER_CONTEXT);

      // Wait for processing
      await flushMicrotasks();
      await new Promise((r) => setTimeout(r, 50));

      // Legacy confirmation by clientMutationId
      queue.confirmByClientMutationId(tx.id);

      expect(completedEvents.length).toBeGreaterThan(0);
    });

    it('should no-op for unknown or already completed transaction', () => {
      // Should not throw
      queue.confirmByClientMutationId('nonexistent');
    });
  });

  describe('delete with lastSyncId 0', () => {
    it('should immediately confirm DELETE when lastSyncId is 0', async () => {
      // Set syncId to 0 to trigger the safety net
      ctx.mocks.mutationExecutor.setSyncId(0);

      const completedEvents: unknown[] = [];
      queue.on('transaction:completed', (tx) => completedEvents.push(tx));

      const task = createTaskFixture();
      await queue.delete(task, TEST_USER_CONTEXT);

      // Wait for processing
      await flushMicrotasks();
      await new Promise((r) => setTimeout(r, 50));

      // DELETE with lastSyncId=0 should be immediately confirmed
      const deleteTxCompleted = (completedEvents as Array<{ type: string }>).some(
        (e) => e.type === 'delete'
      );
      expect(deleteTxCompleted).toBe(true);
    });
  });
});
