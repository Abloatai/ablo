/**
 * Wire-level transaction-id mismatch — REGRESSION TEST FOR THE
 * CHART-DELETE FLICKER ROOT CAUSE.
 *
 * What this verifies (and what was broken before the fix):
 *
 *   The `SyncClient.echo-detection` unit test passes only because it
 *   calls `markTransactionPending(txId)` directly. In production the
 *   wiring is `MutationQueue.create/update/delete` →
 *   `emit('transaction:created', tx)` → `SyncClient.markTransactionPending`.
 *   Echo detection then matches the staged tx id against the
 *   `transactionId` field on each incoming delta.
 *
 *   The discriminator is only useful if the SAME id roundtrips through
 *   the wire. Before the fix:
 *
 *     - `MutationOperation` had no `transactionId` field
 *     - `MutationQueue.executeBatch` built ops without one
 *       (lines 924-929 of MutationQueue.ts)
 *     - `apps/sync-server/src/mutators/commit.ts` stamped every delta
 *       in a batch with a single `clientTxId` (the batch idempotency
 *       hash from `hashOperations(...)`), NOT per-op transaction ids
 *
 *   So a server delta echo carries `transactionId = batch-hash`, but
 *   the client's pending set has individual UUIDs. They never match
 *   → echo detection never fires → the chart-delete flicker stays.
 *
 * The two tests below pin the contract at both ends of the wire:
 *
 *   1. Per-op `transactionId` reaches `MutationExecutor.commit(...)`
 *      (the client end of the wire)
 *   2. When that id roundtrips back as the delta's `transactionId`,
 *      echo detection drains the pending set and the pool stays
 *      consistent with optimistic state (the receive end)
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { InstanceCache as ObjectPool, ModelScope } from '../../src/local/InstanceCache';
import { ModelRegistry, setActiveRegistry } from '../../src/local/ModelRegistry';
import { SyncClient } from '../../src/local/SyncClient';
import { Database } from '../../src/local/Database';
import { MutationQueue } from '../../src/local/transactions/mutations/MutationQueue';
import {
  registerTestModels,
  createTestConfig,
  createTestContext,
  createSlideLayerFixture,
  resetFixtureCounter,
  flushMicrotasks,
  type TestContextResult,
} from '../../src/local/testing';

const ENRICH_NOOP = (
  _name: string,
  d: Record<string, unknown>,
): Record<string, unknown> => d;

const TEST_USER_CONTEXT = {
  userId: 'user-1',
  organizationId: 'org-1',
};

interface DbResult {
  action: 'add' | 'update' | 'remove' | 'archive';
  modelName: string;
  modelId: string;
  data?: Record<string, unknown> | null;
  transactionId?: string;
}

// Wait for the MutationQueue's batchDelay-scheduled commit to fire —
// DETERMINISTICALLY, by waiting for the transaction's own confirmation events
// (`transaction:completed:<id>` / `transaction:failed:<id>`, emitted once the
// batch is dispatched and the executor ack lands) instead of the old fixed
// 300ms sleep that guessed at the SyncClient queue's `batchDelay: 150` timer.
// The MockMutationExecutor acks every commit with an incrementing lastSyncId,
// so confirmation is ack-based and always arrives; a hang here is a real queue
// bug and fails via the jest timeout.
async function waitForCommit(
  queue: MutationQueue,
  ...txIds: string[]
): Promise<void> {
  await Promise.all(
    txIds.map(
      (id) =>
        new Promise<void>((resolve) => {
          queue.once(`transaction:completed:${id}`, () => { resolve(); });
          queue.once(`transaction:failed:${id}`, () => { resolve(); });
        }),
    ),
  );
  // Let same-tick follow-up handlers (echo bookkeeping, listeners) run.
  await flushMicrotasks();
}

describe('wire-level transactionId roundtrip (chart-delete flicker root cause)', () => {
  let registry: ModelRegistry;
  let pool: ObjectPool;
  let database: Database;
  let client: SyncClient;
  let ctx: TestContextResult;

  beforeEach(() => {
    resetFixtureCounter();
    registry = new ModelRegistry();
    setActiveRegistry(registry);
    registerTestModels(registry);

    ctx = createTestContext({ config: createTestConfig() });

    pool = new ObjectPool(
      { maxSize: 1000, gcInterval: 0, useWeakRefs: false },
      registry,
    );

    database = {
      saveTransaction: () => Promise.resolve(undefined),
      getPersistedTransactions: () => Promise.resolve([]),
      sealTransactionRecord: () => Promise.resolve(undefined),
      removeTransaction: () => Promise.resolve(),
      getStore: () => null,
      clear: () => Promise.resolve(undefined),
    } as unknown as Database;

    client = new SyncClient(pool, database);

    // SyncClient gates the queue on `connectionState === 'connected'`.
    // We never call `connect()` (no real WS), so override the checker
    // after SyncClient has wired its own listeners — the queue still
    // emits 'transaction:created' through the SyncClient's listener,
    // but commits also flush instead of parking forever.
    client.getMutationQueue().setConnectionChecker(() => true);
  });

  afterEach(() => {
    client.disconnect();
    pool.clear();
    ctx.cleanup();
  });

  // ─────────────────────────────────────────────────────────────────────
  // 1. Per-op transactionId reaches the wire
  // ─────────────────────────────────────────────────────────────────────

  it('attaches per-op transactionId to each operation in commit(...)', async () => {
    const queue = client.getMutationQueue();

    const layer1 = createSlideLayerFixture({
      slideId: 'slide-1',
      type: 'rect',
      zIndex: 0,
    });
    const layer2 = createSlideLayerFixture({
      slideId: 'slide-1',
      type: 'rect',
      zIndex: 1,
    });

    const tx1 = await queue.create(layer1, TEST_USER_CONTEXT);
    const tx2 = await queue.create(layer2, TEST_USER_CONTEXT);

    await waitForCommit(queue, tx1.id, tx2.id);

    const commits = ctx.mocks.mutationExecutor.calls.filter(
      (c) => c.method === 'commit',
    );
    expect(commits.length).toBeGreaterThan(0);

    const allOps = commits.flatMap((c) => c.operations ?? []);
    expect(allOps.length).toBe(2);

    const opTxIds = allOps
      .map((op) => (op as { transactionId?: string }).transactionId)
      .filter((v): v is string => typeof v === 'string');

    // CONTRACT: every op must carry its originating transaction id.
    // Pre-fix this array was empty (MutationOperation had no
    // transactionId field) → echo detection had nothing to match on.
    expect(opTxIds).toHaveLength(2);
    expect(new Set(opTxIds)).toEqual(new Set([tx1.id, tx2.id]));
  });

  // ─────────────────────────────────────────────────────────────────────
  // 2. End-to-end: chart-delete flicker via the real queue path
  // ─────────────────────────────────────────────────────────────────────
  //
  // This is the production scenario the OPTIMISTIC_RECONCILIATION.md
  // doc describes. Before the fix, the server-confirming CREATE delta
  // arrived carrying the BATCH idempotency hash (clientTxId) as its
  // transactionId — which never matched the per-tx ids the SyncClient
  // had marked pending via `transaction:created`. Echo detection
  // silently no-op'd → pool resurrected the row.

  it('does not resurrect a deleted layer when CREATE echo arrives — using REAL MutationQueue path', async () => {
    const queue = client.getMutationQueue();

    // Step 1: optimistic CREATE via the queue (publishes
    // 'transaction:created' → SyncClient.markTransactionPending).
    const layer = createSlideLayerFixture({
      slideId: 'slide-1',
      type: 'rect',
      zIndex: 0,
    });
    const layerId = layer.id;
    const layerData = {
      id: layerId,
      slideId: 'slide-1',
      type: 'rect',
      zIndex: 0,
      organizationId: 'org-1',
    };

    // Mirror what the optimistic-add path does: pool reflects the
    // create immediately. (TestSlideLayer fixtures don't auto-add to
    // pool; we add manually so the test is hermetic.)
    pool.add(layer, ModelScope.live);
    expect(pool.get(layerId)).toBeDefined();

    const txCreate = await queue.create(layer, TEST_USER_CONTEXT);

    // Let the CREATE leave the queue, but do not deliver its echo yet.
    // A same-tick create+delete now coalesces away locally, so this test
    // explicitly models the still-relevant attempted-create window:
    // server accepted CREATE, user deleted before the CREATE echo arrived.
    await waitForCommit(queue, txCreate.id);

    // Step 2: optimistic DELETE before the server's CREATE echo arrives.
    pool.remove(layerId);
    expect(pool.get(layerId)).toBeUndefined();

    const txDelete = await queue.delete(layer, TEST_USER_CONTEXT);

    await waitForCommit(queue, txDelete.id);

    // Step 3: server's CREATE confirmation lands (carrying the per-op
    // transactionId, the contract we just pinned in test 1). Echo
    // detection should drain the pending set and SKIP the pool add.
    const createEchoBatch: DbResult[] = [
      {
        action: 'add',
        modelName: 'SlideLayer',
        modelId: layerId,
        data: layerData,
        transactionId: txCreate.id,
      },
    ];
    client.applyDeltaBatchToPool(createEchoBatch, ENRICH_NOOP);

    // PRE-FIX: this was the bug — the wire would have echoed back
    // batch-hash, not txCreate.id, so the `if` in applyDeltaBatchToPool
    // never matched, the row was re-added, and the user saw it
    // resurrect for the ~2s window before the DELETE echo arrived.
    expect(pool.get(layerId)).toBeUndefined();

    // Step 4: server's DELETE confirmation lands.
    const deleteEchoBatch: DbResult[] = [
      {
        action: 'remove',
        modelName: 'SlideLayer',
        modelId: layerId,
        transactionId: txDelete.id,
      },
    ];
    client.applyDeltaBatchToPool(deleteEchoBatch, ENRICH_NOOP);

    expect(pool.get(layerId)).toBeUndefined();
  });

  // ─────────────────────────────────────────────────────────────────────
  // 3. Negative regression — proves the bug, not just the symptom
  // ─────────────────────────────────────────────────────────────────────
  //
  // If a delta echo carried a DIFFERENT transactionId (the old
  // batch-hash semantics), the pending set would not drain and the
  // pool WOULD resurrect. This locks in why per-op identity matters.

  it('row resurrects (the bug) when delta echo carries a wrong transactionId — proves the wire identity must match', async () => {
    const queue = client.getMutationQueue();

    const layer = createSlideLayerFixture({
      slideId: 'slide-1',
      type: 'rect',
      zIndex: 0,
    });
    const layerId = layer.id;
    const layerData = {
      id: layerId,
      slideId: 'slide-1',
      type: 'rect',
      zIndex: 0,
      organizationId: 'org-1',
    };

    pool.add(layer, ModelScope.live);
    const txCreate = await queue.create(layer, TEST_USER_CONTEXT);
    await waitForCommit(queue, txCreate.id);

    pool.remove(layerId);
    const txDelete = await queue.delete(layer, TEST_USER_CONTEXT);

    await waitForCommit(queue, txDelete.id);

    // Simulate the PRE-FIX server behavior: every delta in the batch
    // carries the batch idempotency hash, NOT the per-tx id.
    const wrongBatchHash = 'batch-hash-not-matching-any-pending-tx';
    const buggyEchoBatch: DbResult[] = [
      {
        action: 'add',
        modelName: 'SlideLayer',
        modelId: layerId,
        data: layerData,
        transactionId: wrongBatchHash,
      },
    ];
    client.applyDeltaBatchToPool(buggyEchoBatch, ENRICH_NOOP);

    // The pool resurrects — this is the user-visible flicker. We
    // assert it here so a future "fix" that silently swallows
    // mismatched ids (rather than fixing the wire identity) would
    // fail this test.
    expect(pool.get(layerId)).toBeDefined();
  });
});
