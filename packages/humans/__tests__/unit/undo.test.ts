/**
 * Engine undo/redo — ONE consolidated suite.
 *
 * This is the single home for engine-side undo testing. It folds together what
 * used to be four files (undo.test.ts, undo-stream.test.ts, undoApply.test.ts,
 * UndoManager.serialization.test.ts) onto ONE real-pool/real-store harness, and
 * adds the conflict-resolution end-to-end coverage that was previously only a
 * pure-function unit test.
 *
 * Everything below runs against a real `ObjectPool` and a real `SyncStoreContract`
 * (the only stubs are intentional: a throwing `delete`, and the async-echo store
 * that defers its stream emit). Sections:
 *   - RecordingMutation        — inverse derivation from real mutations
 *   - UndoScope undo/redo         — real state reversal (create/update/delete)
 *   - reparent (FK change)        — cross-parent move is captured + reversible
 *   - conflict resolution (e2e)   — skip-stale vs last-writer-wins on real state
 *   - resolveOps (unit)           — per-field/per-row filtering edge cases
 *   - reactivity & failure        — onChange, failed-replay restore
 *   - history limits / UndoManager
 *   - stream recording            — observe the local-mutation stream
 *   - async replay-echo suppression
 *   - serialization               — invocation-order guarantee
 *
 * The slides-facing layers (SlideUndoStack, SelectionHistory,
 * SelectionUndoController) are covered in apps/web/tests/unit/lib/slides/undo.test.ts.
 */

import { z } from 'zod';
import { InstanceCache as ObjectPool } from '../../src/local/InstanceCache';
import { ModelRegistry, setActiveRegistry } from '../../src/local/ModelRegistry';
import { Model } from '../../src/local/Model';
import { defineSchema, model } from '@abloatai/transaction/schema';
import type { SyncStoreContract, LocalMutation } from '../../src/react/context';
import { createTransaction } from '../../src/local/mutators/Transaction';
import { createRecordingMutation } from '../../src/local/mutators/RecordingMutation';
import { UndoManager, UndoScope } from '../../src/local/mutators/UndoManager';
import { resolveOps, deepEqual } from '../../src/local/mutators/undoApply';
import type { InverseOp } from '../../src/local/mutators/inverseOp';
import { ViewRegistry } from '../../src/local/views/ViewRegistry';
import { createTestContext } from '../../src/local/testing';

// ── Shared schema + model ──────────────────────────────────────────────

const testSchema = defineSchema({
  tasks: model(
    {
      title: z.string(),
      status: z.enum(['todo', 'in_progress', 'done']).default('todo'),
      order: z.number().default(0),
      projectId: z.string().optional(),
    },
    { typename: 'Task' }),
});

