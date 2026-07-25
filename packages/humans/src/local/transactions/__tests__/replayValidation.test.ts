/**
 * IDB replay boundary (T1.8) — persisted rows from a previous session (or an
 * older SDK build) must be VALIDATED before re-entering the commit path.
 *
 * Pins three contracts:
 *  1. `deserializePersistedTransaction` — valid rows rehydrate with derived
 *     bookkeeping defaults; malformed rows return `null`; the store's
 *     non-replayable neighbor rows (`'queue'`, `'awaiting_delta'`) are
 *     recognized as such.
 *  2. `MutationQueue.loadPersistedTransactions` — corrupt rows are
 *     dropped + surfaced via `captureMutationFailure`, never replayed.
 *  3. `SyncClient.restoreMutationQueue` — corrupt queue entries are dropped
 *     + logged at debug; valid entries rehydrate into pending mutations; a
 *     restore failure no longer vanishes into an empty catch.
 */
import {
  deserializePersistedTransaction,
  isNonReplayablePersistedRow,
  persistedMutationSchema,
} from '../mutations/replayValidation.js';
import { MutationQueue } from '../mutations/MutationQueue.js';
import { SyncClient } from '../../SyncClient.js';
import { InstanceCache } from '../../InstanceCache.js';
import { ModelRegistry, setActiveRegistry } from '../../ModelRegistry.js';
import {
  createTaskFixture,
  fakeDatabase,
  registerTestModels,
  createTestConfig,
  createTestContext,
  type TestContextResult,
} from '../../testing/index.js';
import type {
  Logger,
  ObservabilityProvider,
  TransactionFailureDetails,
} from '../../interfaces/index.js';
import { noopObservability } from '../../RuntimeContext.js';

const VALID_ROW = {
  id: 'tx_1',
  type: 'update' as const,
  modelName: 'Task',
  modelId: 'task_1',
  data: { title: 'hello' },
  context: { userId: 'user_1', organizationId: 'org_1' },
};

describe('deserializePersistedTransaction', () => {
  let ctx: TestContextResult;

  beforeEach(() => {
    ctx = createTestContext({ config: createTestConfig() });
  });

  afterEach(() => {
    ctx.cleanup();
  });

  it('rehydrates a valid row with derived bookkeeping defaults', () => {
    const tx = deserializePersistedTransaction(VALID_ROW);
    if (tx === null) throw new Error('expected VALID_ROW to rehydrate into a transaction');
    expect(tx.status).toBe('pending');
    expect(tx.modelKey).toBe('task');
    expect(tx.attempts).toBe(0);
    expect(tx.priority).toBe('normal');
    expect(typeof tx.createdAt).toBe('number');
    expect(tx.data).toEqual({ title: 'hello' });
  });

  it('preserves the commit envelope needed for an exact retry', () => {
    const commitEnvelope = {
      idempotencyKey: 'commit_retry-safe',
      operationIndex: 1,
      operationCount: 2,
    };
    const tx = deserializePersistedTransaction({
      ...VALID_ROW,
      commitEnvelope,
    });

    expect(tx?.commitEnvelope).toEqual(commitEnvelope);
  });

  it('rejects malformed persisted commit envelopes', () => {
    expect(
      deserializePersistedTransaction({
        ...VALID_ROW,
        commitEnvelope: {
          idempotencyKey: 'commit_partial',
          operationIndex: 2,
          operationCount: 2,
        },
      }),
    ).toBeNull();
  });

  it('returns null for rows missing addressing or identity fields', () => {
    expect(deserializePersistedTransaction({ id: 'tx_2' })).toBeNull();
    expect(
      deserializePersistedTransaction({ ...VALID_ROW, type: 'not-a-type' }),
    ).toBeNull();
    expect(deserializePersistedTransaction({ ...VALID_ROW, context: {} })).toBeNull();
    expect(deserializePersistedTransaction(null)).toBeNull();
    expect(deserializePersistedTransaction('garbage')).toBeNull();
  });

  it('recognizes the non-replayable neighbor rows in the same store', () => {
    expect(isNonReplayablePersistedRow({ id: 'mutation-queue', type: 'queue' })).toBe(true);
    expect(
      isNonReplayablePersistedRow({ id: 'awaiting_tx_9', type: 'awaiting_delta' }),
    ).toBe(true);
    expect(isNonReplayablePersistedRow(VALID_ROW)).toBe(false);
  });
});

