/**
 * Regression coverage for ambiguous transport failures. If the server commits
 * a batch but its acknowledgement is lost, the automatic retry must replay the
 * same ordered operations under the same wire idempotency key.
 */

import { AbloConnectionError } from '@abloatai/transaction/errors';
import type { DurableWriteStore } from '../../src/local/transactions/mutations/durableWriteStore';
import type {
  CommitResult,
  MutationExecutor,
  MutationOperation,
  MutationOptions,
} from '../../src/local/interfaces/index.js';
import {
  MutationQueue,
  type QueuedMutation,
} from '../../src/local/transactions/mutations/MutationQueue';
import { createDurableCommitEnvelope } from '@abloatai/transaction/transactions/settlement/commitEnvelope';
import {
  createTaskFixture,
  createTestContext,
  resetFixtureCounter,
} from '../../src/local/testing';

const USER_CONTEXT = {
  userId: 'user-1',
  organizationId: 'org-1',
};

interface CapturedAttempt {
  operations: MutationOperation[];
  options?: MutationOptions;
}

interface MemoryOutbox {
  readonly store: DurableWriteStore;
  readonly records: Map<string, Record<string, unknown>>;
}

function createMemoryOutbox(options: {
  beforeSeal?: () => Promise<void>;
  failCleanup?: boolean;
} = {}): MemoryOutbox {
  const records = new Map<string, Record<string, unknown>>();
  const store: DurableWriteStore = {
    async seal(
      record: Record<string, unknown>,
      consumedIds: readonly string[],
    ) {
      await options.beforeSeal?.();
      const id = String(record.id);
      const existing = records.get(id);
      if (existing && JSON.stringify(existing) !== JSON.stringify(record)) {
        throw new Error('idempotency_conflict');
      }
      if (!existing && consumedIds.some((id) => !records.has(id))) {
        throw new Error('source already claimed');
      }
      if (!existing) records.set(id, structuredClone(record));
      for (const consumedId of consumedIds) records.delete(consumedId);
      return existing;
    },
    list() {
      return Promise.resolve(
        [...records.values()].map((record) => structuredClone(record)),
      );
    },
    remove(id: string) {
      if (options.failCleanup) return Promise.reject(new Error('cleanup unavailable'));
      records.delete(id);
      return Promise.resolve();
    },
  };
  return { store, records };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error('condition was not met');
}

function failFirstCommitAfterCapturing(
  queue: MutationQueue,
): CapturedAttempt[] {
  const attempts: CapturedAttempt[] = [];
  const commit: MutationExecutor['commit'] = (
    operations: MutationOperation[],
    options?: MutationOptions,
  ): Promise<CommitResult> => {
    attempts.push({
      operations: operations.map((operation) => ({ ...operation })),
      ...(options ? { options: { ...options } } : {}),
    });
    if (attempts.length === 1) {
      // The write may already be durable; only its acknowledgement is known
      // to have been lost from the client's point of view.
      return Promise.reject(
        new AbloConnectionError('connection closed before commit ack'),
      );
    }
    return Promise.resolve({ lastSyncId: 42, status: 'confirmed' as const });
  };
  queue.setMutationExecutor({
    commit,
    executeCreate: jest.fn(),
    executeUpdate: jest.fn(),
    executeDelete: jest.fn(),
    executeArchive: jest.fn(),
    executeUnarchive: jest.fn(),
  });
  return attempts;
}

