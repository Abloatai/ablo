/**
 * Rejected-commit settlement — pins the 2026-06-10 retry-storm fix.
 *
 * Invariant (Replicache / Zero / Linear): a PERMANENTLY-rejected mutation is
 * SETTLED — removed from the retry path, optimistic effect rolled back, the
 * caller's confirmation rejected with the typed error — never resent. Only
 * transient (network/5xx/429) failures retry, with a bounded attempt budget.
 *
 * The storm this guards against: `handleFailure` re-enqueued a retry while
 * its modelKey was still in `inFlightByModel`, so the in-flight merge path
 * laundered the retry into a FRESH follow-up transaction with `attempts: 0`
 * — the attempt counter never accumulated and a held-claim rejection
 * (`claim_conflict`, then marked retryable) resent forever at ~batchDelay
 * cadence.
 */

import { MutationQueue } from '../../src/local/transactions/mutations/MutationQueue';
import { AbloClaimedError } from '@ablo/transaction/errors';
import {
  createTestContext,
  createTaskFixture,
  resetFixtureCounter,
  flushMicrotasks,
} from '../../src/local/testing';
import type { MockMutationExecutor } from '../../src/local/testing';

const TEST_USER_CONTEXT = {
  userId: 'user-1',
  organizationId: 'org-1',
};

/** Real-timer settle: microtasks + a short macrotask window so the
 *  (jittered, ≤2ms in this config) retry timers can fire. */
async function settle(ms = 60): Promise<void> {
  await flushMicrotasks();
  await new Promise((r) => setTimeout(r, ms));
}

describe('MutationQueue rejected-commit settlement', () => {
  let queue: MutationQueue;
  let executor: MockMutationExecutor;
  let cleanup: () => void;

  beforeEach(() => {
    resetFixtureCounter();
    const ctx = createTestContext({ config: {} });
    cleanup = ctx.cleanup;
    executor = ctx.mocks.mutationExecutor;
    queue = new MutationQueue({
      batchDelay: 0,
      maxBatchSize: 50,
      maxRetries: 3,
      // Tiny backoff so transient-retry tests settle in real time.
      retryBackoff: { baseMs: 1, capMs: 2 },
    });
  });

  afterEach(() => {
    queue.removeAllListeners();
    cleanup();
  });

  it('a held-claim rejection settles after ONE send: no resend, rollback, rejected confirmation', async () => {
    executor.failAll(
      new AbloClaimedError('task/t1 is claimed by another participant', {
        code: 'claim_conflict',
      }),
    );

    const failed: { permanent?: boolean }[] = [];
    const rollbacks: unknown[] = [];
    queue.on('transaction:failed', (p) => failed.push(p as { permanent?: boolean }));
    queue.on('optimistic:rollback', (p) => rollbacks.push(p));

    const task = createTaskFixture({ title: 'original' });
    task.markAsPersisted();
    task.propertyChanged('title', 'original', 'steamroll');
    const tx = await queue.update(task, TEST_USER_CONTEXT, { title: 'steamroll' });

    const confirmation = queue.waitForConfirmation(tx.id);
    // Attach the rejection assertion BEFORE settling so the rejection is
    // observed (not an unhandled rejection race).
    const confirmationAssertion = expect(confirmation).rejects.toBeInstanceOf(AbloClaimedError);

    await settle();

    const commitCalls = executor.calls.filter((c) => c.method === 'commit');
    expect(commitCalls).toHaveLength(1); // settled — never resent
    expect(failed).toHaveLength(1);
    expect(failed[0]?.permanent).toBe(true);
    expect(rollbacks).toHaveLength(1);
    await confirmationAssertion;
  });

  it('a transient failure retries the SAME transaction with a bounded attempt budget', async () => {
    executor.failAll(new Error('network error: connection reset'));

    const failed: { permanent?: boolean }[] = [];
    queue.on('transaction:failed', (p) => failed.push(p as { permanent?: boolean }));

    const task = createTaskFixture({ title: 'original' });
    task.markAsPersisted();
    task.propertyChanged('title', 'original', 'flaky');
    queue.update(task, TEST_USER_CONTEXT, { title: 'flaky' });

    await settle(150);

    const commitCalls = executor.calls.filter((c) => c.method === 'commit');
    // maxRetries(3) bounds TOTAL attempts — and every attempt must carry the
    // SAME transaction (the storm minted a fresh clone per cycle, resetting
    // the counter; clones are visible as differing per-op transactionIds).
    expect(commitCalls).toHaveLength(3);
    const txIds = new Set(
      commitCalls.map(
        (c) => (c.operations?.[0] as { transactionId?: string } | undefined)?.transactionId,
      ),
    );
    expect(txIds.size).toBe(1);
    expect(failed).toHaveLength(1); // exhausted → failed once, then silent
  });
});
