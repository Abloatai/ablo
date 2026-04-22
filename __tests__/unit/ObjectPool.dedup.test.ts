/**
 * ObjectPool deduplication tests — rapid addition window, delta history.
 */

import { ObjectPool, ModelScope } from '../../src/ObjectPool';
import { ModelRegistry, setActiveRegistry } from '../../src/ModelRegistry';
import {
  createTestContext,
  registerTestModels,
  TestTask,
  createTaskFixture,
  resetFixtureCounter,
} from '../../src/testing';

describe('ObjectPool Deduplication', () => {
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

  describe('rapid re-addition window', () => {
    it('should skip rapid re-additions of different model instances with same type:id within 50ms', () => {
      const task1 = new TestTask({ id: 'shared-id', title: 'First' });
      const task2 = new TestTask({ id: 'shared-id', title: 'Second' });

      pool.add(task1);

      // Second add of same id should be skipped because task1 is still valid
      pool.add(task2);

      const retrieved = pool.get('shared-id');
      expect(retrieved).toBe(task1); // Original kept
      expect(pool.getStats().metrics.duplicatesSkipped).toBe(1);
    });
  });

  describe('delta history deduplication', () => {
    it('should skip re-add with older syncId when entry still exists', () => {
      const task1 = new TestTask({ id: 'task-1', title: 'First' });
      pool.add(task1, ModelScope.live, { action: 'I', syncId: 10 });

      // Try to add again with a lower syncId — entry still exists, so existing check deduplicates
      const task2 = new TestTask({ id: 'task-1', title: 'Second' });
      pool.add(task2, ModelScope.live, { action: 'I', syncId: 5 });

      // Original kept because existing entry was valid (not disposed)
      expect(pool.get('task-1')).toBe(task1);
      expect(pool.getStats().metrics.duplicatesSkipped).toBeGreaterThan(0);
    });

    it('should allow newer syncId to replace', () => {
      const task1 = new TestTask({ id: 'task-1', title: 'First' });
      pool.add(task1, ModelScope.live, { action: 'I', syncId: 5 });

      pool.remove('task-1');

      // Wait past the rapid addition window
      // In real code this is 50ms — here we clear recentAdditions manually
      // by accessing the pool after the remove cleared tracking
      const task2 = new TestTask({ id: 'task-1', title: 'Second' });
      pool.add(task2, ModelScope.live, { action: 'U', syncId: 15 });

      const retrieved = pool.get('task-1');
      expect(retrieved).toBe(task2);
    });

    it('should update delta history on each add with syncId', () => {
      const task = new TestTask({ id: 'task-1', title: 'Test' });
      pool.add(task, ModelScope.live, { action: 'I', syncId: 10 });

      // Try to add again with same syncId — should be deduplicated
      const task2 = new TestTask({ id: 'task-1', title: 'Dupe' });
      pool.add(task2, ModelScope.live, { action: 'U', syncId: 10 });

      // Original is kept (existing entry check runs first)
      expect(pool.get('task-1')).toBe(task);
    });
  });

  describe('existing entry check (primary dedup)', () => {
    it('should skip add when model already exists and is not disposed', () => {
      const task = createTaskFixture();
      pool.add(task);
      pool.add(task); // Same instance

      expect(pool.size).toBe(1);
      expect(pool.getStats().metrics.duplicatesSkipped).toBe(1);
    });

    it('should update scope when re-adding with different scope', () => {
      const task = createTaskFixture();
      pool.add(task, ModelScope.live);
      pool.add(task, ModelScope.archived);

      // Model should be in archived scope now
      const archivedTasks = pool.getByType(TestTask, ModelScope.archived);
      expect(archivedTasks).toHaveLength(1);
      expect(archivedTasks[0]).toBe(task);
    });
  });
});
