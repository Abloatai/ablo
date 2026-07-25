/**
 * Commit-lane → undo stream bridge.
 *
 * `ablo.commits.create` (the agent/atomic write door) historically bypassed
 * undo: only the model-proxy lane emitted `transaction:created`. The bridge
 * pins that `SyncClient.onLocalTransaction` ALSO surfaces commit-lane
 * envelopes (via the queue's `commit:created` event), with previous state
 * captured from the pool so the recorder can derive inverse ops:
 *
 *   - UPDATE previousData is restricted to the keys the op wrote (a full-row
 *     inverse would clobber concurrent edits to unrelated fields on revert);
 *   - DELETE of a pool-resident row carries the full row (re-create on undo);
 *   - DELETE of a row the local graph never saw is skipped (not invertible);
 *   - the echo tracker's `transaction:created` path is NOT fed (no optimistic
 *     apply happens on this lane, so there is no echo to suppress).
 */

import { SyncClient } from '../../SyncClient.js';
import type { QueuedMutation } from '../mutations/MutationQueue.js';
import type { Database } from '../../Database.js';
import { createTestHarness } from '../../testing/helpers/syncEngineHarness.js';
import type { TestHarness } from '../../testing/helpers/syncEngineHarness.js';
import { createTaskFixture } from '../../testing/fixtures/models.js';
import { ModelScope } from '@abloatai/transaction/types';
import type {
  DurableWriteStore,
  PendingWrite,
} from '../mutations/durableWriteStore.js';

function memoryOutbox(beforeSeal?: () => Promise<void>): DurableWriteStore {
  const records = new Map<string, PendingWrite>();
  return {
    seal(record): Promise<void> {
      const wait = beforeSeal?.() ?? Promise.resolve();
      return wait.then(() => {
        const existing = records.get(record.id);
        if (existing && JSON.stringify(existing) !== JSON.stringify(record)) {
          throw new Error('idempotency conflict');
        }
        records.set(record.id, record);
      });
    },
    list: () => Promise.resolve([...records.values()]),
    remove(id): Promise<void> {
      records.delete(id);
      return Promise.resolve();
    },
  };
}

describe('commit-lane writes reach the undo stream', () => {
  let harness: TestHarness;
  let syncClient: SyncClient;
  let seen: QueuedMutation[];
  let unsubscribe: () => void;

  beforeEach(() => {
    harness = createTestHarness();
    // The constructor only stores the refs; Database is exercised solely by
    // persistence paths this test never triggers (same stubbing pattern as
    // hydration-chain.test.ts uses for SyncClient itself).
    syncClient = new SyncClient(harness.pool, {} as Database, memoryOutbox());
    seen = [];
    unsubscribe = syncClient.onLocalTransaction((tx) => seen.push(tx));
  });

  afterEach(() => {
    unsubscribe();
    syncClient.dispose();
    harness.cleanup();
  });

  it('surfaces an UPDATE with previousData restricted to the written keys', async () => {
    const task = createTaskFixture({ title: 'Before', status: 'todo' });
    harness.pool.add(task, ModelScope.live);

    await syncClient.getMutationQueue().enqueueCommit('ctx_update', [
      { type: 'UPDATE', model: 'task', id: task.id, input: { title: 'After' } },
    ]);

    expect(seen).toHaveLength(1);
    const tx = seen[0];
    if (!tx) throw new Error('expected one surfaced transaction');
    expect(tx.type).toBe('update');
    expect(tx.modelId).toBe(task.id);
    expect(tx.data).toEqual({ title: 'After' });
    // Only the patched key — NOT the full row.
    expect(tx.previousData).toEqual({ title: 'Before' });
  });

  it('surfaces a DELETE of a resident row with the full previous row', async () => {
    const task = createTaskFixture({ title: 'Doomed' });
    harness.pool.add(task, ModelScope.live);

    await syncClient.getMutationQueue().enqueueCommit('ctx_delete', [
      { type: 'DELETE', model: 'task', id: task.id },
    ]);

    expect(seen).toHaveLength(1);
    const tx = seen[0];
    if (!tx) throw new Error('expected one surfaced transaction');
    expect(tx.type).toBe('delete');
    expect(
      (tx.previousData as Record<string, unknown>).title,
    ).toBe('Doomed');
  });

  it('skips a DELETE of a row the local graph never saw', async () => {
    await syncClient.getMutationQueue().enqueueCommit('ctx_ghost', [
      { type: 'DELETE', model: 'task', id: 'task-never-seen' },
    ]);

    expect(seen).toHaveLength(0);
  });

  it('surfaces a CREATE with null previousData and groups multi-op envelopes in one tick', async () => {
    const task = createTaskFixture({ title: 'Sibling' });
    harness.pool.add(task, ModelScope.live);

    await syncClient.getMutationQueue().enqueueCommit('ctx_multi', [
      { type: 'CREATE', model: 'task', id: 'task-new', input: { title: 'Born' } },
      { type: 'UPDATE', model: 'task', id: task.id, input: { title: 'Renamed' } },
    ]);

    // Both ops are emitted together after the envelope is durably sealed, so
    // the recorder's per-tick flush coalesces them into ONE undo entry.
    expect(seen).toHaveLength(2);
    const [createTx, updateTx] = seen;
    if (!createTx || !updateTx) throw new Error('expected two surfaced transactions');
    expect(createTx.type).toBe('create');
    expect(createTx.previousData).toBeNull();
    expect(updateTx.type).toBe('update');
  });

  it('stops surfacing commit-lane writes after unsubscribe', async () => {
    unsubscribe();
    await syncClient.getMutationQueue().enqueueCommit('ctx_after_off', [
      { type: 'CREATE', model: 'task', id: 'task-x', input: { title: 'x' } },
    ]);
    expect(seen).toHaveLength(0);
    // afterEach calls unsubscribe again — make that a no-op double call.
    unsubscribe = () => {};
  });

  it('captures undo state before an asynchronous durable seal', async () => {
    unsubscribe();
    syncClient.dispose();
    let releaseSeal!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseSeal = resolve;
    });
    syncClient = new SyncClient(
      harness.pool,
      {} as Database,
      memoryOutbox(() => gate),
    );
    seen = [];
    unsubscribe = syncClient.onLocalTransaction((tx) => seen.push(tx));
    const task = createTaskFixture({ title: 'Before seal' });
    harness.pool.add(task, ModelScope.live);

    const pending = syncClient.getMutationQueue().enqueueCommit('ctx_snapshot', [
      { type: 'UPDATE', model: 'task', id: task.id, input: { title: 'Committed' } },
    ]);
    await Promise.resolve();
    Object.assign(task, { title: 'Changed while sealing' });
    releaseSeal();
    await pending;

    expect(seen[0]?.previousData).toEqual({ title: 'Before seal' });
  });
});
