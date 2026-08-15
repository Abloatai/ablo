/**
 * SyncClient.applyBootstrapDataToPool({ scoped: true }) — scoped hydrate-on-enter
 * apply (P4a). A scoped snapshot covers only the groups just entered, NOT the
 * whole type, so the scoped path must:
 *   - NOT ghost-remove rows of the same type that belong to other groups, and
 *   - version-guard the upsert (never clobber a newer live row).
 *
 * The contrast tests show a FULL apply (`scoped` unset) DOES ghost-remove — so
 * the difference is intentional, not accidental.
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
  TestItem,
  type TestContextResult,
} from '../../src/local/testing';

describe('SyncClient scoped bootstrap apply (hydrate-on-enter)', () => {
  let registry: ModelRegistry;
  let pool: ObjectPool;
  let database: Database;
  let client: SyncClient;
  let ctx: TestContextResult;

  beforeEach(() => {
    registry = new ModelRegistry();
    setActiveRegistry(registry);
    registerTestModels(registry); // TestItem registered under typename 'Item'
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

  const titleOf = (id: string) => pool.get<TestItem>(id)?.title;

  it('scoped apply does NOT evict other groups’ rows of the same type', () => {
    // Two Items already loaded (think: two other open collections' entries).
    pool.add(new TestItem({ id: 'keep-1', title: 'collection-A', updatedAt: new Date('2026-01-01T00:00:00Z') }));
    pool.add(new TestItem({ id: 'keep-2', title: 'collection-B', updatedAt: new Date('2026-01-01T00:00:00Z') }));

    // A SCOPED snapshot for a third collection returns only its own row.
    const stats = client.applyBootstrapDataToPool(
      { models: { Item: [{ id: 'new-1', title: 'collection-C', updatedAt: '2026-01-01T00:00:00Z' }] } },
      undefined,
      { scoped: true },
    );

    expect(stats.added).toBe(1);
    expect(stats.removed).toBe(0); // no ghost sweep
    expect(titleOf('keep-1')).toBe('collection-A'); // survived
    expect(titleOf('keep-2')).toBe('collection-B'); // survived
    expect(titleOf('new-1')).toBe('collection-C'); // hydrated
  });

  it('FULL apply (scoped unset) DOES ghost-remove — confirms the contrast', () => {
    pool.add(new TestItem({ id: 'keep-1', title: 'collection-A', updatedAt: new Date('2026-01-01T00:00:00Z') }));

    const stats = client.applyBootstrapDataToPool(
      { models: { Item: [{ id: 'new-1', title: 'collection-C', updatedAt: '2026-01-01T00:00:00Z' }] } },
      // no options → full bootstrap semantics
    );

    expect(stats.removed).toBe(1); // 'keep-1' swept as a ghost
    expect(titleOf('keep-1')).toBeUndefined();
    expect(titleOf('new-1')).toBe('collection-C');
  });

  it('scoped apply does NOT clobber a newer live row with an older snapshot row', () => {
    // A live delta already advanced the row.
    pool.add(new TestItem({ id: 'x', title: 'live-edit', updatedAt: new Date('2026-01-02T00:00:00Z') }));

    const stats = client.applyBootstrapDataToPool(
      { models: { Item: [{ id: 'x', title: 'stale-snapshot', updatedAt: '2026-01-01T00:00:00Z' }] } },
      undefined,
      { scoped: true },
    );

    expect(stats.updated).toBe(0);
    expect(stats.skipped).toBe(1);
    expect(titleOf('x')).toBe('live-edit'); // survived
  });
});
