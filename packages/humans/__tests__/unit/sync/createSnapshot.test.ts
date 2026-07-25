/**
 * Engine-attached createSnapshot — unit tests.
 *
 * Builds the snapshot factory directly on a real ObjectPool + a stub
 * transport. Asserts:
 *   • watermark stamp matches the engine's lastSyncId at capture time
 *   • per-model bucket contains the captured entities
 *   • signal aborts when a captured entity receives a delta
 *   • onChange listeners fire on captured-entity deltas
 *   • non-captured deltas don't trigger invalidation
 *   • reserved schema model names throw a clear error
 */

import { z } from 'zod';
import { defineSchema } from '@ablo/transaction/schema/schema';
import { model } from '@ablo/transaction/schema/model';
import { Ablo, type InternalAbloOptions } from '../../../src/Ablo';
import { createSnapshot } from '../../../src/local/sync/createSnapshot';
import type { SyncDelta, SyncWebSocket } from '../../../src/local/sync/SyncWebSocket';

type DeltaSubscriber = (delta: SyncDelta) => void;

interface StubTransport {
  send: (frame: unknown) => void;
  isConnected: () => boolean;
  subscribe: (event: 'delta', cb: DeltaSubscriber) => () => void;
  __fireDelta: (delta: SyncDelta) => void;
}

function makeStubTransport(): StubTransport {
  const handlers: DeltaSubscriber[] = [];
  return {
    send: () => {},
    isConnected: () => true,
    subscribe: (_event, cb) => {
      handlers.push(cb);
      return () => {
        const i = handlers.indexOf(cb);
        if (i >= 0) handlers.splice(i, 1);
      };
    },
    __fireDelta: (delta) => {
      for (const h of handlers) h(delta);
    },
  };
}

// `createSnapshot` only uses `transport.subscribe('delta', cb)` — see
// src/sync/createSnapshot.ts line 120. The stub fully satisfies that
// surface. The full `SyncWebSocket` type adds dozens of methods we
// don't need; this one bridging cast lives at the test-fixture seam
// rather than scattered across every call site.
function asTransport(stub: StubTransport): SyncWebSocket {
  return stub as unknown as SyncWebSocket;
}

const testSchema = defineSchema({
  notes: model({
    title: z.string(),
  }),
});

function makeEngine() {
  const opts: InternalAbloOptions<typeof testSchema.models> = {
    baseURL: 'ws://localhost:8080',
    schema: testSchema,
    organizationId: 'org-1',
    user: { id: 'user-1' },
    inMemory: true,
    apiKey: 'test',
  };
  return Ablo(opts);
}

interface NoteData extends Record<string, unknown> {
  id: string;
  title: string;
  organizationId: string;
  createdBy: string;
}

function fixedDelta(overrides: Partial<SyncDelta>): SyncDelta {
  return {
    id: 1,
    actionType: 'U',
    modelName: 'notes',
    modelId: 'n-1',
    data: {},
    syncGroups: [],
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('createSnapshot', () => {
  it('stamps the watermark and captures requested entities', () => {
    const engine = makeEngine();
    const pool = engine._pool;
    const note: NoteData = {
      id: 'n-1',
      title: 'Hello',
      organizationId: 'org-1',
      createdBy: 'user-1',
    };
    const created = pool.create('notes', note);
    if (!created) throw new Error('pool.create returned null');
    // `pool.create` returns a fresh model but doesn't insert it; need
    // explicit `add` to make `pool.get(id)` find it.
    pool.add(created);

    const transport = makeStubTransport();
    const snap = createSnapshot({
      pool,
      transport: asTransport(transport),
      getLastSyncId: () => 42,
      entities: { notes: 'n-1' },
    });

    expect(snap.stamp).toBe(42);
    expect(snap.notes['n-1']?.title).toBe('Hello');
    expect(snap.signal.aborted).toBe(false);
  });

  it('aborts the signal when a captured entity receives a delta', () => {
    const engine = makeEngine();
    const pool = engine._pool;
    const note: NoteData = {
      id: 'n-2',
      title: 'X',
      organizationId: 'org-1',
      createdBy: 'user-1',
    };
    pool.create('notes', note);

    const transport = makeStubTransport();
    const snap = createSnapshot({
      pool,
      transport: asTransport(transport),
      getLastSyncId: () => 1,
      entities: { notes: 'n-2' },
    });

    expect(snap.signal.aborted).toBe(false);

    transport.__fireDelta(
      fixedDelta({ id: 2, modelId: 'n-2', data: { title: 'X-edited' } }),
    );

    expect(snap.signal.aborted).toBe(true);
  });

  it('fires onChange listeners on captured-entity deltas', () => {
    const engine = makeEngine();
    const pool = engine._pool;
    const note: NoteData = {
      id: 'n-3',
      title: 'X',
      organizationId: 'org-1',
      createdBy: 'user-1',
    };
    pool.create('notes', note);

    const transport = makeStubTransport();
    const snap = createSnapshot({
      pool,
      transport: asTransport(transport),
      getLastSyncId: () => 1,
      entities: { notes: 'n-3' },
    });

    let observed: { model: string; id: string } | null = null;
    snap.onChange((change) => {
      observed = { model: change.model, id: change.id };
    });

    transport.__fireDelta(fixedDelta({ id: 2, modelId: 'n-3' }));

    expect(observed).toEqual({ model: 'notes', id: 'n-3' });
  });

  it('does not fire on non-captured-entity deltas', () => {
    const engine = makeEngine();
    const pool = engine._pool;
    const note: NoteData = {
      id: 'n-4',
      title: 'X',
      organizationId: 'org-1',
      createdBy: 'user-1',
    };
    pool.create('notes', note);

    const transport = makeStubTransport();
    const snap = createSnapshot({
      pool,
      transport: asTransport(transport),
      getLastSyncId: () => 1,
      entities: { notes: 'n-4' },
    });

    let fired = false;
    snap.onChange(() => {
      fired = true;
    });

    transport.__fireDelta(fixedDelta({ id: 2, modelId: 'n-OTHER' }));

    expect(fired).toBe(false);
    expect(snap.signal.aborted).toBe(false);
  });

  it('throws on reserved snapshot keys (stamp / signal / onChange)', () => {
    const engine = makeEngine();
    expect(() =>
      createSnapshot({
        pool: engine._pool,
        transport: null,
        getLastSyncId: () => 1,
        // `stamp` is a reserved snapshot field name. Widen to a string
        // record so we can pass an intentionally invalid entity name
        // and assert that validation throws.
        entities: { stamp: 'x' } satisfies Record<string, string>,
      }),
    ).toThrow(/reserved/);
  });
});
