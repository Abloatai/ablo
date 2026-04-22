/**
 * ObjectPool unit tests — CRUD, type index, scope management,
 * disposed model safety, lazy initialization, and metrics.
 */

import { autorun } from 'mobx';
import { ObjectPool, ModelScope } from '../../src/ObjectPool';
import { ModelRegistry, setActiveRegistry } from '../../src/ModelRegistry';
import {
  createTestContext,
  registerTestModels,
  TestTask,
  TestProject,
  TestSlide,
  TestSlideLayer,
  createTaskFixture,
  createProjectFixture,
  createSlideFixture,
  createSlideLayerFixture,
  resetFixtureCounter,
} from '../../src/testing';

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
      const task = createTaskFixture({ title: 'Buy milk' });
      pool.add(task);

      const retrieved = pool.get(task.id) as TestTask | undefined;
      expect(retrieved).toBe(task);
      expect(retrieved?.title).toBe('Buy milk');
    });

    it('should return undefined for missing id', () => {
      expect(pool.get('nonexistent')).toBeUndefined();
    });

    it('should track type index for model additions', () => {
      const task = createTaskFixture();
      pool.add(task);

      const tasks = pool.getByType(TestTask);
      expect(tasks).toHaveLength(1);
      expect(tasks[0]).toBe(task);
    });

    it('should add with default scope of live', () => {
      const task = createTaskFixture();
      pool.add(task);

      const liveTasks = pool.getByType(TestTask, ModelScope.live);
      expect(liveTasks).toHaveLength(1);

      const archivedTasks = pool.getByType(TestTask, ModelScope.archived);
      expect(archivedTasks).toHaveLength(0);
    });

    it('should add to archived scope', () => {
      const task = createTaskFixture();
      pool.add(task, ModelScope.archived);

      const liveTasks = pool.getByType(TestTask, ModelScope.live);
      expect(liveTasks).toHaveLength(0);

      const archivedTasks = pool.getByType(TestTask, ModelScope.archived);
      expect(archivedTasks).toHaveLength(1);
    });

    it('should return both live and archived with ModelScope.all', () => {
      const liveTask = createTaskFixture({ title: 'Live' });
      const archivedTask = createTaskFixture({ title: 'Archived' });
      pool.add(liveTask, ModelScope.live);
      pool.add(archivedTask, ModelScope.archived);

      const allTasks = pool.getByType(TestTask, ModelScope.all);
      expect(allTasks).toHaveLength(2);
    });
  });

  // ─────────────────────────────────────────────
  // Scope management
  // ─────────────────────────────────────────────

  describe('scope updates', () => {
    it('should update scope without creating duplicate when add() called with existing id', () => {
      const task = createTaskFixture();
      pool.add(task, ModelScope.live);

      // Re-add same model with different scope
      pool.add(task, ModelScope.archived);

      // Should still be just one entry
      const allTasks = pool.getByType(TestTask, ModelScope.all);
      expect(allTasks).toHaveLength(1);

      // Scope should be updated
      const archivedTasks = pool.getByType(TestTask, ModelScope.archived);
      expect(archivedTasks).toHaveLength(1);
    });
  });

  // ─────────────────────────────────────────────
  // Disposed model safety
  // ─────────────────────────────────────────────

  describe('disposed models', () => {
    it('should return undefined for disposed models on get()', () => {
      const task = createTaskFixture();
      pool.add(task);

      task.dispose();
      expect(pool.get(task.id)).toBeUndefined();
    });

    it('should not return disposed model via get() even if entry exists', () => {
      const task = createTaskFixture({ title: 'Original' });
      pool.add(task);
      task.dispose();

      // get() returns undefined for disposed models — this is the key safety invariant
      expect(pool.get(task.id)).toBeUndefined();
    });
  });

  // ─────────────────────────────────────────────
  // Batch operations
  // ─────────────────────────────────────────────

  describe('addBatch()', () => {
    it('should add multiple models in a single action', () => {
      const tasks = [
        createTaskFixture({ title: 'Task 1' }),
        createTaskFixture({ title: 'Task 2' }),
        createTaskFixture({ title: 'Task 3' }),
      ];

      const addedCount = pool.addBatch(tasks);
      expect(addedCount).toBe(3);
      expect(pool.size).toBe(3);
    });

    it('should skip already-existing models in batch', () => {
      const task = createTaskFixture();
      pool.add(task);

      const addedCount = pool.addBatch([task, createTaskFixture()]);
      expect(addedCount).toBe(1); // Only the new one
      expect(pool.size).toBe(2);
    });

    it('should return 0 for empty array', () => {
      expect(pool.addBatch([])).toBe(0);
    });
  });

  describe('removeBatch()', () => {
    it('should remove multiple models by id', () => {
      const t1 = createTaskFixture();
      const t2 = createTaskFixture();
      const t3 = createTaskFixture();
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
      const existing = createTaskFixture({ title: 'Original' });
      pool.add(existing);

      const updated = new TestTask({ id: existing.id, title: 'Updated' });
      const brandNew = createTaskFixture({ title: 'Brand New' });

      pool.upsertBatch([updated, brandNew]);

      expect(pool.size).toBe(2);
      // Existing model should be updated in-place
      expect((pool.get(existing.id) as TestTask | undefined)?.title).toBe('Updated');
      // The pool keeps the original instance, updated via updateFromData
      expect(pool.get(existing.id)).toBe(existing);
      // New model should be added
      expect((pool.get(brandNew.id) as TestTask | undefined)?.title).toBe('Brand New');
    });
  });

  // ─────────────────────────────────────────────
  // remove() and clear()
  // ─────────────────────────────────────────────

  describe('remove()', () => {
    it('should remove a model by id and dispose it', () => {
      const task = createTaskFixture();
      pool.add(task);

      const result = pool.remove(task.id);
      expect(result).toBe(true);
      expect(pool.get(task.id)).toBeUndefined();
      expect(task.disposed).toBe(true);
    });

    it('should return false for non-existent id', () => {
      expect(pool.remove('nonexistent')).toBe(false);
    });

    it('should remove from type index', () => {
      const task = createTaskFixture();
      pool.add(task);
      pool.remove(task.id);

      expect(pool.getByType(TestTask)).toHaveLength(0);
    });
  });

  describe('clear()', () => {
    it('should remove all entries', () => {
      pool.addBatch([createTaskFixture(), createProjectFixture(), createSlideFixture()]);
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
        createTaskFixture(),
        createTaskFixture(),
        createProjectFixture(),
      ]);

      expect(pool.getByType(TestTask)).toHaveLength(2);
      expect(pool.getByType(TestProject)).toHaveLength(1);
    });

    it('should return empty array for type with no models', () => {
      expect(pool.getByType(TestSlideLayer)).toHaveLength(0);
    });

    it('should initialize type index lazily on first call', () => {
      // The type index for TestSlide should be created on first getByType call
      const slides = pool.getByType(TestSlide);
      expect(slides).toEqual([]);

      // Now add a slide and verify it shows up
      const slide = createSlideFixture();
      pool.add(slide);
      expect(pool.getByType(TestSlide)).toHaveLength(1);
    });
  });

  // ─────────────────────────────────────────────
  // getByTypeName (string-based lookup)
  // ─────────────────────────────────────────────

  describe('getByTypeName()', () => {
    it('should return models by type name string', () => {
      const task = createTaskFixture();
      pool.add(task);

      const tasks = pool.getByTypeName('Task');
      expect(tasks).toHaveLength(1);
      expect(tasks[0]).toBe(task);
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
      const task = createTaskFixture();
      pool.add(task);

      pool.get(task.id);
      pool.get(task.id);

      const stats = pool.getStats();
      expect(stats.metrics.hits).toBe(2);
    });

    it('should track misses on failed get()', () => {
      pool.get('nonexistent');

      const stats = pool.getStats();
      expect(stats.metrics.misses).toBe(1);
    });

    it('should track additions', () => {
      pool.add(createTaskFixture());
      pool.add(createTaskFixture());

      const stats = pool.getStats();
      expect(stats.metrics.additions).toBe(2);
    });

    it('should track duplicatesSkipped', () => {
      const task = createTaskFixture();
      pool.add(task);
      pool.add(task); // Duplicate — same id, not disposed

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

      pool.add(createTaskFixture());
      expect(pool.size).toBe(1);

      pool.add(createProjectFixture());
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
        values.push(pool.getByType(TestTask).length);
      });

      pool.add(createTaskFixture());
      pool.add(createTaskFixture());

      // Initial: 0, after first add: 1, after second add: 2
      expect(values).toEqual([0, 1, 2]);
      disposer();
    });

    it('should trigger autorun when model is removed', () => {
      const task = createTaskFixture();
      pool.add(task);

      const values: number[] = [];
      const disposer = autorun(() => {
        values.push(pool.getByType(TestTask).length);
      });

      pool.remove(task.id);

      expect(values).toEqual([1, 0]);
      disposer();
    });

    it('addBatch should trigger exactly 1 reaction (batched MobX action)', () => {
      let reactionCount = 0;

      const disposer = autorun(() => {
        pool.getByType(TestTask);
        reactionCount++;
      });

      reactionCount = 0; // Reset after initial autorun
      pool.addBatch([
        createTaskFixture(),
        createTaskFixture(),
        createTaskFixture(),
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
      const t1 = createTaskFixture();
      const t2 = createTaskFixture();
      pool.addBatch([t1, t2]);

      const ids = pool.getIdsByModelType('Task');
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
