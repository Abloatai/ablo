/**
 * Delete-after-in-flight-update must not absorb consumed journal sources.
 *
 * A delete cancels the row's pending and in-flight updates and absorbs their
 * journal `sourceMutationIds`, so the writes it supersedes settle under the
 * delete's envelope. But an update that already SEALED an envelope has had its
 * journal rows consumed by that seal — they belong to that envelope forever.
 * A delete that lists them anyway poisons its own seal: the durable store's
 * new-envelope guard finds the sources missing and rejects with
 * `idempotency_conflict`, the optimistic delete reverts, and the user watches
 * their deleted layer come back ("Your delete to SlideLayer was not saved" in
 * the field). Edit a row, then delete it while the edit is on the wire —
 * that's the whole reproduction.
 *
 * These tests drive the real SyncClient + MutationQueue with a scripted
 * executor: the update's commit HANGS in flight while the delete is issued,
 * and the assertion is the fix's contract — the delete's sealed envelope
 * never lists a source id the update's envelope already consumed.
 */

import { SyncClient } from '../../SyncClient.js';
import type { Database } from '../../Database.js';
import { createTestHarness } from '../../testing/helpers/syncEngineHarness.js';
import type { TestHarness } from '../../testing/helpers/syncEngineHarness.js';
import { createTaskFixture } from '../../testing/fixtures/models.js';
import { ModelScope } from '@abloatai/transaction/types';
import type {
  DurableWriteStore,
  PendingWrite,
} from '../mutations/durableWriteStore.js';

function memoryOutbox(): DurableWriteStore & {
  records: Map<string, PendingWrite>;
  /** Append-only seal history — a confirmed envelope is removed from the
   *  store, so assertions about what a seal CLAIMED must read this. */
  sealed: PendingWrite[];
} {
  const records = new Map<string, PendingWrite>();
  const sealed: PendingWrite[] = [];
  return {
    records,
    sealed,
    seal(record): Promise<void> {
      records.set(record.id, record);
      sealed.push(record);
      return Promise.resolve();
    },
    list: () => Promise.resolve([...records.values()]),
    remove(id): Promise<void> {
      records.delete(id);
      return Promise.resolve();
    },
  };
}

function memoryDatabase(): Database {
  const rows = new Map<string, unknown>();
  const db = {
    saveTransaction: (record: { id: string }) => {
      rows.set(record.id, structuredClone(record));
      return Promise.resolve();
    },
    saveTransactions: (records: { id: string }[]) => {
      for (const record of records) rows.set(record.id, structuredClone(record));
      return Promise.resolve();
    },
    getPersistedTransactions: () => Promise.resolve([...rows.values()]),
    removeTransaction: (id: string) => {
      rows.delete(id);
      return Promise.resolve();
    },
  };
  return db as Database;
}

function scriptedExecutor(holdFirst: boolean) {
  const calls: { ops: { type: string; id: string }[] }[] = [];
  let syncId = 0;
  let releaseFirst: (() => void) | undefined;
  const unreachable = (method: string) =>
    Promise.reject(new Error(`scriptedExecutor: unexpected ${method} call`));
  const executor: import('../../interfaces/index.js').MutationExecutor = {
    commit: (operations) => {
      const index = calls.length;
      calls.push({ ops: operations.map((op) => ({ type: op.type, id: op.id })) });
      syncId += 1;
      const result = {
        lastSyncId: syncId,
        status: 'confirmed' as const,
        statusAt: '2026-08-05T10:00:00.058Z',
      };
      if (holdFirst && index === 0) {
        // Held in flight until the test releases it — the window in which the
        // user's delete arrives in the field.
        return new Promise((resolve) => {
          releaseFirst = () => { resolve(result); };
        });
      }
      return Promise.resolve(result);
    },
    executeCreate: () => unreachable('executeCreate'),
    executeUpdate: () => unreachable('executeUpdate'),
    executeDelete: () => unreachable('executeDelete'),
    executeArchive: () => unreachable('executeArchive'),
    executeUnarchive: () => unreachable('executeUnarchive'),
  };
  return { calls, executor, releaseFirst: () => releaseFirst?.() };
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The journal sources a sealed record claimed, across the store's union. */
const sourcesOf = (record: PendingWrite): readonly string[] =>
  'sourceMutationIds' in record ? record.sourceMutationIds : [];

async function eventually(
  predicate: () => boolean,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await wait(50);
  }
  return predicate();
}

describe('delete after an in-flight update on the same row', () => {
  let harness: TestHarness;
  let syncClient: SyncClient;
  let outbox: ReturnType<typeof memoryOutbox>;

  beforeEach(async () => {
    harness = createTestHarness();
    outbox = memoryOutbox();
    syncClient = new SyncClient(harness.pool, memoryDatabase(), outbox);
    await syncClient.initialize('user-1', 'org-1');
  });

  afterEach(() => {
    syncClient.dispose();
    harness.cleanup();
  });

  it("the delete's envelope never lists sources a sealed update already consumed", async () => {
    const { calls, executor, releaseFirst } = scriptedExecutor(true);
    syncClient.getMutationQueue().setMutationExecutor(executor);

    const task = createTaskFixture({ title: 'before' });
    task.markAsPersisted();
    task.clearChanges();
    harness.pool.add(task, ModelScope.live);

    // The edit: dispatched and HELD in flight — its envelope is sealed, so
    // its journal sources are consumed and belong to it.
    task.applyChanges({ title: 'after' });
    syncClient.update(task);
    expect(await eventually(() => calls.length >= 1, 3_000)).toBe(true);

    expect(outbox.sealed).toHaveLength(1);
    const updateEnvelope = outbox.sealed[0];
    if (!updateEnvelope) throw new Error('update envelope was not sealed');
    const consumed = new Set(sourcesOf(updateEnvelope));
    expect(consumed.size).toBeGreaterThan(0);

    // The delete, while the edit is still on the wire. Staging is where the
    // absorption happens — the delete cancels the executing update and takes
    // its sources — so the poison (before the fix) is already in place here.
    // The queue announces staging on its own emitter, so the test listens
    // rather than reaching into private state.
    let deleteStaged = false;
    syncClient.getMutationQueue().on('transaction:created', (tx: { type?: string }) => {
      if (tx.type === 'delete') deleteStaged = true;
    });
    syncClient.delete(task);
    expect(await eventually(() => deleteStaged, 3_000)).toBe(true);

    // The edit settles; the delete may now dispatch — in the field this is
    // the update's ~200ms round trip completing after the user hit delete.
    releaseFirst();
    expect(await eventually(() => calls.length >= 2, 5_000)).toBe(true);
    expect(calls[1]?.ops.some((op) => op.type === 'DELETE')).toBe(true);

    // The fix's contract: the delete sealed its own envelope, and it does not
    // claim a single journal source the update's seal already consumed —
    // listing one is what made the durable store reject the delete and revert
    // it in front of the user.
    const deleteEnvelope = outbox.sealed.find(
      (record) => record.id !== updateEnvelope.id,
    );
    if (!deleteEnvelope) throw new Error('delete envelope was not sealed');
    const overlap = sourcesOf(deleteEnvelope).filter((id) => consumed.has(id));
    expect(overlap).toEqual([]);
  });
});
