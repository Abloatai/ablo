/**
 * defineMutators + Transaction tests — pure factory path.
 *
 * Tests the pure `createTransaction` + `defineMutators` factories directly,
 * mirroring how `useMutators` dispatches internally. React hook is NOT
 * tested here (avoids cross-version React issues in the monorepo).
 *
 * Pattern follows useMutate.test.ts / useReader.test.ts.
 */

import { z } from 'zod';
import { ObjectPool } from '../../src/ObjectPool';
import { ModelRegistry, setActiveRegistry } from '../../src/ModelRegistry';
import { Model } from '../../src/Model';
import { defineSchema, model } from '../../src/schema';
import type { SyncStoreContract } from '../../src/react/context';
import { ViewRegistry } from '../../src/core/ViewRegistry';
import { createTestContext } from '../../src/testing';

import { createTransaction, type Transaction } from '../../src/mutators/Transaction';
import { defineMutators } from '../../src/mutators/defineMutators';

// ── Test schema ────────────────────────────────────────────────────────

const testSchema = defineSchema({
  tasks: model(
    {
      title: z.string(),
      status: z.enum(['todo', 'in_progress', 'done']).default('todo'),
      priority: z.string().optional(),
      order: z.number().default(0),
      projectId: z.string().optional(),
      parentId: z.string().optional(),
    },
    {},
    { typename: 'Task' },
  ),
  projects: model(
    {
      name: z.string(),
      description: z.string().optional(),
    },
    {},
    { typename: 'Project' },
  ),
});

type TestSchema = typeof testSchema;

// ── Test model classes ────────────────────────────────────────────────

class TestTask extends Model {
  title!: string;
  status!: 'todo' | 'in_progress' | 'done';
  priority?: string;
  order!: number;
  projectId?: string;
  parentId?: string;
  organizationId!: string;

  constructor(data: Record<string, unknown>) {
    super(data);
    this.title = data.title as string;
    this.status = (data.status as 'todo' | 'in_progress' | 'done') ?? 'todo';
    this.priority = data.priority as string | undefined;
    this.order = (data.order as number) ?? 0;
    this.projectId = data.projectId as string | undefined;
    this.parentId = data.parentId as string | undefined;
    this.organizationId = data.organizationId as string;
  }
}

class TestProject extends Model {
  name!: string;
  description?: string;
  organizationId!: string;

  constructor(data: Record<string, unknown>) {
    super(data);
    this.name = data.name as string;
    this.description = data.description as string | undefined;
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
  registry.registerModel('Project', TestProject);
  setActiveRegistry(registry);
  const ctx = createTestContext();
  cleanupCtx = ctx.cleanup;
  pool = new ObjectPool({ maxSize: 100, gcInterval: 0, useWeakRefs: false }, registry);
  pool.registerForeignKey('Task', 'projectId');
  pool.registerForeignKey('Task', 'parentId');
  store = createStore(pool);
});

afterEach(() => {
  pool.clear();
  cleanupCtx();
});

// ── Helpers ────────────────────────────────────────────────────────────

interface TaskShape {
  id: string;
  title: string;
  status: 'todo' | 'in_progress' | 'done';
  projectId?: string;
  parentId?: string;
  organizationId: string;
}

interface ProjectShape {
  id: string;
  name: string;
  description?: string;
  organizationId: string;
}

function asTask(m: unknown): TaskShape {
  return m as unknown as TaskShape;
}

function asProject(m: unknown): ProjectShape {
  return m as unknown as ProjectShape;
}

// ═══════════════════════════════════════════════════════════════════════
// A. defineMutators pass-through
// ═══════════════════════════════════════════════════════════════════════

describe('defineMutators', () => {
  it('returns the same mutators object (pass-through)', () => {
    const defs = {
      tasks: {
        myMutator: async ({ args }: { tx: Transaction<TestSchema>; args: { x: number } }) =>
          args.x,
      },
    };

    const result = defineMutators(testSchema, defs);

    // Pass-through: either same reference or structurally identical
    expect(result.tasks.myMutator).toBe(defs.tasks.myMutator);
  });

  it('preserves all declared mutator groups and names', () => {
    const mutators = defineMutators(testSchema, {
      tasks: {
        a: async () => 1,
        b: async () => 2,
      },
      projects: {
        c: async () => 3,
      },
    });

    expect(Object.keys(mutators)).toEqual(expect.arrayContaining(['tasks', 'projects']));
    expect(Object.keys(mutators.tasks)).toEqual(expect.arrayContaining(['a', 'b']));
    expect(Object.keys(mutators.projects)).toEqual(['c']);
  });

  it('empty mutators is a no-op — defineMutators(schema, {}) works', () => {
    const mutators = defineMutators(testSchema, {});
    expect(mutators).toEqual({});
  });
});

