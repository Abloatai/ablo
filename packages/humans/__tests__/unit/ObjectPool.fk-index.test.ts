/**
 * ObjectPool FK index tests — registration, lookup, cleanup on remove.
 */

import { InstanceCache as ObjectPool, ModelScope } from '../../src/local/InstanceCache';
import { ModelRegistry, setActiveRegistry } from '../../src/local/ModelRegistry';
import {
  createTestContext,
  registerTestModels,
  TestEntry,
  TestEntryLayer,
  TestItem,
  createEntryFixture,
  createEntryLayerFixture,
  createItemFixture,
  resetFixtureCounter,
} from '../../src/local/testing';

describe('ObjectPool FK Indexes', () => {
  let pool: ObjectPool;
  let registry: ModelRegistry;
  let cleanup: () => void;

  beforeEach(() => {
    resetFixtureCounter();
    registry = new ModelRegistry();
    setActiveRegistry(registry);
    registerTestModels(registry);
    const ctx = createTestContext();
    cleanup = ctx.cleanup;
    pool = new ObjectPool({ maxSize: 100, gcInterval: 0, useWeakRefs: false }, registry);
    pool.registerForeignKey('EntryDetail', 'entryId');
    pool.registerForeignKey('Item', 'workspaceId');
  });

  afterEach(() => {
    pool.clear();
    cleanup();
  });

  it('should index model by FK value on add()', () => {
    const entry = createEntryFixture();
    const layer1 = createEntryLayerFixture({ entryId: entry.id });
    const layer2 = createEntryLayerFixture({ entryId: entry.id });

    pool.add(entry);
    pool.add(layer1);
    pool.add(layer2);

    const layers = pool.getByForeignKey('EntryDetail', 'entryId', entry.id);
    expect(layers).toHaveLength(2);
    expect(layers).toContain(layer1);
    expect(layers).toContain(layer2);
  });

  it('should return empty for FK value with no matching models', () => {
    const layers = pool.getByForeignKey('EntryDetail', 'entryId', 'nonexistent');
    expect(layers).toHaveLength(0);
  });

  it('should return empty for unregistered FK field', () => {
    const item = createItemFixture({ assigneeId: 'user-1' });
    pool.add(item);

    // assigneeId is NOT registered as FK index
    const items = pool.getByForeignKey('Item', 'assigneeId', 'user-1');
    expect(items).toHaveLength(0);
  });

  it('should handle null FK values (skip indexing)', () => {
    const layer = createEntryLayerFixture({ entryId: null });
    pool.add(layer);

    // null FK values are not indexed (only string values)
    const layers = pool.getByForeignKey('EntryDetail', 'entryId', 'null');
    expect(layers).toHaveLength(0);
  });

  it('should handle multiple models with same FK value', () => {
    const entry = createEntryFixture();
    const layers = Array.from({ length: 5 }, (_, i) =>
      createEntryLayerFixture({ entryId: entry.id, zIndex: i })
    );

    pool.add(entry);
    pool.addBatch(layers);

    const result = pool.getByForeignKey('EntryDetail', 'entryId', entry.id);
    expect(result).toHaveLength(5);
  });

  it('should clean up FK index entries on remove()', () => {
    const entry = createEntryFixture();
    const layer = createEntryLayerFixture({ entryId: entry.id });
    pool.add(entry);
    pool.add(layer);

    expect(pool.getByForeignKey('EntryDetail', 'entryId', entry.id)).toHaveLength(1);

    pool.remove(layer.id);

    expect(pool.getByForeignKey('EntryDetail', 'entryId', entry.id)).toHaveLength(0);
  });

  it('should clean up FK index on removeBatch()', () => {
    const entry = createEntryFixture();
    const l1 = createEntryLayerFixture({ entryId: entry.id });
    const l2 = createEntryLayerFixture({ entryId: entry.id });
    pool.add(entry);
    pool.addBatch([l1, l2]);

    pool.removeBatch([l1.id, l2.id]);

    expect(pool.getByForeignKey('EntryDetail', 'entryId', entry.id)).toHaveLength(0);
  });

  it('should support multiple FK fields on the same model', () => {
    // Item has both workspaceId (registered) and assigneeId (not registered)
    const item = createItemFixture({ workspaceId: 'workspace-1' });
    pool.add(item);

    const byWorkspace = pool.getByForeignKey('Item', 'workspaceId', 'workspace-1');
    expect(byWorkspace).toHaveLength(1);
    expect(byWorkspace[0]).toBe(item);
  });
});
