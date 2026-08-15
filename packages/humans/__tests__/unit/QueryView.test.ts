/**
 * QueryView + ViewRegistry IVM (Incremental View Maintenance) tests.
 *
 * Tests are written against pool.createView<T>() and the underlying
 * QueryView / ViewRegistry in src/views/.
 */

import { InstanceCache as ObjectPool, ModelScope } from '../../src/local/InstanceCache';
import { ModelRegistry, setActiveRegistry } from '../../src/local/ModelRegistry';
import { QueryView, type QueryViewOptions } from '../../src/local/views/QueryView';
import { ViewRegistry } from '../../src/local/views/ViewRegistry';
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

// ---------------------------------------------------------------------------
// Type helpers — QueryView requires `T extends Record<string, unknown>`.
// Test model classes satisfy this structurally but TS can't prove it for
// classes without an explicit index signature. We declare branded intersections
// that keep autocomplete working in the tests.
// ---------------------------------------------------------------------------

type ItemRecord = TestItem & Record<string, unknown>;
type EntryRecord = TestEntry & Record<string, unknown>;
type EntryLayerRecord = TestEntryLayer & Record<string, unknown>;

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
    const items = Array.from({ length: 5 }, () => createItemFixture());
    items.forEach((t) => { pool.add(t); });

    const view = pool.createView<ItemRecord>('Item');
    expect(view.results).toHaveLength(5);
  });

  it('filters with where clause', () => {
    pool.add(createItemFixture({ workspaceId: 'p1' }));
    pool.add(createItemFixture({ workspaceId: 'p1' }));
    pool.add(createItemFixture({ workspaceId: 'p2' }));

    const view = pool.createView<ItemRecord>('Item', {
      where: { workspaceId: 'p1' },
    });

    expect(view.results).toHaveLength(2);
    view.results.forEach((t) => { expect(t.workspaceId).toBe('p1'); });
  });

  it('filters with filter predicate', () => {
    pool.add(createItemFixture({ status: 'done' }));
    pool.add(createItemFixture({ status: 'done' }));
    pool.add(createItemFixture({ status: 'todo' }));

    const view = pool.createView<ItemRecord>('Item', {
      filter: (t: ItemRecord) => t.status === 'done',
    });

    expect(view.results).toHaveLength(2);
  });

  it('sorts by orderBy', () => {
    pool.add(createEntryFixture({ order: 3 }));
    pool.add(createEntryFixture({ order: 1 }));
    pool.add(createEntryFixture({ order: 2 }));

    const view = pool.createView<EntryRecord>('Entry', {
      orderBy: 'order',
      order: 'asc',
    });

    expect(view.results.map((s) => s.order)).toEqual([1, 2, 3]);
  });

  it('applies limit', () => {
    Array.from({ length: 10 }, () => createItemFixture()).forEach((t) => { pool.add(t); });

    const view = pool.createView<ItemRecord>('Item', { limit: 3 });
    expect(view.results).toHaveLength(3);
  });

  it('applies offset + limit', () => {
    const entries = Array.from({ length: 10 }, (_, i) =>
      createEntryFixture({ order: i + 1 })
    );
    entries.forEach((s) => { pool.add(s); });

    const view = pool.createView<EntryRecord>('Entry', {
      orderBy: 'order',
      order: 'asc',
      offset: 2,
      limit: 3,
    });

    expect(view.results).toHaveLength(3);
    expect(view.results.map((s) => s.order)).toEqual([3, 4, 5]);
  });

  it('uses FK index when available and returns correct results', () => {
    pool.registerForeignKey('EntryDetail', 'entryId');

    const entry = createEntryFixture();
    pool.add(entry);
    pool.add(createEntryLayerFixture({ entryId: entry.id }));
    pool.add(createEntryLayerFixture({ entryId: entry.id }));
    pool.add(createEntryLayerFixture({ entryId: 'other-entry' }));

    const view = pool.createView<EntryLayerRecord>('EntryDetail', {
      where: { entryId: entry.id },
    });

    expect(view.results).toHaveLength(2);
    view.results.forEach((l) => { expect(l.entryId).toBe(entry.id); });
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
    pool.add(createItemFixture({ status: 'done' }));

    const view = pool.createView<ItemRecord>('Item', {
      filter: (t: ItemRecord) => t.status === 'done',
    });
    expect(view.results).toHaveLength(1);

    pool.add(createItemFixture({ status: 'done' }));
    expect(view.results).toHaveLength(2);
  });

  it('adding a non-matching model does NOT update view results', () => {
    pool.add(createItemFixture({ status: 'done' }));

    const view = pool.createView<ItemRecord>('Item', {
      filter: (t: ItemRecord) => t.status === 'done',
    });
    expect(view.results).toHaveLength(1);

    pool.add(createItemFixture({ status: 'todo' }));
    expect(view.results).toHaveLength(1);
  });

  it('added model is inserted in correct sort position', () => {
    pool.add(createEntryFixture({ order: 1 }));
    pool.add(createEntryFixture({ order: 3 }));
    pool.add(createEntryFixture({ order: 5 }));

    const view = pool.createView<EntryRecord>('Entry', {
      orderBy: 'order',
      order: 'asc',
    });
    expect(view.results.map((s) => s.order)).toEqual([1, 3, 5]);

    pool.add(createEntryFixture({ order: 2 }));
    expect(view.results.map((s) => s.order)).toEqual([1, 2, 3, 5]);
    expect(view.results[1]?.order).toBe(2);
  });

  it('added model respects limit', () => {
    Array.from({ length: 3 }, (_, i) =>
      createEntryFixture({ order: i + 1 })
    ).forEach((s) => { pool.add(s); });

    const view = pool.createView<EntryRecord>('Entry', {
      orderBy: 'order',
      order: 'asc',
      limit: 3,
    });
    expect(view.results).toHaveLength(3);

    // Add a model that would sort first — it enters the window, last one drops out
    pool.add(createEntryFixture({ order: 0 }));
    expect(view.results).toHaveLength(3);
    expect(view.results[0]?.order).toBe(0);
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
    const item = createItemFixture({ status: 'todo' });
    pool.add(item);

    const view = pool.createView<ItemRecord>('Item', {
      filter: (t: ItemRecord) => t.status === 'done',
    });
    expect(view.results).toHaveLength(0);

    // Mutate via upsert — upsert calls updateFromData on existing model
    const updated = new TestItem({ ...item, status: 'done' });
    updated.id = item.id;
    pool.upsert(updated, ModelScope.live);

    expect(view.results).toHaveLength(1);
    expect(view.results[0]?.status).toBe('done');
  });

  it('updating model that exits filter range removes it from view', () => {
    const item = createItemFixture({ status: 'done' });
    pool.add(item);

    const view = pool.createView<ItemRecord>('Item', {
      filter: (t: ItemRecord) => t.status === 'done',
    });
    expect(view.results).toHaveLength(1);

    const updated = new TestItem({ ...item, status: 'todo' });
    updated.id = item.id;
    pool.upsert(updated, ModelScope.live);

    expect(view.results).toHaveLength(0);
  });

  it('updating sort field repositions model', () => {
    const s1 = createEntryFixture({ order: 1 });
    const s2 = createEntryFixture({ order: 2 });
    const s3 = createEntryFixture({ order: 3 });
    pool.add(s1);
    pool.add(s2);
    pool.add(s3);

    const view = pool.createView<EntryRecord>('Entry', {
      orderBy: 'order',
      order: 'asc',
    });
    expect(view.results.map((s) => s.order)).toEqual([1, 2, 3]);

    // Move s1 to the end
    const updated = new TestEntry({ ...s1, order: 10 });
    updated.id = s1.id;
    pool.upsert(updated, ModelScope.live);

    expect(view.results.map((s) => s.order)).toEqual([2, 3, 10]);
  });

  it('updating non-relevant field does not change view order or membership', () => {
    const item = createItemFixture({ status: 'done', title: 'Original' });
    pool.add(item);

    const view = pool.createView<ItemRecord>('Item', {
      filter: (t: ItemRecord) => t.status === 'done',
    });
    expect(view.results).toHaveLength(1);

    // Update title (not filtered/sorted on)
    const updated = new TestItem({ ...item, title: 'Updated' });
    updated.id = item.id;
    pool.upsert(updated, ModelScope.live);

    expect(view.results).toHaveLength(1);
    expect(view.results[0]?.title).toBe('Updated');
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
    const t1 = createItemFixture();
    const t2 = createItemFixture();
    const t3 = createItemFixture();
    pool.add(t1);
    pool.add(t2);
    pool.add(t3);

    const view = pool.createView<ItemRecord>('Item');
    expect(view.results).toHaveLength(3);

    pool.remove(t2.id);
    expect(view.results).toHaveLength(2);
    expect(view.results.find((t) => t.id === t2.id)).toBeUndefined();
  });

  it('removing a model not in view does not affect view', () => {
    const matching = createItemFixture({ status: 'done' });
    const nonMatching = createItemFixture({ status: 'todo' });
    pool.add(matching);
    pool.add(nonMatching);

    const view = pool.createView<ItemRecord>('Item', {
      filter: (t: ItemRecord) => t.status === 'done',
    });
    expect(view.results).toHaveLength(1);

    pool.remove(nonMatching.id);
    expect(view.results).toHaveLength(1);
    expect(view.results[0]?.id).toBe(matching.id);
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
    const itemView = pool.createView<ItemRecord>('Item');
    const entryView = pool.createView<EntryRecord>('Entry');

    pool.add(createItemFixture());

    expect(itemView.results).toHaveLength(1);
    expect(entryView.results).toHaveLength(0);
  });

  it('disposed view stops receiving notifications', () => {
    const view = pool.createView<ItemRecord>('Item');
    pool.add(createItemFixture());
    expect(view.results).toHaveLength(1);

    view.dispose();

    pool.add(createItemFixture());
    // After dispose, results should not update
    expect(view.results).toHaveLength(1);
  });

  it('multiple views on same typename both get notified', () => {
    const doneView = pool.createView<ItemRecord>('Item', {
      filter: (t: ItemRecord) => t.status === 'done',
    });
    const todoView = pool.createView<ItemRecord>('Item', {
      filter: (t: ItemRecord) => t.status === 'todo',
    });

    pool.add(createItemFixture({ status: 'done' }));

    expect(doneView.results).toHaveLength(1);
    expect(todoView.results).toHaveLength(0);

    pool.add(createItemFixture({ status: 'todo' }));

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
    const view = pool.createView<ItemRecord>('Item');
    expect(view.results).toHaveLength(0);

    pool.add(createItemFixture());
    expect(view.results).toHaveLength(1);
  });

  it('pool.addBatch() notifies views', () => {
    const view = pool.createView<ItemRecord>('Item');

    const items = Array.from({ length: 5 }, () => createItemFixture());
    pool.addBatch(items);

    expect(view.results).toHaveLength(5);
  });

  it('pool.remove() notifies views', () => {
    const item = createItemFixture();
    pool.add(item);

    const view = pool.createView<ItemRecord>('Item');
    expect(view.results).toHaveLength(1);

    pool.remove(item.id);
    expect(view.results).toHaveLength(0);
  });

  it('pool.upsertBatch() notifies views for updates', () => {
    const item = createItemFixture({ status: 'todo' });
    pool.add(item);

    const view = pool.createView<ItemRecord>('Item', {
      filter: (t: ItemRecord) => t.status === 'done',
    });
    expect(view.results).toHaveLength(0);

    const updated = new TestItem({ ...item, status: 'done' });
    updated.id = item.id;
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
    pool.add(createItemFixture());
    pool.add(createItemFixture());
    pool.add(createItemFixture());

    const view = pool.createView<ItemRecord>('Item');
    expect(view.results).toHaveLength(3);
  });

  it('view on empty pool returns empty array', () => {
    const view = pool.createView<ItemRecord>('Item');
    expect(view.results).toHaveLength(0);
    expect(Array.from(view.results)).toEqual([]);
  });

  it('results reference is stable across mutations', () => {
    const view = pool.createView<ItemRecord>('Item');
    const ref = view.results;

    pool.add(createItemFixture());
    // The results reference should be the same object (important for React)
    expect(view.results).toBe(ref);
    expect(ref).toHaveLength(1);
  });
});
