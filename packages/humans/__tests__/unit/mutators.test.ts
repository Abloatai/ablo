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
import { InstanceCache as ObjectPool } from '../../src/local/InstanceCache';
import { ModelRegistry, setActiveRegistry } from '../../src/local/ModelRegistry';
import { Model } from '../../src/local/Model';
import { defineSchema, model } from '@abloatai/transaction/schema';
import type { SyncStoreContract } from '../../src/react/context';
import { ViewRegistry } from '../../src/local/views/ViewRegistry';
import { createTestContext } from '../../src/local/testing';

import { createTransaction, type Transaction } from '../../src/local/mutators/Transaction';
import { defineMutators } from '../../src/local/mutators/defineMutators';

// ── Test schema ────────────────────────────────────────────────────────

const testSchema = defineSchema({
  items: model(
    {
      title: z.string(),
      status: z.enum(['todo', 'in_progress', 'done']).default('todo'),
      priority: z.string().optional(),
      order: z.number().default(0),
      workspaceId: z.string().optional(),
      parentId: z.string().optional(),
    },
    { typename: 'Item' }),
  workspaces: model(
    {
      name: z.string(),
      description: z.string().optional(),
    },
    { typename: 'Workspace' }),
});

type TestSchema = typeof testSchema;

// ── Test model classes ────────────────────────────────────────────────

class TestItem extends Model {
  title!: string;
  status!: 'todo' | 'in_progress' | 'done';
  priority?: string;
  order!: number;
  workspaceId?: string;
  parentId?: string;
  organizationId!: string;

  constructor(data: Record<string, unknown>) {
    super(data);
    this.title = data.title as string;
    this.status = (data.status as 'todo' | 'in_progress' | 'done') ?? 'todo';
    this.priority = data.priority as string | undefined;
    this.order = (data.order as number) ?? 0;
    this.workspaceId = data.workspaceId as string | undefined;
    this.parentId = data.parentId as string | undefined;
    this.organizationId = data.organizationId as string;
  }
}

class TestWorkspace extends Model {
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

    retrieve: (_class, id) => pool.get(id),
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
    // Sync-status getters — mutator tests don't drive sync state.
    isReady: true,
    isSyncing: false,
    isOffline: false,
    isReconnecting: false,
    isError: false,
    hasUnsyncedChanges: false,
    syncStatus: {
      state: 'idle' as const,
      progress: 100,
      pendingChanges: 0,
      isSessionError: false,
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
  registry.registerModel('Item', TestItem);
  registry.registerModel('Workspace', TestWorkspace);
  setActiveRegistry(registry);
  const ctx = createTestContext();
  cleanupCtx = ctx.cleanup;
  pool = new ObjectPool({ maxSize: 100, gcInterval: 0, useWeakRefs: false }, registry);
  pool.registerForeignKey('Item', 'workspaceId');
  pool.registerForeignKey('Item', 'parentId');
  store = createStore(pool);
});

afterEach(() => {
  pool.clear();
  cleanupCtx();
});

// ── Helpers ────────────────────────────────────────────────────────────

interface ItemShape {
  id: string;
  title: string;
  status: 'todo' | 'in_progress' | 'done';
  workspaceId?: string;
  parentId?: string;
  organizationId: string;
}

interface WorkspaceShape {
  id: string;
  name: string;
  description?: string;
  organizationId: string;
}

function asItem(m: unknown): ItemShape {
  return m as ItemShape;
}

function asWorkspace(m: unknown): WorkspaceShape {
  return m as WorkspaceShape;
}

// ═══════════════════════════════════════════════════════════════════════
// A. defineMutators pass-through
// ═══════════════════════════════════════════════════════════════════════

