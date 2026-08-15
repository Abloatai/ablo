/**
 * createReaderActions(schema, key, store) — imperative read factory tests.
 *
 * Tests the pure `createReaderActions` factory directly to avoid React
 * cross-version issues in the monorepo. The hook itself is a one-line
 * useMemo wrapper around this factory.
 */

import { z } from 'zod';
import { InstanceCache as ObjectPool } from '../../src/local/InstanceCache';
import { ModelRegistry, setActiveRegistry } from '../../src/local/ModelRegistry';
import { Model } from '../../src/local/Model';
import { defineSchema, model } from '@abloatai/transaction/schema';
import type { SyncStoreContract } from '../../src/react/context';
import { createReaderActions } from '../../src/local/mutators/readerActions';
import { ViewRegistry } from '../../src/local/views/ViewRegistry';
import { createTestContext } from '../../src/local/testing';

// ── Test schema ────────────────────────────────────────────────────────

const testSchema = defineSchema({
  items: model(
    {
      title: z.string(),
      status: z.enum(['todo', 'in_progress', 'done']).default('todo'),
      priority: z.string().optional(),
      order: z.number().default(0),
      workspaceId: z.string().optional(),
      teamId: z.string().optional(),
    },
    { typename: 'Item' }),
});

// ── Test model class ──────────────────────────────────────────────────

class TestItem extends Model {
  title!: string;
  status!: 'todo' | 'in_progress' | 'done';
  priority?: string;
  order!: number;
  workspaceId?: string;
  teamId?: string;

  constructor(data: Record<string, unknown>) {
    super(data);
    this.title = data.title as string;
    this.status = (data.status as 'todo' | 'in_progress' | 'done') ?? 'todo';
    this.priority = data.priority as string | undefined;
    this.order = (data.order as number) ?? 0;
    this.workspaceId = data.workspaceId as string | undefined;
    this.teamId = data.teamId as string | undefined;
  }
}

// ── Minimal store wrapper ─────────────────────────────────────────────

