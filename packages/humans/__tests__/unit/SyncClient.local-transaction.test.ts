/**
 * SyncClient local-transaction relay — regression guard for the
 * "undo records nothing" dead-emitter bug.
 *
 * `BaseSyncedStore.subscribeLocalMutations` (the feed every UndoScope taps for
 * stream recording) routes through `SyncClient.onLocalTransaction`. The bug:
 * an earlier version routed through `SyncClient.subscribe('transaction:created')`
 * instead. Those are TWO DIFFERENT emitters:
 *
 *   - `transaction:created` is emitted ONLY by the internal `MutationQueue`.
 *   - `SyncClient.subscribe(event, h)` registers `h` on SyncClient's OWN
 *     EventEmitter (`super.on`), which never re-broadcasts `transaction:created`.
 *
 * So the undo listener sat on a channel that never fired → every local
 * create/update/delete was invisible to undo. `onLocalTransaction` taps the
 * queue directly (mirrors `onMutationFailure`), which is the fix.
 *
 * These tests drive a REAL mutation through the SyncClient's queue and assert
 * the relay reaches `onLocalTransaction` — and explicitly that the old
 * `subscribe('transaction:created')` path stays silent, so a future refactor
 * can't quietly reintroduce the dead emitter.
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { InstanceCache as ObjectPool } from '../../src/local/InstanceCache';
import { ModelRegistry, setActiveRegistry } from '../../src/local/ModelRegistry';
import { SyncClient } from '../../src/local/SyncClient';
import type { MutationQueue, QueuedMutation } from '../../src/local/transactions/mutations/MutationQueue';
import { Database } from '../../src/local/Database';
import {
  registerTestModels,
  createTestConfig,
  createTestContext,
  createSlideLayerFixture,
  type TestContextResult,
} from '../../src/local/testing';

const TEST_USER_CONTEXT = { userId: 'user-1', organizationId: 'org-1' };

/** Reach the SyncClient's internal queue — the only emitter of `transaction:created`. */
function internalQueue(client: SyncClient): MutationQueue {
  return client.mutationQueue;
}

describe('SyncClient.onLocalTransaction (undo stream relay)', () => {
  let registry: ModelRegistry;
  let pool: ObjectPool;
  let database: Database;
  let client: SyncClient;
  let ctx: TestContextResult;

  beforeEach(() => {
    registry = new ModelRegistry();
    setActiveRegistry(registry);
    registerTestModels(registry);
    ctx = createTestContext({ config: createTestConfig() });
    pool = new ObjectPool({ maxSize: 1000, gcInterval: 0, useWeakRefs: false }, registry);
    database = {
      saveTransaction: async () => undefined,
      getPersistedTransactions: async () => [],
      getStore: () => null,
      clear: async () => undefined,
    } as unknown as Database;
    client = new SyncClient(pool, database);
  });

  afterEach(() => {
    client.disconnect();
    pool.clear();
    ctx.cleanup();
  });

  it('delivers a local create to onLocalTransaction with the full payload', async () => {
    const received: QueuedMutation[] = [];
    const off = client.onLocalTransaction((tx) => received.push(tx));

    const layer = createSlideLayerFixture({ id: 'layer-relay-1', slideId: 'slide-1' });
    await internalQueue(client).create(layer, TEST_USER_CONTEXT);

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      type: 'create',
      modelName: 'SlideLayer',
      modelId: 'layer-relay-1',
    });
    // `data` must be present — undo derives the inverse from it.
    expect(received[0]?.data).toBeTruthy();

    off();
  });

  it('the unsubscribe disposer stops further deliveries', async () => {
    const received: QueuedMutation[] = [];
    const off = client.onLocalTransaction((tx) => received.push(tx));
    off();

    await internalQueue(client).create(
      createSlideLayerFixture({ id: 'layer-relay-2', slideId: 'slide-1' }),
      TEST_USER_CONTEXT,
    );

    expect(received).toHaveLength(0);
  });

  it('subscribe("transaction:created") is the DEAD emitter (regression guard)', async () => {
    // The exact bug: the undo feed must NOT be wired through subscribe(),
    // because SyncClient's own emitter never fires `transaction:created`.
    const viaOnLocal: QueuedMutation[] = [];
    const viaSubscribe: unknown[] = [];
    const offLocal = client.onLocalTransaction((tx) => viaOnLocal.push(tx));
    const offSub = client.subscribe('transaction:created', () => viaSubscribe.push(true));

    await internalQueue(client).create(
      createSlideLayerFixture({ id: 'layer-relay-3', slideId: 'slide-1' }),
      TEST_USER_CONTEXT,
    );

    expect(viaOnLocal).toHaveLength(1); // correct path fires
    expect(viaSubscribe).toHaveLength(0); // dead emitter stays silent

    offLocal();
    offSub();
  });
});
