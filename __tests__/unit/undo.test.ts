/**
 * UndoManager + RecordingTransaction tests.
 *
 * Tests the pure factory path — `createRecordingTransaction` + `UndoScope`
 * exercised directly, no React. Mirrors the pattern of `useMutate.test.ts`.
 */

import { z } from 'zod';
import { ObjectPool } from '../../src/ObjectPool';
import { ModelRegistry, setActiveRegistry } from '../../src/ModelRegistry';
import { Model } from '../../src/Model';
import { defineSchema, model } from '../../src/schema';
import type { SyncStoreContract } from '../../src/react/context';
import { createTransaction } from '../../src/mutators/Transaction';
import { createRecordingTransaction } from '../../src/mutators/RecordingTransaction';
import { UndoManager, UndoScope } from '../../src/mutators/UndoManager';
import { ViewRegistry } from '../../src/core/ViewRegistry';
import { createTestContext } from '../../src/testing';

// ── Test schema ────────────────────────────────────────────────────────

const testSchema = defineSchema({
  tasks: model(
    {
      title: z.string(),
      status: z.enum(['todo', 'in_progress', 'done']).default('todo'),
      order: z.number().default(0),
      projectId: z.string().optional(),
    },
    {},
    { typename: 'Task' },
  ),
});

// ── Test model class ──────────────────────────────────────────────────

class TestTask extends Model {
  title!: string;
  status!: 'todo' | 'in_progress' | 'done';
  order!: number;
  projectId?: string;
  organizationId!: string;
  archivedAt?: Date | null;

  constructor(data: Record<string, unknown>) {
    super(data);
    this.title = (data.title as string) ?? '';
    this.status = (data.status as 'todo' | 'in_progress' | 'done') ?? 'todo';
    this.order = (data.order as number) ?? 0;
    this.projectId = data.projectId as string | undefined;
    this.organizationId = (data.organizationId as string) ?? '';
    this.archivedAt = data.archivedAt as Date | null | undefined;
  }

  override toJSON(): Record<string, unknown> {
    return {
      __typename: 'Task',
      id: this.id,
      title: this.title,
      status: this.status,
      order: this.order,
      projectId: this.projectId,
      organizationId: this.organizationId,
      archivedAt: this.archivedAt,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
    };
  }
}

// ── Minimal store ─────────────────────────────────────────────────────

function createStore(pool: ObjectPool): SyncStoreContract {
  return {
    findById: (_class, id) => pool.get(id),
    queryByClass: () => ({ data: [] }),
    save: async (m) => {
      if (!pool.get(m.id)) pool.add(m);
    },
    delete: async (m) => {
      pool.remove(m.id);
    },
    archive: async () => {},
    unarchive: async () => {},
    pool: {
      get: (id) => pool.get(id),
      getByTypeName: (t, scope) => pool.getByTypeName(t, scope),
      getByForeignKey: (m, f, v) => pool.getByForeignKey(m, f, v),
      createFromData: (d) => pool.createFromData(d),
      hasForeignKeyIndex: (t, f) => pool.hasForeignKeyIndex(t, f),
      createView: (t, o) => pool.createView(t, o),
      viewRegistry: pool.viewRegistry ?? new ViewRegistry(),
    },
  };
}

// ── Setup ──────────────────────────────────────────────────────────────

let pool: ObjectPool;
let store: SyncStoreContract;
let cleanup: () => void;

beforeEach(() => {
  const registry = new ModelRegistry();
  registry.registerModel('Task', TestTask);
  setActiveRegistry(registry);
  const ctx = createTestContext();
  cleanup = ctx.cleanup;
  pool = new ObjectPool({ maxSize: 100, gcInterval: 0, useWeakRefs: false }, registry);
  store = createStore(pool);
});

afterEach(() => {
  pool.clear();
  cleanup();
});

// ── Recording captures ─────────────────────────────────────────────────

