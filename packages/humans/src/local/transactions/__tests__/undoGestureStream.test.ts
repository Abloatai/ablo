/**
 * Gesture-shaped undo, driven through the REAL producer.
 *
 * The existing stream-recording coverage (`__tests__/unit/undo.test.ts`) hands
 * `UndoScope` a hand-written `LocalMutation` with a perfect `previousData`, so
 * it pins the RECORDER but never the PRODUCER. This drives the other half: a
 * real `MutationQueue` freezes `previousData` off a real `Model`, the store
 * republishes it on the local-mutation stream exactly as `BaseSyncedStore` does,
 * and the scope replays through a real transaction against a real pool.
 *
 * The shapes are the slide editor's, because that is where reversal is reported
 * broken: a nested `position` object replaced wholesale on every drag commit
 * (`{ ...layer.position, x, y }`), a paste that creates rows, and a second drag
 * landing before the first is acknowledged.
 */

import { z } from 'zod';
import { InstanceCache as ObjectPool } from '../../InstanceCache.js';
import { ModelRegistry, setActiveRegistry } from '../../ModelRegistry.js';
import { Model } from '../../Model.js';
import { defineSchema, model } from '@abloatai/transaction/schema';
import { UndoScope } from '../../mutators/UndoManager.js';
import { createTransaction } from '../../mutators/Transaction.js';
import {
  MutationQueue,
  type UserContext,
} from '../mutations/MutationQueue.js';
import { createTestContext } from '../../testing/mocks/MockSyncContext.js';
import type { TestContextResult } from '../../testing/mocks/MockSyncContext.js';
import type { SyncStoreContract, LocalMutation } from '../../../react/context.js';

interface Position {
  x: number;
  y: number;
  width: number;
  height: number;
}

const layerSchema = defineSchema({
  layers: model(
    {
      slideId: z.string(),
      zIndex: z.number().default(0),
      position: z.object({
        x: z.number(),
        y: z.number(),
        width: z.number(),
        height: z.number(),
      }),
    },
    { typename: 'Layer' },
  ),
});

class TestLayer extends Model {
  slideId!: string;
  zIndex!: number;
  position!: Position;
  organizationId!: string;

  constructor(data: Record<string, unknown>) {
    super(data);
    this.slideId = (data.slideId as string | undefined) ?? 'slide-1';
    this.zIndex = (data.zIndex as number | undefined) ?? 0;
    this.position = (data.position as Position | undefined) ?? { x: 0, y: 0, width: 100, height: 100 };
    this.organizationId = (data.organizationId as string | undefined) ?? 'org-1';
  }

  override toJSON(): Record<string, unknown> {
    return {
      __typename: 'Layer',
      id: this.id,
      slideId: this.slideId,
      zIndex: this.zIndex,
      position: this.position,
      organizationId: this.organizationId,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
    };
  }
}

const userContext: UserContext = { userId: 'user-1', organizationId: 'org-1' };

let ctx: TestContextResult;
let pool: ObjectPool;
let queue: MutationQueue;
let store: SyncStoreContract;
let scope: UndoScope<typeof layerSchema>;

/**
 * The store the undo scope observes. `subscribeLocalMutations` republishes the
 * queue's `transaction:created` verbatim — the same three lines
 * `BaseSyncedStore` uses — so the scope sees exactly what it sees in the app.
 */
