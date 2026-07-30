/**
 * Ack-based confirmation — the `wait: 'confirmed'` contract.
 *
 * A successful commit response carrying a real server watermark IS the
 * confirmation (the documented semantics, and how Replicache/Zero resolve
 * mutations: from the server's recorded result, never from watching your own
 * change echo back on the replication stream — zero-client's MutationTracker
 * resolves from push responses / poked-down mutation RESULTS, and its own
 * delta echo is suppressed client-side anyway).
 *
 * The old behavior parked confirmed-by-server transactions in
 * `awaiting_delta` until the delta echo arrived — coupling "did my write
 * land" to subscription-stream health. A bare-Node client with no live
 * delta stream hung FOREVER on a write the server had already applied
 * (found by the quickstart loop walk, 2026-06-10).
 */

import {
  MutationQueue,
  type UserContext,
} from '../mutations/MutationQueue.js';
import { createTestContext } from '../../testing/mocks/MockSyncContext.js';
import type { TestContextResult } from '../../testing/mocks/MockSyncContext.js';
import { createTaskFixture } from '../../testing/fixtures/models.js';
import { waitFor } from '../../testing/helpers/wait.js';
import type { StaleNotification } from '@abloatai/transaction/coordination/schema';
import {
  AbloConnectionError,
  AbloError,
  AbloNotFoundError,
} from '@abloatai/transaction/errors';
import type {
  DurableWriteStore,
  PendingWrite,
} from '../mutations/durableWriteStore.js';
import { commitEnvelopeRecordId } from '@abloatai/transaction/transactions/settlement/commitEnvelope';

class MemoryDurableWrites implements DurableWriteStore {
  readonly records = new Map<string, PendingWrite>();
  failRemove = false;

  seal(record: PendingWrite): Promise<void> {
    const existing = this.records.get(record.id);
    if (existing) {
      const acceptedPromotion =
        existing.type === record.type &&
        existing.acceptedAt === undefined &&
        record.acceptedAt !== undefined;
      if (acceptedPromotion) {
        this.records.set(record.id, structuredClone(record));
        return Promise.resolve();
      }
      if (JSON.stringify(existing) !== JSON.stringify(record)) {
        return Promise.reject(new Error('idempotency conflict'));
      }
    }
    if (!existing) this.records.set(record.id, structuredClone(record));
    return Promise.resolve();
  }

  list(): Promise<readonly unknown[]> {
    return Promise.resolve(
      [...this.records.values()].map((record) => structuredClone(record)),
    );
  }

  remove(id: string): Promise<void> {
    if (this.failRemove) return Promise.reject(new Error('outbox unavailable'));
    this.records.delete(id);
    return Promise.resolve();
  }
}

function staleNotification(id: string): StaleNotification {
  return {
    object: 'stale_notification',
    scope: 'row',
    target: { model: 'task', id, fields: ['title'] },
    readAt: 1,
    observedSyncId: 2,
    currentValues: { title: 'newer' },
    writtenBy: { kind: 'user', id: 'user-2' },
  };
}

