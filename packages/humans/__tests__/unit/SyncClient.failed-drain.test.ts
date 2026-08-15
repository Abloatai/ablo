/**
 * Terminal-failure drain for the pending-mutation pipeline.
 *
 * `stagedMutationIds` claims a batch when a drain begins, and the
 * `commit:envelope_persisted` / `transaction:completed` handlers release the
 * claims on the success path. There was no release on `transaction:failed`:
 * after any terminally rejected write the claimed ids stayed in the set
 * forever, and the size guard at the top of `processPendingMutations` then
 * returned early for every later write — a session-wide write stall.
 *
 * These tests drive a real write through the public path (journal → claim →
 * stage), deliver the queue's terminal `transaction:failed` event, and assert
 * the pipeline drains: journal row removed, pending count zero, and — the
 * load-bearing part — the NEXT write still stages.
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { InstanceCache as ObjectPool } from '../../src/local/InstanceCache';
import { ModelRegistry, setActiveRegistry } from '../../src/local/ModelRegistry';
import { SyncClient } from '../../src/local/SyncClient';
import type { MutationQueue, QueuedMutation } from '../../src/local/transactions/mutations/MutationQueue';
import {
  fakeDatabase,
  registerTestModels,
  createTestConfig,
  createTestContext,
  createEntryLayerFixture,
  MockMutationExecutor,
  type TestContextResult,
} from '../../src/local/testing';

/** Reach the SyncClient's internal queue to deliver lifecycle events. */
function internalQueue(client: SyncClient): MutationQueue {
  return client.mutationQueue;
}

describe('SyncClient transaction:failed drain', () => {
  let registry: ModelRegistry;
  let pool: ObjectPool;
  let client: SyncClient;
  let ctx: TestContextResult;
  let savedRecords: Record<string, unknown>[];
  let removedIds: string[];

  beforeEach(() => {
    registry = new ModelRegistry();
    setActiveRegistry(registry);
    registerTestModels(registry);
    ctx = createTestContext({ config: createTestConfig() });
    pool = new ObjectPool({ maxSize: 1000, gcInterval: 0, useWeakRefs: false }, registry);
    savedRecords = [];
    removedIds = [];
    const database = fakeDatabase({
      saveTransaction: (record) => {
        savedRecords.push(record);
        return Promise.resolve();
      },
      // Claims release at seal time on the success path, so the wedge this
      // suite guards against only exists while sealing fails — model the
      // fail-closed adapter and keep every claim held until the failure event.
      sealTransactionRecord: () => Promise.reject(new Error('seal unavailable')),
      getPersistedTransactions: () => Promise.resolve([]),
      removeTransaction: (id: string) => {
        removedIds.push(id);
        return Promise.resolve();
      },
      getStore: () => undefined,
      clear: () => Promise.resolve(undefined),
    });
    client = new SyncClient(pool, database);
    internalQueue(client).setMutationExecutor(new MockMutationExecutor());
  });

  afterEach(() => {
    client.disconnect();
    pool.clear();
    ctx.cleanup();
  });

  function journaledMutationIds(): string[] {
    return savedRecords
      .map((record) => String(record.id))
      .filter((id) => id.startsWith('pending-mutation:'))
      .map((id) => id.slice('pending-mutation:'.length));
  }

  it('releases claims and journal rows on terminal failure, so later writes still stage', async () => {
    await client.initialize('user-1', 'org-1');

    const layerA = createEntryLayerFixture({ id: 'layer-a', entryId: 'entry-1' });
    client.delete(layerA);
    await client.syncNow();
    expect(client.getSyncStats().pendingMutations).toBe(1);
    const [mutationId] = journaledMutationIds();
    expect(mutationId).toBeTruthy();

    internalQueue(client).emit('transaction:failed', {
      transaction: { sourceMutationIds: [mutationId] },
      error: new Error('permanently rejected'),
      permanent: true,
    });

    expect(client.getSyncStats().pendingMutations).toBe(0);
    expect(removedIds).toContain(`pending-mutation:${mutationId}`);

    // The load-bearing assertion: a later write must still reach the queue.
    // With the claim never released, processPendingMutations returns early
    // forever and this syncNow() hangs on the unstaged write.
    const staged: QueuedMutation[] = [];
    const off = client.onLocalTransaction((tx) => staged.push(tx));
    const layerB = createEntryLayerFixture({ id: 'layer-b', entryId: 'entry-1' });
    client.delete(layerB);
    await client.syncNow();
    off();

    expect(staged.some((tx) => tx.modelId === 'layer-b')).toBe(true);
  });

  it('ignores failures that carry no journal-sourced mutations', async () => {
    await client.initialize('user-1', 'org-1');

    const layer = createEntryLayerFixture({ id: 'layer-c', entryId: 'entry-1' });
    client.delete(layer);
    await client.syncNow();
    expect(client.getSyncStats().pendingMutations).toBe(1);

    // Atomic commits.create failures have no sourceMutationIds; the drain
    // must not touch unrelated pending state.
    internalQueue(client).emit('transaction:failed', {
      transaction: {},
      error: new Error('unrelated commit failure'),
      permanent: true,
    });

    expect(client.getSyncStats().pendingMutations).toBe(1);
  });
});
