import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { InstanceCache as ObjectPool } from '../../src/local/InstanceCache';
import { ModelRegistry, setActiveRegistry } from '../../src/local/ModelRegistry';
import { SyncClient } from '../../src/local/SyncClient';
import {
  createTestConfig,
  createTestContext,
  createItemFixture,
  fakeDatabase,
  MockMutationExecutor,
  registerTestModels,
  type TestContextResult,
} from '../../src/local/testing';

describe('SyncClient model-write staging', () => {
  let ctx: TestContextResult;
  let client: SyncClient;
  let executor: MockMutationExecutor;
  let pool: ObjectPool;

  beforeEach(() => {
    const registry = new ModelRegistry();
    setActiveRegistry(registry);
    registerTestModels(registry);
    ctx = createTestContext({ config: createTestConfig() });
    pool = new ObjectPool({ maxSize: 100, gcInterval: 0, useWeakRefs: false }, registry);
    executor = new MockMutationExecutor();
    const database = fakeDatabase({
      saveTransaction: () => Promise.resolve(),
      saveTransactions: () => Promise.resolve(),
      removeTransaction: () => Promise.resolve(),
      getPersistedTransactions: () => Promise.resolve([]),
      sealTransactionRecord: () => Promise.resolve(),
    });
    client = new SyncClient(pool, database, {
      seal: () => Promise.resolve(),
      list: () => Promise.resolve([]),
      remove: () => Promise.resolve(),
    });
    client.mutationQueue.setMutationExecutor(executor);
  });

  afterEach(() => {
    client.disconnect();
    pool.clear();
    ctx.cleanup();
  });

  it('batches concurrent confirmed model drains into one commit', async () => {
    await client.initialize('user-1', 'org-1');
    const models = ['a', 'b', 'c'].map((id) => createItemFixture({ id }));

    await Promise.all(
      models.map(async (model) => {
        client.add(model);
        await Promise.resolve();
        await client.syncNow();
        await client.waitForConfirmation('Item', model.id);
      }),
    );

    const commits = executor.getCallsByMethod('commit');
    expect(commits).toHaveLength(1);
    expect(commits[0]?.operations).toHaveLength(3);
  });
});
