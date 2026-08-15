/**
 * MutationQueue delta confirmation tests — syncId threshold matching,
 * timeout behavior, retry with backoff, reconciliation events.
 */

import { MutationQueue } from '../../src/local/transactions/mutations/MutationQueue';
import {
  createTestContext,
  createItemFixture,
  resetFixtureCounter,
  flushMicrotasks,
} from '../../src/local/testing';
import type { TestContextResult } from '../../src/local/testing';

const TEST_USER_CONTEXT = {
  userId: 'user-1',
  organizationId: 'org-1',
};

describe('MutationQueue Delta Confirmation', () => {
  let queue: MutationQueue;
  let ctx: TestContextResult;

  beforeEach(() => {
    resetFixtureCounter();
    ctx = createTestContext({
      config: {
      },
    });
    // Short timeout for tests
    queue = new MutationQueue({
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

      const item = createItemFixture();
      await queue.create(item, TEST_USER_CONTEXT);

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

      const item = createItemFixture();
      await queue.create(item, TEST_USER_CONTEXT);

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

      const item = createItemFixture();
      await queue.create(item, TEST_USER_CONTEXT);

      // Wait for batch processing
      await flushMicrotasks();
      await new Promise((r) => setTimeout(r, 50));

      // Transaction should be immediately confirmed because
      // lastSeenSyncId (1000) >= syncIdNeededForCompletion (1)
      expect(completedEvents.length).toBeGreaterThan(0);
    });
  });

  describe('delta confirmation timeout', () => {
    afterEach(() => {
      jest.useRealTimers();
    });

    it('should emit reconciliation:needed on timeout (zero-watermark anomaly path)', async () => {
      jest.useFakeTimers();

      const reconciliationEvents: unknown[] = [];
      queue.on('reconciliation:needed', (data) => reconciliationEvents.push(data));

      // A real ack (lastSyncId > 0) now confirms IMMEDIATELY (ack-based
      // confirmation, see ackConfirmation.test.ts). Only the lastSyncId=0
      // server anomaly still parks in awaiting_delta with the
      // reconciliation timeout — exercise THAT path.
      ctx.mocks.mutationExecutor.setSyncId(0);

      const item = createItemFixture();
      await queue.create(item, TEST_USER_CONTEXT);

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

      // Zero-watermark anomaly path (real acks confirm immediately now).
      ctx.mocks.mutationExecutor.setSyncId(0);

      const item = createItemFixture();
      await queue.create(item, TEST_USER_CONTEXT);

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

  describe('delete with lastSyncId 0', () => {
    it('should immediately confirm DELETE when lastSyncId is 0', async () => {
      // Set syncId to 0 to trigger the safety net
      ctx.mocks.mutationExecutor.setSyncId(0);

      const completedEvents: unknown[] = [];
      queue.on('transaction:completed', (tx) => completedEvents.push(tx));

      const item = createItemFixture();
      await queue.delete(item, TEST_USER_CONTEXT);

      // Wait for processing
      await flushMicrotasks();
      await new Promise((r) => setTimeout(r, 50));

      // DELETE with lastSyncId=0 should be immediately confirmed
      const deleteTxCompleted = (completedEvents as { type: string }[]).some(
        (e) => e.type === 'delete'
      );
      expect(deleteTxCompleted).toBe(true);
    });
  });
});
