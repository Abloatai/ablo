/**
 * ObjectPool unit tests — CRUD, type index, scope management,
 * disposed model safety, lazy initialization, and metrics.
 */

import { autorun } from 'mobx';
import { InstanceCache as ObjectPool, ModelScope } from '../../src/local/InstanceCache';
import { ModelRegistry, setActiveRegistry } from '../../src/local/ModelRegistry';
import {
  createTestContext,
  registerTestModels,
  TestItem,
  TestWorkspace,
  TestEntry,
  TestEntryLayer,
  createItemFixture,
  createWorkspaceFixture,
  createEntryFixture,
  createEntryLayerFixture,
  resetFixtureCounter,
} from '../../src/local/testing';

describe('ObjectPool', () => {
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
  });

  afterEach(() => {
    pool.clear();
    cleanup();
  });

  // ─────────────────────────────────────────────
  // Basic CRUD
  // ─────────────────────────────────────────────

  describe('add() and get()', () => {
    it('should add a model and retrieve by id', () => {
      const item = createItemFixture({ title: 'Buy milk' });
      pool.add(item);

      const retrieved = pool.get<TestItem>(item.id);
      expect(retrieved).toBe(item);
      expect(retrieved?.title).toBe('Buy milk');
    });

    it('should return undefined for missing id', () => {
      expect(pool.get('nonexistent')).toBeUndefined();
    });

    it('should track type index for model additions', () => {
      const item = createItemFixture();
      pool.add(item);

      const items = pool.getByType(TestItem);
      expect(items).toHaveLength(1);
      expect(items[0]).toBe(item);
    });

    it('should add with default scope of live', () => {
      const item = createItemFixture();
      pool.add(item);

      const liveItems = pool.getByType(TestItem, ModelScope.live);
      expect(liveItems).toHaveLength(1);

      const archivedItems = pool.getByType(TestItem, ModelScope.archived);
      expect(archivedItems).toHaveLength(0);
    });

    it('should add to archived scope', () => {
      const item = createItemFixture();
      pool.add(item, ModelScope.archived);

      const liveItems = pool.getByType(TestItem, ModelScope.live);
      expect(liveItems).toHaveLength(0);

      const archivedItems = pool.getByType(TestItem, ModelScope.archived);
      expect(archivedItems).toHaveLength(1);
    });

    it('should return both live and archived with ModelScope.all', () => {
      const liveItem = createItemFixture({ title: 'Live' });
      const archivedItem = createItemFixture({ title: 'Archived' });
      pool.add(liveItem, ModelScope.live);
      pool.add(archivedItem, ModelScope.archived);

      const allItems = pool.getByType(TestItem, ModelScope.all);
      expect(allItems).toHaveLength(2);
    });
  });

  // ─────────────────────────────────────────────
  // Scope management
  // ─────────────────────────────────────────────

  describe('scope updates', () => {
    it('should update scope without creating duplicate when add() called with existing id', () => {
      const item = createItemFixture();
      pool.add(item, ModelScope.live);

      // Re-add same model with different scope
      pool.add(item, ModelScope.archived);

      // Should still be just one entry
      const allItems = pool.getByType(TestItem, ModelScope.all);
      expect(allItems).toHaveLength(1);

      // Scope should be updated
      const archivedItems = pool.getByType(TestItem, ModelScope.archived);
      expect(archivedItems).toHaveLength(1);
    });
  });

  // ─────────────────────────────────────────────
  // Disposed model safety
  // ─────────────────────────────────────────────

  describe('disposed models', () => {
    it('should return undefined for disposed models on get()', () => {
      const item = createItemFixture();
      pool.add(item);

      item.dispose();
      expect(pool.get(item.id)).toBeUndefined();
    });

    it('should not return disposed model via get() even if entry exists', () => {
      const item = createItemFixture({ title: 'Original' });
      pool.add(item);
      item.dispose();

      // get() returns undefined for disposed models — this is the key safety invariant
      expect(pool.get(item.id)).toBeUndefined();
    });
  });

  // ─────────────────────────────────────────────
  // Batch operations
  // ─────────────────────────────────────────────

  describe('addBatch()', () => {
    it('should add multiple models in a single action', () => {
      const items = [
        createItemFixture({ title: 'Item 1' }),
        createItemFixture({ title: 'Item 2' }),
        createItemFixture({ title: 'Item 3' }),
      ];

      const addedCount = pool.addBatch(items);
      expect(addedCount).toBe(3);
      expect(pool.size).toBe(3);
    });

    it('should skip already-existing models in batch', () => {
      const item = createItemFixture();
      pool.add(item);

      const addedCount = pool.addBatch([item, createItemFixture()]);
      expect(addedCount).toBe(1); // Only the new one
      expect(pool.size).toBe(2);
    });

    it('should return 0 for empty array', () => {
      expect(pool.addBatch([])).toBe(0);
    });
  });

  describe('removeBatch()', () => {
    it('should remove multiple models by id', () => {
      const t1 = createItemFixture();
      const t2 = createItemFixture();
      const t3 = createItemFixture();
      pool.addBatch([t1, t2, t3]);

      const removedCount = pool.removeBatch([t1.id, t2.id]);
      expect(removedCount).toBe(2);
      expect(pool.size).toBe(1);
      expect(pool.get(t3.id)).toBe(t3);
    });

    it('should handle removing non-existent ids gracefully', () => {
      const removedCount = pool.removeBatch(['does-not-exist']);
      expect(removedCount).toBe(0);
    });
  });

  describe('upsertBatch()', () => {
    it('should add new models and update existing ones', () => {
      const existing = createItemFixture({ title: 'Original' });
      pool.add(existing);

      const updated = new TestItem({ id: existing.id, title: 'Updated' });
      const brandNew = createItemFixture({ title: 'Brand New' });

      pool.upsertBatch([updated, brandNew]);

      expect(pool.size).toBe(2);
      // Existing model should be updated in-place
      expect(pool.get<TestItem>(existing.id)?.title).toBe('Updated');
      // The pool keeps the original instance, updated via updateFromData
      expect(pool.get(existing.id)).toBe(existing);
      // New model should be added
      expect(pool.get<TestItem>(brandNew.id)?.title).toBe('Brand New');
    });
  });

  // ─────────────────────────────────────────────
  // remove() and clear()
  // ─────────────────────────────────────────────

  describe('remove()', () => {
    it('should remove a model by id and dispose it', () => {
      const item = createItemFixture();
      pool.add(item);

      const result = pool.remove(item.id);
      expect(result).toBe(true);
      expect(pool.get(item.id)).toBeUndefined();
      expect(item.disposed).toBe(true);
    });

    it('should return false for non-existent id', () => {
      expect(pool.remove('nonexistent')).toBe(false);
    });

    it('should remove from type index', () => {
      const item = createItemFixture();
      pool.add(item);
      pool.remove(item.id);

      expect(pool.getByType(TestItem)).toHaveLength(0);
    });
  });

  describe('clear()', () => {
    it('should remove all entries', () => {
      pool.addBatch([createItemFixture(), createWorkspaceFixture(), createEntryFixture()]);
      expect(pool.size).toBe(3);

      pool.clear();
      expect(pool.size).toBe(0);
    });
  });

  // ─────────────────────────────────────────────
  // getByType with different model types
  // ─────────────────────────────────────────────

  describe('getByType()', () => {
    it('should return only models of the specified type', () => {
      pool.addBatch([
        createItemFixture(),
        createItemFixture(),
        createWorkspaceFixture(),
      ]);

      expect(pool.getByType(TestItem)).toHaveLength(2);
      expect(pool.getByType(TestWorkspace)).toHaveLength(1);
    });

    it('should return empty array for type with no models', () => {
      expect(pool.getByType(TestEntryLayer)).toHaveLength(0);
    });

    it('should initialize type index lazily on first call', () => {
      // The type index for TestEntry should be created on first getByType call
      const entries = pool.getByType(TestEntry);
      expect(entries).toEqual([]);

      // Now add a entry and verify it shows up
      const entry = createEntryFixture();
      pool.add(entry);
      expect(pool.getByType(TestEntry)).toHaveLength(1);
    });
  });

  // ─────────────────────────────────────────────
  // getByTypeName (string-based lookup)
  // ─────────────────────────────────────────────

  describe('getByTypeName()', () => {
    it('should return models by type name string', () => {
      const item = createItemFixture();
      pool.add(item);

      const items = pool.getByTypeName('Item');
      expect(items).toHaveLength(1);
      expect(items[0]).toBe(item);
    });

    it('should return empty for unknown type name', () => {
      expect(pool.getByTypeName('NonExistent')).toHaveLength(0);
    });
  });

  // ─────────────────────────────────────────────
  // Metrics
  // ─────────────────────────────────────────────

  describe('metrics', () => {
    it('should track hits on successful get()', () => {
      const item = createItemFixture();
      pool.add(item);

      pool.get(item.id);
      pool.get(item.id);

      const stats = pool.getStats();
      expect(stats.metrics.hits).toBe(2);
    });

    it('should track misses on failed get()', () => {
      pool.get('nonexistent');

      const stats = pool.getStats();
      expect(stats.metrics.misses).toBe(1);
    });

    it('should track additions', () => {
      pool.add(createItemFixture());
      pool.add(createItemFixture());

      const stats = pool.getStats();
      expect(stats.metrics.additions).toBe(2);
    });

    it('should track duplicatesSkipped', () => {
      const item = createItemFixture();
      pool.add(item);
      pool.add(item); // Duplicate — same id, not disposed

      const stats = pool.getStats();
      expect(stats.metrics.duplicatesSkipped).toBe(1);
    });
  });

  // ─────────────────────────────────────────────
  // Size
  // ─────────────────────────────────────────────

  describe('size', () => {
    it('should report correct size', () => {
      expect(pool.size).toBe(0);

      pool.add(createItemFixture());
      expect(pool.size).toBe(1);

      pool.add(createWorkspaceFixture());
      expect(pool.size).toBe(2);
    });
  });

  // ─────────────────────────────────────────────
  // MobX Reactivity
  // ─────────────────────────────────────────────

  describe('reactivity', () => {
    it('should trigger autorun when model is added', () => {
      const values: number[] = [];

      const disposer = autorun(() => {
        values.push(pool.getByType(TestItem).length);
      });

      pool.add(createItemFixture());
      pool.add(createItemFixture());

      // Initial: 0, after first add: 1, after second add: 2
      expect(values).toEqual([0, 1, 2]);
      disposer();
    });

    it('should trigger autorun when model is removed', () => {
      const item = createItemFixture();
      pool.add(item);

      const values: number[] = [];
      const disposer = autorun(() => {
        values.push(pool.getByType(TestItem).length);
      });

      pool.remove(item.id);

      expect(values).toEqual([1, 0]);
      disposer();
    });

    it('addBatch should trigger exactly 1 reaction (batched MobX action)', () => {
      let reactionCount = 0;

      const disposer = autorun(() => {
        pool.getByType(TestItem);
        reactionCount++;
      });

      reactionCount = 0; // Reset after initial autorun
      pool.addBatch([
        createItemFixture(),
        createItemFixture(),
        createItemFixture(),
      ]);

      expect(reactionCount).toBe(1); // Single batched reaction
      disposer();
    });
  });

  // ─────────────────────────────────────────────
  // getIdsByModelType
  // ─────────────────────────────────────────────

  describe('getIdsByModelType()', () => {
    it('should return set of IDs for a model type', () => {
      const t1 = createItemFixture();
      const t2 = createItemFixture();
      pool.addBatch([t1, t2]);

      const ids = pool.getIdsByModelType('Item');
      expect(ids).toBeDefined();
      expect(ids!.size).toBe(2);
      expect(ids!.has(t1.id)).toBe(true);
      expect(ids!.has(t2.id)).toBe(true);
    });

    it('should return undefined for unknown type', () => {
      expect(pool.getIdsByModelType('NonExistent')).toBeUndefined();
    });
  });
});
