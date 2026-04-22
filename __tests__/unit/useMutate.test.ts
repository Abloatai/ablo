/**
 * useMutate(schema, key) — schema-typed mutations tests.
 *
 * Tests the pure `createMutateActions` factory directly to avoid React
 * cross-version issues in the monorepo. The hook itself is a one-line
 * useMemo wrapper around this factory.
 */

import { z } from 'zod';
import { ObjectPool } from '../../src/ObjectPool';
import { ModelRegistry, setActiveRegistry } from '../../src/ModelRegistry';
import { Model } from '../../src/Model';
import { defineSchema, model, field } from '../../src/schema';
import type { SyncStoreContract } from '../../src/react/context';
import { createMutateActions } from '../../src/react/useMutate';
import { ViewRegistry } from '../../src/core/ViewRegistry';
import { createTestContext } from '../../src/testing';

// ── Test schema ────────────────────────────────────────────────────────

const testSchema = defineSchema({
  tasks: model(
    {
      title: z.string(),
      status: z.enum(['todo', 'in_progress', 'done']).default('todo'),
      priority: z.string().optional(),
      order: z.number().default(0),
      completedAt: z.date().optional(),
    },
    {},
    { typename: 'Task' },
  ),
});

// ── Test model class — registered for createFromData lookups ──────────

class TestTask extends Model {
  title!: string;
  status!: 'todo' | 'in_progress' | 'done';
  priority?: string;
  order!: number;
  completedAt?: Date;
  organizationId!: string;

  constructor(data: Record<string, unknown>) {
    super(data);
    this.title = data.title as string;
    this.status = (data.status as 'todo' | 'in_progress' | 'done') ?? 'todo';
    this.priority = data.priority as string | undefined;
    this.order = (data.order as number) ?? 0;
    this.completedAt = data.completedAt as Date | undefined;
    this.organizationId = data.organizationId as string;
  }
}

// ── Minimal SyncStoreContract wrapping a real ObjectPool ──────────────

interface TestStore extends SyncStoreContract {
  saveCalls: Model[];
  deleteCalls: Model[];
  archiveCalls: Model[];
  unarchiveCalls: Model[];
}

function createStore(pool: ObjectPool): TestStore {
  const store: TestStore = {
    saveCalls: [],
    deleteCalls: [],
    archiveCalls: [],
    unarchiveCalls: [],

    findById: (_class, id) => pool.get(id),
    queryByClass: () => ({ data: [] }),

    save: async (m) => {
      store.saveCalls.push(m);
      if (!pool.get(m.id)) pool.add(m);
    },
    delete: async (m) => {
      store.deleteCalls.push(m);
      pool.remove(m.id);
    },
    archive: async (m) => {
      store.archiveCalls.push(m);
    },
    unarchive: async (m) => {
      store.unarchiveCalls.push(m);
    },

    pool: {
      get: (id) => pool.get(id),
      getByTypeName: (typename, scope) => pool.getByTypeName(typename, scope),
      getByForeignKey: (modelName, fieldName, fieldValue) =>
        pool.getByForeignKey(modelName, fieldName, fieldValue),
      createFromData: (data) => pool.createFromData(data),
      hasForeignKeyIndex: (typename, fieldName) =>
        pool.hasForeignKeyIndex(typename, fieldName),
      createView: (typename, options) => pool.createView(typename, options),
      viewRegistry: pool.viewRegistry ?? new ViewRegistry(),
    },
  };
  return store;
}

// ── Setup ──────────────────────────────────────────────────────────────

let pool: ObjectPool;
let registry: ModelRegistry;
let store: TestStore;
let cleanupCtx: () => void;

beforeEach(() => {
  registry = new ModelRegistry();
  registry.registerModel('Task', TestTask);
  setActiveRegistry(registry);
  const ctx = createTestContext();
  cleanupCtx = ctx.cleanup;
  pool = new ObjectPool({ maxSize: 100, gcInterval: 0, useWeakRefs: false }, registry);
  store = createStore(pool);
});

afterEach(() => {
  pool.clear();
  cleanupCtx();
});

// ── Tests ──────────────────────────────────────────────────────────────