describe('MutationQueue.loadPersistedTransactions', () => {
  let ctx: TestContextResult;
  let captured: TransactionFailureDetails[];

  beforeEach(() => {
    captured = [];
    const observability: ObservabilityProvider = {
      ...noopObservability,
      captureMutationFailure: (info: TransactionFailureDetails) => {
        captured.push(info);
      },
    };
    ctx = createTestContext({ config: createTestConfig(), observability });
  });

  afterEach(() => {
    ctx.cleanup();
  });

  it('drops corrupt rows with a captureMutationFailure, replays valid ones', async () => {
    const queue = new MutationQueue({ enablePersistence: true, batchDelay: 60_000 });
    const database = fakeDatabase({
      getPersistedTransactions: () =>
        Promise.resolve([
          { id: 'corrupt_1', type: 'update' }, // missing model addressing/context
          { id: 'mutation-queue', type: 'queue', mutations: [] }, // neighbor row: silent skip
          VALID_ROW, // replayable
        ]),
    });

    await queue.loadPersistedTransactions(database);

    const stats = queue.getStats();
    expect(stats.pending).toBe(1);
    // Exactly ONE capture: the corrupt row. The 'queue' neighbor is expected.
    expect(captured).toHaveLength(1);
    expect(captured[0]?.context).toBe('deserialize-persisted-transaction');
    queue.dispose();
  });
});