// ═══════════════════════════════════════════════════════════════════════
// B. Transaction.mutate.create/update/delete/archive
// ═══════════════════════════════════════════════════════════════════════

describe('Transaction.mutate.create/update/delete/archive', () => {
  it('tx.mutations.tasks.create adds to pool + calls store.save', async () => {
    const tx = createTransaction(testSchema, store, 'org-1');

    const created = await tx.mutations.tasks.create({ title: 'Hello' });

    const t = asTask(created);
    expect(t.id).toMatch(/^[0-9a-f-]+$/);
    expect(t.title).toBe('Hello');
    expect(t.status).toBe('todo');
    expect(t.organizationId).toBe('org-1');
    expect(store.saveCalls).toHaveLength(1);
    expect(pool.get(t.id)).toBeDefined();
  });

  it('tx.mutations.tasks.update applies partial changes + calls store.save', async () => {
    const tx = createTransaction(testSchema, store, 'org-1');
    const created = await tx.mutations.tasks.create({ title: 'Original' });
    const id = asTask(created).id;

    const updated = await tx.mutations.tasks.update({ id, title: 'Updated', status: 'done' });

    expect(asTask(updated).title).toBe('Updated');
    expect(asTask(updated).status).toBe('done');
    expect(store.saveCalls).toHaveLength(2);

    const fromPool = asTask(pool.get(id));
    expect(fromPool.title).toBe('Updated');
    expect(fromPool.status).toBe('done');
  });

  it('tx.mutations.tasks.delete removes from pool + calls store.delete', async () => {
    const tx = createTransaction(testSchema, store, 'org-1');
    const created = await tx.mutations.tasks.create({ title: 'Task' });
    const id = asTask(created).id;

    await tx.mutations.tasks.delete(id);

    expect(store.deleteCalls).toHaveLength(1);
    expect(pool.get(id)).toBeUndefined();
  });

  it('tx.mutations.tasks.archive calls store.archive', async () => {
    const tx = createTransaction(testSchema, store, 'org-1');
    const created = await tx.mutations.tasks.create({ title: 'Task' });
    const id = asTask(created).id;

    await tx.mutations.tasks.archive(id);

    expect(store.archiveCalls).toHaveLength(1);
    expect(store.archiveCalls[0]?.id).toBe(id);
  });

  it('unknown model key throws at access time (proxy behavior)', () => {
    const tx = createTransaction(testSchema, store, 'org-1');
    expect(() => {
      // Touching a key that's not in the schema must throw at runtime.
      // TypeScript narrows `tx.mutations` to the schema's model keys;
      // we bypass that narrowing here (the directive immediately below)
      // to exercise the Proxy's runtime guard.
      // @ts-expect-error intentional: `unknownModel` is not in the schema
      void tx.mutations.unknownModel;
    }).toThrow();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// C. Transaction.mutate.createMany/updateMany/deleteMany
// ═══════════════════════════════════════════════════════════════════════

describe('Transaction.mutate batch operations', () => {
  it('createMany creates N models and saves them all', async () => {
    const tx = createTransaction(testSchema, store, 'org-1');

    const created = await tx.mutations.tasks.createMany([
      { title: 'A' },
      { title: 'B' },
      { title: 'C' },
    ]);

    expect(created).toHaveLength(3);
    expect(store.saveCalls).toHaveLength(3);
    for (const entity of created) {
      expect(pool.get(asTask(entity).id)).toBeDefined();
    }
  });

  it('updateMany applies patches to N models', async () => {
    const tx = createTransaction(testSchema, store, 'org-1');
    const c = await tx.mutations.tasks.createMany([
      { title: 'A' },
      { title: 'B' },
      { title: 'C' },
    ]);
    const ids = c.map((e) => asTask(e).id);
    store.saveCalls.length = 0;

    await tx.mutations.tasks.updateMany(
      ids.map((id) => ({ id, status: 'done' as const })),
    );

    expect(store.saveCalls).toHaveLength(3);
    for (const id of ids) {
      expect(asTask(pool.get(id)).status).toBe('done');
    }
  });

  it('deleteMany removes N models', async () => {
    const tx = createTransaction(testSchema, store, 'org-1');
    const c = await tx.mutations.tasks.createMany([
      { title: 'A' },
      { title: 'B' },
      { title: 'C' },
    ]);
    const ids = c.map((e) => asTask(e).id);

    await tx.mutations.tasks.deleteMany(ids);

    expect(store.deleteCalls).toHaveLength(3);
    for (const id of ids) {
      expect(pool.get(id)).toBeUndefined();
    }
  });

  it('empty array is a no-op for createMany/updateMany/deleteMany', async () => {
    const tx = createTransaction(testSchema, store, 'org-1');

    const createdEmpty = await tx.mutations.tasks.createMany([]);
    await tx.mutations.tasks.updateMany([]);
    await tx.mutations.tasks.deleteMany([]);

    expect(createdEmpty).toEqual([]);
    expect(store.saveCalls).toHaveLength(0);
    expect(store.deleteCalls).toHaveLength(0);
  });

  it('V1 does not rollback: mid-batch failure leaves preceding ops applied', async () => {
    const tx = createTransaction(testSchema, store, 'org-1');
    const c = await tx.mutations.tasks.createMany([
      { title: 'A' },
      { title: 'B' },
    ]);
    const [a, b] = c.map((e) => asTask(e).id);
    store.saveCalls.length = 0;

    // Patch b with a nonexistent id to force failure on the second item
    await expect(
      tx.mutations.tasks.updateMany([
        { id: a, title: 'A-updated' },
        { id: 'nonexistent', title: 'fail' },
        { id: b, title: 'B-updated' },
      ]),
    ).rejects.toThrow();

    // First update went through; last did not. This documents V1 no-rollback behavior.
    expect(asTask(pool.get(a)).title).toBe('A-updated');
    expect(asTask(pool.get(b)).title).toBe('B');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// D. Transaction.read.*
// ═══════════════════════════════════════════════════════════════════════

describe('Transaction.read', () => {
  it('tx.read.tasks.findById returns the typed model', async () => {
    const tx = createTransaction(testSchema, store, 'org-1');
    const created = await tx.mutations.tasks.create({ title: 'Find me' });
    const id = asTask(created).id;

    const found = tx.read.tasks.findById(id);

    expect(found).toBeDefined();
    expect(asTask(found).title).toBe('Find me');
  });

  it('tx.read.tasks.findMany({ where }) uses FK index for registered field', async () => {
    const tx = createTransaction(testSchema, store, 'org-1');
    await tx.mutations.tasks.create({ title: 'a', projectId: 'p1' });
    await tx.mutations.tasks.create({ title: 'b', projectId: 'p2' });
    await tx.mutations.tasks.create({ title: 'c', projectId: 'p1' });

    const p1Tasks = tx.read.tasks.findMany({ where: { projectId: 'p1' } });

    expect(p1Tasks).toHaveLength(2);
    expect(p1Tasks.every((t) => asTask(t).projectId === 'p1')).toBe(true);
  });

  it('tx.read.tasks.findFirst returns the first match', async () => {
    const tx = createTransaction(testSchema, store, 'org-1');
    await tx.mutations.tasks.create({ title: 'todo-1', status: 'todo' });
    await tx.mutations.tasks.create({ title: 'done-1', status: 'done' });

    const first = tx.read.tasks.findFirst({ where: { status: 'done' } });

    expect(first).toBeDefined();
    expect(asTask(first).title).toBe('done-1');
  });

  it('tx.read.tasks.count returns the count', async () => {
    const tx = createTransaction(testSchema, store, 'org-1');
    await tx.mutations.tasks.create({ title: 'a', projectId: 'p1' });
    await tx.mutations.tasks.create({ title: 'b', projectId: 'p1' });
    await tx.mutations.tasks.create({ title: 'c', projectId: 'p2' });

    expect(tx.read.tasks.count({ where: { projectId: 'p1' } })).toBe(2);
    expect(tx.read.tasks.count()).toBe(3);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// E. Custom mutator end-to-end
// ═══════════════════════════════════════════════════════════════════════

describe('Custom mutator end-to-end', () => {
  it('creates task + subtask — both land in pool, 2 saves', async () => {
    const mutators = defineMutators(testSchema, {
      tasks: {
        createWithSubtask: async ({
          tx,
          args,
        }: {
          tx: Transaction<TestSchema>;
          args: { title: string };
        }) => {
          const task = await tx.mutations.tasks.create({ title: args.title, status: 'todo' });
          const parentId = asTask(task).id;
          await tx.mutations.tasks.create({
            title: `${args.title} (sub)`,
            parentId,
          });
          return task;
        },
      },
    });

    const tx = createTransaction(testSchema, store, 'org-1');
    const parent = await mutators.tasks.createWithSubtask({
      tx,
      args: { title: 'Parent' },
    });

    expect(store.saveCalls).toHaveLength(2);
    const parentId = asTask(parent).id;
    const subtasks = pool.getByForeignKey('Task', 'parentId', parentId);
    expect(subtasks).toHaveLength(1);
    expect(asTask(subtasks[0]).title).toBe('Parent (sub)');
  });

  it('reads then creates — reader sees pool state before create', async () => {
    const mutators = defineMutators(testSchema, {
      tasks: {
        createInProject: async ({
          tx,
          args,
        }: {
          tx: Transaction<TestSchema>;
          args: { projectId: string; title: string };
        }) => {
          const existing = tx.read.tasks.count({ where: { projectId: args.projectId } });
          return tx.mutations.tasks.create({
            title: `${args.title} #${existing + 1}`,
            projectId: args.projectId,
          });
        },
      },
    });

    const tx = createTransaction(testSchema, store, 'org-1');
    await tx.mutations.tasks.create({ title: 'seed', projectId: 'p1' });

    const next = await mutators.tasks.createInProject({
      tx,
      args: { projectId: 'p1', title: 'New' },
    });

    expect(asTask(next).title).toBe('New #2');
  });

  it('returns a value — value flows back to caller', async () => {
    const mutators = defineMutators(testSchema, {
      tasks: {
        makeSummary: async ({
          tx,
          args,
        }: {
          tx: Transaction<TestSchema>;
          args: { titles: string[] };
        }) => {
          const created: string[] = [];
          for (const title of args.titles) {
            const t = await tx.mutations.tasks.create({ title });
            created.push(asTask(t).id);
          }
          return { count: created.length, ids: created };
        },
      },
    });

    const tx = createTransaction(testSchema, store, 'org-1');
    const result = await mutators.tasks.makeSummary({
      tx,
      args: { titles: ['a', 'b', 'c'] },
    });

    expect(result.count).toBe(3);
    expect(result.ids).toHaveLength(3);
    for (const id of result.ids) {
      expect(pool.get(id)).toBeDefined();
    }
  });

  it('throws mid-mutator — no rollback, partial state visible (V1 behavior)', async () => {
    const mutators = defineMutators(testSchema, {
      tasks: {
        failHalfway: async ({
          tx,
          args,
        }: {
          tx: Transaction<TestSchema>;
          args: { title: string };
        }) => {
          await tx.mutations.tasks.create({ title: args.title });
          throw new Error('boom');
        },
      },
    });

    const tx = createTransaction(testSchema, store, 'org-1');

    await expect(
      mutators.tasks.failHalfway({ tx, args: { title: 'partial' } }),
    ).rejects.toThrow(/boom/);

    // The first create was NOT rolled back — it sits in the pool.
    const partial = pool.getByTypeName('Task');
    expect(partial).toHaveLength(1);
    expect(asTask(partial[0]).title).toBe('partial');
    expect(store.saveCalls).toHaveLength(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// F. Cross-model mutators
// ═══════════════════════════════════════════════════════════════════════

describe('Cross-model mutators', () => {
  it('creates a project + 3 tasks attached to it — all 4 entities land', async () => {
    const mutators = defineMutators(testSchema, {
      projects: {
        createWithTasks: async ({
          tx,
          args,
        }: {
          tx: Transaction<TestSchema>;
          args: { name: string; taskTitles: string[] };
        }) => {
          const project = await tx.mutations.projects.create({ name: args.name });
          const projectId = asProject(project).id;
          for (const title of args.taskTitles) {
            await tx.mutations.tasks.create({ title, projectId });
          }
          return project;
        },
      },
    });

    const tx = createTransaction(testSchema, store, 'org-1');
    const project = await mutators.projects.createWithTasks({
      tx,
      args: { name: 'Launch', taskTitles: ['spec', 'build', 'ship'] },
    });

    const projectId = asProject(project).id;
    expect(pool.get(projectId)).toBeDefined();
    const tasks = pool.getByForeignKey('Task', 'projectId', projectId);
    expect(tasks).toHaveLength(3);
    expect(tasks.map((t) => asTask(t).title).sort()).toEqual(['build', 'ship', 'spec']);
    // 1 project save + 3 task saves = 4
    expect(store.saveCalls).toHaveLength(4);
  });

  it('uses tx.read.tasks.findMany({ where: { projectId } }) to compute before create', async () => {
    const mutators = defineMutators(testSchema, {
      tasks: {
        appendToProject: async ({
          tx,
          args,
        }: {
          tx: Transaction<TestSchema>;
          args: { projectId: string; title: string };
        }) => {
          const siblings = tx.read.tasks.findMany({ where: { projectId: args.projectId } });
          const nextOrder = siblings.reduce(
            (max, t) => Math.max(max, (t as unknown as { order: number }).order ?? 0),
            0,
          ) + 1;
          return tx.mutations.tasks.create({
            title: args.title,
            projectId: args.projectId,
            order: nextOrder,
          });
        },
      },
    });

    const tx = createTransaction(testSchema, store, 'org-1');
    await tx.mutations.tasks.create({ title: 'first', projectId: 'p1', order: 1 });
    await tx.mutations.tasks.create({ title: 'second', projectId: 'p1', order: 2 });

    const third = await mutators.tasks.appendToProject({
      tx,
      args: { projectId: 'p1', title: 'third' },
    });

    expect((third as unknown as { order: number }).order).toBe(3);
  });
});