describe('useMutate.create', () => {
  it('creates a model with auto-generated id, timestamps, and orgId', async () => {
    const tasks = createMutateActions(testSchema, 'tasks', store, 'org-1');

    const created = await tasks.create({ title: 'Fix bug' });

    expect(created).toBeDefined();
    expect((created as { id: string }).id).toMatch(/^[0-9a-f-]+$/);
    expect((created as { title: string }).title).toBe('Fix bug');
    expect((created as { status: string }).status).toBe('todo');
    expect(store.saveCalls).toHaveLength(1);
    expect(pool.get((created as { id: string }).id)).toBeDefined();
  });

  it('respects caller-provided id', async () => {
    const tasks = createMutateActions(testSchema, 'tasks', store, 'org-1');

    const created = await tasks.create({ id: 'task-custom', title: 'Task' });

    expect((created as { id: string }).id).toBe('task-custom');
    expect(pool.get('task-custom')).toBeDefined();
  });

  it('uses organizationId from context when not provided', async () => {
    const tasks = createMutateActions(testSchema, 'tasks', store, 'org-1');

    const created = await tasks.create({ title: 'Task' });

    expect((created as { organizationId: string }).organizationId).toBe('org-1');
  });

  it('uses provided organizationId over context default', async () => {
    const tasks = createMutateActions(testSchema, 'tasks', store, 'org-1');

    const created = await tasks.create({
      title: 'Task',
      organizationId: 'org-override',
    } as never);

    expect((created as { organizationId: string }).organizationId).toBe('org-override');
  });
});

describe('useMutate.update', () => {
  it('applies partial changes and saves', async () => {
    const tasks = createMutateActions(testSchema, 'tasks', store, 'org-1');
    const created = await tasks.create({ title: 'Original' });
    const id = (created as { id: string }).id;

    const updated = await tasks.update({ id, title: 'Updated', status: 'done' });

    expect((updated as { title: string }).title).toBe('Updated');
    expect((updated as { status: string }).status).toBe('done');
    expect(store.saveCalls).toHaveLength(2);

    const fromPool = pool.get(id) as unknown as { title: string; status: string };
    expect(fromPool.title).toBe('Updated');
    expect(fromPool.status).toBe('done');
  });

  it('updates updatedAt timestamp', async () => {
    const tasks = createMutateActions(testSchema, 'tasks', store, 'org-1');
    const created = await tasks.create({ title: 'Task' });
    const id = (created as { id: string }).id;
    const originalUpdatedAt = (created as { updatedAt: Date }).updatedAt.getTime();

    await new Promise((r) => setTimeout(r, 5));
    await tasks.update({ id, title: 'New' });

    const fromPool = pool.get(id) as unknown as { updatedAt: Date };
    expect(fromPool.updatedAt.getTime()).toBeGreaterThan(originalUpdatedAt);
  });

  it('throws if model not found in pool', async () => {
    const tasks = createMutateActions(testSchema, 'tasks', store, 'org-1');

    await expect(tasks.update({ id: 'nonexistent', title: 'x' })).rejects.toThrow(
      /not found in pool/,
    );
  });

  it('preserves model identity (same instance) across updates', async () => {
    const tasks = createMutateActions(testSchema, 'tasks', store, 'org-1');
    const created = await tasks.create({ title: 'Task' });
    const id = (created as { id: string }).id;
    const beforeRef = pool.get(id);

    await tasks.update({ id, title: 'Changed' });
    const afterRef = pool.get(id);

    expect(afterRef).toBe(beforeRef);
  });
});

describe('useMutate.delete', () => {
  it('deletes a model by id', async () => {
    const tasks = createMutateActions(testSchema, 'tasks', store, 'org-1');
    const created = await tasks.create({ title: 'Task' });
    const id = (created as { id: string }).id;
    expect(pool.get(id)).toBeDefined();

    await tasks.delete(id);

    expect(store.deleteCalls).toHaveLength(1);
    expect(pool.get(id)).toBeUndefined();
  });

  it('no-ops silently if model is not in pool', async () => {
    const tasks = createMutateActions(testSchema, 'tasks', store, 'org-1');

    await tasks.delete('nonexistent');

    expect(store.deleteCalls).toHaveLength(0);
  });
});

describe('useMutate.archive / unarchive', () => {
  it('archives a model by id', async () => {
    const tasks = createMutateActions(testSchema, 'tasks', store, 'org-1');
    const created = await tasks.create({ title: 'Task' });
    const id = (created as { id: string }).id;

    await tasks.archive(id);

    expect(store.archiveCalls).toHaveLength(1);
    expect(store.archiveCalls[0]?.id).toBe(id);
  });

  it('unarchives a model by id', async () => {
    const tasks = createMutateActions(testSchema, 'tasks', store, 'org-1');
    const created = await tasks.create({ title: 'Task' });
    const id = (created as { id: string }).id;

    await tasks.unarchive(id);

    expect(store.unarchiveCalls).toHaveLength(1);
    expect(store.unarchiveCalls[0]?.id).toBe(id);
  });

  it('archive no-ops if not found', async () => {
    const tasks = createMutateActions(testSchema, 'tasks', store, 'org-1');
    await tasks.archive('nonexistent');
    expect(store.archiveCalls).toHaveLength(0);
  });
});