function createStore(): SyncStoreContract {
  return {
    retrieve: (_class, id) => pool.get(id),
    queryByClass: () => ({ data: [] }),
    save: (m) => {
      if (!pool.get(m.id)) pool.add(m);
      return Promise.resolve();
    },
    delete: (m) => {
      pool.remove(m.id);
      return Promise.resolve();
    },
    archive: () => Promise.resolve(),
    unarchive: () => Promise.resolve(),
    subscribeLocalMutations: (handler: (m: LocalMutation) => void) => {
      const listener = (tx: {
        type: LocalMutation['type'];
        modelName?: string;
        modelId?: string;
        data?: Record<string, unknown> | null;
        previousData?: Record<string, unknown> | null;
      }): void => {
        if (!tx.modelName || !tx.modelId) return;
        handler({
          type: tx.type,
          modelName: tx.modelName,
          modelId: tx.modelId,
          data: tx.data ?? null,
          previousData: tx.previousData ?? null,
        });
      };
      queue.on('transaction:created', listener);
      return () => queue.off('transaction:created', listener);
    },
    pool: {
      get: (id) => pool.get(id),
      getByTypeName: (t, s) => pool.getByTypeName(t, s),
      getByForeignKey: (m, f, v) => pool.getByForeignKey(m, f, v),
      createFromData: (d) => pool.createFromData(d),
      hasForeignKeyIndex: (t, f) => pool.hasForeignKeyIndex(t, f),
      createView: (t, o) => pool.createView(t, o),
      viewRegistry: pool.viewRegistry,
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
  registry.registerModel('Layer', TestLayer);
  setActiveRegistry(registry);
  ctx = createTestContext();
  pool = new ObjectPool({ maxSize: 100, gcInterval: 0, useWeakRefs: false }, registry);
  queue = new MutationQueue({ enablePersistence: false });
  store = createStore();
  scope = new UndoScope(layerSchema, store, 'org-1', {
    recordFromStream: true,
    tracksModel: (key) => key === 'layers',
  });
});

afterEach(() => {
  scope.dispose();
  queue.dispose();
  pool.clear();
  ctx.cleanup();
});

/** One microtask — the scope's per-tick batch flush. */
const tick = (): Promise<void> => Promise.resolve();

/**
 * The pooled row, as the model class this suite registered. An absent id is the
 * assertion failing rather than a `TypeError` two lines later: every caller here
 * reads `.position` off the result, and a replay that removed a row instead of
 * reverting it should say which row it lost.
 */
const layer = (id: string): TestLayer => {
  const pooled = pool.get<TestLayer>(id);
  if (!pooled) throw new Error(`no pooled layer '${id}'`);
  return pooled;
};

/** Seed a persisted row the way bootstrap does: pooled, acked, untracked. */
function seedLayer(id: string, position: Position): TestLayer {
  const m = new TestLayer({ id, slideId: 'slide-1', position, organizationId: 'org-1' });
  pool.add(m);
  m.markAsPersisted();
  return m;
}

/**
 * A drag commit: the editor replaces `position` wholesale through the model
 * proxy (`applyChanges` → `syncClient.update`), never field-by-field.
 */
async function commitDrag(id: string, to: { x: number; y: number }): Promise<void> {
  const m = layer(id);
  m.applyChanges({ position: { ...m.position, ...to } });
  await queue.update(m, userContext);
  await tick();
}

describe('drag commit → stream → undo', () => {
  it('restores the pre-drag position', async () => {
    seedLayer('l1', { x: 10, y: 20, width: 100, height: 50 });

    await commitDrag('l1', { x: 300, y: 400 });
    expect(layer('l1').position).toEqual({ x: 300, y: 400, width: 100, height: 50 });
    expect(scope.size()).toEqual({ undo: 1, redo: 0 });

    await scope.undo();
    expect(layer('l1').position).toEqual({ x: 10, y: 20, width: 100, height: 50 });
  });

  it('walks back through two drags one step at a time', async () => {
    seedLayer('l1', { x: 0, y: 0, width: 100, height: 50 });

    await commitDrag('l1', { x: 100, y: 100 });
    await commitDrag('l1', { x: 200, y: 200 });
    expect(scope.size().undo).toBe(2);

    await scope.undo();
    expect(layer('l1').position).toMatchObject({ x: 100, y: 100 });

    await scope.undo();
    expect(layer('l1').position).toMatchObject({ x: 0, y: 0 });
  });

  it('survives the server echo landing before Cmd+Z', async () => {
    seedLayer('l1', { x: 0, y: 0, width: 100, height: 50 });
    await commitDrag('l1', { x: 250, y: 125 });

    // The confirmed write comes back as a delta and rehydrates the row: same
    // values, a different object identity, keys in the server's order.
    layer('l1').updateFromData({
      position: { height: 50, width: 100, y: 125, x: 250 },
    });

    await scope.undo();
    expect(layer('l1').position).toMatchObject({ x: 0, y: 0 });
  });

  it('redoes the drag it just undid', async () => {
    seedLayer('l1', { x: 0, y: 0, width: 100, height: 50 });
    await commitDrag('l1', { x: 80, y: 90 });

    await scope.undo();
    expect(layer('l1').position).toMatchObject({ x: 0, y: 0 });

    await scope.redo();
    expect(layer('l1').position).toMatchObject({ x: 80, y: 90 });
    expect(scope.size()).toEqual({ undo: 1, redo: 0 });
  });
});

describe('paste (create) → stream → undo', () => {
  it('removes the pasted row and puts it back on redo', async () => {
    const pasted = new TestLayer({
      id: 'p1',
      slideId: 'slide-1',
      position: { x: 5, y: 5, width: 100, height: 50 },
      organizationId: 'org-1',
    });
    pool.add(pasted);
    await queue.create(pasted, userContext);
    await tick();

    expect(scope.size().undo).toBe(1);

    await scope.undo();
    expect(pool.get('p1')).toBeUndefined();

    await scope.redo();
    expect(pool.get('p1')).toBeDefined();
  });

  it('collapses a multi-layer paste into ONE undo step', async () => {
    for (const id of ['p1', 'p2', 'p3']) {
      const m = new TestLayer({
        id,
        slideId: 'slide-1',
        position: { x: 5, y: 5, width: 100, height: 50 },
        organizationId: 'org-1',
      });
      pool.add(m);
      void queue.create(m, userContext);
    }
    await tick();

    expect(scope.size().undo).toBe(1);

    await scope.undo();
    expect(pool.get('p1')).toBeUndefined();
    expect(pool.get('p2')).toBeUndefined();
    expect(pool.get('p3')).toBeUndefined();
  });
});

describe('paste then drag — the stack the editor actually produces', () => {
  it('undoes the move first, then the creation', async () => {
    const m = new TestLayer({
      id: 'p1',
      slideId: 'slide-1',
      position: { x: 5, y: 5, width: 100, height: 50 },
      organizationId: 'org-1',
    });
    pool.add(m);
    await queue.create(m, userContext);
    await tick();
    await commitDrag('p1', { x: 400, y: 300 });

    expect(scope.size().undo).toBe(2);

    await scope.undo();
    expect(layer('p1').position).toMatchObject({ x: 5, y: 5 });

    await scope.undo();
    expect(pool.get('p1')).toBeUndefined();
  });
});

describe('keyboard nudge → debounced batch → undo', () => {
  /**
   * The nudge does NOT use the draft channel. Each arrow keypress assigns
   * `layer.position` DIRECTLY on the model, and only a debounce later does the
   * batch reach `updateMany` — carrying the very object the last keypress
   * assigned. Two things have to hold for that to be reversible: the direct
   * write must be tracked (the `mobxSetup` `observe()` bridge forwards it to
   * `propertyChanged`, simulated here the way `updatePreviousDataRebaseline`
   * does), and `propertyChanged`'s first-old-wins must survive the three
   * keypresses so the baseline is the position before the FIRST one.
   */
  it('restores the position from before the first keypress, not the last', async () => {
    const m = seedLayer('l1', { x: 0, y: 0, width: 100, height: 50 });

    let pos = m.position;
    for (let i = 0; i < 3; i++) {
      const next = { ...pos, x: pos.x + 1 };
      m.propertyChanged('position', pos, next); // what the observe() bridge does
      m.position = next;
      pos = next;
    }
    expect(m.position).toMatchObject({ x: 3, y: 0 });

    // Debounce fires with the SAME object reference the last keypress stored,
    // so `applyChanges` writes a value the model already holds — a no-op that
    // must not disturb the baseline the keypresses established.
    m.applyChanges({ position: pos });
    await queue.update(m, userContext);
    await tick();

    expect(scope.size().undo).toBe(1);
    await scope.undo();
    expect(layer('l1').position).toMatchObject({ x: 0, y: 0 });
  });

  it('reverses a multi-layer nudge in ONE step', async () => {
    seedLayer('a', { x: 0, y: 0, width: 10, height: 10 });
    seedLayer('b', { x: 50, y: 50, width: 10, height: 10 });

    for (const id of ['a', 'b']) {
      const m = layer(id);
      const next = { ...m.position, y: m.position.y + 10 };
      m.propertyChanged('position', m.position, next);
      m.position = next;
      m.applyChanges({ position: next });
      void queue.update(m, userContext);
    }
    await tick();

    expect(scope.size().undo).toBe(1);
    await scope.undo();
    expect(layer('a').position).toMatchObject({ y: 0 });
    expect(layer('b').position).toMatchObject({ y: 50 });
  });
});

describe('createTransaction replay target', () => {
  it('writes through the same pool the editor reads', async () => {
    seedLayer('l1', { x: 1, y: 2, width: 3, height: 4 });
    await createTransaction(layerSchema, store, 'org-1').mutations.layers.update({
      id: 'l1',
      position: { x: 9, y: 9, width: 3, height: 4 },
    });
    expect(layer('l1').position).toMatchObject({ x: 9, y: 9 });
  });
});