describe('defineMutators', () => {
  it('returns the same mutators object (pass-through)', () => {
    const defs = {
      items: {
        myMutator: async ({ args }: { tx: Transaction<TestSchema>; args: { x: number } }) =>
          args.x,
      },
    };

    const result = defineMutators(testSchema, defs);

    // Pass-through: either same reference or structurally identical
    expect(result.items.myMutator).toBe(defs.items.myMutator);
  });

  it('preserves all declared mutator groups and names', () => {
    const mutators = defineMutators(testSchema, {
      items: {
        a: async () => 1,
        b: async () => 2,
      },
      workspaces: {
        c: async () => 3,
      },
    });

    expect(Object.keys(mutators)).toEqual(expect.arrayContaining(['items', 'workspaces']));
    expect(Object.keys(mutators.items)).toEqual(expect.arrayContaining(['a', 'b']));
    expect(Object.keys(mutators.workspaces)).toEqual(['c']);
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
  it('tx.mutations.items.create adds to pool + calls store.save', async () => {
    const tx = createTransaction(testSchema, store, 'org-1');

    const created = await tx.mutations.items.create({ title: 'Hello' });

    const t = asItem(created);
    expect(t.id).toMatch(/^[0-9a-f-]+$/);
    expect(t.title).toBe('Hello');
    expect(t.status).toBe('todo');
    expect(t.organizationId).toBe('org-1');
    expect(store.saveCalls).toHaveLength(1);
    expect(pool.get(t.id)).toBeDefined();
  });

  it('tx.mutations.items.update applies partial changes + calls store.save', async () => {
    const tx = createTransaction(testSchema, store, 'org-1');
    const created = await tx.mutations.items.create({ title: 'Original' });
    const id = asItem(created).id;

    const updated = await tx.mutations.items.update({ id, title: 'Updated', status: 'done' });

    expect(asItem(updated).title).toBe('Updated');
    expect(asItem(updated).status).toBe('done');
    expect(store.saveCalls).toHaveLength(2);

    const fromPool = asItem(pool.get(id));
    expect(fromPool.title).toBe('Updated');
    expect(fromPool.status).toBe('done');
  });

  it('tx.mutations.items.delete removes from pool + calls store.delete', async () => {
    const tx = createTransaction(testSchema, store, 'org-1');
    const created = await tx.mutations.items.create({ title: 'Item' });
    const id = asItem(created).id;

    await tx.mutations.items.delete(id);

    expect(store.deleteCalls).toHaveLength(1);
    expect(pool.get(id)).toBeUndefined();
  });

  it('tx.mutations.items.archive calls store.archive', async () => {
    const tx = createTransaction(testSchema, store, 'org-1');
    const created = await tx.mutations.items.create({ title: 'Item' });
    const id = asItem(created).id;

    await tx.mutations.items.archive(id);

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

    const created = await tx.mutations.items.create([
      { title: 'A' },
      { title: 'B' },
      { title: 'C' },
    ]);

    expect(created).toHaveLength(3);
    expect(store.saveCalls).toHaveLength(3);
    for (const entity of created) {
      expect(pool.get(asItem(entity).id)).toBeDefined();
    }
  });

  it('updateMany applies patches to N models', async () => {
    const tx = createTransaction(testSchema, store, 'org-1');
    const c = await tx.mutations.items.create([
      { title: 'A' },
      { title: 'B' },
      { title: 'C' },
    ]);
    const ids = c.map((e) => asItem(e).id);
    store.saveCalls.length = 0;

    await tx.mutations.items.update(
      ids.map((id) => ({ id, status: 'done' as const })),
    );

    expect(store.saveCalls).toHaveLength(3);
    for (const id of ids) {
      expect(asItem(pool.get(id)).status).toBe('done');
    }
  });

  it('deleteMany removes N models', async () => {
    const tx = createTransaction(testSchema, store, 'org-1');
    const c = await tx.mutations.items.create([
      { title: 'A' },
      { title: 'B' },
      { title: 'C' },
    ]);
    const ids = c.map((e) => asItem(e).id);

    await tx.mutations.items.delete(ids);

    expect(store.deleteCalls).toHaveLength(3);
    for (const id of ids) {
      expect(pool.get(id)).toBeUndefined();
    }
  });

  it('empty array is a no-op for createMany/updateMany/deleteMany', async () => {
    const tx = createTransaction(testSchema, store, 'org-1');

    const createdEmpty = await tx.mutations.items.create([]);
    await tx.mutations.items.update([]);
    await tx.mutations.items.delete([]);

    expect(createdEmpty).toEqual([]);
    expect(store.saveCalls).toHaveLength(0);
    expect(store.deleteCalls).toHaveLength(0);
  });

  it('V1 does not rollback: mid-batch failure leaves preceding ops applied', async () => {
    const tx = createTransaction(testSchema, store, 'org-1');
    const c = await tx.mutations.items.create([
      { title: 'A' },
      { title: 'B' },
    ]);
    const [a, b] = c.map((e) => asItem(e).id);
    if (a === undefined || b === undefined) throw new Error('expected two created item ids');
    store.saveCalls.length = 0;

    // Patch b with a nonexistent id to force failure on the second item
    await expect(
      tx.mutations.items.update([
        { id: a, title: 'A-updated' },
        { id: 'nonexistent', title: 'fail' },
        { id: b, title: 'B-updated' },
      ]),
    ).rejects.toThrow();

    // First update went through; last did not. This documents V1 no-rollback behavior.
    expect(asItem(pool.get(a)).title).toBe('A-updated');
    expect(asItem(pool.get(b)).title).toBe('B');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// D. Transaction.read.*
// ═══════════════════════════════════════════════════════════════════════

describe('Transaction.read', () => {
  it('tx.read.items.retrieve returns the typed model', async () => {
    const tx = createTransaction(testSchema, store, 'org-1');
    const created = await tx.mutations.items.create({ title: 'Find me' });
    const id = asItem(created).id;

    const found = tx.read.items.retrieve(id);

    expect(found).toBeDefined();
    expect(asItem(found).title).toBe('Find me');
  });

  it('tx.read.items.list({ where }) uses FK index for registered field', async () => {
    const tx = createTransaction(testSchema, store, 'org-1');
    await tx.mutations.items.create({ title: 'a', workspaceId: 'p1' });
    await tx.mutations.items.create({ title: 'b', workspaceId: 'p2' });
    await tx.mutations.items.create({ title: 'c', workspaceId: 'p1' });

    const p1Items = tx.read.items.list({ where: { workspaceId: 'p1' } });

    expect(p1Items).toHaveLength(2);
    expect(p1Items.every((t) => asItem(t).workspaceId === 'p1')).toBe(true);
  });

  it('tx.read.items.findFirst returns the first match', async () => {
    const tx = createTransaction(testSchema, store, 'org-1');
    await tx.mutations.items.create({ title: 'todo-1', status: 'todo' });
    await tx.mutations.items.create({ title: 'done-1', status: 'done' });

    const first = tx.read.items.list({ where: { status: 'done' }, limit: 1 })[0];

    expect(first).toBeDefined();
    expect(asItem(first).title).toBe('done-1');
  });

  it('tx.read.items.count returns the count', async () => {
    const tx = createTransaction(testSchema, store, 'org-1');
    await tx.mutations.items.create({ title: 'a', workspaceId: 'p1' });
    await tx.mutations.items.create({ title: 'b', workspaceId: 'p1' });
    await tx.mutations.items.create({ title: 'c', workspaceId: 'p2' });

    expect(tx.read.items.count({ where: { workspaceId: 'p1' } })).toBe(2);
    expect(tx.read.items.count()).toBe(3);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// E. Custom mutator end-to-end
// ═══════════════════════════════════════════════════════════════════════

describe('Custom mutator end-to-end', () => {
  it('creates item + subitem — both land in pool, 2 saves', async () => {
    const mutators = defineMutators(testSchema, {
      items: {
        createWithSubitem: async ({
          tx,
          args,
        }: {
          tx: Transaction<TestSchema>;
          args: { title: string };
        }) => {
          const item = await tx.mutations.items.create({ title: args.title, status: 'todo' });
          const parentId = asItem(item).id;
          await tx.mutations.items.create({
            title: `${args.title} (sub)`,
            parentId,
          });
          return item;
        },
      },
    });

    const tx = createTransaction(testSchema, store, 'org-1');
    const parent = await mutators.items.createWithSubitem({
      tx,
      args: { title: 'Parent' },
    });

    expect(store.saveCalls).toHaveLength(2);
    const parentId = asItem(parent).id;
    const subitems = pool.getByForeignKey('Item', 'parentId', parentId);
    expect(subitems).toHaveLength(1);
    expect(asItem(subitems[0]).title).toBe('Parent (sub)');
  });

  it('reads then creates — reader sees pool state before create', async () => {
    const mutators = defineMutators(testSchema, {
      items: {
        createInWorkspace: async ({
          tx,
          args,
        }: {
          tx: Transaction<TestSchema>;
          args: { workspaceId: string; title: string };
        }) => {
          const existing = tx.read.items.count({ where: { workspaceId: args.workspaceId } });
          return tx.mutations.items.create({
            title: `${args.title} #${existing + 1}`,
            workspaceId: args.workspaceId,
          });
        },
      },
    });

    const tx = createTransaction(testSchema, store, 'org-1');
    await tx.mutations.items.create({ title: 'seed', workspaceId: 'p1' });

    const next = await mutators.items.createInWorkspace({
      tx,
      args: { workspaceId: 'p1', title: 'New' },
    });

    expect(asItem(next).title).toBe('New #2');
  });

  it('returns a value — value flows back to caller', async () => {
    const mutators = defineMutators(testSchema, {
      items: {
        makeSummary: async ({
          tx,
          args,
        }: {
          tx: Transaction<TestSchema>;
          args: { titles: string[] };
        }) => {
          const created: string[] = [];
          for (const title of args.titles) {
            const t = await tx.mutations.items.create({ title });
            created.push(asItem(t).id);
          }
          return { count: created.length, ids: created };
        },
      },
    });

    const tx = createTransaction(testSchema, store, 'org-1');
    const result = await mutators.items.makeSummary({
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
      items: {
        failHalfway: async ({
          tx,
          args,
        }: {
          tx: Transaction<TestSchema>;
          args: { title: string };
        }) => {
          await tx.mutations.items.create({ title: args.title });
          throw new Error('boom');
        },
      },
    });

    const tx = createTransaction(testSchema, store, 'org-1');

    await expect(
      mutators.items.failHalfway({ tx, args: { title: 'partial' } }),
    ).rejects.toThrow(/boom/);

    // The first create was NOT rolled back — it sits in the pool.
    const partial = pool.getByTypeName('Item');
    expect(partial).toHaveLength(1);
    expect(asItem(partial[0]).title).toBe('partial');
    expect(store.saveCalls).toHaveLength(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// F. Cross-model mutators
// ═══════════════════════════════════════════════════════════════════════

describe('Cross-model mutators', () => {
  it('creates a workspace + 3 items attached to it — all 4 entities land', async () => {
    const mutators = defineMutators(testSchema, {
      workspaces: {
        createWithItems: async ({
          tx,
          args,
        }: {
          tx: Transaction<TestSchema>;
          args: { name: string; itemTitles: string[] };
        }) => {
          const workspace = await tx.mutations.workspaces.create({ name: args.name });
          const workspaceId = asWorkspace(workspace).id;
          for (const title of args.itemTitles) {
            await tx.mutations.items.create({ title, workspaceId });
          }
          return workspace;
        },
      },
    });

    const tx = createTransaction(testSchema, store, 'org-1');
    const workspace = await mutators.workspaces.createWithItems({
      tx,
      args: { name: 'Launch', itemTitles: ['spec', 'build', 'ship'] },
    });

    const workspaceId = asWorkspace(workspace).id;
    expect(pool.get(workspaceId)).toBeDefined();
    const items = pool.getByForeignKey('Item', 'workspaceId', workspaceId);
    expect(items).toHaveLength(3);
    expect(items.map((t) => asItem(t).title).sort()).toEqual(['build', 'ship', 'spec']);
    // 1 workspace save + 3 item saves = 4
    expect(store.saveCalls).toHaveLength(4);
  });

  it('uses tx.read.items.list({ where: { workspaceId } }) to compute before create', async () => {
    const mutators = defineMutators(testSchema, {
      items: {
        appendToWorkspace: async ({
          tx,
          args,
        }: {
          tx: Transaction<TestSchema>;
          args: { workspaceId: string; title: string };
        }) => {
          const siblings = tx.read.items.list({ where: { workspaceId: args.workspaceId } });
          const nextOrder = siblings.reduce(
            (max, t) => Math.max(max, (t as unknown as { order: number }).order ?? 0),
            0,
          ) + 1;
          return tx.mutations.items.create({
            title: args.title,
            workspaceId: args.workspaceId,
            order: nextOrder,
          });
        },
      },
    });

    const tx = createTransaction(testSchema, store, 'org-1');
    await tx.mutations.items.create({ title: 'first', workspaceId: 'p1', order: 1 });
    await tx.mutations.items.create({ title: 'second', workspaceId: 'p1', order: 2 });

    const third = await mutators.items.appendToWorkspace({
      tx,
      args: { workspaceId: 'p1', title: 'third' },
    });

    expect((third as unknown as { order: number }).order).toBe(3);
  });
});
