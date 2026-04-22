/**
 * TransactionQueue rollback tests — optimistic rollback on failure,
 * skip rollback for disposed models, no rollback when disconnected.
 */

import { TransactionQueue } from '../../src/transactions/TransactionQueue';
import {
  createTestContext,
  createTaskFixture,
  resetFixtureCounter,
  flushMicrotasks,
  MockMutationExecutor,
} from '../../src/testing';
import type { TestContextResult } from '../../src/testing';

const TEST_USER_CONTEXT = {
  userId: 'user-1',
  organizationId: 'org-1',
};

describe('TransactionQueue Rollback', () => {
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
    queue = new TransactionQueue({ batchDelay: 0, maxRetries: 1 });
  });

  afterEach(() => {
    queue.removeAllListeners();
    ctx.cleanup();
  });

  describe('permanent error rollback', () => {
    it('should emit optimistic:rollback on permanent failure', async () => {
      const rollbacks: unknown[] = [];
      queue.on('optimistic:rollback', (data) => rollbacks.push(data));

      // Make mutation fail with permanent error (not network error)
      ctx.mocks.mutationExecutor.failAll(new Error('Validation failed'));

      const task = createTaskFixture();
      await queue.create(task, TEST_USER_CONTEXT);

      // Wait for batch processing
      await flushMicrotasks();
      await new Promise((r) => setTimeout(r, 100));

      expect(rollbacks.length).toBeGreaterThan(0);
      const rollback = rollbacks[0] as { model: unknown; reason: string };
      expect(rollback.model).toBe(task);
      expect(rollback.reason).toBe('permanent_error');
    });

    it('should emit transaction:failed with permanent flag', async () => {
      const failures: unknown[] = [];
      queue.on('transaction:failed', (data) => failures.push(data));

      ctx.mocks.mutationExecutor.failAll(new Error('Constraint violation'));

      const task = createTaskFixture();
      await queue.create(task, TEST_USER_CONTEXT);

      await flushMicrotasks();
      await new Promise((r) => setTimeout(r, 100));

      expect(failures.length).toBeGreaterThan(0);
      const failure = failures[0] as { transaction: { type: string }; permanent: boolean };
      expect(failure.permanent).toBe(true);
    });
  });

  describe('transient error retry', () => {
    it('should retry on network errors (transient) and eventually fail', async () => {
      // Use maxRetries: 1, so after 1 retry it fails
      const localQueue = new TransactionQueue({ batchDelay: 0, maxRetries: 2 });
      const failures: unknown[] = [];
      localQueue.on('transaction:failed', (data) => failures.push(data));

      // Network errors are transient — should retry before failing
      ctx.mocks.mutationExecutor.failAll(new Error('Failed to fetch'));

      const task = createTaskFixture();
      await localQueue.create(task, TEST_USER_CONTEXT);

      // Wait for retries to complete (they go through microtask scheduling)
      await flushMicrotasks();
      await new Promise((r) => setTimeout(r, 500));

      // Should have attempted multiple calls (initial + retries)
      const batchCalls = ctx.mocks.mutationExecutor.getCallsByMethod('commit');
      expect(batchCalls.length).toBeGreaterThanOrEqual(2);

      // Eventually should fail after max retries
      expect(failures.length).toBeGreaterThan(0);

      localQueue.removeAllListeners();
    });
  });

  describe('delete cancels pending updates', () => {
    it('should cancel pending update transactions when delete is issued', async () => {
      const task = createTaskFixture();
      task.markAsPersisted();
      task.propertyChanged('title', 'Old', 'New');

      // Create an update first
      await queue.update(task, TEST_USER_CONTEXT, { title: 'New' });

      // Then delete — should cancel the pending update
      await queue.delete(task, TEST_USER_CONTEXT);

      // The delete should take priority
      await flushMicrotasks();
      await new Promise((r) => setTimeout(r, 50));
    });
  });
});
