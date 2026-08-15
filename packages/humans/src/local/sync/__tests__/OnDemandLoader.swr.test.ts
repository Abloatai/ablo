/**
 * OnDemandLoader — local-first lazy reads + durable expand children.
 *
 * Covers the structural fix that stops lazy relations (e.g. EntryDetail) being
 * re-fetched from the network on every mount:
 *
 *  1. `expand`-fetched children are hydrated into the pool AND persisted to
 *     their OWN typed store (not just nested inside the parent row).
 *  2. Lazy models default to local-first ('unknown'): a repeat read is served
 *     from the warm pool without blocking on the network, and revalidates in
 *     the background.
 *  3. The same lazy read can be re-served from local storage via the relation
 *     FK after the parent expand, proving the children are durably cached.
 *  4. An explicit `{ type: 'complete' }` still forces a server-confirmed read.
 *
 * The network leg (`postQuery`) is mocked so we control exactly what the
 * "server" returns and can assert when the engine does / doesn't wait on it.
 */

import { z } from 'zod';
import { Ablo, type InternalAbloOptions } from '../../../Ablo.js';
import { defineSchema } from '@abloatai/transaction/schema/schema';
import { model } from '@abloatai/transaction/schema/model';
import { relation } from '@abloatai/transaction/schema/relation';
import * as queryClient from '../../query/client.js';

jest.mock('../../query/client.js', () => ({
  postQuery: jest.fn(),
}));

const postQueryMock = queryClient.postQuery as jest.MockedFunction<typeof queryClient.postQuery>;

const silentLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

function makeSchema() {
  return defineSchema({
    entries: model(
      { collectionId: z.string() },
      {
        relations: { layers: relation.hasMany('entryDetails', 'entryId') },
        typename: 'Entry', load: 'instant',
      }),
    entryDetails: model(
      {
        entryId: z.string(),
        type: z.string(),
        zIndex: z.number().default(0),
        position: z
          .object({
            x: z.number(),
            y: z.number(),
            width: z.number(),
            height: z.number(),
          })
          .optional(),
      },
      {
        relations: { entry: relation.belongsTo('entries', 'entryId', { index: true }) },
        typename: 'EntryDetail', load: 'lazy',
      }),
  });
}

type TestSchema = ReturnType<typeof makeSchema>;

function makeAblo() {
  const schema = makeSchema();
  return Ablo({
    schema,
    baseURL: 'ws://localhost:1234',
    user: { id: 'user-1' },
    inMemory: true,
    logger: silentLogger,
  } as InternalAbloOptions<TestSchema['models']>);
}

/** A never-resolving promise — stands in for a slow/absent network so we can
 *  assert a read resolved WITHOUT waiting on it. */
function hangingNetwork(): Promise<never> {
  return new Promise<never>(() => undefined);
}

