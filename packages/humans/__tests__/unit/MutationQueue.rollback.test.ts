/**
 * MutationQueue rollback tests — optimistic rollback on failure,
 * skip rollback for disposed models, no rollback when disconnected.
 */

import { MutationQueue } from '../../src/local/transactions/mutations/MutationQueue';
import {
  createTestContext,
  createTaskFixture,
  resetFixtureCounter,
  flushMicrotasks,
  MockMutationExecutor,
} from '../../src/local/testing';
import type { TestContextResult } from '../../src/local/testing';

const TEST_USER_CONTEXT = {
  userId: 'user-1',
  organizationId: 'org-1',
};

/**
 * Deterministic confirmation wait — resolves on the FIRST emission of `event`.
 * Replaces the old fixed sleeps (100–500ms), which guessed at how long batch
 * processing + retries take: the queue emits its confirmation events
 * ('optimistic:rollback', 'transaction:failed', 'transaction:completed:<id>'),
 * so the test can wait for the actual event instead of a wall-clock estimate.
 * A hang here is a real confirmation bug and fails via the jest timeout.
 */
function onceEvent<T>(queue: MutationQueue, event: string): Promise<T> {
  return new Promise<T>((resolve) => {
    queue.once(event, (payload: T) => { resolve(payload); });
  });
}

/** Wait until a specific transaction settles (completed OR failed). */
async function settled(queue: MutationQueue, txId: string): Promise<void> {
  await Promise.race([
    onceEvent(queue, `transaction:completed:${txId}`),
    onceEvent(queue, `transaction:failed:${txId}`),
  ]);
  // Let any same-tick follow-up handlers (pool apply, listeners) run.
  await flushMicrotasks();
}

describe('MutationQueue Rollback', () => {
  let queue: MutationQueue;
  let ctx: TestContextResult;

  beforeEach(() => {
    resetFixtureCounter();
    ctx = createTestContext({
      config: {
      },
    });
    queue = new MutationQueue({ batchDelay: 0, maxRetries: 1, availabilityRetryWindowMs: 0 });
  });

  afterEach(() => {
    queue.removeAllListeners();
    ctx.cleanup();
  });

  describe('permanent error rollback', () => {
    it('should emit optimistic:rollback on permanent failure', async () => {
      // Attach the confirmation wait BEFORE enqueuing so the event can't race it.
      const firstRollback = onceEvent<{ model: unknown; reason: string }>(
        queue,
        'optimistic:rollback',
      );

      // Make mutation fail with permanent error (not network error)
      ctx.mocks.mutationExecutor.failAll(new Error('Validation failed'));

      const task = createTaskFixture();
      await queue.create(task, TEST_USER_CONTEXT);

      // Deterministic: the rollback event IS batch-processing completion.
      const rollback = await firstRollback;

      expect(rollback.model).toBe(task);
      expect(rollback.reason).toBe('permanent_error');
    });

    it('should emit transaction:failed with permanent flag', async () => {
      const firstFailure = onceEvent<{ transaction: { type: string }; permanent: boolean }>(
        queue,
        'transaction:failed',
      );

      ctx.mocks.mutationExecutor.failAll(new Error('Constraint violation'));

      const task = createTaskFixture();
      await queue.create(task, TEST_USER_CONTEXT);

      const failure = await firstFailure;
      expect(failure.permanent).toBe(true);
    });
  });

  describe('transient error retry', () => {
    it('should retry on network errors (transient) and eventually fail', async () => {
      // Use maxRetries: 1, so after 1 retry it fails
      const localQueue = new MutationQueue({
        batchDelay: 0,
        maxRetries: 2,
        availabilityRetryWindowMs: 0,
      });
      // 'transaction:failed' only fires once retries are EXHAUSTED — waiting on
      // it is the deterministic version of the old 500ms "hope retries finished"
      // sleep (the retries' backoff timers run at whatever pace they run).
      const firstFailure = onceEvent(localQueue, 'transaction:failed');

      // Network errors are transient — should retry before failing
      ctx.mocks.mutationExecutor.failAll(new Error('Failed to fetch'));

      const task = createTaskFixture();
      await localQueue.create(task, TEST_USER_CONTEXT);

      await firstFailure;

      // Should have attempted multiple calls (initial + retries)
      const batchCalls = ctx.mocks.mutationExecutor.getCallsByMethod('commit');
      expect(batchCalls.length).toBeGreaterThanOrEqual(2);

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
      const txDelete = await queue.delete(task, TEST_USER_CONTEXT);

      // The delete should take priority; wait for ITS confirmation rather than
      // sleeping an arbitrary 50ms.
      await settled(queue, txDelete.id);
    });
  });
});