describe('MutationQueue retry idempotency', () => {
  let queue: MutationQueue;
  let cleanup: () => void;

  beforeEach(() => {
    resetFixtureCounter();
    const context = createTestContext();
    cleanup = context.cleanup;
    queue = new MutationQueue({
      batchDelay: 0,
      maxBatchSize: 50,
      maxRetries: 3,
      retryBackoff: { baseMs: 1, capMs: 1 },
    });
  });

  afterEach(() => {
    queue.dispose();
    cleanup();
  });

  it('retries an ambiguous batch with the identical key, members, and order', async () => {
    const attempts = failFirstCommitAfterCapturing(queue);

    const firstPromise = queue.create(
      createTaskFixture({ title: 'first' }),
      USER_CONTEXT,
    );
    const secondPromise = queue.create(
      createTaskFixture({ title: 'second' }),
      USER_CONTEXT,
    );
    const transactions: QueuedMutation[] = await Promise.all([
      firstPromise,
      secondPromise,
    ]);

    const confirmations = transactions.flatMap((transaction) =>
      transaction.confirmation ? [transaction.confirmation] : [],
    );
    expect(confirmations).toHaveLength(transactions.length);
    await Promise.all(confirmations);

    expect(attempts).toHaveLength(2);
    const firstAttempt = attempts[0];
    const retryAttempt = attempts[1];
    expect(firstAttempt?.options?.idempotencyKey).toMatch(/^commit_/);
    expect(retryAttempt?.options?.idempotencyKey).toBe(
      firstAttempt?.options?.idempotencyKey,
    );
    expect(retryAttempt?.operations).toEqual(firstAttempt?.operations);
    expect(firstAttempt?.operations.map((operation) => operation.transactionId)).toEqual(
      transactions.map((transaction) => transaction.id),
    );
  });

  it('reuses the envelope when reconnect flush replays a lost acknowledgement', async () => {
    queue.dispose();
    queue = new MutationQueue({ batchDelay: 60_000, maxBatchSize: 50 });
    const attempts = failFirstCommitAfterCapturing(queue);

    const transaction = await queue.create(
      createTaskFixture({ title: 'offline write' }),
      USER_CONTEXT,
    );
    // Let the staging microtask move the transaction behind the long batch
    // timer, then simulate two reconnect kicks around one lost ack.
    await Promise.resolve();
    await queue.drainPending();
    await queue.drainPending();
    await transaction.confirmation;

    expect(attempts).toHaveLength(2);
    expect(attempts[0]?.options?.idempotencyKey).toMatch(/^commit_/);
    expect(attempts[1]?.options?.idempotencyKey).toBe(
      attempts[0]?.options?.idempotencyKey,
    );
    expect(attempts[1]?.operations).toEqual(attempts[0]?.operations);
  });

  it('removes reconnect-drained transactions from the canonical execution queue', async () => {
    queue.dispose();
    queue = new MutationQueue({ batchDelay: 60_000, maxBatchSize: 50 });
    const attempts: CapturedAttempt[] = [];
    queue.setMutationExecutor({
      commit: (operations, options) => {
        attempts.push({
          operations: operations.map((operation) => ({ ...operation })),
          ...(options ? { options: { ...options } } : {}),
        });
        return Promise.resolve({ lastSyncId: 42, status: 'confirmed' as const });
      },
      executeCreate: jest.fn(),
      executeUpdate: jest.fn(),
      executeDelete: jest.fn(),
      executeArchive: jest.fn(),
      executeUnarchive: jest.fn(),
    });

    const transaction = await queue.create(
      createTaskFixture({ title: 'drain once' }),
      USER_CONTEXT,
    );
    await Promise.resolve();
    await queue.drainPending();
    await transaction.confirmation;
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(attempts).toHaveLength(1);
  });

  it('keeps caller-supplied keys as separate requests during reconnect flush', async () => {
    queue.dispose();
    queue = new MutationQueue({ batchDelay: 60_000, maxBatchSize: 50 });
    const attempts: CapturedAttempt[] = [];
    queue.setMutationExecutor({
      commit: (operations, options) => {
        attempts.push({
          operations: operations.map((operation) => ({ ...operation })),
          ...(options ? { options: { ...options } } : {}),
        });
        return Promise.resolve({ lastSyncId: attempts.length, status: 'confirmed' as const });
      },
      executeCreate: jest.fn(),
      executeUpdate: jest.fn(),
      executeDelete: jest.fn(),
      executeArchive: jest.fn(),
      executeUnarchive: jest.fn(),
    });

    const first = await queue.create(
      createTaskFixture({ title: 'first explicit key' }),
      USER_CONTEXT,
      { idempotencyKey: 'caller-key-1' },
    );
    const second = await queue.create(
      createTaskFixture({ title: 'second explicit key' }),
      USER_CONTEXT,
      { idempotencyKey: 'caller-key-2' },
    );
    await Promise.resolve();

    await queue.drainPending();
    await Promise.all([first.confirmation, second.confirmation]);

    expect(attempts).toHaveLength(2);
    expect(attempts.map((attempt) => attempt.options?.idempotencyKey)).toEqual([
      'caller-key-1',
      'caller-key-2',
    ]);
    expect(attempts.map((attempt) => attempt.operations)).toEqual([
      [expect.objectContaining({ id: first.modelId, transactionId: first.id })],
      [expect.objectContaining({ id: second.modelId, transactionId: second.id })],
    ]);
  });

  it('treats explicit-key updates as coalescing barriers', async () => {
    queue.dispose();
    queue = new MutationQueue({ batchDelay: 60_000, maxBatchSize: 50 });
    const attempts: CapturedAttempt[] = [];
    queue.setMutationExecutor({
      commit: (operations, options) => {
        attempts.push({
          operations: operations.map((operation) => ({ ...operation })),
          ...(options ? { options: { ...options } } : {}),
        });
        return Promise.resolve({ lastSyncId: attempts.length, status: 'confirmed' as const });
      },
      executeCreate: jest.fn(),
      executeUpdate: jest.fn(),
      executeDelete: jest.fn(),
      executeArchive: jest.fn(),
      executeUnarchive: jest.fn(),
    });
    const task = createTaskFixture({ title: 'before' });
    const first = await queue.update(
      task,
      USER_CONTEXT,
      { title: 'first' },
      { idempotencyKey: 'update-key-1' },
    );
    const second = await queue.update(
      task,
      USER_CONTEXT,
      { title: 'second' },
      { idempotencyKey: 'update-key-2' },
    );
    await Promise.resolve();

    await queue.drainPending();
    await Promise.all([first.confirmation, second.confirmation]);

    expect(attempts.map((attempt) => attempt.options?.idempotencyKey)).toEqual([
      'update-key-1',
      'update-key-2',
    ]);
    expect(attempts.map((attempt) => attempt.operations[0]?.input)).toEqual([
      expect.objectContaining({ title: 'first' }),
      expect.objectContaining({ title: 'second' }),
    ]);
  });

  it('transfers a canceled update journal into its superseding delete envelope', async () => {
    queue.dispose();
    queue = new MutationQueue({ batchDelay: 60_000 });
    const outbox = createMemoryOutbox();
    outbox.records.set('pending-mutation:source-update', {
      id: 'pending-mutation:source-update',
      type: 'pending_mutation',
    });
    outbox.records.set('pending-mutation:source-delete', {
      id: 'pending-mutation:source-delete',
      type: 'pending_mutation',
    });
    queue.setCommitOutbox(outbox.store);
    const commit = jest.fn<Promise<CommitResult>, [MutationOperation[], MutationOptions?]>(
      () => Promise.resolve({ lastSyncId: 12, status: 'confirmed' as const }),
    );
    queue.setMutationExecutor({
      commit,
      executeCreate: jest.fn(),
      executeUpdate: jest.fn(),
      executeDelete: jest.fn(),
      executeArchive: jest.fn(),
      executeUnarchive: jest.fn(),
    });
    const task = createTaskFixture({ title: 'before delete' });
    await queue.update(
      task,
      USER_CONTEXT,
      { title: 'will be canceled' },
      undefined,
      'source-update',
    );
    const deleted = await queue.delete(
      task,
      USER_CONTEXT,
      undefined,
      'source-delete',
    );
    await Promise.resolve();
    await queue.drainPending();
    await deleted.confirmation;

    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit.mock.calls[0]?.[0]?.map((operation) => operation.type)).toEqual([
      'DELETE',
    ]);
    expect(outbox.records.has('pending-mutation:source-update')).toBe(false);
    expect(outbox.records.has('pending-mutation:source-delete')).toBe(false);
  });

  it('never dispatches before the exact envelope is durably sealed', async () => {
    let releaseSeal!: () => void;
    const sealGate = new Promise<void>((resolve) => {
      releaseSeal = resolve;
    });
    let sealStarted = false;
    const outbox = createMemoryOutbox({
      beforeSeal: () => {
        sealStarted = true;
        return sealGate;
      },
    });
    queue.setCommitOutbox(outbox.store);
    const commit = jest.fn<Promise<CommitResult>, [MutationOperation[], MutationOptions?]>(
      () => Promise.resolve({ lastSyncId: 7, status: 'confirmed' as const }),
    );
    queue.setMutationExecutor({
      commit,
      executeCreate: jest.fn(),
      executeUpdate: jest.fn(),
      executeDelete: jest.fn(),
      executeArchive: jest.fn(),
      executeUnarchive: jest.fn(),
    });

    const transaction = await queue.create(
      createTaskFixture({ title: 'write-ahead' }),
      USER_CONTEXT,
    );
    await waitFor(() => sealStarted);
    expect(commit).not.toHaveBeenCalled();

    releaseSeal();
    await transaction.confirmation;
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it('fails queued commits closed when outbox sealing fails', async () => {
    const outbox = createMemoryOutbox({
      beforeSeal: () => Promise.reject(new Error('quota exceeded')),
    });
    queue.setCommitOutbox(outbox.store);
    const commit = jest.fn(() => Promise.resolve({ lastSyncId: 7, status: 'confirmed' as const }));
    queue.setMutationExecutor({
      commit,
      executeCreate: jest.fn(),
      executeUpdate: jest.fn(),
      executeDelete: jest.fn(),
      executeArchive: jest.fn(),
      executeUnarchive: jest.fn(),
    });

    await expect(
      queue.enqueueCommit('caller-durable-key', [
        { type: 'UPDATE', model: 'task', id: 'task-1', input: { title: 'safe' } },
      ]),
    ).rejects.toThrow('Could not persist the durable write before dispatch');
    expect(commit).not.toHaveBeenCalled();
  });

  it('restores a lost-ack envelope with the identical key and operation order', async () => {
    queue.dispose();
    const outbox = createMemoryOutbox();
    queue = new MutationQueue({ batchDelay: 60_000, maxBatchSize: 50 });
    queue.setCommitOutbox(outbox.store);
    const firstAttempts = failFirstCommitAfterCapturing(queue);

    await queue.create(createTaskFixture({ title: 'crash-a' }), USER_CONTEXT);
    await queue.create(createTaskFixture({ title: 'crash-b' }), USER_CONTEXT);
    await Promise.resolve();
    await queue.drainPending();
    expect(firstAttempts).toHaveLength(1);
    expect(outbox.records.size).toBe(1);
    const original = firstAttempts[0];
    queue.dispose();

    const replayQueue = new MutationQueue({ batchDelay: 0 });
    queue = replayQueue;
    replayQueue.setCommitOutbox(outbox.store);
    const replayAttempts: CapturedAttempt[] = [];
    replayQueue.setMutationExecutor({
      commit: (operations, options) => {
        replayAttempts.push({
          operations: operations.map((operation) => ({ ...operation })),
          ...(options ? { options: { ...options } } : {}),
        });
        return Promise.resolve({ lastSyncId: 99, status: 'confirmed' as const });
      },
      executeCreate: jest.fn(),
      executeUpdate: jest.fn(),
      executeDelete: jest.fn(),
      executeArchive: jest.fn(),
      executeUnarchive: jest.fn(),
    });

    await replayQueue.restoreDurableCommits();
    await waitFor(() => replayAttempts.length === 1 && outbox.records.size === 0);
    expect(replayAttempts[0]?.options?.idempotencyKey).toBe(
      original?.options?.idempotencyKey,
    );
    expect(replayAttempts[0]?.operations).toEqual(original?.operations);
  });

  it('leaves an acknowledged envelope replayable when local cleanup fails', async () => {
    queue.dispose();
    const outbox = createMemoryOutbox({ failCleanup: true });
    queue = new MutationQueue({ batchDelay: 0 });
    queue.setCommitOutbox(outbox.store);
    const commit = jest.fn(() => Promise.resolve({ lastSyncId: 8, status: 'confirmed' as const }));
    queue.setMutationExecutor({
      commit,
      executeCreate: jest.fn(),
      executeUpdate: jest.fn(),
      executeDelete: jest.fn(),
      executeArchive: jest.fn(),
      executeUnarchive: jest.fn(),
    });
    const transaction = await queue.create(
      createTaskFixture({ title: 'cleanup-safe' }),
      USER_CONTEXT,
    );
    await transaction.confirmation;
    expect(commit).toHaveBeenCalledTimes(1);
    expect(outbox.records.size).toBe(1);
  });

  it('rejects one atomic key reused for a different request', async () => {
    const commit = jest.fn(() => Promise.resolve({ lastSyncId: 8, status: 'confirmed' as const }));
    queue.setMutationExecutor({
      commit,
      executeCreate: jest.fn(),
      executeUpdate: jest.fn(),
      executeDelete: jest.fn(),
      executeArchive: jest.fn(),
      executeUnarchive: jest.fn(),
    });

    await queue.enqueueCommit('same-key', [
      { type: 'UPDATE', model: 'task', id: 'task-1', input: { title: 'first' } },
    ]);
    await expect(queue.enqueueCommit('same-key', [
      { type: 'UPDATE', model: 'task', id: 'task-1', input: { title: 'different' } },
    ])).rejects.toMatchObject({
      code: 'idempotency_conflict',
      type: 'AbloIdempotencyError',
    });
  });

  it('isolates throwing lifecycle observers from durable dispatch', async () => {
    const outbox = createMemoryOutbox();
    queue.setCommitOutbox(outbox.store);
    const commit = jest.fn(() => Promise.resolve({ lastSyncId: 9, status: 'confirmed' as const }));
    queue.setMutationExecutor({
      commit,
      executeCreate: jest.fn(),
      executeUpdate: jest.fn(),
      executeDelete: jest.fn(),
      executeArchive: jest.fn(),
      executeUnarchive: jest.fn(),
    });
    queue.on('commit:envelope_persisted', () => {
      throw new Error('observer failed');
    });
    queue.on('commit:created', () => {
      throw new Error('undo observer failed');
    });

    await expect(queue.enqueueCommit('observer-safe', [
      { type: 'DELETE', model: 'task', id: 'task-1' },
    ])).resolves.toBeUndefined();
    await waitFor(() => commit.mock.calls.length === 1);
  });

  it('drains past a throwing transaction:completed observer', async () => {
    const outbox = createMemoryOutbox();
    queue.setCommitOutbox(outbox.store);
    const commit = jest.fn(() => Promise.resolve({ lastSyncId: 11, status: 'confirmed' as const }));
    queue.setMutationExecutor({
      commit,
      executeCreate: jest.fn(),
      executeUpdate: jest.fn(),
      executeDelete: jest.fn(),
      executeArchive: jest.fn(),
      executeUnarchive: jest.fn(),
    });
    queue.on('transaction:completed', () => {
      throw new Error('receipt observer failed');
    });
    const firstReceipt = new Promise<void>((resolve) => {
      queue.on('transaction:completed:first-commit', () => {
        resolve();
      });
    });

    await Promise.all([
      queue.enqueueCommit('first-commit', [
        { type: 'DELETE', model: 'task', id: 'task-1' },
      ]),
      queue.enqueueCommit('second-commit', [
        { type: 'DELETE', model: 'task', id: 'task-2' },
      ]),
    ]);

    // A throw from the broadcast observer must not shift the lane a second
    // time (dropping the second commit) or suppress the per-id receipt.
    await waitFor(() => commit.mock.calls.length === 2);
    await firstReceipt;
    await waitFor(() => outbox.records.size === 0);
  });

  it('fails startup closed instead of replaying beyond the idempotency window', async () => {
    const outbox = createMemoryOutbox();
    const old = Date.now() - 23 * 60 * 60 * 1000 - 1;
    const envelope = createDurableCommitEnvelope({
      idempotencyKey: 'too-old-to-replay',
      origin: 'atomic_commit',
      operations: [
        { type: 'DELETE', model: 'task', id: 'task-old' },
      ],
      sourceMutationIds: [],
      commitOptions: {},
      createdAt: old,
      sealedAt: old,
    });
    outbox.records.set(envelope.id, envelope);
    queue.setCommitOutbox(outbox.store);
    const commit = jest.fn(() => Promise.resolve({ lastSyncId: 10, status: 'confirmed' as const }));
    queue.setMutationExecutor({
      commit,
      executeCreate: jest.fn(),
      executeUpdate: jest.fn(),
      executeDelete: jest.fn(),
      executeArchive: jest.fn(),
      executeUnarchive: jest.fn(),
    });

    await expect(queue.restoreDurableCommits()).rejects.toMatchObject({
      code: 'idempotency_conflict',
    });
    expect(commit).not.toHaveBeenCalled();
    expect(outbox.records.has(envelope.id)).toBe(true);
  });
});