function createStore(pool: ObjectPool): SyncStoreContract {
  return {
    retrieve: (_class, id) => pool.get(id),
    queryByClass: () => ({ data: [] }),
    save: async () => {},
    delete: async () => {},
    archive: async () => {},
    unarchive: async () => {},
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
    // Sync-status getters — reader tests don't drive sync state.
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
}

// ── Setup ──────────────────────────────────────────────────────────────

let pool: ObjectPool;
let registry: ModelRegistry;
let store: SyncStoreContract;
let cleanupCtx: () => void;

function seed(item: Record<string, unknown>): Model {
  const full: Record<string, unknown> = {
    __typename: 'Item',
    id: (item.id) ?? Model.generateId(),
    organizationId: 'org-1',
    createdAt: new Date(),
    updatedAt: new Date(),
    title: (item.title) ?? 'Item',
    ...item,
  };
  const m = pool.createFromData(full);
  if (!m) throw new Error('seed: createFromData returned null');
  pool.add(m);
  return m;
}

beforeEach(() => {
  registry = new ModelRegistry();
  registry.registerModel('Item', TestItem);
  setActiveRegistry(registry);
  const ctx = createTestContext();
  cleanupCtx = ctx.cleanup;
  pool = new ObjectPool({ maxSize: 100, gcInterval: 0, useWeakRefs: false }, registry);
  pool.registerForeignKey('Item', 'workspaceId');
  store = createStore(pool);
});

afterEach(() => {
  pool.clear();
  cleanupCtx();
});

// ── Tests ──────────────────────────────────────────────────────────────

describe('useReader.retrieve', () => {
  it('returns the entity by ID', () => {
    const item = seed({ id: 'item-1', title: 'Hello' });
    const reader = createReaderActions(testSchema, 'items', store);

    const found = reader.retrieve('item-1');

    expect(found).toBe(item);
  });

  it('returns undefined for unknown id', () => {
    const reader = createReaderActions(testSchema, 'items', store);
    expect(reader.retrieve('nonexistent')).toBeUndefined();
  });
});

describe('useReader.findMany', () => {
  it('returns all items when no options provided', () => {
    seed({ id: 't1' });
    seed({ id: 't2' });
    seed({ id: 't3' });

    const reader = createReaderActions(testSchema, 'items', store);
    expect(reader.list()).toHaveLength(3);
  });

  it('filters by where clause', () => {
    seed({ id: 't1', status: 'todo' });
    seed({ id: 't2', status: 'done' });
    seed({ id: 't3', status: 'todo' });

    const reader = createReaderActions(testSchema, 'items', store);
    const todos = reader.list({ where: { status: 'todo' } });

    expect(todos).toHaveLength(2);
    expect(todos.every((t) => (t as unknown as TestItem).status === 'todo')).toBe(true);
  });

  it('uses FK index for single-field where on indexed field', () => {
    seed({ id: 't1', workspaceId: 'p1' });
    seed({ id: 't2', workspaceId: 'p2' });
    seed({ id: 't3', workspaceId: 'p1' });
    seed({ id: 't4', workspaceId: undefined });

    const reader = createReaderActions(testSchema, 'items', store);
    const p1Items = reader.list({ where: { workspaceId: 'p1' } });

    expect(p1Items).toHaveLength(2);
    expect(p1Items.map((t) => (t as unknown as TestItem).id).sort()).toEqual(['t1', 't3']);
  });

  it('falls back to full scan when where field is not indexed', () => {
    seed({ id: 't1', teamId: 'team-1' });
    seed({ id: 't2', teamId: 'team-2' });

    const reader = createReaderActions(testSchema, 'items', store);
    // teamId is not FK-indexed — should still work via scan
    const result = reader.list({ where: { teamId: 'team-1' } });

    expect(result).toHaveLength(1);
  });

  it('applies filter predicate after where', () => {
    seed({ id: 't1', workspaceId: 'p1', status: 'todo' });
    seed({ id: 't2', workspaceId: 'p1', status: 'done' });
    seed({ id: 't3', workspaceId: 'p1', status: 'todo' });

    const reader = createReaderActions(testSchema, 'items', store);
    const result = reader.list({
      where: { workspaceId: 'p1' },
      filter: (t) => (t as unknown as TestItem).status === 'todo',
    });

    expect(result).toHaveLength(2);
  });

  it('sorts by orderBy asc', () => {
    seed({ id: 't1', order: 3 });
    seed({ id: 't2', order: 1 });
    seed({ id: 't3', order: 2 });

    const reader = createReaderActions(testSchema, 'items', store);
    const sorted = reader.list({ orderBy: 'order', order: 'asc' });

    expect(sorted.map((t) => (t as unknown as TestItem).order)).toEqual([1, 2, 3]);
  });

  it('sorts by orderBy desc', () => {
    seed({ id: 't1', order: 1 });
    seed({ id: 't2', order: 3 });
    seed({ id: 't3', order: 2 });

    const reader = createReaderActions(testSchema, 'items', store);
    const sorted = reader.list({ orderBy: 'order', order: 'desc' });

    expect(sorted.map((t) => (t as unknown as TestItem).order)).toEqual([3, 2, 1]);
  });

  it('applies limit', () => {
    for (let i = 0; i < 10; i++) seed({ id: `t${i}`, order: i });

    const reader = createReaderActions(testSchema, 'items', store);
    const result = reader.list({ orderBy: 'order', limit: 3 });

    expect(result).toHaveLength(3);
  });

  it('applies offset + limit', () => {
    for (let i = 0; i < 10; i++) seed({ id: `t${i}`, order: i });

    const reader = createReaderActions(testSchema, 'items', store);
    const result = reader.list({ orderBy: 'order', offset: 3, limit: 3 });

    expect(result.map((t) => (t as unknown as TestItem).order)).toEqual([3, 4, 5]);
  });

  it('returns snapshot (not reactive to later changes)', () => {
    seed({ id: 't1' });
    const reader = createReaderActions(testSchema, 'items', store);

    const first = reader.list();
    expect(first).toHaveLength(1);

    seed({ id: 't2' });
    // `first` is a snapshot — unchanged
    expect(first).toHaveLength(1);

    // New read reflects current state
    expect(reader.list()).toHaveLength(2);
  });
});

describe('useReader.findFirst', () => {
  it('returns the first matching entity', () => {
    seed({ id: 't1', status: 'todo', order: 2 });
    seed({ id: 't2', status: 'todo', order: 1 });

    const reader = createReaderActions(testSchema, 'items', store);
    const first = reader.list({
      where: { status: 'todo' },
      orderBy: 'order',
      order: 'asc',
      limit: 1,
    })[0];

    expect((first as unknown as TestItem).id).toBe('t2');
  });

  it('returns undefined if no match', () => {
    seed({ id: 't1', status: 'todo' });

    const reader = createReaderActions(testSchema, 'items', store);
    const first = reader.list({ where: { status: 'done' }, limit: 1 })[0];

    expect(first).toBeUndefined();
  });
});

describe('useReader.count', () => {
  it('returns number of matching entities', () => {
    seed({ id: 't1', workspaceId: 'p1' });
    seed({ id: 't2', workspaceId: 'p1' });
    seed({ id: 't3', workspaceId: 'p2' });

    const reader = createReaderActions(testSchema, 'items', store);
    expect(reader.count({ where: { workspaceId: 'p1' } })).toBe(2);
    expect(reader.count()).toBe(3);
  });
});
