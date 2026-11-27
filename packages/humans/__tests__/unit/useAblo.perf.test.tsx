/** @jest-environment jsdom */
import { act, renderHook } from '@testing-library/react';
import { runInAction } from 'mobx';
import { z } from 'zod';
import type { ReactNode } from 'react';
import { Ablo } from '../../src/Ablo.js';
import { createAbloReact } from '../../src/react/createAbloReact.js';
import { defineSchema } from '@abloatai/transaction/schema/schema';
import { model } from '@abloatai/transaction/schema/model';

const schema = defineSchema({
  chats: model({ title: z.string(), meta: z.object({ tag: z.string() }).optional() }, {
    typename: 'PerfChat',
  }),
});
const { AbloProvider, useAblo } = createAbloReact(schema);
const clients: Ablo<(typeof schema)['models']>[] = [];

function setup() {
  const client = Ablo({ schema, persistence: 'memory', baseURL: 'http://localhost:8080' });
  clients.push(client);
  jest.spyOn(client, 'ready').mockImplementation(() => new Promise(() => { /* Keep bootstrap pending. */ }));
  const wrapper = ({ children }: { children: ReactNode }) => (
    <AbloProvider client={client} fallback="passthrough">{children}</AbloProvider>
  );
  return { client, wrapper };
}

function addRows(client: Ablo<(typeof schema)['models']>, count: number) {
  runInAction(() => {
    const batch = [];
    for (let i = 0; i < count; i++) {
      const row = client._pool.create('PerfChat', {
        id: `chat-${i}`,
        title: `Chat ${i}`,
        meta: { tag: `t-${i}` },
      });
      if (row) batch.push(row);
    }
    client._pool.addBatch(batch);
  });
}

afterEach(async () => {
  jest.restoreAllMocks();
  await Promise.all(clients.splice(0).map((c) => c.dispose()));
});

describe('React snapshot caching, claim isolation, and batched hydration (CS12/CS13)', () => {
  it('CS12: updating 1 model in a 300-row list preserves reference identity of the 299 unchanged snapshots and freezes O(1) objects', () => {
    const { client, wrapper } = setup();
    addRows(client, 300);

    const select = (ablo: Parameters<Parameters<typeof useAblo>[0]>[0]) => ablo.chats.local.list();
    const { result } = renderHook(() => useAblo(select), { wrapper });
    expect(result.current).toHaveLength(300);

    // First mutation establishes the observed reaction's baseline snapshot.
    act(() => {
      runInAction(() => {
        client.chats.local.get('chat-41')!.title = 'Renamed 41';
      });
    });
    const before = result.current!;

    const freezeSpy = jest.spyOn(Object, 'freeze');
    const target = client.chats.local.get('chat-42')!;
    act(() => {
      runInAction(() => {
        target.title = 'Renamed 42';
      });
    });

    const after = result.current!;
    expect(after).toHaveLength(300);
    // Unchanged rows keep exact object identity (structural sharing).
    let preserved = 0;
    for (let i = 0; i < 300; i++) {
      if (before[i] === after[i]) preserved++;
    }
    expect(preserved).toBe(299);
    expect(after.find((r) => r.id === 'chat-42')?.title).toBe('Renamed 42');
    // Freeze count scales with the 1 changed model + 1 outer array, NOT with all 300 rows.
    expect(freezeSpy.mock.calls.length).toBeLessThan(20);
  });

  it('CS13: unrelated claim updates do not recompute selector-only useAblo hooks that never read claims', () => {
    const { client, wrapper } = setup();
    addRows(client, 5);

    const select = jest.fn((ablo: Parameters<Parameters<typeof useAblo>[0]>[0]) =>
      ablo.chats.local.get('chat-0')?.title,
    );
    const { result } = renderHook(() => useAblo(select), { wrapper });
    expect(result.current).toBe('Chat 0');
    const callsBefore = select.mock.calls.length;

    act(() => {
      client._ws.emit('presence_snapshot', {
        presenceSessionId: 'agent-session',
        participant: { id: 'agent-1', kind: 'agent' },
        revision: 1,
        activities: [{
          id: 'claim:lease-99',
          version: 1,
          operation: 'claim',
          source: 'claim',
          target: { model: 'PerfChat', id: 'chat-1' },
          startedAt: '2026-09-06T10:00:00.000Z',
          updatedAt: '2026-09-06T10:00:00.000Z',
          expiresAt: '2026-09-06T10:01:00.000Z',
        }],
        tombstones: [],
      });
    });

    expect(select).toHaveBeenCalledTimes(callsBefore);
  });

  it('batches bulk OnDemandLoader hydration into a single MobX reaction flush', async () => {
    const { client, wrapper } = setup();
    addRows(client, 100);

    const select = jest.fn((ablo: Parameters<Parameters<typeof useAblo>[0]>[0]) =>
      ablo.chats.local.list().map((r) => r.title),
    );
    renderHook(() => useAblo(select), { wrapper });
    const callsBefore = select.mock.calls.length;

    // Mock /sync/query returning updated versions of all 100 existing rows.
    const updatedRows = Array.from({ length: 100 }, (_, i) => ({
      __typename: 'PerfChat',
      id: `chat-${i}`,
      title: `Updated ${i}`,
    }));
    const originalFetch = globalThis.fetch;
    globalThis.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: () => Promise.resolve({ results: [updatedRows] }),
      clone() { return this; },
    } as unknown as Response);

    try {
      await act(async () => {
        await client.chats.list({ type: 'complete' });
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    // Without runInAction batching, updating 100 existing rows fired the selector 100+ times.
    expect(select.mock.calls.length - callsBefore).toBeLessThanOrEqual(2);
  });
});