describe('OnDemandLoader — local-first lazy + durable expand', () => {
  beforeEach(() => {
    postQueryMock.mockReset();
  });

  it('persists expand children to their own store and re-serves them locally', async () => {
    const ablo = makeAblo();
    try {
      // Server returns the entry with its layers nested under `layers`.
      postQueryMock.mockResolvedValueOnce({
        results: [
          [
            {
              __typename: 'Entry',
              id: 's1',
              collectionId: 'd1',
              layers: [
                { __typename: 'EntryDetail', id: 'l1', entryId: 's1', type: 'text', zIndex: 0 },
                { __typename: 'EntryDetail', id: 'l2', entryId: 's1', type: 'shape', zIndex: 1 },
              ],
            },
          ],
        ],
      });

      await ablo.entries.list({ where: { collectionId: 'd1' }, expand: ['layers'] });

      // Children landed in the EntryDetail pool via the FK index.
      const inPool = ablo.entryDetails.local.list({ where: { entryId: 's1' } });
      expect(inPool.map((l) => l.id).sort()).toEqual(['l1', 'l2']);

      // Now the network "goes away". A lazy read must still resolve from the
      // warm local cache rather than hanging on the network.
      postQueryMock.mockImplementation(() => hangingNetwork());
      const served = await ablo.entryDetails.list({ where: { entryId: 's1' } });
      expect(served.map((l) => l.id).sort()).toEqual(['l1', 'l2']);
    } finally {
      await ablo.dispose();
    }
  });

  it('lazy reads default to local-first and do not block on the network', async () => {
    const ablo = makeAblo();
    try {
      // First fetch seeds the pool + IDB from the server.
      postQueryMock.mockResolvedValueOnce({
        results: [[{ __typename: 'EntryDetail', id: 'l9', entryId: 's2', type: 'text', zIndex: 0 }]],
      });
      const first = await ablo.entryDetails.list({ where: { entryId: 's2' } });
      expect(first.map((l) => l.id)).toEqual(['l9']);

      // Network now hangs forever. Because entryDetails is lazy, the default is
      // local-first: this resolves from the pool instead of awaiting the hang.
      postQueryMock.mockImplementation(() => hangingNetwork());
      const second = await ablo.entryDetails.list({ where: { entryId: 's2' } });
      expect(second.map((l) => l.id)).toEqual(['l9']);
    } finally {
      await ablo.dispose();
    }
  });

  it('serves a repeat read from cache with ZERO network once hydrated', async () => {
    const ablo = makeAblo();
    try {
      postQueryMock.mockResolvedValue({
        results: [[{ __typename: 'EntryDetail', id: 'l1', entryId: 's1', type: 'text', zIndex: 0 }]],
      });

      // First read: cold cache → one network fetch, marks the query hydrated.
      await ablo.entryDetails.list({ where: { entryId: 's1' } });
      expect(postQueryMock).toHaveBeenCalledTimes(1);

      // Second identical read: the WS stream owns freshness now, so this must
      // be served purely from the pool with NO additional query — exactly the
      // "I just had it open and nothing changed" case.
      const again = await ablo.entryDetails.list({ where: { entryId: 's1' } });
      expect(again.map((l) => l.id)).toEqual(['l1']);
      expect(postQueryMock).toHaveBeenCalledTimes(1);
    } finally {
      await ablo.dispose();
    }
  });

  it('does not re-query an already-opened collection (instant primary + expand)', async () => {
    const ablo = makeAblo();
    try {
      postQueryMock.mockResolvedValue({
        results: [
          [
            {
              __typename: 'Entry',
              id: 's1',
              collectionId: 'd1',
              layers: [
                { __typename: 'EntryDetail', id: 'l1', entryId: 's1', type: 'text', zIndex: 0 },
              ],
            },
          ],
        ],
      });

      // Mirrors the collection-open path: entries (instant) listed with expand:layers.
      await ablo.entries.list({ where: { collectionId: 'd1' }, expand: ['layers'] });
      expect(postQueryMock).toHaveBeenCalledTimes(1);

      // Re-opening the same collection must not issue another query.
      await ablo.entries.list({ where: { collectionId: 'd1' }, expand: ['layers'] });
      expect(postQueryMock).toHaveBeenCalledTimes(1);
      // And the layers are still resolvable from the local store.
      expect(ablo.entryDetails.local.list({ where: { entryId: 's1' } }).map((l) => l.id)).toEqual(['l1']);
    } finally {
      await ablo.dispose();
    }
  });

  it('honors an explicit complete read on a lazy model (server-confirmed)', async () => {
    const ablo = makeAblo();
    try {
      // Seed local state.
      postQueryMock.mockResolvedValueOnce({
        results: [
          [
            {
              __typename: 'EntryDetail',
              id: 'lA',
              entryId: 's3',
              type: 'text',
              zIndex: 0,
              updatedAt: '2026-07-18T08:00:00.000Z',
            },
          ],
        ],
      });
      await ablo.entryDetails.list({ where: { entryId: 's3' } });

      // A complete read must reflect what the server returns now — here the
      // server adds a second layer that local doesn't have yet.
      postQueryMock.mockResolvedValueOnce({
        results: [
          [
            {
              __typename: 'EntryDetail',
              id: 'lA',
              entryId: 's3',
              type: 'text',
              zIndex: 4,
              updatedAt: '2026-07-18T08:01:00.000Z',
            },
            { __typename: 'EntryDetail', id: 'lB', entryId: 's3', type: 'shape', zIndex: 1 },
          ],
        ],
      });
      const complete = await ablo.entryDetails.list({
        where: { entryId: 's3' },
        type: 'complete',
      });
      expect(complete.map((l) => l.id).sort()).toEqual(['lA', 'lB']);
      expect(ablo.entryDetails.local.get('lA')?.zIndex).toBe(4);
    } finally {
      await ablo.dispose();
    }
  });

  it('does not let a late query response overwrite a newer optimistic layer update', async () => {
    const ablo = makeAblo();
    const initialPosition = { x: 10, y: 20, width: 100, height: 80 };
    const resizedPosition = { x: 10, y: 20, width: 240, height: 160 };
    const initialUpdatedAt = '2000-01-01T00:00:00.000Z';

    try {
      // Seed the live layer, then begin the collection-level expand used by the
      // editor. Its response represents a snapshot taken before the resize,
      // but is deliberately held until after the optimistic write.
      postQueryMock.mockResolvedValueOnce({
        results: [
          [
            {
              __typename: 'EntryDetail',
              id: 'l-resize',
              entryId: 's-resize',
              type: 'shape',
              zIndex: 0,
              position: initialPosition,
              updatedAt: initialUpdatedAt,
            },
          ],
        ],
      });
      await ablo.entryDetails.list({ where: { entryId: 's-resize' } });

      let releaseExpand!: (value: Awaited<ReturnType<typeof queryClient.postQuery>>) => void;
      let markExpandStarted!: () => void;
      const expandStarted = new Promise<void>((resolve) => {
        markExpandStarted = resolve;
      });
      const delayedExpand = new Promise<Awaited<ReturnType<typeof queryClient.postQuery>>>(
        (resolve) => {
          releaseExpand = resolve;
        },
      );
      postQueryMock.mockImplementationOnce(() => {
        markExpandStarted();
        return delayedExpand;
      });

      const expanding = ablo.entries.list({
        where: { collectionId: 'd-resize' },
        expand: ['layers'],
      });
      await expandStarted;

      await ablo.entryDetails.update({
        id: 'l-resize',
        data: { position: resizedPosition },
      });
      expect(ablo.entryDetails.local.get('l-resize')?.position).toEqual(resizedPosition);

      releaseExpand({
        results: [
          [
            {
              __typename: 'Entry',
              id: 's-resize',
              collectionId: 'd-resize',
              layers: [
                {
                  __typename: 'EntryDetail',
                  id: 'l-resize',
                  entryId: 's-resize',
                  type: 'shape',
                  zIndex: 0,
                  position: initialPosition,
                  updatedAt: initialUpdatedAt,
                },
              ],
            },
          ],
        ],
      });
      await expanding;

      // The query started first, so its row is only an old server baseline.
      // The local optimistic position must remain visible while its commit is
      // being journaled/confirmed.
      expect(ablo.entryDetails.local.get('l-resize')?.position).toEqual(resizedPosition);
    } finally {
      await ablo.dispose();
    }
  });
});
