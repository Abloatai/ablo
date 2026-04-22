/**
 * useReader(schema, key) — imperative typed reads tests.
 *
 * Tests the pure `createReaderActions` factory directly to avoid React
 * cross-version issues in the monorepo. The hook itself is a one-line
 * useMemo wrapper around this factory.
 */

import { z } from 'zod';
import { ObjectPool } from '../../src/ObjectPool';
import { ModelRegistry, setActiveRegistry } from '../../src/ModelRegistry';
import { Model } from '../../src/Model';
import { defineSchema, model } from '../../src/schema';
import type { SyncStoreContract } from '../../src/react/context';
import { createReaderActions } from '../../src/react/useReader';
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
      projectId: z.string().optional(),
      teamId: z.string().optional(),
    },
    {},
    { typename: 'Task' },
  ),
});

// ── Test model class ──────────────────────────────────────────────────

class TestTask extends Model {
  title!: string;
  status!: 'todo' | 'in_progress' | 'done';
  priority?: string;
  order!: number;
  projectId?: string;
  teamId?: string;

  constructor(data: Record<string, unknown>) {
    super(data);
    this.title = data.title as string;
    this.status = (data.status as 'todo' | 'in_progress' | 'done') ?? 'todo';
    this.priority = data.priority as string | undefined;
    this.order = (data.order as number) ?? 0;
    this.projectId = data.projectId as string | undefined;
    this.teamId = data.teamId as string | undefined;
  }
}

// ── Minimal store wrapper ─────────────────────────────────────────────

function createStore(pool: ObjectPool): SyncStoreContract {
  return {
    findById: (_class, id) => pool.get(id),
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
  };
}

// ── Setup ──────────────────────────────────────────────────────────────

let pool: ObjectPool;
let registry: ModelRegistry;
let store: SyncStoreContract;
let cleanupCtx: () => void;

function seed(task: Record<string, unknown>): Model {
  const full: Record<string, unknown> = {
    __typename: 'Task',
    id: (task.id as string | undefined) ?? Model.generateId(),
    organizationId: 'org-1',
    createdAt: new Date(),
    updatedAt: new Date(),
    title: (task.title as string | undefined) ?? 'Task',
    ...task,
  };
  const m = pool.createFromData(full);
  if (!m) throw new Error('seed: createFromData returned null');
  pool.add(m);
  return m;
}

beforeEach(() => {
  registry = new ModelRegistry();
  registry.registerModel('Task', TestTask);
  setActiveRegistry(registry);
  const ctx = createTestContext();
  cleanupCtx = ctx.cleanup;
  pool = new ObjectPool({ maxSize: 100, gcInterval: 0, useWeakRefs: false }, registry);
  pool.registerForeignKey('Task', 'projectId');
  store = createStore(pool);
});

afterEach(() => {
  pool.clear();
  cleanupCtx();
});

// ── Tests ──────────────────────────────────────────────────────────────

describe('useReader.findById', () => {
  it('returns the entity by ID', () => {
    const task = seed({ id: 'task-1', title: 'Hello' });
    const reader = createReaderActions(testSchema, 'tasks', store);

    const found = reader.findById('task-1');

    expect(found).toBe(task);
  });

  it('returns undefined for unknown id', () => {
    const reader = createReaderActions(testSchema, 'tasks', store);
    expect(reader.findById('nonexistent')).toBeUndefined();
  });
});

