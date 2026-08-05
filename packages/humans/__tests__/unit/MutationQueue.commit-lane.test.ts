/**
 * MutationQueue commit-lane tests — the queue path that backs
 * `ablo.commits.create()`. Distinct from the model-proxy path (Transaction
 * objects with single modelName/modelId): commit-lane envelopes are raw
 * pre-built `operations[]`, atomic, no coalescing.
 *
 * Contract claims under test:
 *   1. enqueue → executor success → waitForCommitReceipt resolves with lastSyncId
 *   2. enqueue → permanent error → waitForCommitReceipt rejects; tx dropped from lane
 *   3. enqueue → transient (AbloConnectionError) → tx stays at head; reconnect
 *      kick (drainPending) drains it
 *   4. lane is serial: B's executor doesn't fire until A's resolves
 *   5. same clientTxId enqueued twice → executor called once; both waiters resolve
 */

import { MutationQueue } from '../../src/local/transactions/mutations/MutationQueue';
import { AbloConnectionError, AbloValidationError } from '@abloatai/transaction/errors';
import { createTestContext } from '../../src/local/testing';

const OP = (id = 'op-1') => ({
  type: 'UPDATE',
  model: 'agentjob',
  id,
  input: { status: 'running' },
});

describe('MutationQueue commit lane', () => {
  let queue: MutationQueue;
  let cleanup: () => void;
  let mocks: ReturnType<typeof createTestContext>['mocks'];

  beforeEach(() => {
    const ctx = createTestContext({
      mutationExecutorOptions: { initialSyncId: 100 },
    });
    cleanup = ctx.cleanup;
    mocks = ctx.mocks;
    queue = new MutationQueue({ batchDelay: 0, maxBatchSize: 50 });
  });

  afterEach(() => {
    queue.dispose();
    jest.restoreAllMocks();
    cleanup();
  });

  it('resolves waitForCommitReceipt with lastSyncId on executor success', async () => {
    void queue.enqueueCommit('tx-1', [OP()]);
    const { lastSyncId } = await queue.waitForCommitReceipt('tx-1');
    expect(lastSyncId).toBe(100);
    expect(mocks.mutationExecutor.getCallsByMethod('commit')).toHaveLength(1);
  });

  it('rejects waitForCommitReceipt on permanent error and drops the tx', async () => {
    const err = new AbloValidationError('capability scope denied', {
      code: 'capability_scope_denied',
    });
    mocks.mutationExecutor.failMethod('commit', err);

    void queue.enqueueCommit('tx-2', [OP()]);
    await expect(queue.waitForCommitReceipt('tx-2')).rejects.toThrow(
      'capability scope denied',
    );

    // Lane must not retry permanent errors — single call only
    expect(mocks.mutationExecutor.getCallsByMethod('commit')).toHaveLength(1);
  });

  it('holds at head-of-queue on transient (AbloConnectionError); reconnect kick drains it', async () => {
    // The production lane also schedules an automatic jittered retry. Pin the
    // jitter beyond this test's reconnect kick so the assertion proves the
    // reconnect path instead of racing a legitimate timer-driven attempt.
    jest.spyOn(Math, 'random').mockReturnValue(0.5);
    const connErr = new AbloConnectionError('SyncWebSocket not connected');
    mocks.mutationExecutor.failMethod('commit', connErr);

    void queue.enqueueCommit('tx-3', [OP()]);

    // Give the first attempt a chance to fail
    await new Promise((r) => setTimeout(r, 10));

    // Tx is still in the store, not resolved
    expect(mocks.mutationExecutor.getCallsByMethod('commit')).toHaveLength(1);
    expect(queue.hasClientMutationId('tx-3')).toBe(true);

    // Simulate reconnect: executor succeeds, queue flushes offline queue
    mocks.mutationExecutor.clearFailure('commit');
    await queue.drainPending();

    const { lastSyncId } = await queue.waitForCommitReceipt('tx-3');
    expect(lastSyncId).toBe(100);
    expect(mocks.mutationExecutor.getCallsByMethod('commit')).toHaveLength(2);
  });

  it('serializes: B does not fire until A resolves', async () => {
    // Slow the executor so we can observe ordering
    const order: string[] = [];
    const origCommit = mocks.mutationExecutor.commit.bind(mocks.mutationExecutor);
    (mocks.mutationExecutor as unknown as { commit: typeof origCommit }).commit =
      async (operations, options) => {
        const id = (operations[0]?.id ?? 'unknown');
        order.push(`enter:${id}`);
        await new Promise((r) => setTimeout(r, 20));
        order.push(`exit:${id}`);
        return origCommit(operations, options);
      };

    void queue.enqueueCommit('tx-A', [OP('A')]);
    void queue.enqueueCommit('tx-B', [OP('B')]);

    await Promise.all([
      queue.waitForCommitReceipt('tx-A'),
      queue.waitForCommitReceipt('tx-B'),
    ]);

    // Strict serialization: A fully exits before B enters
    expect(order).toEqual(['enter:A', 'exit:A', 'enter:B', 'exit:B']);
  });

  it('dedupes same clientTxId in-session: executor called once, both waiters resolve', async () => {
    void queue.enqueueCommit('tx-dup', [OP()]);
    void queue.enqueueCommit('tx-dup', [OP()]); // dropped

    const [r1, r2] = await Promise.all([
      queue.waitForCommitReceipt('tx-dup'),
      queue.waitForCommitReceipt('tx-dup'),
    ]);

    expect(r1.lastSyncId).toBe(100);
    expect(r2.lastSyncId).toBe(100);
    expect(mocks.mutationExecutor.getCallsByMethod('commit')).toHaveLength(1);
  });
});
