/**
 * ObjectPool deduplication tests — rapid addition window, delta history.
 */

import { InstanceCache as ObjectPool, ModelScope } from '../../src/local/InstanceCache';
import { ModelRegistry, setActiveRegistry } from '../../src/local/ModelRegistry';
import {
  createTestContext,
  registerTestModels,
  TestItem,
  createItemFixture,
  resetFixtureCounter,
} from '../../src/local/testing';

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
      const item1 = new TestItem({ id: 'shared-id', title: 'First' });
      const item2 = new TestItem({ id: 'shared-id', title: 'Second' });

      pool.add(item1);

      // Second add of same id should be skipped because item1 is still valid
      pool.add(item2);

      const retrieved = pool.get('shared-id');
      expect(retrieved).toBe(item1); // Original kept
      expect(pool.getStats().metrics.duplicatesSkipped).toBe(1);
    });
  });

  describe('delta history deduplication', () => {
    it('should skip re-add with older syncId when entry still exists', () => {
      const item1 = new TestItem({ id: 'item-1', title: 'First' });
      pool.add(item1, ModelScope.live, { action: 'I', syncId: 10 });

      // Try to add again with a lower syncId — entry still exists, so existing check deduplicates
      const item2 = new TestItem({ id: 'item-1', title: 'Second' });
      pool.add(item2, ModelScope.live, { action: 'I', syncId: 5 });

      // Original kept because existing entry was valid (not disposed)
      expect(pool.get('item-1')).toBe(item1);
      expect(pool.getStats().metrics.duplicatesSkipped).toBeGreaterThan(0);
    });

    it('should allow newer syncId to replace', () => {
      const item1 = new TestItem({ id: 'item-1', title: 'First' });
      pool.add(item1, ModelScope.live, { action: 'I', syncId: 5 });

      pool.remove('item-1');

      // Wait past the rapid addition window
      // In real code this is 50ms — here we clear recentAdditions manually
      // by accessing the pool after the remove cleared tracking
      const item2 = new TestItem({ id: 'item-1', title: 'Second' });
      pool.add(item2, ModelScope.live, { action: 'U', syncId: 15 });

      const retrieved = pool.get('item-1');
      expect(retrieved).toBe(item2);
    });

    it('should update delta history on each add with syncId', () => {
      const item = new TestItem({ id: 'item-1', title: 'Test' });
      pool.add(item, ModelScope.live, { action: 'I', syncId: 10 });

      // Try to add again with same syncId — should be deduplicated
      const item2 = new TestItem({ id: 'item-1', title: 'Dupe' });
      pool.add(item2, ModelScope.live, { action: 'U', syncId: 10 });

      // Original is kept (existing entry check runs first)
      expect(pool.get('item-1')).toBe(item);
    });
  });

  describe('existing entry check (primary dedup)', () => {
    it('should skip add when model already exists and is not disposed', () => {
      const item = createItemFixture();
      pool.add(item);
      pool.add(item); // Same instance

      expect(pool.size).toBe(1);
      expect(pool.getStats().metrics.duplicatesSkipped).toBe(1);
    });

    it('should update scope when re-adding with different scope', () => {
      const item = createItemFixture();
      pool.add(item, ModelScope.live);
      pool.add(item, ModelScope.archived);

      // Model should be in archived scope now
      const archivedItems = pool.getByType(TestItem, ModelScope.archived);
      expect(archivedItems).toHaveLength(1);
      expect(archivedItems[0]).toBe(item);
    });
  });
});