describe('useReader.findMany', () => {
  it('returns all tasks when no options provided', () => {
    seed({ id: 't1' });
    seed({ id: 't2' });
    seed({ id: 't3' });

    const reader = createReaderActions(testSchema, 'tasks', store);
    expect(reader.findMany()).toHaveLength(3);
  });

  it('filters by where clause', () => {
    seed({ id: 't1', status: 'todo' });
    seed({ id: 't2', status: 'done' });
    seed({ id: 't3', status: 'todo' });

    const reader = createReaderActions(testSchema, 'tasks', store);
    const todos = reader.findMany({ where: { status: 'todo' } });

    expect(todos).toHaveLength(2);
    expect(todos.every((t) => (t as unknown as TestTask).status === 'todo')).toBe(true);
  });

  it('uses FK index for single-field where on indexed field', () => {
    seed({ id: 't1', projectId: 'p1' });
    seed({ id: 't2', projectId: 'p2' });
    seed({ id: 't3', projectId: 'p1' });
    seed({ id: 't4', projectId: undefined });

    const reader = createReaderActions(testSchema, 'tasks', store);
    const p1Tasks = reader.findMany({ where: { projectId: 'p1' } });

    expect(p1Tasks).toHaveLength(2);
    expect(p1Tasks.map((t) => (t as unknown as TestTask).id).sort()).toEqual(['t1', 't3']);
  });

  it('falls back to full scan when where field is not indexed', () => {
    seed({ id: 't1', teamId: 'team-1' });
    seed({ id: 't2', teamId: 'team-2' });

    const reader = createReaderActions(testSchema, 'tasks', store);
    // teamId is not FK-indexed — should still work via scan
    const result = reader.findMany({ where: { teamId: 'team-1' } });

    expect(result).toHaveLength(1);
  });

  it('applies filter predicate after where', () => {
    seed({ id: 't1', projectId: 'p1', status: 'todo' });
    seed({ id: 't2', projectId: 'p1', status: 'done' });
    seed({ id: 't3', projectId: 'p1', status: 'todo' });

    const reader = createReaderActions(testSchema, 'tasks', store);
    const result = reader.findMany({
      where: { projectId: 'p1' },
      filter: (t) => (t as unknown as TestTask).status === 'todo',
    });

    expect(result).toHaveLength(2);
  });

  it('sorts by orderBy asc', () => {
    seed({ id: 't1', order: 3 });
    seed({ id: 't2', order: 1 });
    seed({ id: 't3', order: 2 });

    const reader = createReaderActions(testSchema, 'tasks', store);
    const sorted = reader.findMany({ orderBy: 'order', order: 'asc' });

    expect(sorted.map((t) => (t as unknown as TestTask).order)).toEqual([1, 2, 3]);
  });

  it('sorts by orderBy desc', () => {
    seed({ id: 't1', order: 1 });
    seed({ id: 't2', order: 3 });
    seed({ id: 't3', order: 2 });

    const reader = createReaderActions(testSchema, 'tasks', store);
    const sorted = reader.findMany({ orderBy: 'order', order: 'desc' });

    expect(sorted.map((t) => (t as unknown as TestTask).order)).toEqual([3, 2, 1]);
  });

  it('applies limit', () => {
    for (let i = 0; i < 10; i++) seed({ id: `t${i}`, order: i });

    const reader = createReaderActions(testSchema, 'tasks', store);
    const result = reader.findMany({ orderBy: 'order', limit: 3 });

    expect(result).toHaveLength(3);
  });

  it('applies offset + limit', () => {
    for (let i = 0; i < 10; i++) seed({ id: `t${i}`, order: i });

    const reader = createReaderActions(testSchema, 'tasks', store);
    const result = reader.findMany({ orderBy: 'order', offset: 3, limit: 3 });

    expect(result.map((t) => (t as unknown as TestTask).order)).toEqual([3, 4, 5]);
  });

  it('returns snapshot (not reactive to later changes)', () => {
    seed({ id: 't1' });
    const reader = createReaderActions(testSchema, 'tasks', store);

    const first = reader.findMany();
    expect(first).toHaveLength(1);

    seed({ id: 't2' });
    // `first` is a snapshot — unchanged
    expect(first).toHaveLength(1);

    // New read reflects current state
    expect(reader.findMany()).toHaveLength(2);
  });
});

describe('useReader.findFirst', () => {
  it('returns the first matching entity', () => {
    seed({ id: 't1', status: 'todo', order: 2 });
    seed({ id: 't2', status: 'todo', order: 1 });

    const reader = createReaderActions(testSchema, 'tasks', store);
    const first = reader.findFirst({
      where: { status: 'todo' },
      orderBy: 'order',
      order: 'asc',
    });

    expect((first as unknown as TestTask).id).toBe('t2');
  });

  it('returns undefined if no match', () => {
    seed({ id: 't1', status: 'todo' });

    const reader = createReaderActions(testSchema, 'tasks', store);
    const first = reader.findFirst({ where: { status: 'done' } });

    expect(first).toBeUndefined();
  });
});

describe('useReader.count', () => {
  it('returns number of matching entities', () => {
    seed({ id: 't1', projectId: 'p1' });
    seed({ id: 't2', projectId: 'p1' });
    seed({ id: 't3', projectId: 'p2' });

    const reader = createReaderActions(testSchema, 'tasks', store);
    expect(reader.count({ where: { projectId: 'p1' } })).toBe(2);
    expect(reader.count()).toBe(3);
  });
});