describe('ack-based transaction confirmation', () => {
  let ctx: TestContextResult;
  let queue: MutationQueue;
  const userContext: UserContext = { userId: 'user_1', organizationId: 'org_1' };

  beforeEach(() => {
    ctx = createTestContext();
    queue = new MutationQueue({ enablePersistence: false });
  });

  afterEach(() => {
    queue.dispose?.();
    ctx.cleanup();
  });

  it('confirms on the server ack alone — NO delta echo required', async () => {
    const task = createTaskFixture();
    const tx = await queue.create(task, userContext);

    // The mock executor acks with lastSyncId > 0; no delta is ever injected.
    // Both the per-tx confirmation promise and the (model,id) lookup resolve.
    await expect(tx.confirmation).resolves.toBeUndefined();
    await expect(
      queue.confirmationFor(task.getModelName(), task.id),
    ).resolves.toBeUndefined();
    await waitFor(() => tx.status === 'completed');
  });

  it('still parks a ZERO-watermark non-delete in awaiting_delta (server anomaly path)', async () => {
    // lastSyncId 0 from the server = accepted but no delta emitted — keep the
    // anomaly path observable instead of silently confirming.
    ctx.mocks.mutationExecutor.setSyncId(0);
    const task = createTaskFixture();
    const tx = await queue.create(task, userContext);

    await waitFor(() => tx.status === 'awaiting_delta');
    expect(tx.status).toBe('awaiting_delta');
  });

  it('keeps a queued forward pending until its source-correlated echo arrives', async () => {
    ctx.mocks.mutationExecutor.setSyncId(0);
    ctx.mocks.mutationExecutor.setStatus('queued');
    const correlationId = 'source-correlation-model';
    ctx.mocks.mutationExecutor.setCorrelationId(correlationId);
    const task = createTaskFixture();
    const tx = await queue.create(task, userContext);

    await waitFor(() => tx.status === 'awaiting_delta');

    // A global watermark advance is not proof that the source database
    // committed this write. Even an arbitrarily newer unrelated delta must not
    // satisfy a queued receipt.
    queue.onDeltaReceived(
      10_000,
      'some-other-transaction',
      'some-other-correlation',
    );
    expect(tx.status).toBe('awaiting_delta');

    const clientTxId = ctx.mocks.mutationExecutor.lastCall?.options?.idempotencyKey;
    if (typeof clientTxId !== 'string') throw new Error('missing commit idempotency key');
    // The caller id remains the optimistic-echo identity; it is not proof that
    // the queued source execution has appeared in WAL.
    queue.onDeltaReceived(10_001, clientTxId);
    expect(tx.status).toBe('awaiting_delta');

    queue.onDeltaReceived(10_002, tx.id, correlationId);
    await expect(tx.confirmation).resolves.toBeUndefined();
    expect(tx.status).toBe('completed');
  });

  it('surfaces replication lag without failing or rolling back an accepted model write', async () => {
    queue.dispose();
    queue = new MutationQueue({
      enablePersistence: false,
      deltaConfirmationTimeout: 10,
    });
    ctx.mocks.mutationExecutor.setStatus('queued');
    const correlationId = 'source-correlation-lagged-model';
    ctx.mocks.mutationExecutor.setCorrelationId(correlationId);
    const failed = jest.fn();
    const rolledBack = jest.fn();
    queue.on('transaction:failed', failed);
    queue.on('optimistic:rollback', rolledBack);

    const task = createTaskFixture();
    const tx = await queue.update(task, userContext, { title: 'accepted' });
    await waitFor(() => tx.status === 'awaiting_delta');

    await expect(tx.confirmation).rejects.toMatchObject({
      code: 'replication_lag_timeout',
      details: { accepted: true, correlationId, timeoutMs: 10 },
    });
    expect(tx.status).toBe('awaiting_delta');
    expect(failed).not.toHaveBeenCalled();
    expect(rolledBack).not.toHaveBeenCalled();

    const clientTxId = ctx.mocks.mutationExecutor.lastCall?.options?.idempotencyKey;
    if (typeof clientTxId !== 'string') throw new Error('missing commit idempotency key');
    queue.onDeltaReceived(10_003, tx.id, correlationId);
    expect(tx.status).toBe('completed');
    await expect(queue.confirmationFor(task.getModelName(), task.id)).resolves.toBeUndefined();
  });

  it('retains a queued model envelope durably until its correlated echo', async () => {
    queue.dispose();
    const outbox = new MemoryDurableWrites();
    queue = new MutationQueue({ enablePersistence: true });
    queue.setCommitOutbox(outbox);
    ctx.mocks.mutationExecutor.setStatus('queued');
    const correlationId = 'source-correlation-durable-model';
    ctx.mocks.mutationExecutor.setCorrelationId(correlationId);

    const task = createTaskFixture();
    const tx = await queue.update(task, userContext, { title: 'durable' });
    await waitFor(() => tx.status === 'awaiting_delta');
    const clientTxId = ctx.mocks.mutationExecutor.lastCall?.options?.idempotencyKey;
    if (typeof clientTxId !== 'string') throw new Error('missing commit idempotency key');

    const persisted = outbox.records.get(commitEnvelopeRecordId(clientTxId));
    expect(typeof persisted?.acceptedAt).toBe('number');
    expect(persisted?.correlationId).toBe(correlationId);
    queue.onDeltaReceived(10_004, tx.id, correlationId);
    await waitFor(
      () => !outbox.records.has(commitEnvelopeRecordId(clientTxId)),
    );
    expect(tx.status).toBe('completed');
  });

  it('does not let reconnect flushing promote a queued source receipt to confirmed', async () => {
    queue.dispose();
    const outbox = new MemoryDurableWrites();
    queue = new MutationQueue({
      enablePersistence: true,
      batchDelay: 60_000,
    });
    queue.setCommitOutbox(outbox);
    ctx.mocks.mutationExecutor.setStatus('queued');
    const correlationId = 'source-correlation-offline-model';
    ctx.mocks.mutationExecutor.setCorrelationId(correlationId);

    const task = createTaskFixture();
    const tx = await queue.update(task, userContext, { title: 'offline' });
    await Promise.resolve();
    await queue.drainPending();

    expect(tx.status).toBe('awaiting_delta');
    const clientTxId = ctx.mocks.mutationExecutor.lastCall?.options?.idempotencyKey;
    if (typeof clientTxId !== 'string') throw new Error('missing commit idempotency key');
    expect(outbox.records.has(commitEnvelopeRecordId(clientTxId))).toBe(true);

    queue.onDeltaReceived(10_005, tx.id, correlationId);
    await waitFor(
      () => !outbox.records.has(commitEnvelopeRecordId(clientTxId)),
    );
    expect(tx.status).toBe('completed');
  });

  it('does not apply the zero-watermark DELETE shortcut to a queued forward', async () => {
    ctx.mocks.mutationExecutor.setSyncId(0);
    ctx.mocks.mutationExecutor.setStatus('queued');
    ctx.mocks.mutationExecutor.setCorrelationId('source-correlation-delete');
    const task = createTaskFixture();
    const tx = await queue.delete(task, userContext);

    await waitFor(() => tx.status === 'awaiting_delta');
    queue.onDeltaReceived(
      10_000,
      'unrelated-delete',
      'unrelated-correlation',
    );

    expect(tx.status).toBe('awaiting_delta');
  });

  it('keeps the legacy zero-watermark DELETE shortcut for a confirmed receipt', async () => {
    ctx.mocks.mutationExecutor.setSyncId(0);
    const task = createTaskFixture();
    const tx = await queue.delete(task, userContext);

    await expect(tx.confirmation).resolves.toBeUndefined();
    expect(tx.status).toBe('completed');
  });

  it('releases same-row UPDATE merging after a queued receipt', async () => {
    ctx.mocks.mutationExecutor.setStatus('queued');
    ctx.mocks.mutationExecutor.setCorrelationId('source-correlation-merge');
    const task = createTaskFixture();
    const first = await queue.update(task, userContext, { title: 'first' });
    await waitFor(() => first.status === 'awaiting_delta');

    const second = await queue.update(task, userContext, { title: 'second' });
    await waitFor(
      () => ctx.mocks.mutationExecutor.getCallsByMethod('commit').length === 2,
    );

    expect(second.status).toBe('awaiting_delta');
  });

  it('waits for the newest same-row write when timestamps are equal', async () => {
    ctx.mocks.mutationExecutor.setStatus('queued');
    ctx.mocks.mutationExecutor.setCorrelationId('source-correlation-same-ms');
    const task = createTaskFixture();
    const first = await queue.update(task, userContext, { title: 'first' });
    await waitFor(() => first.status === 'awaiting_delta');

    const second = await queue.update(task, userContext, { title: 'second' });
    await waitFor(() => second.status === 'awaiting_delta');
    second.createdAt = first.createdAt;

    expect(queue.confirmationFor(task.getModelName(), task.id)).toBe(second.confirmation);
  });

  it('completes held notify members while the forwarded members await their echo', async () => {
    ctx.mocks.mutationExecutor.setStatus('queued');
    ctx.mocks.mutationExecutor.setCorrelationId('source-correlation-notify');
    const heldTask = createTaskFixture({ id: 'task-held' });
    const forwardedTask = createTaskFixture({ id: 'task-forwarded' });
    ctx.mocks.mutationExecutor.setNotifications([
      staleNotification(heldTask.id),
    ]);

    const heldPromise = queue.create(heldTask, userContext);
    const forwardedPromise = queue.create(forwardedTask, userContext);
    const [held, forwarded] = await Promise.all([heldPromise, forwardedPromise]);
    await waitFor(
      () => held.status === 'completed' && forwarded.status === 'awaiting_delta',
    );

    expect(held.status).toBe('completed');
    expect(forwarded.status).toBe('awaiting_delta');
  });

  it('fails missing members while the forwarded members await their echo', async () => {
    ctx.mocks.mutationExecutor.setStatus('queued');
    ctx.mocks.mutationExecutor.setCorrelationId('source-correlation-missing');
    const missingTask = createTaskFixture({ id: 'task-missing' });
    const forwardedTask = createTaskFixture({ id: 'task-forwarded' });
    ctx.mocks.mutationExecutor.setMissingIds([missingTask.id]);

    const missingPromise = queue.update(
      missingTask,
      userContext,
      { title: 'missing' },
    );
    const forwardedPromise = queue.update(
      forwardedTask,
      userContext,
      { title: 'forwarded' },
    );
    const [missing, forwarded] = await Promise.all([
      missingPromise,
      forwardedPromise,
    ]);
    await waitFor(
      () => missing.status === 'failed' && forwarded.status === 'awaiting_delta',
    );

    await expect(missing.confirmation).rejects.toBeInstanceOf(AbloNotFoundError);
    expect(forwarded.status).toBe('awaiting_delta');
  });

  it('keeps an atomic queued commit pending across unrelated deltas', async () => {
    ctx.mocks.mutationExecutor.setSyncId(0);
    ctx.mocks.mutationExecutor.setStatus('queued');
    const correlationId = 'source-correlation-atomic';
    ctx.mocks.mutationExecutor.setCorrelationId(correlationId);
    ctx.mocks.mutationExecutor.setMissingIds(['task-missing']);
    const clientTxId = 'forwarded-atomic-commit';
    await queue.enqueueCommit(clientTxId, [
      {
        type: 'UPDATE',
        model: 'task',
        id: 'task-missing',
        input: { title: 'missing' },
      },
      {
        type: 'UPDATE',
        model: 'task',
        id: 'task-1',
        input: { title: 'forwarded' },
      },
    ]);
    const receipt = queue.waitForCommitReceipt(clientTxId);
    let settled = false;
    void receipt.then(() => {
      settled = true;
    });

    await waitFor(
      () => ctx.mocks.mutationExecutor.getCallsByMethod('commit').length === 1,
    );
    queue.onDeltaReceived(
      20_000,
      'some-other-transaction',
      'some-other-correlation',
    );
    await Promise.resolve();
    expect(settled).toBe(false);

    queue.onDeltaReceived(20_001, clientTxId);
    await Promise.resolve();
    expect(settled).toBe(false);

    queue.onDeltaReceived(20_002, undefined, correlationId);
    await expect(receipt).resolves.toEqual({
      lastSyncId: 20_002,
      notifications: undefined,
      missingIds: ['task-missing'],
    });
  });

  it('times out only the atomic confirmation waiter and retains the durable envelope', async () => {
    queue.dispose();
    const outbox = new MemoryDurableWrites();
    queue = new MutationQueue({
      enablePersistence: true,
      deltaConfirmationTimeout: 10,
    });
    queue.setCommitOutbox(outbox);
    ctx.mocks.mutationExecutor.setStatus('queued');
    const correlationId = 'source-correlation-atomic-timeout';
    ctx.mocks.mutationExecutor.setCorrelationId(correlationId);
    const failed = jest.fn();
    queue.on('transaction:failed', failed);

    const clientTxId = 'forwarded-atomic-timeout';
    await queue.enqueueCommit(clientTxId, [
      {
        type: 'UPDATE',
        model: 'task',
        id: 'task-1',
        input: { title: 'accepted' },
      },
    ]);
    const receipt = queue.waitForCommitReceipt(clientTxId);
    await waitFor(
      () => ctx.mocks.mutationExecutor.getCallsByMethod('commit').length === 1,
    );

    await expect(receipt).rejects.toBeInstanceOf(AbloConnectionError);
    await expect(queue.waitForCommitReceipt(clientTxId)).rejects.toMatchObject({
      code: 'replication_lag_timeout',
      details: { clientTxId, correlationId, accepted: true, timeoutMs: 10 },
    });
    expect(failed).not.toHaveBeenCalled();
    expect(outbox.records.has(commitEnvelopeRecordId(clientTxId))).toBe(true);

    queue.onDeltaReceived(20_003, undefined, correlationId);
    await expect(queue.waitForCommitReceipt(clientTxId)).resolves.toMatchObject({
      lastSyncId: 20_003,
    });
    await waitFor(
      () => !outbox.records.has(commitEnvelopeRecordId(clientTxId)),
    );
  });

  it('replays the exact durable envelope on an explicit same-key retry after lag', async () => {
    queue.dispose();
    const outbox = new MemoryDurableWrites();
    queue = new MutationQueue({
      enablePersistence: true,
      deltaConfirmationTimeout: 10,
    });
    queue.setCommitOutbox(outbox);
    ctx.mocks.mutationExecutor.setStatus('queued');
    ctx.mocks.mutationExecutor.setCorrelationId(
      'source-correlation-in-session-retry',
    );
    const clientTxId = 'forwarded-in-session-retry';
    const operations = [
      {
        type: 'UPDATE' as const,
        model: 'task',
        id: 'task-1',
        input: { title: 'idempotent status probe' },
      },
    ];

    await queue.enqueueCommit(clientTxId, operations);
    await expect(queue.waitForCommitReceipt(clientTxId)).rejects.toMatchObject({
      code: 'replication_lag_timeout',
    });
    expect(outbox.records.has(commitEnvelopeRecordId(clientTxId))).toBe(true);

    // Model the server's replay promotion: the source endpoint is not invoked
    // again, but the matching WAL delta now exists, so the same idempotency key
    // returns its authoritative sync id as confirmed.
    ctx.mocks.mutationExecutor.setStatus('confirmed');
    ctx.mocks.mutationExecutor.setSyncId(20_005);
    await queue.enqueueCommit(clientTxId, operations);
    await expect(queue.waitForCommitReceipt(clientTxId)).resolves.toMatchObject({
      lastSyncId: 20_005,
    });
    expect(ctx.mocks.mutationExecutor.getCallsByMethod('commit')).toHaveLength(2);
    await waitFor(
      () => !outbox.records.has(commitEnvelopeRecordId(clientTxId)),
    );
  });

  it('self-retries an atomic durable envelope throughout the availability window', async () => {
    queue.dispose();
    const outbox = new MemoryDurableWrites();
    queue = new MutationQueue({
      enablePersistence: true,
      maxRetries: 1,
      availabilityRetryWindowMs: 1_000,
      retryBackoff: { baseMs: 1, capMs: 2 },
    });
    queue.setCommitOutbox(outbox);
    ctx.mocks.mutationExecutor.failMethod(
      'commit',
      new AbloError('workspace route is being resolved', {
        code: 'tenant_routing_failed',
      }),
    );

    const clientTxId = 'aurora-promotion-retry';
    await queue.enqueueCommit(clientTxId, [
      {
        type: 'UPDATE',
        model: 'task',
        id: 'task-1',
        input: { title: 'exactly once' },
      },
    ]);

    // More than maxRetries proves the lane is waking itself inside the
    // failover-sized wall-clock window instead of waiting for another enqueue.
    await waitFor(
      () => ctx.mocks.mutationExecutor.getCallsByMethod('commit').length >= 3,
    );
    ctx.mocks.mutationExecutor.clearFailure('commit');
    const receipt = await queue.waitForCommitReceipt(clientTxId);
    expect(typeof receipt.lastSyncId).toBe('number');

    const calls = ctx.mocks.mutationExecutor.getCallsByMethod('commit');
    expect(calls.length).toBeGreaterThanOrEqual(4);
    expect(new Set(calls.map((call) => call.options?.idempotencyKey))).toEqual(
      new Set([clientTxId]),
    );
    expect(calls.every((call) => call.operations?.[0]?.input?.title === 'exactly once')).toBe(true);
    await waitFor(
      () => !outbox.records.has(commitEnvelopeRecordId(clientTxId)),
    );
  });

  it('uses an early echo to settle and clear a queued envelope replayed after restart', async () => {
    queue.dispose();
    const outbox = new MemoryDurableWrites();
    const clientTxId = 'forwarded-restart-echo';
    queue = new MutationQueue({ enablePersistence: true });
    queue.setCommitOutbox(outbox);
    ctx.mocks.mutationExecutor.setStatus('queued');
    const correlationId = 'source-correlation-restart';
    ctx.mocks.mutationExecutor.setCorrelationId(correlationId);
    await queue.enqueueCommit(clientTxId, [
      {
        type: 'UPDATE',
        model: 'task',
        id: 'task-1',
        input: { title: 'survives restart' },
      },
    ]);
    await waitFor(
      () => ctx.mocks.mutationExecutor.getCallsByMethod('commit').length === 1,
    );
    // Wait for the ACCEPTED envelope, not merely the dispatched call: the
    // queued receipt's acceptance (acceptedAt + correlationId) persists a
    // beat after the executor is invoked, and the restart below replays
    // whatever this snapshot holds — a sealed-but-unaccepted envelope would
    // make the hand-crafted record below invalid.
    await waitFor(() => {
      const record = outbox.records.get(commitEnvelopeRecordId(clientTxId));
      return record?.type === 'commit_envelope' && record.acceptedAt !== undefined;
    });
    const accepted = outbox.records.get(commitEnvelopeRecordId(clientTxId));
    if (accepted?.type !== 'commit_envelope') {
      throw new Error('missing accepted durable commit envelope');
    }
    const oldAcceptedAt = Date.now() - 25 * 60 * 60 * 1000;
    outbox.records.set(commitEnvelopeRecordId(clientTxId), {
      ...accepted,
      createdAt: oldAcceptedAt - 1,
      sealedAt: oldAcceptedAt,
      acceptedAt: oldAcceptedAt + 1,
      timestamp: oldAcceptedAt,
    });
    queue.dispose();

    queue = new MutationQueue({ enablePersistence: true });
    queue.setCommitOutbox(outbox);
    // Replication and the replayed forward use independent channels. Pin the
    // race where the WAL echo wins before the cached queued receipt returns.
    queue.onDeltaReceived(20_004, undefined, correlationId);
    await queue.restoreDurableCommits();
    await waitFor(
      () => ctx.mocks.mutationExecutor.getCallsByMethod('commit').length === 2,
    );
    await expect(queue.waitForCommitReceipt(clientTxId)).resolves.toMatchObject({
      lastSyncId: 20_004,
    });
    await waitFor(
      () => !outbox.records.has(commitEnvelopeRecordId(clientTxId)),
    );
  });

  it('clears a stranded echo envelope when idempotent replay is upgraded to confirmed', async () => {
    queue.dispose();
    const outbox = new MemoryDurableWrites();
    const clientTxId = 'forwarded-replay-upgrade';
    queue = new MutationQueue({ enablePersistence: true });
    queue.setCommitOutbox(outbox);
    ctx.mocks.mutationExecutor.setStatus('queued');
    const correlationId = 'source-correlation-cleanup-race';
    ctx.mocks.mutationExecutor.setCorrelationId(correlationId);
    await queue.enqueueCommit(clientTxId, [
      {
        type: 'UPDATE',
        model: 'task',
        id: 'task-1',
        input: { title: 'echo already checkpointed' },
      },
    ]);
    await waitFor(
      () => ctx.mocks.mutationExecutor.getCallsByMethod('commit').length === 1,
    );

    // Pin the crash window: the echo completed, but durable-envelope cleanup
    // did not. A restarted client may resume after that echo's checkpoint and
    // therefore cannot depend on seeing the same delta again.
    outbox.failRemove = true;
    queue.onDeltaReceived(20_005, undefined, correlationId);
    await Promise.resolve();
    expect(outbox.records.has(commitEnvelopeRecordId(clientTxId))).toBe(true);
    queue.dispose();

    outbox.failRemove = false;
    ctx.mocks.mutationExecutor.setStatus('confirmed');
    ctx.mocks.mutationExecutor.setSyncId(20_005);
    queue = new MutationQueue({ enablePersistence: true });
    queue.setCommitOutbox(outbox);
    await queue.restoreDurableCommits();
    await waitFor(
      () => ctx.mocks.mutationExecutor.getCallsByMethod('commit').length === 2,
    );
    await expect(queue.waitForCommitReceipt(clientTxId)).resolves.toMatchObject({
      lastSyncId: 20_005,
    });
    await waitFor(
      () => !outbox.records.has(commitEnvelopeRecordId(clientTxId)),
    );
  });

  it('does not confuse same-id notification targets from different models', async () => {
    const clientTxId = 'same-id-different-models';
    const notification = staleNotification('shared-id');
    ctx.mocks.mutationExecutor.setStatus('queued');
    const correlationId = 'source-correlation-same-id-models';
    ctx.mocks.mutationExecutor.setCorrelationId(correlationId);
    ctx.mocks.mutationExecutor.setNotifications([notification]);
    await queue.enqueueCommit(clientTxId, [
      {
        type: 'UPDATE',
        model: 'task',
        id: 'shared-id',
        input: { title: 'held' },
      },
      {
        type: 'UPDATE',
        model: 'comment',
        id: 'shared-id',
        input: { body: 'forwarded' },
      },
    ]);
    const receipt = queue.waitForCommitReceipt(clientTxId);
    let settled = false;
    void receipt.then(() => {
      settled = true;
    });
    await waitFor(
      () => ctx.mocks.mutationExecutor.getCallsByMethod('commit').length === 1,
    );
    await Promise.resolve();
    expect(settled).toBe(false);

    queue.onDeltaReceived(30_001, undefined, correlationId);
    await expect(receipt).resolves.toEqual({
      lastSyncId: 30_001,
      notifications: [notification],
    });
  });

});
