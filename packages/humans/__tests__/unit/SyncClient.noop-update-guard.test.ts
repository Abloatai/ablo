/**
 * SyncClient no-op UPDATE guard.
 *
 * A changeless `client.update(model)` used to be enqueued and shipped to the
 * server, where `coalesceOperations` Rule 4 drops empty-input updates. If the
 * no-op was the only op in the batch the commit came back as `lastSyncId: 0`,
 * which (a) tripped `captureCommitZeroSyncId` as a false-positive Sentry anomaly
 * and (b) parked the tx in `awaiting_delta` for a 30s reconciliation timeout on
 * a write that changed nothing.
 *
 * The fix bails at the client boundary: `SyncClient.mutate` skips an UPDATE whose
 * model has an empty dirty-set (`Model.hasChanges === false` — an O(1) check on
 * `modifiedProperties.size`, no allocation). A genuine change still enqueues.
 *
 * The guard sits immediately before `queueMutation`, which pushes onto
 * `pendingMutations` SYNCHRONOUSLY (the async drain only happens later, gated on
 * online + userId). So that array is the exact, deterministic chokepoint: an
 * enqueued mutation lands there before any microtask, an elided one never does.
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { InstanceCache as ObjectPool } from '../../src/local/InstanceCache';
import { ModelRegistry, setActiveRegistry } from '../../src/local/ModelRegistry';
import { SyncClient } from '../../src/local/SyncClient';
import { Database } from '../../src/local/Database';
import {
  registerTestModels,
  createTestConfig,
  createTestContext,
  createEntryLayerFixture,
  type TestContextResult,
} from '../../src/local/testing';

/** The synchronous pre-drain buffer `queueMutation` pushes onto. */
function pendingCount(client: SyncClient): number {
  return (client as unknown as { pendingMutations: unknown[] }).pendingMutations.length;
}

describe('SyncClient no-op UPDATE guard', () => {
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

  it('skips a changeless update — nothing is enqueued', () => {
    const layer = createEntryLayerFixture({ id: 'layer-noop-1', entryId: 'entry-1' });
    layer.clearChanges(); // empty dirty-set: hasChanges === false
    expect(layer.hasChanges).toBe(false);

    client.update(layer);

    expect(pendingCount(client)).toBe(0);
  });

  it('enqueues an update that has a real dirty field', () => {
    const layer = createEntryLayerFixture({ id: 'layer-noop-2', entryId: 'entry-1' });
    layer.clearChanges();
    // Public dirty-set entry point — deterministic, no MobX setter interception.
    layer.propertyChanged('content', 'old', 'new');
    expect(layer.hasChanges).toBe(true);

    client.update(layer);

    expect(pendingCount(client)).toBe(1);
  });

  it('enqueues explicit guarded changes even when the live model already matches', () => {
    const layer = createEntryLayerFixture({ id: 'layer-noop-guarded', entryId: 'entry-1' });
    layer.clearChanges();

    client.update(layer, undefined, { content: 'same-value-requested-by-caller' });

    expect(pendingCount(client)).toBe(1);
  });

  it('a non-Model object (hasChanges undefined) is NOT dropped — safe fallthrough', () => {
    // `rowAsModel` only casts, so a plain object can reach `update`. The guard
    // uses `=== false`, so `undefined` falls through to the normal enqueue path
    // rather than silently dropping a potentially-real write.
    const plain = {
      id: 'layer-noop-3',
      getModelName: () => 'EntryDetail',
      getChanges: () => ({ content: 'x' }),
    } as unknown as Parameters<typeof client.update>[0];

    client.update(plain);

    expect(pendingCount(client)).toBe(1);
  });
});