describe('RecordingTransaction', () => {
  it('captures create → delete inverse', async () => {
    const rec = createRecordingTransaction(testSchema, store, 'org-1');
    const task = await rec.tx.mutations.tasks.create({ title: 'Hello' });
    const entry = rec.getEntry();

    expect(entry).not.toBeNull();
    expect(entry!.inverses).toHaveLength(1);
    expect(entry!.inverses[0]).toMatchObject({
      kind: 'delete',
      modelKey: 'tasks',
      id: (task as { id: string }).id,
    });
  });

  it('captures update → update-back inverse with prev values', async () => {
    const rec = createRecordingTransaction(testSchema, store, 'org-1');
    const task = await rec.tx.mutations.tasks.create({ title: 'Original' });
    const id = (task as { id: string }).id;

    await rec.tx.mutations.tasks.update({ id, title: 'Changed' });
    const entry = rec.getEntry();

    // Inverses applied in reverse: restore title='Original', then delete the task.
    expect(entry!.inverses[0]).toMatchObject({
      kind: 'update',
      modelKey: 'tasks',
      patch: { id, title: 'Original' },
    });
  });

  it('captures delete → create inverse with full model snapshot', async () => {
    const rec = createRecordingTransaction(testSchema, store, 'org-1');
    const task = await rec.tx.mutations.tasks.create({ title: 'Doomed', status: 'in_progress' });
    const id = (task as { id: string }).id;

    await rec.tx.mutations.tasks.delete(id);
    const entry = rec.getEntry();

    // Last inverse (applied first on undo): recreate the deleted task.
    const restore = entry!.inverses[0];
    expect(restore.kind).toBe('create');
    if (restore.kind !== 'create') throw new Error('unreachable');
    expect(restore.data).toMatchObject({ id, title: 'Doomed', status: 'in_progress' });
  });

  it('returns null entry when no writes happened', async () => {
    const rec = createRecordingTransaction(testSchema, store, 'org-1');
    // No-op: only a read.
    rec.tx.read.tasks.findMany();
    expect(rec.getEntry()).toBeNull();
  });

  it('inverses are ordered reverse-of-forward', async () => {
    const rec = createRecordingTransaction(testSchema, store, 'org-1');
    const a = await rec.tx.mutations.tasks.create({ title: 'A' });
    const b = await rec.tx.mutations.tasks.create({ title: 'B' });
    const entry = rec.getEntry()!;

    // Forwards: create A, create B.
    expect(entry.forwards[0]).toMatchObject({ kind: 'create', modelKey: 'tasks' });
    expect(entry.forwards[1]).toMatchObject({ kind: 'create', modelKey: 'tasks' });
    // Inverses are reversed: delete B, then delete A.
    expect(entry.inverses[0]).toMatchObject({ kind: 'delete', id: (b as { id: string }).id });
    expect(entry.inverses[1]).toMatchObject({ kind: 'delete', id: (a as { id: string }).id });
  });

  it('captures createMany → deleteMany inverse', async () => {
    const rec = createRecordingTransaction(testSchema, store, 'org-1');
    const created = await rec.tx.mutations.tasks.createMany([
      { title: 'A' },
      { title: 'B' },
      { title: 'C' },
    ]);
    const entry = rec.getEntry()!;

    const inverse = entry.inverses[0];
    expect(inverse.kind).toBe('deleteMany');
    if (inverse.kind !== 'deleteMany') throw new Error('unreachable');
    expect(inverse.ids).toHaveLength(3);
    expect(inverse.ids).toEqual(created.map((m) => (m as { id: string }).id));
  });

  it('captures deleteMany → createMany inverse with snapshots', async () => {
    const rec = createRecordingTransaction(testSchema, store, 'org-1');
    const a = await rec.tx.mutations.tasks.create({ title: 'A' });
    const b = await rec.tx.mutations.tasks.create({ title: 'B' });
    const ids = [(a as { id: string }).id, (b as { id: string }).id];

    await rec.tx.mutations.tasks.deleteMany(ids);
    const entry = rec.getEntry()!;

    const restore = entry.inverses[0];
    expect(restore.kind).toBe('createMany');
    if (restore.kind !== 'createMany') throw new Error('unreachable');
    expect(restore.data).toHaveLength(2);
    expect(restore.data[0]).toMatchObject({ title: 'A' });
    expect(restore.data[1]).toMatchObject({ title: 'B' });
  });
});

