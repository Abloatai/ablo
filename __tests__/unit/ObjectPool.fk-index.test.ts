/**
 * ObjectPool FK index tests — registration, lookup, cleanup on remove.
 */

import { ObjectPool, ModelScope } from '../../src/ObjectPool';
import { ModelRegistry, setActiveRegistry } from '../../src/ModelRegistry';
import {
  createTestContext,
  registerTestModels,
  TestSlide,
  TestSlideLayer,
  TestTask,
  createSlideFixture,
  createSlideLayerFixture,
  createTaskFixture,
  resetFixtureCounter,
} from '../../src/testing';

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
    pool.registerForeignKey('SlideLayer', 'slideId');
    pool.registerForeignKey('Task', 'projectId');
  });

  afterEach(() => {
    pool.clear();
    cleanup();
  });

  it('should index model by FK value on add()', () => {
    const slide = createSlideFixture();
    const layer1 = createSlideLayerFixture({ slideId: slide.id });
    const layer2 = createSlideLayerFixture({ slideId: slide.id });

    pool.add(slide);
    pool.add(layer1);
    pool.add(layer2);

    const layers = pool.getByForeignKey('SlideLayer', 'slideId', slide.id);
    expect(layers).toHaveLength(2);
    expect(layers).toContain(layer1);
    expect(layers).toContain(layer2);
  });

  it('should return empty for FK value with no matching models', () => {
    const layers = pool.getByForeignKey('SlideLayer', 'slideId', 'nonexistent');
    expect(layers).toHaveLength(0);
  });

  it('should return empty for unregistered FK field', () => {
    const task = createTaskFixture({ assigneeId: 'user-1' });
    pool.add(task);

    // assigneeId is NOT registered as FK index
    const tasks = pool.getByForeignKey('Task', 'assigneeId', 'user-1');
    expect(tasks).toHaveLength(0);
  });

  it('should handle null FK values (skip indexing)', () => {
    const layer = createSlideLayerFixture({ slideId: null });
    pool.add(layer);

    // null FK values are not indexed (only string values)
    const layers = pool.getByForeignKey('SlideLayer', 'slideId', 'null');
    expect(layers).toHaveLength(0);
  });

  it('should handle multiple models with same FK value', () => {
    const slide = createSlideFixture();
    const layers = Array.from({ length: 5 }, (_, i) =>
      createSlideLayerFixture({ slideId: slide.id, zIndex: i })
    );

    pool.add(slide);
    pool.addBatch(layers);

    const result = pool.getByForeignKey('SlideLayer', 'slideId', slide.id);
    expect(result).toHaveLength(5);
  });

  it('should clean up FK index entries on remove()', () => {
    const slide = createSlideFixture();
    const layer = createSlideLayerFixture({ slideId: slide.id });
    pool.add(slide);
    pool.add(layer);

    expect(pool.getByForeignKey('SlideLayer', 'slideId', slide.id)).toHaveLength(1);

    pool.remove(layer.id);

    expect(pool.getByForeignKey('SlideLayer', 'slideId', slide.id)).toHaveLength(0);
  });

  it('should clean up FK index on removeBatch()', () => {
    const slide = createSlideFixture();
    const l1 = createSlideLayerFixture({ slideId: slide.id });
    const l2 = createSlideLayerFixture({ slideId: slide.id });
    pool.add(slide);
    pool.addBatch([l1, l2]);

    pool.removeBatch([l1.id, l2.id]);

    expect(pool.getByForeignKey('SlideLayer', 'slideId', slide.id)).toHaveLength(0);
  });

  it('should support multiple FK fields on the same model', () => {
    // Task has both projectId (registered) and assigneeId (not registered)
    const task = createTaskFixture({ projectId: 'project-1' });
    pool.add(task);

    const byProject = pool.getByForeignKey('Task', 'projectId', 'project-1');
    expect(byProject).toHaveLength(1);
    expect(byProject[0]).toBe(task);
  });
});
