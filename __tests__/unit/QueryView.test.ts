/**
 * QueryView + ViewRegistry IVM (Incremental View Maintenance) tests.
 *
 * Tests are written against pool.createView<T>() and the underlying
 * QueryView / ViewRegistry in src/core/.
 * Some tests (notably remove notifications) will fail until the
 * implementation agent wires notifyRemoved into ObjectPool.remove/removeBatch.
 */

import { ObjectPool, ModelScope } from '../../src/ObjectPool';
import { ModelRegistry, setActiveRegistry } from '../../src/ModelRegistry';
import { QueryView, type QueryViewOptions } from '../../src/core/QueryView';
import { ViewRegistry } from '../../src/core/ViewRegistry';
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

// ---------------------------------------------------------------------------
// Type helpers — QueryView requires `T extends Record<string, unknown>`.
// Test model classes satisfy this structurally but TS can't prove it for
// classes without an explicit index signature. We declare branded intersections
// that keep autocomplete working in the tests.
// ---------------------------------------------------------------------------

type TaskRecord = TestTask & Record<string, unknown>;
type SlideRecord = TestSlide & Record<string, unknown>;
type SlideLayerRecord = TestSlideLayer & Record<string, unknown>;

// ---------------------------------------------------------------------------
// Shared setup
// ---------------------------------------------------------------------------

function createPool(registry: ModelRegistry): ObjectPool {
  return new ObjectPool({ maxSize: 100, gcInterval: 0, useWeakRefs: false }, registry);
}

// ---------------------------------------------------------------------------
// A. QueryView initial scan
// ---------------------------------------------------------------------------

describe('QueryView initial scan', () => {
  let pool: ObjectPool;
  let registry: ModelRegistry;
  let cleanup: () => void;

  beforeEach(() => {
    resetFixtureCounter();
    registry = new ModelRegistry();
    registerTestModels(registry);
    setActiveRegistry(registry);
    const ctx = createTestContext();
    cleanup = ctx.cleanup;
    pool = createPool(registry);
  });

  afterEach(() => {
    pool.clear();
    cleanup();
  });

  it('returns all models of a type', () => {
    const tasks = Array.from({ length: 5 }, () => createTaskFixture());
    tasks.forEach((t) => pool.add(t));

    const view = pool.createView<TaskRecord>('Task');
    expect(view.results).toHaveLength(5);
  });

  it('filters with where clause', () => {
    pool.add(createTaskFixture({ projectId: 'p1' }));
    pool.add(createTaskFixture({ projectId: 'p1' }));
    pool.add(createTaskFixture({ projectId: 'p2' }));

    const view = pool.createView<TaskRecord>('Task', {
      where: { projectId: 'p1' },
    });

    expect(view.results).toHaveLength(2);
    view.results.forEach((t) => expect(t.projectId).toBe('p1'));
  });

  it('filters with filter predicate', () => {
    pool.add(createTaskFixture({ status: 'done' }));
    pool.add(createTaskFixture({ status: 'done' }));
    pool.add(createTaskFixture({ status: 'todo' }));

    const view = pool.createView<TaskRecord>('Task', {
      filter: (t: TaskRecord) => t.status === 'done',
    });

    expect(view.results).toHaveLength(2);
  });

  it('sorts by orderBy', () => {
    pool.add(createSlideFixture({ order: 3 }));
    pool.add(createSlideFixture({ order: 1 }));
    pool.add(createSlideFixture({ order: 2 }));

    const view = pool.createView<SlideRecord>('Slide', {
      orderBy: 'order',
      order: 'asc',
    });

    expect(view.results.map((s) => s.order)).toEqual([1, 2, 3]);
  });

  it('applies limit', () => {
    Array.from({ length: 10 }, () => createTaskFixture()).forEach((t) => pool.add(t));

    const view = pool.createView<TaskRecord>('Task', { limit: 3 });
    expect(view.results).toHaveLength(3);
  });

  it('applies offset + limit', () => {
    const slides = Array.from({ length: 10 }, (_, i) =>
      createSlideFixture({ order: i + 1 })
    );
    slides.forEach((s) => pool.add(s));

    const view = pool.createView<SlideRecord>('Slide', {
      orderBy: 'order',
      order: 'asc',
      offset: 2,
      limit: 3,
    });

    expect(view.results).toHaveLength(3);
    expect(view.results.map((s) => s.order)).toEqual([3, 4, 5]);
  });

  it('uses FK index when available and returns correct results', () => {
    pool.registerForeignKey('SlideLayer', 'slideId');

    const slide = createSlideFixture();
    pool.add(slide);
    pool.add(createSlideLayerFixture({ slideId: slide.id }));
    pool.add(createSlideLayerFixture({ slideId: slide.id }));
    pool.add(createSlideLayerFixture({ slideId: 'other-slide' }));

    const view = pool.createView<SlideLayerRecord>('SlideLayer', {
      where: { slideId: slide.id },
    });

    expect(view.results).toHaveLength(2);
    view.results.forEach((l) => expect(l.slideId).toBe(slide.id));
  });
});