// ── UndoScope behavior ─────────────────────────────────────────────────

describe('UndoScope.undo', () => {
  it('reverses a create (task disappears from pool)', async () => {
    const scope = new UndoScope(testSchema, store, 'org-1');
    const rec = createRecordingTransaction(testSchema, store, 'org-1');
    const task = await rec.tx.mutations.tasks.create({ title: 'Temp' });
    const id = (task as { id: string }).id;
    scope.record(rec.getEntry()!);

    expect(pool.get(id)).toBeDefined();
    await scope.undo();
    expect(pool.get(id)).toBeUndefined();
  });

  it('reverses an update (field returns to prev value)', async () => {
    const scope = new UndoScope(testSchema, store, 'org-1');
    // Setup (not recorded):
    const seed = await createTransaction(testSchema, store, 'org-1').mutations.tasks.create({
      title: 'Original',
    });
    const id = (seed as { id: string }).id;

    // Recorded edit:
    const rec = createRecordingTransaction(testSchema, store, 'org-1');
    await rec.tx.mutations.tasks.update({ id, title: 'Changed' });
    scope.record(rec.getEntry()!);

    expect((pool.get(id) as unknown as TestTask).title).toBe('Changed');
    await scope.undo();
    expect((pool.get(id) as unknown as TestTask).title).toBe('Original');
  });

  it('reverses a delete (task reappears in pool)', async () => {
    const scope = new UndoScope(testSchema, store, 'org-1');
    const seed = await createTransaction(testSchema, store, 'org-1').mutations.tasks.create({
      title: 'Doomed',
      status: 'in_progress',
    });
    const id = (seed as { id: string }).id;

    const rec = createRecordingTransaction(testSchema, store, 'org-1');
    await rec.tx.mutations.tasks.delete(id);
    scope.record(rec.getEntry()!);

    expect(pool.get(id)).toBeUndefined();
    await scope.undo();
    const restored = pool.get(id) as unknown as TestTask;
    expect(restored).toBeDefined();
    expect(restored.title).toBe('Doomed');
    expect(restored.status).toBe('in_progress');
  });

  it('reverses a multi-op mutator atomically', async () => {
    const scope = new UndoScope(testSchema, store, 'org-1');
    const rec = createRecordingTransaction(testSchema, store, 'org-1');

    const a = await rec.tx.mutations.tasks.create({ title: 'A' });
    const b = await rec.tx.mutations.tasks.create({ title: 'B' });
    const c = await rec.tx.mutations.tasks.create({ title: 'C' });
    scope.record(rec.getEntry()!);

    expect(pool.getByTypeName('Task')).toHaveLength(3);
    await scope.undo();
    expect(pool.getByTypeName('Task')).toHaveLength(0);
    void a;
    void b;
    void c;
  });

  it('no-ops when undo stack is empty', async () => {
    const scope = new UndoScope(testSchema, store, 'org-1');
    await expect(scope.undo()).resolves.toBeUndefined();
  });

  it('canUndo reflects stack state', async () => {
    const scope = new UndoScope(testSchema, store, 'org-1');
    expect(scope.canUndo()).toBe(false);

    const rec = createRecordingTransaction(testSchema, store, 'org-1');
    await rec.tx.mutations.tasks.create({ title: 'X' });
    scope.record(rec.getEntry()!);
    expect(scope.canUndo()).toBe(true);

    await scope.undo();
    expect(scope.canUndo()).toBe(false);
  });
});

