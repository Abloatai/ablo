/**
 * Drain liveness — the staged-batch lock must never wedge the pipeline.
 *
 * `SyncClient.processPendingMutations` waits for every in-progress durability
 * stage before draining confirmation. Those stage promises must always settle,
 * or every later write in the session queues silently forever (the "moves stop
 * persisting but nothing errors" field bug).
 *
 * These tests drive the real SyncClient + MutationQueue with a controllable
 * executor and assert the invariant directly: after a first write settles in
 * ANY way, a second write to a different row still reaches the wire and the
 * staged set drains.
 */

import { z } from 'zod';
import { isObservable, observable } from 'mobx';
import { SyncClient } from '../../SyncClient.js';
import type { Database } from '../../Database.js';
import { registerModelsFromSchema } from '../../client/modelRegistration.js';
import { createTestHarness } from '../../testing/helpers/syncEngineHarness.js';
import type { TestHarness } from '../../testing/helpers/syncEngineHarness.js';
import { createItemFixture } from '../../testing/fixtures/models.js';
import { defineSchema } from '@abloatai/transaction/schema/schema';
import { model } from '@abloatai/transaction/schema/model';
import { ModelScope } from '@abloatai/transaction/types';
import { AbloError } from '@abloatai/transaction/errors';
import type {
  DurableWriteStore,
  PendingWrite,
} from '../mutations/durableWriteStore.js';

function memoryOutbox(): DurableWriteStore {
  const records = new Map<string, PendingWrite>();
  return {
    seal(record): Promise<void> {
      records.set(record.id, record);
      return Promise.resolve();
    },
    list: () => Promise.resolve([...records.values()]),
    remove(id): Promise<void> {
      records.delete(id);
      return Promise.resolve();
    },
  };
}

/**
 * The journal/persistence surface the drain path actually touches. Records are
 * passed through `structuredClone` before storing — the same serialization
 * IndexedDB applies in the browser. A journal record carrying a non-cloneable
 * value (a MobX observable proxy leaked into `modelData` or
 * `capturedChanges`) must fail HERE the way it fails in production; a plain
 * Map store silently accepts what the real database rejects.
 */
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

interface CommitCall {
  ops: { type: string; id: string; input?: Record<string, unknown> }[];
  idempotencyKey?: string;
}

/**
 * Executor whose `commit` behavior is scripted per call: each entry resolves,
 * rejects, or hangs. Calls beyond the script resolve normally. The per-model
 * execute* methods are unreachable here — the queue's batch path routes every
 * write through `commit` — so they fail loudly if a refactor ever changes that.
 */
function scriptedExecutor(script: ('resolve' | 'reject' | 'hang')[]) {
  const calls: CommitCall[] = [];
  let syncId = 0;
  const unreachable = (method: string) =>
    Promise.reject(new Error(`scriptedExecutor: unexpected ${method} call`));
  const executor: import('../../interfaces/index.js').MutationExecutor = {
    commit: (operations, options) => {
      const behavior = script[calls.length] ?? 'resolve';
      calls.push({
        ops: operations.map((op) => ({
          type: op.type,
          id: op.id,
          ...(op.input !== undefined ? { input: op.input } : {}),
        })),
        ...(options?.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}),
      });
      if (behavior === 'hang') return new Promise(() => undefined);
      if (behavior === 'reject') {
        return Promise.reject(new Error('server rejected this commit'));
      }
      syncId += 1;
      return Promise.resolve({
        lastSyncId: syncId,
        status: 'confirmed' as const,
        statusAt: '2026-08-05T10:00:00.058Z',
      });
    },
    executeCreate: () => unreachable('executeCreate'),
    executeUpdate: () => unreachable('executeUpdate'),
    executeDelete: () => unreachable('executeDelete'),
    executeArchive: () => unreachable('executeArchive'),
    executeUnarchive: () => unreachable('executeUnarchive'),
  };
  return { calls, executor };
}