describe('SyncClient.restoreMutationQueue (via initialize)', () => {
  let ctx: TestContextResult;
  let registry: ModelRegistry;
  let pool: InstanceCache;
  let debugLog: jest.Mock;

  beforeEach(() => {
    debugLog = jest.fn();
    const logger: Logger = {
      debug: debugLog,
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    };
    registry = new ModelRegistry();
    setActiveRegistry(registry);
    registerTestModels(registry);
    ctx = createTestContext({ config: createTestConfig(), logger });
    pool = new InstanceCache({ maxSize: 1000, gcInterval: 0, useWeakRefs: false }, registry);
  });

  afterEach(() => {
    pool.stopGC();
    pool.clear();
    ctx.cleanup();
  });

  function makeClient(persisted: unknown[]): SyncClient {
    const database = fakeDatabase({
      saveTransaction: () => Promise.resolve(undefined),
      getPersistedTransactions: () => Promise.resolve(persisted),
      getStore: () => undefined,
      clear: () => Promise.resolve(undefined),
    });
    return new SyncClient(pool, database);
  }

  it('replays valid persisted mutations and drops corrupt ones with a debug log', async () => {
    const client = makeClient([
      {
        id: 'mutation-queue',
        type: 'queue',
        timestamp: Date.now(),
        mutations: [
          {
            type: 'update',
            modelName: 'Task',
            modelData: { __typename: 'Task', id: 'task_1', title: 'restored' },
            timestamp: new Date().toISOString(),
          },
          // Corrupt: no modelData at all — must be dropped, not crash restore.
          { type: 'update', modelName: 'Task', timestamp: new Date().toISOString() },
          // Corrupt: unknown mutation type.
          {
            type: 'explode',
            modelName: 'Task',
            modelData: { __typename: 'Task', id: 'task_2' },
            timestamp: new Date().toISOString(),
          },
        ],
      },
    ]);

    await client.initialize('user_1', 'org_1');

    expect(client.getState().pendingMutations).toBe(1);
    const dropLogs = debugLog.mock.calls.filter((c: [string, ...unknown[]]) =>
      c[0].includes('Dropping malformed persisted mutation'),
    );
    expect(dropLogs).toHaveLength(2);
    client.disconnect();
  });

  it('fails closed when the durable commit outbox is unreadable', async () => {
    const database = fakeDatabase({
      saveTransaction: () => Promise.resolve(undefined),
      getPersistedTransactions: () => Promise.reject(new Error('IDB store gone')),
      getStore: () => undefined,
      clear: () => Promise.resolve(undefined),
    });
    const client = new SyncClient(pool, database);

    await expect(client.initialize('user_1', 'org_1')).rejects.toThrow('IDB store gone');

    const failLogs = debugLog.mock.calls.filter((c: [string, ...unknown[]]) =>
      c[0].includes('Failed to restore durable writes'),
    );
    expect(failLogs).toHaveLength(1);
    client.disconnect();
  });

  it('journals writes queued before identity once initialization supplies scope', async () => {
    ctx.cleanup();
    ctx = createTestContext({ config: createTestConfig(), startOffline: true });
    const saved: Record<string, unknown>[] = [];
    const database = fakeDatabase({
      saveTransactions: (rows: readonly Record<string, unknown>[]) => {
        saved.push(...rows);
        return Promise.resolve();
      },
      saveTransaction: (row: Record<string, unknown>) => {
        saved.push(row);
        return Promise.resolve();
      },
      getPersistedTransactions: () => Promise.resolve([]),
      sealTransactionRecord: () => Promise.resolve(undefined),
      removeTransaction: () => Promise.resolve(),
      getStore: () => undefined,
      clear: () => Promise.resolve(),
    });
    const client = new SyncClient(pool, database);

    client.add(createTaskFixture({ title: 'queued before auth' }));
    await Promise.resolve();
    await Promise.resolve();
    expect(saved).toEqual([]);

    await client.initialize('user_preinit', 'org_preinit');
    expect(saved).toEqual([
      expect.objectContaining({
        type: 'pending_mutation',
        storageVersion: 2,
        scope: {
          organizationId: 'org_preinit',
          participantId: 'user_preinit',
          namespace: 'default',
        },
      }),
    ]);
    expect(client.getState().pendingMutations).toBe(1);
    client.disconnect();
  });

  it('migrates scope-less pending-mutation v1 records to scoped v2', async () => {
    ctx.cleanup();
    ctx = createTestContext({ config: createTestConfig(), startOffline: true });
    const saved: Record<string, unknown>[] = [];
    const legacy = {
      id: 'pending-mutation:legacy-1',
      type: 'pending_mutation',
      storageVersion: 1,
      mutation: {
        mutationId: 'legacy-1',
        type: 'update',
        modelName: 'Task',
        modelData: { __typename: 'Task', id: 'task-legacy', title: 'restored' },
        timestamp: new Date().toISOString(),
      },
      timestamp: Date.now(),
    };
    const database = fakeDatabase({
      saveTransaction: (row: Record<string, unknown>) => {
        saved.push(row);
        return Promise.resolve();
      },
      getPersistedTransactions: () => Promise.resolve([legacy]),
      sealTransactionRecord: () => Promise.resolve(undefined),
      removeTransaction: () => Promise.resolve(),
      getStore: () => undefined,
      clear: () => Promise.resolve(),
    });
    const client = new SyncClient(pool, database);

    await client.initialize('user_migrated', 'org_migrated');
    expect(saved).toEqual([
      expect.objectContaining({
        id: 'pending-mutation:legacy-1',
        storageVersion: 2,
        scope: {
          organizationId: 'org_migrated',
          participantId: 'user_migrated',
          namespace: 'default',
        },
      }),
    ]);
    expect(client.getState().pendingMutations).toBe(1);
    client.disconnect();
  });
});

describe('persistedMutationSchema', () => {
  it('accepts the exact shape persistMutationQueue writes', () => {
    const parsed = persistedMutationSchema.safeParse({
      type: 'create',
      modelData: { id: 'x' },
      modelName: 'Task',
      timestamp: new Date().toISOString(),
      writeOptions: { readAt: 12, onStale: 'reject' },
    });
    expect(parsed.success).toBe(true);
  });
});
