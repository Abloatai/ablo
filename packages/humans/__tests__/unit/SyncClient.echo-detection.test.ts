/**
 * Echo detection at the receive layer.
 *
 * Reproduces the "chart-delete flicker" architectural bug documented in
 * `apps/sync-server/docs/OPTIMISTIC_RECONCILIATION.md`:
 *
 *   - User optimistically creates a model (pool gains row)
 *   - User optimistically deletes that model (pool loses row)
 *   - Server confirms the CREATE — its delta echo arrives back
 *   - Server confirms the DELETE — its delta echo arrives back
 *
 * In the buggy code, the CREATE echo lands BEFORE the DELETE echo (the
 * server processes them as separate commits, deltas may arrive seconds
 * apart). The receive path (`applyDeltaBatchToPool`) blindly re-applies
 * each delta to the pool. The net pool transition:
 *
 *   absent (deleted) → present (CREATE echo) → absent (DELETE echo)
 *
 * That's the flicker. The fix: at the receive layer, recognize echoes
 * of mutations the client has already applied locally, and skip the
 * pool mutation. The IDB write still applies (the delta is the
 * authoritative version).
 *
 * Discriminator: `delta.transactionId` (already on the wire). When a
 * transaction stages locally, its id enters a "pending optimistic" set
 * on `SyncClient`. When a delta arrives whose `transactionId` is in
 * that set, the pool mutation is suppressed and the id is removed from
 * the set.
 *
 * These tests describe the behavior we want. Currently most fail; they
 * pass after the echo-detection wiring lands.
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { InstanceCache as ObjectPool, ModelScope } from '../../src/local/InstanceCache';
import { ModelRegistry, setActiveRegistry } from '../../src/local/ModelRegistry';
import { SyncClient } from '../../src/local/SyncClient';
import { Database } from '../../src/local/Database';
import {
  registerTestModels,
  createTestConfig,
  createTestContext,
  TestSlideLayer,
  type TestContextResult,
} from '../../src/local/testing';

const ENRICH_NOOP = (
  _name: string,
  d: Record<string, unknown>,
): Record<string, unknown> => d;

interface DbResult {
  action: 'add' | 'update' | 'remove' | 'archive';
  modelName: string;
  modelId: string;
  data?: Record<string, unknown> | null;
  /**
   * Server-stamped transaction id — echoes the client's commit op id.
   * The receive layer uses this to detect "this is a confirmation of
   * something I've already applied locally."
   */
  transactionId?: string;
}