// ---------------------------------------------------------------------------
// B. Incremental add
// ---------------------------------------------------------------------------

describe('QueryView incremental add', () => {
  let pool: ObjectPool;
  let registry: ModelRegistry;
  let cleanup: () => void;

  beforeEach(() => {
    resetFixtureCounter();
    registry = new ModelRegistry();
    registerTestModels(registry);
    setActiveRegistry(registry);
    const ctx = createTestContext();
    cleanup = ctx.cleanup;
    pool = createPool(registry);
  });

  afterEach(() => {
    pool.clear();
    cleanup();
  });

  it('adding a matching model updates view results', () => {
    pool.add(createTaskFixture({ status: 'done' }));

    const view = pool.createView<TaskRecord>('Task', {
      filter: (t: TaskRecord) => t.status === 'done',
    });
    expect(view.results).toHaveLength(1);

    pool.add(createTaskFixture({ status: 'done' }));
    expect(view.results).toHaveLength(2);
  });

  it('adding a non-matching model does NOT update view results', () => {
    pool.add(createTaskFixture({ status: 'done' }));

    const view = pool.createView<TaskRecord>('Task', {
      filter: (t: TaskRecord) => t.status === 'done',
    });
    expect(view.results).toHaveLength(1);

    pool.add(createTaskFixture({ status: 'todo' }));
    expect(view.results).toHaveLength(1);
  });

  it('added model is inserted in correct sort position', () => {
    pool.add(createSlideFixture({ order: 1 }));
    pool.add(createSlideFixture({ order: 3 }));
    pool.add(createSlideFixture({ order: 5 }));

    const view = pool.createView<SlideRecord>('Slide', {
      orderBy: 'order',
      order: 'asc',
    });
    expect(view.results.map((s) => s.order)).toEqual([1, 3, 5]);

    pool.add(createSlideFixture({ order: 2 }));
    expect(view.results.map((s) => s.order)).toEqual([1, 2, 3, 5]);
    expect(view.results[1].order).toBe(2);
  });

  it('added model respects limit', () => {
    Array.from({ length: 3 }, (_, i) =>
      createSlideFixture({ order: i + 1 })
    ).forEach((s) => pool.add(s));

    const view = pool.createView<SlideRecord>('Slide', {
      orderBy: 'order',
      order: 'asc',
      limit: 3,
    });
    expect(view.results).toHaveLength(3);

    // Add a model that would sort first — it enters the window, last one drops out
    pool.add(createSlideFixture({ order: 0 }));
    expect(view.results).toHaveLength(3);
    expect(view.results[0].order).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// C. Incremental update
// ---------------------------------------------------------------------------

describe('QueryView incremental update', () => {
  let pool: ObjectPool;
  let registry: ModelRegistry;
  let cleanup: () => void;

  beforeEach(() => {
    resetFixtureCounter();
    registry = new ModelRegistry();
    registerTestModels(registry);
    setActiveRegistry(registry);
    const ctx = createTestContext();
    cleanup = ctx.cleanup;
    pool = createPool(registry);
  });

  afterEach(() => {
    pool.clear();
    cleanup();
  });

  it('updating model that enters filter range adds it to view', () => {
    const task = createTaskFixture({ status: 'todo' });
    pool.add(task);

    const view = pool.createView<TaskRecord>('Task', {
      filter: (t: TaskRecord) => t.status === 'done',
    });
    expect(view.results).toHaveLength(0);

    // Mutate via upsert — upsert calls updateFromData on existing model
    const updated = new TestTask({ ...task, status: 'done' });
    updated.id = task.id;
    pool.upsert(updated, ModelScope.live);

    expect(view.results).toHaveLength(1);
    expect(view.results[0].status).toBe('done');
  });

  it('updating model that exits filter range removes it from view', () => {
    const task = createTaskFixture({ status: 'done' });
    pool.add(task);

    const view = pool.createView<TaskRecord>('Task', {
      filter: (t: TaskRecord) => t.status === 'done',
    });
    expect(view.results).toHaveLength(1);

    const updated = new TestTask({ ...task, status: 'todo' });
    updated.id = task.id;
    pool.upsert(updated, ModelScope.live);

    expect(view.results).toHaveLength(0);
  });

  it('updating sort field repositions model', () => {
    const s1 = createSlideFixture({ order: 1 });
    const s2 = createSlideFixture({ order: 2 });
    const s3 = createSlideFixture({ order: 3 });
    pool.add(s1);
    pool.add(s2);
    pool.add(s3);

    const view = pool.createView<SlideRecord>('Slide', {
      orderBy: 'order',
      order: 'asc',
    });
    expect(view.results.map((s) => s.order)).toEqual([1, 2, 3]);

    // Move s1 to the end
    const updated = new TestSlide({ ...s1, order: 10 });
    updated.id = s1.id;
    pool.upsert(updated, ModelScope.live);

    expect(view.results.map((s) => s.order)).toEqual([2, 3, 10]);
  });

  it('updating non-relevant field does not change view order or membership', () => {
    const task = createTaskFixture({ status: 'done', title: 'Original' });
    pool.add(task);

    const view = pool.createView<TaskRecord>('Task', {
      filter: (t: TaskRecord) => t.status === 'done',
    });
    expect(view.results).toHaveLength(1);

    // Update title (not filtered/sorted on)
    const updated = new TestTask({ ...task, title: 'Updated' });
    updated.id = task.id;
    pool.upsert(updated, ModelScope.live);

    expect(view.results).toHaveLength(1);
    expect(view.results[0].title).toBe('Updated');
  });
});

// ---------------------------------------------------------------------------
// D. Incremental remove
// ---------------------------------------------------------------------------

describe('QueryView incremental remove', () => {
  let pool: ObjectPool;
  let registry: ModelRegistry;
  let cleanup: () => void;

  beforeEach(() => {
    resetFixtureCounter();
    registry = new ModelRegistry();
    registerTestModels(registry);
    setActiveRegistry(registry);
    const ctx = createTestContext();
    cleanup = ctx.cleanup;
    pool = createPool(registry);
  });

  afterEach(() => {
    pool.clear();
    cleanup();
  });

  it('removing a model from pool removes it from view', () => {
    const t1 = createTaskFixture();
    const t2 = createTaskFixture();
    const t3 = createTaskFixture();
    pool.add(t1);
    pool.add(t2);
    pool.add(t3);

    const view = pool.createView<TaskRecord>('Task');
    expect(view.results).toHaveLength(3);

    pool.remove(t2.id);
    expect(view.results).toHaveLength(2);
    expect(view.results.find((t) => t.id === t2.id)).toBeUndefined();
  });

  it('removing a model not in view does not affect view', () => {
    const matching = createTaskFixture({ status: 'done' });
    const nonMatching = createTaskFixture({ status: 'todo' });
    pool.add(matching);
    pool.add(nonMatching);

    const view = pool.createView<TaskRecord>('Task', {
      filter: (t: TaskRecord) => t.status === 'done',
    });
    expect(view.results).toHaveLength(1);

    pool.remove(nonMatching.id);
    expect(view.results).toHaveLength(1);
    expect(view.results[0].id).toBe(matching.id);
  });
});

// ---------------------------------------------------------------------------
// E. ViewRegistry
// ---------------------------------------------------------------------------

describe('ViewRegistry', () => {
  let pool: ObjectPool;
  let registry: ModelRegistry;
  let cleanup: () => void;

  beforeEach(() => {
    resetFixtureCounter();
    registry = new ModelRegistry();
    registerTestModels(registry);
    setActiveRegistry(registry);
    const ctx = createTestContext();
    cleanup = ctx.cleanup;
    pool = createPool(registry);
  });

  afterEach(() => {
    pool.clear();
    cleanup();
  });

  it('notifies correct views by typename', () => {
    const taskView = pool.createView<TaskRecord>('Task');
    const slideView = pool.createView<SlideRecord>('Slide');

    pool.add(createTaskFixture());

    expect(taskView.results).toHaveLength(1);
    expect(slideView.results).toHaveLength(0);
  });

  it('disposed view stops receiving notifications', () => {
    const view = pool.createView<TaskRecord>('Task');
    pool.add(createTaskFixture());
    expect(view.results).toHaveLength(1);

    view.dispose();

    pool.add(createTaskFixture());
    // After dispose, results should not update
    expect(view.results).toHaveLength(1);
  });

  it('multiple views on same typename both get notified', () => {
    const doneView = pool.createView<TaskRecord>('Task', {
      filter: (t: TaskRecord) => t.status === 'done',
    });
    const todoView = pool.createView<TaskRecord>('Task', {
      filter: (t: TaskRecord) => t.status === 'todo',
    });

    pool.add(createTaskFixture({ status: 'done' }));

    expect(doneView.results).toHaveLength(1);
    expect(todoView.results).toHaveLength(0);

    pool.add(createTaskFixture({ status: 'todo' }));

    expect(doneView.results).toHaveLength(1);
    expect(todoView.results).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// F. ObjectPool integration
// ---------------------------------------------------------------------------

describe('QueryView ObjectPool integration', () => {
  let pool: ObjectPool;
  let registry: ModelRegistry;
  let cleanup: () => void;

  beforeEach(() => {
    resetFixtureCounter();
    registry = new ModelRegistry();
    registerTestModels(registry);
    setActiveRegistry(registry);
    const ctx = createTestContext();
    cleanup = ctx.cleanup;
    pool = createPool(registry);
  });

  afterEach(() => {
    pool.clear();
    cleanup();
  });

  it('pool.add() notifies views', () => {
    const view = pool.createView<TaskRecord>('Task');
    expect(view.results).toHaveLength(0);

    pool.add(createTaskFixture());
    expect(view.results).toHaveLength(1);
  });

  it('pool.addBatch() notifies views', () => {
    const view = pool.createView<TaskRecord>('Task');

    const tasks = Array.from({ length: 5 }, () => createTaskFixture());
    pool.addBatch(tasks);

    expect(view.results).toHaveLength(5);
  });

  it('pool.remove() notifies views', () => {
    const task = createTaskFixture();
    pool.add(task);

    const view = pool.createView<TaskRecord>('Task');
    expect(view.results).toHaveLength(1);

    pool.remove(task.id);
    expect(view.results).toHaveLength(0);
  });

  it('pool.upsertBatch() notifies views for updates', () => {
    const task = createTaskFixture({ status: 'todo' });
    pool.add(task);

    const view = pool.createView<TaskRecord>('Task', {
      filter: (t: TaskRecord) => t.status === 'done',
    });
    expect(view.results).toHaveLength(0);

    const updated = new TestTask({ ...task, status: 'done' });
    updated.id = task.id;
    pool.upsertBatch([updated], ModelScope.live);

    expect(view.results).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// G. Edge cases
// ---------------------------------------------------------------------------

describe('QueryView edge cases', () => {
  let pool: ObjectPool;
  let registry: ModelRegistry;
  let cleanup: () => void;

  beforeEach(() => {
    resetFixtureCounter();
    registry = new ModelRegistry();
    registerTestModels(registry);
    setActiveRegistry(registry);
    const ctx = createTestContext();
    cleanup = ctx.cleanup;
    pool = createPool(registry);
  });

  afterEach(() => {
    pool.clear();
    cleanup();
  });

  it('view with no options returns all models of type', () => {
    pool.add(createTaskFixture());
    pool.add(createTaskFixture());
    pool.add(createTaskFixture());

    const view = pool.createView<TaskRecord>('Task');
    expect(view.results).toHaveLength(3);
  });

  it('view on empty pool returns empty array', () => {
    const view = pool.createView<TaskRecord>('Task');
    expect(view.results).toHaveLength(0);
    expect(Array.from(view.results)).toEqual([]);
  });

  it('results reference is stable across mutations', () => {
    const view = pool.createView<TaskRecord>('Task');
    const ref = view.results;

    pool.add(createTaskFixture());
    // The results reference should be the same object (important for React)
    expect(view.results).toBe(ref);
    expect(ref).toHaveLength(1);
  });
});
