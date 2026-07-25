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
  TestTask,
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
    registerTestModels(registry); // TestTask registered under typename 'Task'
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

  const titleOf = (id: string) => pool.get<TestTask>(id)?.title;

  it('scoped apply does NOT evict other groups’ rows of the same type', () => {
    // Two Tasks already loaded (think: two other open decks' slides).
    pool.add(new TestTask({ id: 'keep-1', title: 'deck-A', updatedAt: new Date('2026-01-01T00:00:00Z') }));
    pool.add(new TestTask({ id: 'keep-2', title: 'deck-B', updatedAt: new Date('2026-01-01T00:00:00Z') }));

    // A SCOPED snapshot for a third deck returns only its own row.
    const stats = client.applyBootstrapDataToPool(
      { models: { Task: [{ id: 'new-1', title: 'deck-C', updatedAt: '2026-01-01T00:00:00Z' }] } },
      undefined,
      { scoped: true },
    );

    expect(stats.added).toBe(1);
    expect(stats.removed).toBe(0); // no ghost sweep
    expect(titleOf('keep-1')).toBe('deck-A'); // survived
    expect(titleOf('keep-2')).toBe('deck-B'); // survived
    expect(titleOf('new-1')).toBe('deck-C'); // hydrated
  });

  it('FULL apply (scoped unset) DOES ghost-remove — confirms the contrast', () => {
    pool.add(new TestTask({ id: 'keep-1', title: 'deck-A', updatedAt: new Date('2026-01-01T00:00:00Z') }));

    const stats = client.applyBootstrapDataToPool(
      { models: { Task: [{ id: 'new-1', title: 'deck-C', updatedAt: '2026-01-01T00:00:00Z' }] } },
      // no options → full bootstrap semantics
    );

    expect(stats.removed).toBe(1); // 'keep-1' swept as a ghost
    expect(titleOf('keep-1')).toBeUndefined();
    expect(titleOf('new-1')).toBe('deck-C');
  });

  it('scoped apply does NOT clobber a newer live row with an older snapshot row', () => {
    // A live delta already advanced the row.
    pool.add(new TestTask({ id: 'x', title: 'live-edit', updatedAt: new Date('2026-01-02T00:00:00Z') }));

    const stats = client.applyBootstrapDataToPool(
      { models: { Task: [{ id: 'x', title: 'stale-snapshot', updatedAt: '2026-01-01T00:00:00Z' }] } },
      undefined,
      { scoped: true },
    );

    expect(stats.updated).toBe(0);
    expect(stats.skipped).toBe(1);
    expect(titleOf('x')).toBe('live-edit'); // survived
  });
});