describe('SyncClient echo detection (architectural)', () => {
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

    // Stub Database — applyDeltaBatchToPool doesn't touch IDB itself
    // (that's processDeltaBatch's job), but the constructor needs one.
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

  // ─────────────────────────────────────────────────────────────────────────
  // 1. Reproduce the flicker
  // ─────────────────────────────────────────────────────────────────────────

  it('does NOT resurrect a row when the CREATE echo arrives after an optimistic DELETE', () => {
    const layerId = 'layer-flicker-1';
    const txCreateId = 'tx-create-flicker';
    const txDeleteId = 'tx-delete-flicker';
    const layerData = {
      id: layerId,
      slideId: 'slide-1',
      type: 'rect',
      zIndex: 0,
      organizationId: 'org-1',
    };

    // Step 1: optimistic create. The mutation hasn't reached the server
    // yet, but the pool already reflects it.
    const created = pool.createFromData({ __typename: 'SlideLayer', ...layerData });
    expect(created).not.toBeNull();
    pool.add(created!, ModelScope.live);
    expect(pool.get(layerId)).toBeDefined();

    // Step 2: optimistic delete BEFORE the server has confirmed the
    // create. Pool no longer has the row.
    pool.remove(layerId);
    expect(pool.get(layerId)).toBeUndefined();

    // Mark BOTH transactions as locally-applied. In production this
    // happens automatically when MutationQueue stages a transaction.
    // For a focused test we drive the API directly.
    client.markTransactionPending(txCreateId);
    client.markTransactionPending(txDeleteId);

    // Step 3: server's confirming CREATE delta arrives. In the buggy
    // path, this would re-create the row (`existing` is null →
    // createFromData → addBatch). With echo detection, the delta is
    // recognized as a confirmation of `txCreateId` and the pool stays
    // empty.
    const createEchoBatch: DbResult[] = [
      { action: 'add', modelName: 'SlideLayer', modelId: layerId, data: layerData, transactionId: txCreateId },
    ];
    client.applyDeltaBatchToPool(createEchoBatch, ENRICH_NOOP);

    expect(pool.get(layerId)).toBeUndefined();

    // Step 4: server's confirming DELETE delta arrives. Pool already
    // empty; the remove is a no-op.
    const deleteEchoBatch: DbResult[] = [
      { action: 'remove', modelName: 'SlideLayer', modelId: layerId, transactionId: txDeleteId },
    ];
    client.applyDeltaBatchToPool(deleteEchoBatch, ENRICH_NOOP);

    expect(pool.get(layerId)).toBeUndefined();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 2. Foreign deltas still apply
  // ─────────────────────────────────────────────────────────────────────────

  it('applies deltas from OTHER clients normally (unknown transactionId)', () => {
    const layerId = 'layer-foreign';
    const layerData = {
      id: layerId,
      slideId: 'slide-1',
      type: 'rect',
      zIndex: 0,
      organizationId: 'org-1',
    };

    // No local transaction was staged for this id — the delta is from
    // another client/agent. Pool should gain the row.
    const foreignBatch: DbResult[] = [
      { action: 'add', modelName: 'SlideLayer', modelId: layerId, data: layerData, transactionId: 'tx-from-other-client' },
    ];
    client.applyDeltaBatchToPool(foreignBatch, ENRICH_NOOP);

    expect(pool.get(layerId)).toBeDefined();
  });

  it('applies deltas with NO transactionId (legacy / system-emitted) normally', () => {
    const layerId = 'layer-legacy';
    const layerData = {
      id: layerId,
      slideId: 'slide-1',
      type: 'rect',
      zIndex: 0,
      organizationId: 'org-1',
    };

    const legacyBatch: DbResult[] = [
      { action: 'add', modelName: 'SlideLayer', modelId: layerId, data: layerData /* no transactionId */ },
    ];
    client.applyDeltaBatchToPool(legacyBatch, ENRICH_NOOP);

    expect(pool.get(layerId)).toBeDefined();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 3. Pending set is drained when the matching echo lands
  // ─────────────────────────────────────────────────────────────────────────

  it('drains the pending set so a SECOND non-echo delta with the same id applies', () => {
    const layerId = 'layer-second-pass';
    const txId = 'tx-once';
    const layerData = {
      id: layerId,
      slideId: 'slide-1',
      type: 'rect',
      zIndex: 0,
      organizationId: 'org-1',
    };

    client.markTransactionPending(txId);

    // Echo arrives — pool unchanged (was empty), pending drained.
    client.applyDeltaBatchToPool(
      [{ action: 'add', modelName: 'SlideLayer', modelId: layerId, data: layerData, transactionId: txId }],
      ENRICH_NOOP,
    );
    expect(pool.get(layerId)).toBeUndefined();

    // Second add for the same id with the SAME transactionId is no
    // longer in the pending set — should apply (defensive: a re-broadcast
    // shouldn't permanently silence a row).
    client.applyDeltaBatchToPool(
      [{ action: 'add', modelName: 'SlideLayer', modelId: layerId, data: layerData, transactionId: txId }],
      ENRICH_NOOP,
    );
    expect(pool.get(layerId)).toBeDefined();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 4. Per-id selectivity within a batch
  // ─────────────────────────────────────────────────────────────────────────

  it('skips only the echoed delta in a mixed batch; others apply', () => {
    const ownId = 'layer-own';
    const otherId = 'layer-other';
    const ownTx = 'tx-own';
    const layerOwn = {
      id: ownId, slideId: 's', type: 'rect', zIndex: 0, organizationId: 'org-1',
    };
    const layerOther = {
      id: otherId, slideId: 's', type: 'rect', zIndex: 0, organizationId: 'org-1',
    };

    // Optimistic create + delete locally — own row should NOT be in pool.
    const created = pool.createFromData({ __typename: 'SlideLayer', ...layerOwn });
    pool.add(created!, ModelScope.live);
    pool.remove(ownId);

    client.markTransactionPending(ownTx);

    // Mixed batch: echo for own + foreign add.
    client.applyDeltaBatchToPool(
      [
        { action: 'add', modelName: 'SlideLayer', modelId: ownId, data: layerOwn, transactionId: ownTx },
        { action: 'add', modelName: 'SlideLayer', modelId: otherId, data: layerOther, transactionId: 'tx-other-client' },
      ],
      ENRICH_NOOP,
    );

    expect(pool.get(ownId)).toBeUndefined();   // echo skipped
    expect(pool.get(otherId)).toBeDefined();   // foreign applied
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 5. Update echoes
  // ─────────────────────────────────────────────────────────────────────────

  it('does not re-apply an UPDATE echo on top of newer local optimistic state', () => {
    const layerId = 'layer-update-echo';
    const txUpdate1 = 'tx-update-1';

    // Initial state via foreign delta (or assume bootstrap).
    client.applyDeltaBatchToPool(
      [{ action: 'add', modelName: 'SlideLayer', modelId: layerId, data: { id: layerId, slideId: 's', type: 'rect', zIndex: 1, organizationId: 'org-1' }, transactionId: 'tx-from-bootstrap' }],
      ENRICH_NOOP,
    );
    expect(pool.get(layerId)).toBeDefined();

    // Optimistic local update bumps zIndex to 5. Pool reflects it.
    const live = pool.get(layerId)!;
    (live as unknown as { zIndex: number }).zIndex = 5;

    // Mark the local update as pending; echo will arrive.
    client.markTransactionPending(txUpdate1);

    // Server's confirming UPDATE delta carries zIndex=5 (the value the
    // client sent). Re-applying overwrites the same value — no visible
    // flicker. But if the user has SINCE done another optimistic update
    // (zIndex=10), an echo of the EARLIER update would clobber it.
    // Simulate that ordering: the second optimistic update bumps to 10
    // BEFORE the first echo arrives.
    (live as unknown as { zIndex: number }).zIndex = 10;

    // Echo of update 1 arrives with zIndex=5 (the value the client sent
    // when staging tx-update-1). Without echo detection this would
    // clobber the user's newer zIndex=10 back to zIndex=5.
    client.applyDeltaBatchToPool(
      [{ action: 'update', modelName: 'SlideLayer', modelId: layerId, data: { id: layerId, slideId: 's', type: 'rect', zIndex: 5, organizationId: 'org-1' }, transactionId: txUpdate1 }],
      ENRICH_NOOP,
    );

    // With echo detection, the update is recognized as the user's
    // already-applied mutation and skipped — zIndex stays at 10.
    const after = pool.get(layerId)!;
    expect((after as unknown as { zIndex: number }).zIndex).toBe(10);
  });
});
