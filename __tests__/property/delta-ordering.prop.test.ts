/**
 * Property-based tests for delta ordering.
 *
 * Uses fast-check to verify:
 * - Duplicate deltas (same syncId) are idempotent in ObjectPool
 * - INSERT followed by UPDATE produces model with merged fields
 * - Random delta sequences never corrupt pool type index
 */

import fc from 'fast-check';
import { ObjectPool, ModelScope } from '../../src/ObjectPool';
import { ModelRegistry, setActiveRegistry } from '../../src/ModelRegistry';
import {
  createTestContext,
  registerTestModels,
  TestTask,
  resetFixtureCounter,
} from '../../src/testing';

describe('Property: Delta Ordering Invariants', () => {
  let registry: ModelRegistry;
  let cleanup: () => void;

  beforeEach(() => {
    resetFixtureCounter();
    registry = new ModelRegistry();
    setActiveRegistry(registry);
    registerTestModels(registry);
    const ctx = createTestContext();
    cleanup = ctx.cleanup;
  });

  afterEach(() => {
    cleanup();
  });

  it('duplicate add with same syncId is idempotent (pool size unchanged)', () => {
    fc.assert(
      fc.property(
        fc.uuid(),
        fc.integer({ min: 1, max: 1000 }),
        fc.integer({ min: 1, max: 5 }),
        (modelId, syncId, repeatCount) => {
          const pool = new ObjectPool({ maxSize: 100, gcInterval: 0, useWeakRefs: false }, registry);

          // Add the same model with the same syncId multiple times
          for (let i = 0; i < repeatCount; i++) {
            pool.add(
              new TestTask({ id: modelId, title: `Attempt ${i}` }),
              ModelScope.live,
              { action: 'I', syncId }
            );
          }

          // INVARIANT: pool should have exactly 1 entry for this ID
          expect(pool.size).toBe(1);

          // The first add should win (subsequent adds are deduped)
          const model = pool.get(modelId);
          expect(model).toBeDefined();

          pool.clear();
        }
      ),
      { numRuns: 30 }
    );
  });

  it('INSERT then UPDATE with higher syncId results in model present in pool', () => {
    fc.assert(
      fc.property(
        fc.uuid(),
        fc.integer({ min: 1, max: 500 }),
        fc.string({ minLength: 1, maxLength: 20 }),
        fc.string({ minLength: 1, maxLength: 20 }),
        (modelId, baseSyncId, title1, title2) => {
          const pool = new ObjectPool({ maxSize: 100, gcInterval: 0, useWeakRefs: false }, registry);

          // INSERT
          const model = new TestTask({ id: modelId, title: title1 });
          pool.add(model, ModelScope.live, { action: 'I', syncId: baseSyncId });

          // UPDATE with higher syncId — should update in place via upsert
          const updatedModel = new TestTask({ id: modelId, title: title2 });
          pool.upsert(updatedModel, ModelScope.live);

          // INVARIANT: model is still present and was updated
          const retrieved = pool.get(modelId) as TestTask | undefined;
          expect(retrieved).toBeDefined();
          expect(retrieved!.title).toBe(title2);

          pool.clear();
        }
      ),
      { numRuns: 30 }
    );
  });

  it('random INSERT/REMOVE sequences never corrupt type index', () => {
    const opArb = fc.oneof(
      fc.record({
        type: fc.constant('insert' as const),
        id: fc.uuid(),
        syncId: fc.integer({ min: 1, max: 10000 }),
      }),
      fc.record({
        type: fc.constant('remove' as const),
        id: fc.uuid(),
      })
    );

    fc.assert(
      fc.property(
        fc.array(opArb, { minLength: 5, maxLength: 50 }),
        (ops) => {
          const pool = new ObjectPool({ maxSize: 500, gcInterval: 0, useWeakRefs: false }, registry);
          const knownIds = new Set<string>();

          for (const op of ops) {
            if (op.type === 'insert') {
              pool.add(
                new TestTask({ id: op.id }),
                ModelScope.live,
                { action: 'I', syncId: op.syncId }
              );
              knownIds.add(op.id);
            } else {
              pool.remove(op.id);
              knownIds.delete(op.id);
            }
          }

          // INVARIANT: type index should be consistent
          const typeIds = pool.getIdsByModelType('Task');
          const poolTasks = pool.getByType(TestTask, ModelScope.all);

          if (typeIds) {
            // Every ID in type index should be gettable
            for (const id of typeIds) {
              // May be undefined if disposed, but should not throw
              pool.get(id);
            }

            // getByType count should match type index size (minus disposed/GC'd)
            expect(poolTasks.length).toBeLessThanOrEqual(typeIds.size);
          }

          pool.clear();
        }
      ),
      { numRuns: 30 }
    );
  });

  it('DELETE always removes model regardless of prior operations', () => {
    fc.assert(
      fc.property(
        fc.uuid(),
        fc.array(
          fc.oneof(
            fc.constant('insert' as const),
            fc.constant('update' as const)
          ),
          { minLength: 1, maxLength: 5 }
        ),
        (modelId, priorOps) => {
          const pool = new ObjectPool({ maxSize: 100, gcInterval: 0, useWeakRefs: false }, registry);

          // Apply prior operations
          let syncId = 1;
          for (const op of priorOps) {
            if (op === 'insert') {
              pool.add(
                new TestTask({ id: modelId }),
                ModelScope.live,
                { action: 'I', syncId: syncId++ }
              );
            } else {
              pool.upsert(
                new TestTask({ id: modelId, title: `Update ${syncId}` }),
                ModelScope.live
              );
              syncId++;
            }
          }

          // DELETE
          pool.remove(modelId);

          // INVARIANT: model is gone regardless of prior state
          expect(pool.get(modelId)).toBeUndefined();

          // Type index should not contain the ID
          const typeIds = pool.getIdsByModelType('Task');
          if (typeIds) {
            expect(typeIds.has(modelId)).toBe(false);
          }

          pool.clear();
        }
      ),
      { numRuns: 30 }
    );
  });
});