describe('UndoScope.redo', () => {
  it('re-applies a create after undo', async () => {
    const scope = new UndoScope(testSchema, store, 'org-1');
    const rec = createRecordingTransaction(testSchema, store, 'org-1');
    const task = await rec.tx.mutations.tasks.create({ title: 'Toggle me' });
    const id = (task as { id: string }).id;
    scope.record(rec.getEntry()!);

    await scope.undo();
    expect(pool.get(id)).toBeUndefined();
    expect(scope.canRedo()).toBe(true);

    await scope.redo();
    expect(pool.get(id)).toBeDefined();
    expect(scope.canUndo()).toBe(true);
    expect(scope.canRedo()).toBe(false);
  });

  it('re-applies an update after undo', async () => {
    const scope = new UndoScope(testSchema, store, 'org-1');
    const seed = await createTransaction(testSchema, store, 'org-1').mutations.tasks.create({
      title: 'v1',
    });
    const id = (seed as { id: string }).id;

    const rec = createRecordingTransaction(testSchema, store, 'org-1');
    await rec.tx.mutations.tasks.update({ id, title: 'v2' });
    scope.record(rec.getEntry()!);

    await scope.undo();
    expect((pool.get(id) as unknown as TestTask).title).toBe('v1');
    await scope.redo();
    expect((pool.get(id) as unknown as TestTask).title).toBe('v2');
  });

  it('new mutation clears the redo stack', async () => {
    const scope = new UndoScope(testSchema, store, 'org-1');
    const rec1 = createRecordingTransaction(testSchema, store, 'org-1');
    await rec1.tx.mutations.tasks.create({ title: 'A' });
    scope.record(rec1.getEntry()!);

    await scope.undo();
    expect(scope.canRedo()).toBe(true);

    // New mutation recorded after undo — redo becomes unreachable.
    const rec2 = createRecordingTransaction(testSchema, store, 'org-1');
    await rec2.tx.mutations.tasks.create({ title: 'B' });
    scope.record(rec2.getEntry()!);

    expect(scope.canRedo()).toBe(false);
  });
});

describe('UndoScope history limits', () => {
  it('caps history at maxHistory', async () => {
    const scope = new UndoScope(testSchema, store, 'org-1', { maxHistory: 3 });

    for (let i = 0; i < 5; i++) {
      const rec = createRecordingTransaction(testSchema, store, 'org-1');
      await rec.tx.mutations.tasks.create({ title: `T${i}` });
      scope.record(rec.getEntry()!);
    }

    expect(scope.size().undo).toBe(3);
  });

  it('clear() wipes both stacks', async () => {
    const scope = new UndoScope(testSchema, store, 'org-1');
    const rec = createRecordingTransaction(testSchema, store, 'org-1');
    await rec.tx.mutations.tasks.create({ title: 'X' });
    scope.record(rec.getEntry()!);
    await scope.undo();

    expect(scope.size()).toEqual({ undo: 0, redo: 1 });
    scope.clear();
    expect(scope.size()).toEqual({ undo: 0, redo: 0 });
  });
});

describe('UndoManager', () => {
  it('getScope returns the same scope for a repeated name', () => {
    const manager = new UndoManager(testSchema, store, 'org-1');
    const a = manager.getScope('deck-editor');
    const b = manager.getScope('deck-editor');
    expect(a).toBe(b);
  });

  it('different names get independent stacks', async () => {
    const manager = new UndoManager(testSchema, store, 'org-1');
    const deck = manager.getScope('deck-editor');
    const sheet = manager.getScope('spreadsheet');

    const rec = createRecordingTransaction(testSchema, store, 'org-1');
    await rec.tx.mutations.tasks.create({ title: 'deck-thing' });
    deck.record(rec.getEntry()!);

    expect(deck.canUndo()).toBe(true);
    expect(sheet.canUndo()).toBe(false);
  });

  it('clearAll clears every scope', async () => {
    const manager = new UndoManager(testSchema, store, 'org-1');
    const a = manager.getScope('a');
    const b = manager.getScope('b');

    const rec1 = createRecordingTransaction(testSchema, store, 'org-1');
    await rec1.tx.mutations.tasks.create({ title: 'a1' });
    a.record(rec1.getEntry()!);

    const rec2 = createRecordingTransaction(testSchema, store, 'org-1');
    await rec2.tx.mutations.tasks.create({ title: 'b1' });
    b.record(rec2.getEntry()!);

    manager.clearAll();
    expect(a.canUndo()).toBe(false);
    expect(b.canUndo()).toBe(false);
  });
});