function pendingStagesOf(client: SyncClient): Set<Promise<void>> {
  return Reflect.get(client, 'pendingStages') as Set<Promise<void>>;
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Poll until `predicate` holds or `timeoutMs` elapses. */
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

describe('staged-batch drain liveness', () => {
  let harness: TestHarness;
  let syncClient: SyncClient;

  beforeEach(async () => {
    harness = createTestHarness();
    syncClient = new SyncClient(harness.pool, memoryDatabase(), memoryOutbox());
    await syncClient.initialize('user-1', 'org-1');
  });

  afterEach(() => {
    syncClient.dispose();
    harness.cleanup();
  });

  function makeDirtyItem(title: unknown) {
    const item = createItemFixture({ title: 'before' });
    item.markAsPersisted();
    item.clearChanges();
    harness.pool.add(item, ModelScope.live);
    item.applyChanges({ title });
    return item;
  }

  it('a move survives an already-observable sibling in the full journal row', async () => {
    // Register a model through the REAL schema-registration path with the
    // production shape traits: camelCase plural key, distinct typename, a
    // json object field (`position`), and field-level reactivity. This pins
    // the projection contract (`projectCommitPayload` keeps schema-declared
    // json fields) that a plain-string model like `entrycollection.title` cannot
    // exercise — the field-drop failure mode is silent and model-specific.
    const layerSchema = defineSchema({
      layerProbes: model(
        {
          entryId: z.string(),
          type: z.enum(['text', 'shape']),
          zIndex: z.number().default(0),
          position: z.object({
            x: z.number(),
            y: z.number(),
            width: z.number(),
            height: z.number(),
            rotation: z.number().optional(),
          }),
          contentJson: z.record(z.string(), z.unknown()).nullish(),
        },
        {
          typename: 'LayerProbe',
          tableName: 'layer_probes',
          mutable: true,
          load: 'instant',
          lazyObservable: true,
        }),
    });
    registerModelsFromSchema(layerSchema, harness.registry);

    const { calls, executor } = scriptedExecutor(['resolve']);
    syncClient.getMutationQueue().setMutationExecutor(executor);

    const ModelClass = harness.registry.getModelByName('LayerProbe');
    if (!ModelClass) throw new Error('LayerProbe was not registered');
    const layer = new ModelClass({
      id: 'layer-1',
      entryId: 'entry-1',
      type: 'shape',
      position: { x: 100, y: 100, width: 200, height: 200 },
    });
    layer.markAsPersisted();
    layer.clearChanges();
    harness.pool.add(layer, ModelScope.live);

    // Reproduce a value that was made observable upstream before assignment.
    // JSON model fields use observable.ref, which prevents new proxies but
    // deliberately does not unwrap an existing one.
    layer.applyChanges({
      contentJson: observable({
        type: 'doc',
        content: [{ type: 'paragraph' }],
      }),
    });
    layer.clearChanges();
    expect(isObservable(Reflect.get(layer, 'contentJson'))).toBe(true);

    layer.applyChanges({
      position: { x: 250, y: 300, width: 200, height: 200 },
    });

    // `onStale: 'notify'` mirrors the layer mutators' NOTIFY_ON_STALE — the
    // write option that separates layer moves from plain renames. It rides
    // the journal record (zod-validated) and the wire op, so a schema gap
    // for it silently drops exactly this class of write and no other.
    syncClient.update(layer, { onStale: 'notify' });

    expect(await eventually(() => calls.length >= 1, 3_000)).toBe(true);
    const op = calls[0]?.ops[0];
    expect(op?.id).toBe('layer-1');
    expect(op?.input).toEqual({
      position: { x: 250, y: 300, width: 200, height: 200 },
    });
  });

  it('sanity: two sequential updates both reach the wire and the lock drains', async () => {
    const { calls, executor } = scriptedExecutor(['resolve', 'resolve']);
    syncClient.getMutationQueue().setMutationExecutor(executor);

    const first = makeDirtyItem('first');
    syncClient.update(first);
    await eventually(() => calls.length >= 1, 3_000);

    const second = makeDirtyItem('second');
    syncClient.update(second);

    expect(await eventually(() => calls.length >= 2, 3_000)).toBe(true);
    expect(
      await eventually(() => pendingStagesOf(syncClient).size === 0, 3_000),
    ).toBe(true);
  });

  it('a non-cloneable journal row does not discard a valid same-tick sibling', async () => {
    const { calls, executor } = scriptedExecutor(['resolve']);
    syncClient.getMutationQueue().setMutationExecutor(executor);

    const invalid = makeDirtyItem(() => 'functions are not cloneable');
    const valid = makeDirtyItem('valid sibling');

    // These enter one journal flush. The shared JSON boundary rejects
    // `invalid` before IndexedDB; the client must still persist and dispatch
    // `valid` from the same event-loop burst.
    syncClient.update(invalid);
    syncClient.update(valid);

    expect(
      await eventually(
        () => calls.some((call) => call.ops.some((op) => op.id === valid.id)),
        3_000,
      ),
    ).toBe(true);
    expect(
      calls.some((call) => call.ops.some((op) => op.id === invalid.id)),
    ).toBe(false);
    expect(
      await eventually(() => pendingStagesOf(syncClient).size === 0, 3_000),
    ).toBe(true);
  });

  it('a terminally rejected commit must not block the next write', async () => {
    const { calls, executor } = scriptedExecutor([
      'reject', 'reject', 'reject', 'reject', 'reject',
    ]);
    syncClient.getMutationQueue().setMutationExecutor(executor);

    const doomed = makeDirtyItem('doomed');
    syncClient.update(doomed);
    await eventually(() => calls.length >= 1, 3_000);

    const survivor = makeDirtyItem('survivor');
    syncClient.update(survivor);

    const survivorDispatched = await eventually(
      () => calls.some((call) => call.ops.some((op) => op.id === survivor.id)),
      15_000,
    );
    expect(survivorDispatched).toBe(true);
    expect(
      await eventually(() => pendingStagesOf(syncClient).size === 0, 15_000),
    ).toBe(true);
  }, 40_000);

  it('retries the exact model-batch envelope throughout the availability window', async () => {
    const { calls, executor } = scriptedExecutor([
      'reject', 'reject', 'reject', 'resolve',
    ]);
    const queue = syncClient.getMutationQueue();
    queue.setMutationExecutor(executor);
    const config = Reflect.get(queue, 'config') as {
      maxRetries: number;
      availabilityRetryWindowMs: number;
      retryBackoff: { baseMs: number; capMs: number };
    };
    config.maxRetries = 1;
    config.availabilityRetryWindowMs = 1_000;
    config.retryBackoff = { baseMs: 1, capMs: 2 };

    // The scripted executor's generic rejection would be permanent by design.
    // Replace only commit with the retryable server code observed during
    // Aurora writer promotion.
    let attempt = 0;
    const originalCommit = executor.commit.bind(executor);
    executor.commit = async (operations, options) => {
      attempt += 1;
      if (attempt <= 3) {
        // Capture through the test double, then substitute the wire error.
        try {
          return await originalCommit(operations, options);
        } catch {
          throw new AbloError('workspace route is being resolved', {
            code: 'tenant_routing_failed',
          });
        }
      }
      return originalCommit(operations, options);
    };

    const item = makeDirtyItem('survives promotion');
    syncClient.update(item);

    expect(await eventually(() => calls.length >= 4, 5_000)).toBe(true);
    expect(
      await eventually(() => pendingStagesOf(syncClient).size === 0, 5_000),
    ).toBe(true);
    expect(new Set(calls.map((call) => call.idempotencyKey)).size).toBe(1);
    expect(calls.every((call) => call.ops[0]?.id === item.id)).toBe(true);
  }, 15_000);

  it('a commit the transport never answers must not block writes to other rows', async () => {
    const { calls, executor } = scriptedExecutor(['hang']);
    const queue = syncClient.getMutationQueue();
    queue.setMutationExecutor(executor);
    // Shrink the dispatch bound so the timeout → retry cycle fits in test time.
    const config = Reflect.get(queue, 'config') as { commitDispatchTimeoutMs: number };
    config.commitDispatchTimeoutMs = 500;

    const stuck = makeDirtyItem('stuck');
    syncClient.update(stuck);
    await eventually(() => calls.length >= 1, 3_000);

    const survivor = makeDirtyItem('survivor');
    syncClient.update(survivor);

    // The unanswered dispatch times out as a retryable no-receipt failure; the
    // retry (scripted to resolve, as a recovered transport would) settles the
    // stuck write, releasing the staged lock for the survivor.
    const survivorDispatched = await eventually(
      () => calls.some((call) => call.ops.some((op) => op.id === survivor.id)),
      10_000,
    );
    expect(survivorDispatched).toBe(true);
    expect(
      await eventually(() => pendingStagesOf(syncClient).size === 0, 10_000),
    ).toBe(true);
  }, 30_000);
});