class TestTask extends Model {
  title!: string;
  status!: 'todo' | 'in_progress' | 'done';
  order!: number;
  projectId?: string;
  organizationId!: string;
  override archivedAt?: Date | null;

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

// ── Shared real store ──────────────────────────────────────────────────
//
// One store builder serves every section. `save`/`delete` re-emit on the
// local-mutation stream — mirroring the real engine, where a replayed undo
// write goes back through the commit path. Stream subscribers only exist when a
// scope is created with `recordFromStream: true`, so the manual-record sections
// (which don't subscribe) are unaffected by the emit.

let pool: ObjectPool;
let store: SyncStoreContract;
let emit: (m: LocalMutation) => void;
let cleanup: () => void;

function createStore(): SyncStoreContract {
  const handlers = new Set<(m: LocalMutation) => void>();
  emit = (m) => {
    for (const h of handlers) h(m);
  };
  return {
    retrieve: (_class, id) => pool.get(id),
    queryByClass: () => ({ data: [] }),
    save: async (m) => {
      if (!pool.get(m.id)) pool.add(m);
      emit({ type: 'update', modelName: 'Task', modelId: m.id, data: { title: (m as TestTask).title } });
    },
    delete: async (m) => {
      pool.remove(m.id);
      emit({ type: 'delete', modelName: 'Task', modelId: m.id, previousData: m.toJSON() });
    },
    archive: async () => {},
    unarchive: async () => {},
    subscribeLocalMutations: (handler) => {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    pool: {
      get: (id) => pool.get(id),
      getByTypeName: (t, scope) => pool.getByTypeName(t, scope),
      getByForeignKey: (m, f, v) => pool.getByForeignKey(m, f, v),
      createFromData: (d) => pool.createFromData(d),
      hasForeignKeyIndex: (t, f) => pool.hasForeignKeyIndex(t, f),
      createView: (t, o) => pool.createView(t, o),
      viewRegistry: pool.viewRegistry ?? new ViewRegistry(),
    },
    isReady: true,
    isSyncing: false,
    isOffline: false,
    isReconnecting: false,
    isError: false,
    hasUnsyncedChanges: false,
    syncStatus: { state: 'idle' as const, progress: 100, pendingChanges: 0, isSessionError: false },
  };
}

beforeEach(() => {
  const registry = new ModelRegistry();
  registry.registerModel('Task', TestTask);
  setActiveRegistry(registry);
  const ctx = createTestContext();
  cleanup = ctx.cleanup;
  pool = new ObjectPool({ maxSize: 100, gcInterval: 0, useWeakRefs: false }, registry);
  store = createStore();
});

afterEach(() => {
  pool.clear();
  cleanup();
});

/** Read a task from the pool (asserting it's present is the caller's job). */
const task = (id: string): TestTask => pool.get(id) as unknown as TestTask;
/** Wait one microtask so the stream scope's per-tick flush runs. */
const tick = (): Promise<void> => Promise.resolve();
/** Seed a task without recording it on any undo scope. */
async function seed(input: { title: string; status?: 'todo' | 'in_progress' | 'done'; projectId?: string }): Promise<string> {
  const created = await createTransaction(testSchema, store, 'org-1').mutations.tasks.create(input);
  return (created as { id: string }).id;
}

// ── RecordingMutation (inverse derivation) ──────────────────────────

describe('RecordingMutation', () => {
  it('captures create → delete inverse', async () => {
    const rec = createRecordingMutation(testSchema, store, 'org-1');
    const t = await rec.tx.mutations.tasks.create({ title: 'Hello' });
    const entry = rec.getEntry();

    expect(entry).not.toBeNull();
    expect(entry!.inverses).toHaveLength(1);
    expect(entry!.inverses[0]).toMatchObject({ kind: 'delete', modelKey: 'tasks', id: (t as { id: string }).id });
  });

  it('captures update → update-back inverse with prev values', async () => {
    const rec = createRecordingMutation(testSchema, store, 'org-1');
    const t = await rec.tx.mutations.tasks.create({ title: 'Original' });
    const id = (t as { id: string }).id;

    await rec.tx.mutations.tasks.update({ id, title: 'Changed' });
    const entry = rec.getEntry();

    expect(entry!.inverses[0]).toMatchObject({ kind: 'update', modelKey: 'tasks', patch: { id, title: 'Original' } });
  });

  it('captures delete → create inverse with full model snapshot', async () => {
    const rec = createRecordingMutation(testSchema, store, 'org-1');
    const t = await rec.tx.mutations.tasks.create({ title: 'Doomed', status: 'in_progress' });
    const id = (t as { id: string }).id;

    await rec.tx.mutations.tasks.delete(id);
    const restore = rec.getEntry()!.inverses[0];
    if (!restore) throw new Error('expected a restore inverse op');
    expect(restore.kind).toBe('create');
    if (restore.kind !== 'create') throw new Error('unreachable');
    expect(restore.data).toMatchObject({ id, title: 'Doomed', status: 'in_progress' });
  });

  it('returns null entry when no writes happened', async () => {
    const rec = createRecordingMutation(testSchema, store, 'org-1');
    rec.tx.read.tasks.list();
    expect(rec.getEntry()).toBeNull();
  });

  it('inverses are ordered reverse-of-forward', async () => {
    const rec = createRecordingMutation(testSchema, store, 'org-1');
    const a = await rec.tx.mutations.tasks.create({ title: 'A' });
    const b = await rec.tx.mutations.tasks.create({ title: 'B' });
    const entry = rec.getEntry()!;

    expect(entry.forwards[0]).toMatchObject({ kind: 'create', modelKey: 'tasks' });
    expect(entry.forwards[1]).toMatchObject({ kind: 'create', modelKey: 'tasks' });
    expect(entry.inverses[0]).toMatchObject({ kind: 'delete', id: (b as { id: string }).id });
    expect(entry.inverses[1]).toMatchObject({ kind: 'delete', id: (a as { id: string }).id });
  });

  it('captures createMany → deleteMany inverse', async () => {
    const rec = createRecordingMutation(testSchema, store, 'org-1');
    const created = await rec.tx.mutations.tasks.create([{ title: 'A' }, { title: 'B' }, { title: 'C' }]);
    const inverse = rec.getEntry()!.inverses[0];
    if (!inverse) throw new Error('expected a deleteMany inverse op');
    expect(inverse.kind).toBe('deleteMany');
    if (inverse.kind !== 'deleteMany') throw new Error('unreachable');
    expect(inverse.ids).toEqual(created.map((m) => (m as { id: string }).id));
  });

  it('captures deleteMany → createMany inverse with snapshots', async () => {
    const rec = createRecordingMutation(testSchema, store, 'org-1');
    const a = await rec.tx.mutations.tasks.create({ title: 'A' });
    const b = await rec.tx.mutations.tasks.create({ title: 'B' });
    await rec.tx.mutations.tasks.delete([(a as { id: string }).id, (b as { id: string }).id]);

    const restore = rec.getEntry()!.inverses[0];
    if (!restore) throw new Error('expected a createMany inverse op');
    expect(restore.kind).toBe('createMany');
    if (restore.kind !== 'createMany') throw new Error('unreachable');
    expect(restore.data).toHaveLength(2);
    expect(restore.data[0]).toMatchObject({ title: 'A' });
    expect(restore.data[1]).toMatchObject({ title: 'B' });
  });
});

// ── UndoScope undo/redo (real state reversal) ──────────────────────────

describe('UndoScope.undo (real reversal)', () => {
  it('reverses a create (task disappears from pool)', async () => {
    const scope = new UndoScope(testSchema, store, 'org-1');
    const rec = createRecordingMutation(testSchema, store, 'org-1');
    const t = await rec.tx.mutations.tasks.create({ title: 'Temp' });
    const id = (t as { id: string }).id;
    scope.record(rec.getEntry()!);

    expect(pool.get(id)).toBeDefined();
    await scope.undo();
    expect(pool.get(id)).toBeUndefined();
  });

  it('reverses an update (field returns to prev value)', async () => {
    const scope = new UndoScope(testSchema, store, 'org-1');
    const id = await seed({ title: 'Original' });

    const rec = createRecordingMutation(testSchema, store, 'org-1');
    await rec.tx.mutations.tasks.update({ id, title: 'Changed' });
    scope.record(rec.getEntry()!);

    expect(task(id).title).toBe('Changed');
    await scope.undo();
    expect(task(id).title).toBe('Original');
  });

  it('reverses a delete (task reappears in pool)', async () => {
    const scope = new UndoScope(testSchema, store, 'org-1');
    const id = await seed({ title: 'Doomed', status: 'in_progress' });

    const rec = createRecordingMutation(testSchema, store, 'org-1');
    await rec.tx.mutations.tasks.delete(id);
    scope.record(rec.getEntry()!);

    expect(pool.get(id)).toBeUndefined();
    await scope.undo();
    expect(task(id)).toBeDefined();
    expect(task(id).title).toBe('Doomed');
    expect(task(id).status).toBe('in_progress');
  });

  it('reverses a multi-op mutator atomically', async () => {
    const scope = new UndoScope(testSchema, store, 'org-1');
    const rec = createRecordingMutation(testSchema, store, 'org-1');
    await rec.tx.mutations.tasks.create({ title: 'A' });
    await rec.tx.mutations.tasks.create({ title: 'B' });
    await rec.tx.mutations.tasks.create({ title: 'C' });
    scope.record(rec.getEntry()!);

    expect(pool.getByTypeName('Task')).toHaveLength(3);
    await scope.undo();
    expect(pool.getByTypeName('Task')).toHaveLength(0);
  });

  it('no-ops when undo stack is empty', async () => {
    const scope = new UndoScope(testSchema, store, 'org-1');
    await expect(scope.undo()).resolves.toBeUndefined();
  });

  it('canUndo reflects stack state', async () => {
    const scope = new UndoScope(testSchema, store, 'org-1');
    expect(scope.canUndo()).toBe(false);

    const rec = createRecordingMutation(testSchema, store, 'org-1');
    await rec.tx.mutations.tasks.create({ title: 'X' });
    scope.record(rec.getEntry()!);
    expect(scope.canUndo()).toBe(true);

    await scope.undo();
    expect(scope.canUndo()).toBe(false);
  });
});

describe('UndoScope.redo (real reversal)', () => {
  it('re-applies a create after undo', async () => {
    const scope = new UndoScope(testSchema, store, 'org-1');
    const rec = createRecordingMutation(testSchema, store, 'org-1');
    const t = await rec.tx.mutations.tasks.create({ title: 'Toggle me' });
    const id = (t as { id: string }).id;
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
    const id = await seed({ title: 'v1' });

    const rec = createRecordingMutation(testSchema, store, 'org-1');
    await rec.tx.mutations.tasks.update({ id, title: 'v2' });
    scope.record(rec.getEntry()!);

    await scope.undo();
    expect(task(id).title).toBe('v1');
    await scope.redo();
    expect(task(id).title).toBe('v2');
  });

  it('new mutation clears the redo stack', async () => {
    const scope = new UndoScope(testSchema, store, 'org-1');
    const rec1 = createRecordingMutation(testSchema, store, 'org-1');
    await rec1.tx.mutations.tasks.create({ title: 'A' });
    scope.record(rec1.getEntry()!);

    await scope.undo();
    expect(scope.canRedo()).toBe(true);

    const rec2 = createRecordingMutation(testSchema, store, 'org-1');
    await rec2.tx.mutations.tasks.create({ title: 'B' });
    scope.record(rec2.getEntry()!);

    expect(scope.canRedo()).toBe(false);
  });
});

// ── Reparent (FK change) — the cross-slide layer-move analog ───────────
//
// Moving a slide layer to another slide is a single `update({ slideId })`
// (reparent), NOT delete+create. `projectId` here stands in for `slideId`.
describe('UndoScope reparent (FK change)', () => {
  it('captures the previous parent id in the inverse (reparent is reversible)', async () => {
    const id = await seed({ title: 'movable', projectId: 'p1' });

    const rec = createRecordingMutation(testSchema, store, 'org-1');
    await rec.tx.mutations.tasks.update({ id, projectId: 'p2' });
    expect(rec.getEntry()!.inverses[0]).toMatchObject({ kind: 'update', modelKey: 'tasks', patch: { id, projectId: 'p1' } });
  });

  it('undo returns the row to its original parent; redo re-moves it', async () => {
    const scope = new UndoScope(testSchema, store, 'org-1');
    const id = await seed({ title: 'movable', projectId: 'p1' });

    const rec = createRecordingMutation(testSchema, store, 'org-1');
    await rec.tx.mutations.tasks.update({ id, projectId: 'p2' });
    scope.record(rec.getEntry()!);

    expect(task(id).projectId).toBe('p2');
    await scope.undo();
    expect(task(id).projectId).toBe('p1');
    await scope.redo();
    expect(task(id).projectId).toBe('p2');
  });
});

// ── Conflict resolution (skip-stale vs last-writer-wins), END-TO-END ────
//
// The differentiator: undo is per-user. A collaborator's edit arrives as an
// inbound sync delta — it updates the POOL but never lands on our undo stack.
// We simulate that by mutating the pooled model directly (no record), then prove
// undo respects the policy when it replays against the now-changed live state.

describe('UndoScope conflict resolution (e2e)', () => {
  it('skip-stale (default): undo leaves a field a collaborator changed after you', async () => {
    const scope = new UndoScope(testSchema, store, 'org-1'); // default policy
    const id = await seed({ title: 'old' });

    const rec = createRecordingMutation(testSchema, store, 'org-1');
    await rec.tx.mutations.tasks.update({ id, title: 'mine' });
    scope.record(rec.getEntry()!);
    expect(task(id).title).toBe('mine');

    // Collaborator edit arrives as a remote delta: updates the pool, not our stack.
    task(id).title = 'theirs';

    await scope.undo();
    // Must NOT clobber the collaborator back to 'old' — their change still stands.
    expect(task(id).title).toBe('theirs');
  });

  it('skip-stale: still reverts a field the collaborator did NOT touch (partial)', async () => {
    const scope = new UndoScope(testSchema, store, 'org-1');
    const id = await seed({ title: 'oldTitle', status: 'todo' });

    const rec = createRecordingMutation(testSchema, store, 'org-1');
    await rec.tx.mutations.tasks.update({ id, title: 'myTitle', status: 'in_progress' });
    scope.record(rec.getEntry()!);

    // Collaborator changes ONLY status after me; title still holds my value.
    task(id).status = 'done';

    await scope.undo();
    expect(task(id).title).toBe('oldTitle'); // still mine → reverted
    expect(task(id).status).toBe('done'); // collaborator's → left intact
  });

  it('last-writer-wins: undo clobbers the collaborator change (legacy behavior)', async () => {
    const scope = new UndoScope(testSchema, store, 'org-1', { conflictPolicy: 'last-writer-wins' });
    const id = await seed({ title: 'old' });

    const rec = createRecordingMutation(testSchema, store, 'org-1');
    await rec.tx.mutations.tasks.update({ id, title: 'mine' });
    scope.record(rec.getEntry()!);

    task(id).title = 'theirs';

    await scope.undo();
    expect(task(id).title).toBe('old'); // inverse applied verbatim, clobbering theirs
  });

  it('skip-stale: redo re-applies only where the redo value still stands', async () => {
    const scope = new UndoScope(testSchema, store, 'org-1');
    const id = await seed({ title: 'old' });

    const rec = createRecordingMutation(testSchema, store, 'org-1');
    await rec.tx.mutations.tasks.update({ id, title: 'mine' });
    scope.record(rec.getEntry()!);

    await scope.undo(); // no collaborator yet → reverts to 'old'
    expect(task(id).title).toBe('old');

    // Collaborator edits between undo and redo.
    task(id).title = 'theirs';
    await scope.redo();
    // redo wanted to set 'mine', but live is 'theirs' (not the 'old' undo established) → skip.
    expect(task(id).title).toBe('theirs');
  });
});

// ── resolveOps (unit) — per-field / per-row filtering edge cases ────────
//
// Kept as fast pure-function checks for shapes that are awkward to stage e2e
// (updateMany per-row, structural passthrough). The store stub exposes only the
// single field resolveOps reads: `pool.get(id).toJSON()`.

describe('resolveOps (unit)', () => {
  function storeWith(values: Record<string, Record<string, unknown>>): SyncStoreContract {
    return {
      pool: {
        get: (id: string) => {
          const v = values[id];
          return v ? ({ toJSON: () => ({ id, ...v }) } as unknown as never) : undefined;
        },
      },
    } as unknown as SyncStoreContract;
  }

  it('deepEqual compares scalars, nested objects, and arrays', () => {
    expect(deepEqual(1, 1)).toBe(true);
    expect(deepEqual('a', 'b')).toBe(false);
    expect(deepEqual({ x: 1, y: { z: 2 } }, { x: 1, y: { z: 2 } })).toBe(true);
    expect(deepEqual([1, 2, 3], [1, 2, 3])).toBe(true);
    expect(deepEqual({ x: 1 }, { x: 1, y: 2 })).toBe(false);
  });

  it('filters per-row inside updateMany', () => {
    const inv: InverseOp[] = [
      { kind: 'updateMany', modelKey: 'tasks', patches: [{ id: 'a', title: 'oldA' }, { id: 'b', title: 'oldB' }] },
    ];
    const fwd: InverseOp[] = [
      { kind: 'updateMany', modelKey: 'tasks', patches: [{ id: 'a', title: 'mineA' }, { id: 'b', title: 'mineB' }] },
    ];
    const s = storeWith({ a: { title: 'mineA' }, b: { title: 'theirsB' } }); // b superseded
    expect(resolveOps(inv, fwd, s, 'skip-stale')).toEqual([
      { kind: 'updateMany', modelKey: 'tasks', patches: [{ id: 'a', title: 'oldA' }] },
    ]);
  });

  it('passes structural create/delete ops through unconditionally', () => {
    const ops: InverseOp[] = [
      { kind: 'delete', modelKey: 'tasks', id: 't1' },
      { kind: 'create', modelKey: 'tasks', data: { id: 't2', title: 'x' } },
    ];
    expect(resolveOps(ops, [], storeWith({}), 'skip-stale')).toEqual(ops);
  });

  it('last-writer-wins returns the ops unchanged', () => {
    const inverse: InverseOp[] = [{ kind: 'update', modelKey: 'tasks', patch: { id: 't1', title: 'old' } }];
    const forward: InverseOp[] = [{ kind: 'update', modelKey: 'tasks', patch: { id: 't1', title: 'mine' } }];
    expect(resolveOps(inverse, forward, storeWith({ t1: { title: 'theirs' } }), 'last-writer-wins')).toBe(inverse);
  });
});

// ── Reactivity & failure handling ──────────────────────────────────────

describe('UndoScope reactivity & failure handling', () => {
  it('onChange fires on record, undo, redo, and clear', async () => {
    const scope = new UndoScope(testSchema, store, 'org-1');
    let changes = 0;
    const off = scope.onChange(() => {
      changes++;
    });

    const rec = createRecordingMutation(testSchema, store, 'org-1');
    await rec.tx.mutations.tasks.create({ title: 'X' });
    scope.record(rec.getEntry()!); // 1
    await scope.undo(); // 2
    await scope.redo(); // 3
    scope.clear(); // 4

    expect(changes).toBe(4);
    off();
  });

  it('a failed undo replay restores the entry instead of losing it', async () => {
    const throwingStore: SyncStoreContract = {
      ...store,
      delete: async () => {
        throw new Error('server rejected delete');
      },
    };
    const scope = new UndoScope(testSchema, throwingStore, 'org-1');
    const rec = createRecordingMutation(testSchema, throwingStore, 'org-1');
    await rec.tx.mutations.tasks.create({ title: 'sticky' });
    scope.record(rec.getEntry()!);

    expect(scope.canUndo()).toBe(true);
    await expect(scope.undo()).rejects.toThrow('server rejected delete');
    expect(scope.size()).toEqual({ undo: 1, redo: 0 });
  });
});

describe('UndoScope history limits', () => {
  it('caps history at maxHistory', async () => {
    const scope = new UndoScope(testSchema, store, 'org-1', { maxHistory: 3 });
    for (let i = 0; i < 5; i++) {
      const rec = createRecordingMutation(testSchema, store, 'org-1');
      await rec.tx.mutations.tasks.create({ title: `T${i}` });
      scope.record(rec.getEntry()!);
    }
    expect(scope.size().undo).toBe(3);
  });

  it('clear() wipes both stacks', async () => {
    const scope = new UndoScope(testSchema, store, 'org-1');
    const rec = createRecordingMutation(testSchema, store, 'org-1');
    await rec.tx.mutations.tasks.create({ title: 'X' });
    scope.record(rec.getEntry()!);
    await scope.undo();

    expect(scope.size()).toEqual({ undo: 0, redo: 1 });
    scope.clear();
    expect(scope.size()).toEqual({ undo: 0, redo: 0 });
  });
});

describe('UndoManager (named scopes)', () => {
  it('getScope returns the same scope for a repeated name', () => {
    const manager = new UndoManager(testSchema, store, 'org-1');
    expect(manager.getScope('deck-editor')).toBe(manager.getScope('deck-editor'));
  });

  it('different names get independent stacks', async () => {
    const manager = new UndoManager(testSchema, store, 'org-1');
    const deck = manager.getScope('deck-editor');
    const sheet = manager.getScope('spreadsheet');

    const rec = createRecordingMutation(testSchema, store, 'org-1');
    await rec.tx.mutations.tasks.create({ title: 'deck-thing' });
    deck.record(rec.getEntry()!);

    expect(deck.canUndo()).toBe(true);
    expect(sheet.canUndo()).toBe(false);
  });

  it('clearAll clears every scope', async () => {
    const manager = new UndoManager(testSchema, store, 'org-1');
    const a = manager.getScope('a');
    const b = manager.getScope('b');

    const rec1 = createRecordingMutation(testSchema, store, 'org-1');
    await rec1.tx.mutations.tasks.create({ title: 'a1' });
    a.record(rec1.getEntry()!);
    const rec2 = createRecordingMutation(testSchema, store, 'org-1');
    await rec2.tx.mutations.tasks.create({ title: 'b1' });
    b.record(rec2.getEntry()!);

    manager.clearAll();
    expect(a.canUndo()).toBe(false);
    expect(b.canUndo()).toBe(false);
  });
});

// ── Stream recording (observe the local-mutation stream) ───────────────

function makeStreamScope(): UndoScope<typeof testSchema> {
  return new UndoScope(testSchema, store, 'org-1', { recordFromStream: true });
}

describe('UndoScope stream recording', () => {
  it('derives an update inverse from previousData and restores on undo', async () => {
    pool.add(new TestTask({ id: 't1', title: 'new', order: 0, organizationId: 'org-1' }));
    const scope = makeStreamScope();

    emit({ type: 'update', modelName: 'Task', modelId: 't1', data: { title: 'new' }, previousData: { id: 't1', title: 'old' } });
    await tick();

    expect(scope.size()).toEqual({ undo: 1, redo: 0 });
    await scope.undo();
    expect(task('t1').title).toBe('old');
    expect(scope.size()).toEqual({ undo: 0, redo: 1 }); // replay did NOT re-record
  });

  it('coalesces multiple mutations in one tick into a single entry', async () => {
    pool.add(new TestTask({ id: 'a', title: 'A1', organizationId: 'org-1' }));
    pool.add(new TestTask({ id: 'b', title: 'B1', organizationId: 'org-1' }));
    const scope = makeStreamScope();
    const entries: number[] = [];
    scope.onRecord((e) => entries.push(e.forwards.length));

    emit({ type: 'update', modelName: 'Task', modelId: 'a', data: { title: 'A2' }, previousData: { id: 'a', title: 'A1' } });
    emit({ type: 'update', modelName: 'Task', modelId: 'b', data: { title: 'B2' }, previousData: { id: 'b', title: 'B1' } });
    await tick();

    expect(entries).toEqual([2]);
    expect(scope.size().undo).toBe(1);
  });

  it('groups mutations across ticks via beginGroup/endGroup (pause/resume)', async () => {
    pool.add(new TestTask({ id: 'g', title: 'v0', organizationId: 'org-1' }));
    const scope = makeStreamScope();

    scope.beginGroup('drag');
    emit({ type: 'update', modelName: 'Task', modelId: 'g', data: { order: 1 }, previousData: { id: 'g', order: 0 } });
    await tick();
    emit({ type: 'update', modelName: 'Task', modelId: 'g', data: { order: 2 }, previousData: { id: 'g', order: 1 } });
    await tick();
    expect(scope.size().undo).toBe(0); // nothing recorded while group open

    scope.endGroup();
    expect(scope.size().undo).toBe(1); // whole gesture = one entry
  });

  it('ignores mutations for models outside tracksModel', async () => {
    const scope = new UndoScope(testSchema, store, 'org-1', { recordFromStream: true, tracksModel: (key) => key === 'somethingElse' });
    emit({ type: 'update', modelName: 'Task', modelId: 't1', data: { title: 'x' }, previousData: { id: 't1', title: 'y' } });
    await tick();
    expect(scope.size().undo).toBe(0);
  });

  it('records nothing when the store does not expose the stream', async () => {
    const noStream: SyncStoreContract = { ...store };
    delete (noStream as { subscribeLocalMutations?: unknown }).subscribeLocalMutations;
    const scope = new UndoScope(testSchema, noStream, 'org-1', { recordFromStream: true });
    emit({ type: 'update', modelName: 'Task', modelId: 't1', data: { title: 'x' }, previousData: { id: 't1', title: 'y' } });
    await tick();
    expect(scope.size().undo).toBe(0);
  });
});

// ── Async replay-echo suppression ──────────────────────────────────────
//
// A store whose writes surface on the stream a macrotask LATER — mirroring the
// real engine (the echo lands after undo()/redo() reset their synchronous
// `replaying` flag). This is the timing that made every undo silently wipe its
// own redo stack before the `pendingReplayEchoes` guard was added.

describe('UndoScope async replay-echo suppression', () => {
  function asyncEchoStore(): SyncStoreContract {
    return {
      ...store,
      save: async (m) => {
        if (!pool.get(m.id)) pool.add(m);
        const title = (m as TestTask).title;
        setTimeout(() => { emit({ type: 'update', modelName: 'Task', modelId: m.id, data: { title } }); }, 0);
      },
      delete: async (m) => {
        const previousData = m.toJSON();
        pool.remove(m.id);
        setTimeout(() => { emit({ type: 'delete', modelName: 'Task', modelId: m.id, previousData }); }, 0);
      },
    };
  }
  const macrotask = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

  it("does not let an undo's async echo wipe the redo stack", async () => {
    pool.add(new TestTask({ id: 't1', title: 'new', order: 0, organizationId: 'org-1' }));
    const scope = new UndoScope(testSchema, asyncEchoStore(), 'org-1', { recordFromStream: true });

    emit({ type: 'update', modelName: 'Task', modelId: 't1', data: { title: 'new' }, previousData: { id: 't1', title: 'old' } });
    await tick();
    expect(scope.size()).toEqual({ undo: 1, redo: 0 });

    await scope.undo();
    expect(task('t1').title).toBe('old');
    expect(scope.size()).toEqual({ undo: 0, redo: 1 });

    await macrotask();
    await tick();
    expect(scope.size()).toEqual({ undo: 0, redo: 1 }); // echo did NOT record
  });

  it('redo restores the value after an async-echo undo', async () => {
    pool.add(new TestTask({ id: 't2', title: 'B', order: 0, organizationId: 'org-1' }));
    const scope = new UndoScope(testSchema, asyncEchoStore(), 'org-1', { recordFromStream: true });

    emit({ type: 'update', modelName: 'Task', modelId: 't2', data: { title: 'B' }, previousData: { id: 't2', title: 'A' } });
    await tick();

    await scope.undo();
    await macrotask();
    await tick();
    expect(task('t2').title).toBe('A');

    await scope.redo();
    await macrotask();
    await tick();
    expect(task('t2').title).toBe('B');
    expect(scope.size()).toEqual({ undo: 1, redo: 0 });
  });

  it('still records a genuine edit to the same row after the echo settles', async () => {
    pool.add(new TestTask({ id: 't3', title: 'v1', order: 0, organizationId: 'org-1' }));
    const scope = new UndoScope(testSchema, asyncEchoStore(), 'org-1', { recordFromStream: true });

    emit({ type: 'update', modelName: 'Task', modelId: 't3', data: { title: 'v1' }, previousData: { id: 't3', title: 'v0' } });
    await tick();

    await scope.undo();
    await macrotask();
    await tick();
    expect(scope.size()).toEqual({ undo: 0, redo: 1 });

    emit({ type: 'update', modelName: 'Task', modelId: 't3', data: { title: 'v2' }, previousData: { id: 't3', title: 'old' } });
    await tick();
    expect(scope.size()).toEqual({ undo: 1, redo: 0 });
  });
});

// ── Serialization (invocation-order guarantee) ─────────────────────────
//
// Every scope operation (record/undo/redo) runs through one chain so entries
// land in INVOCATION order and never interleave — the "flaky undo" regression.

describe('UndoScope serialization', () => {
  const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

  it('runs queued work in invocation order even when earlier work resolves slower', async () => {
    const scope = new UndoScope(testSchema, store, 'org-1');
    const completed: number[] = [];
    const p1 = scope.runRecorded(async () => { await delay(30); completed.push(1); });
    const p2 = scope.runRecorded(async () => { await delay(20); completed.push(2); });
    const p3 = scope.runRecorded(async () => { await delay(10); completed.push(3); });
    await Promise.all([p1, p2, p3]);
    expect(completed).toEqual([1, 2, 3]);
  });

  it('never interleaves two recordings (at most one runs at a time)', async () => {
    const scope = new UndoScope(testSchema, store, 'org-1');
    let active = 0;
    let maxActive = 0;
    const job = (latency: number) =>
      scope.runRecorded(async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await delay(latency);
        active -= 1;
      });
    await Promise.all([job(15), job(5), job(10), job(1)]);
    expect(maxActive).toBe(1);
    expect(active).toBe(0);
  });

  it('surfaces a rejection to its caller without wedging the chain', async () => {
    const scope = new UndoScope(testSchema, store, 'org-1');
    const completed: string[] = [];
    const ok1 = scope.runRecorded(async () => { await delay(5); completed.push('a'); });
    const boom = scope.runRecorded(async () => { throw new Error('mutator failed'); });
    const ok2 = scope.runRecorded(async () => { await delay(5); completed.push('b'); });
    await expect(boom).rejects.toThrow('mutator failed');
    await Promise.all([ok1, ok2]);
    expect(completed).toEqual(['a', 'b']);
  });

  it('orders undo after a still-settling recording', async () => {
    const scope = new UndoScope(testSchema, store, 'org-1');
    const events: string[] = [];
    const recording = scope.runRecorded(async () => {
      await delay(20);
      scope.record({ label: 'edit', inverses: [], forwards: [] });
      events.push('recorded');
    });
    const undo = scope.undo().then(() => events.push('undone'));
    await Promise.all([recording, undo]);
    expect(events).toEqual(['recorded', 'undone']);
    expect(scope.size()).toEqual({ undo: 0, redo: 1 });
  });
});
