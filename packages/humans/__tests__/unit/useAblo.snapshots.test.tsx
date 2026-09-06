/** @jest-environment jsdom */
import { act, renderHook } from '@testing-library/react';
import { renderToString } from 'react-dom/server';
import { hydrateRoot } from 'react-dom/client';
import { observable, runInAction } from 'mobx';
import { z } from 'zod';
import type { ReactNode } from 'react';
import { Ablo } from '../../src/Ablo.js';
import { createAbloReact } from '../../src/react/createAbloReact.js';
import { defineSchema } from '@abloatai/transaction/schema/schema';
import { model } from '@abloatai/transaction/schema/model';

const suffix = observable({ value: '!' });
const schema = defineSchema({
  chats: model({ title: z.string(), metadata: z.object({ color: z.string() }).optional() }, {
    typename: 'SnapshotChat',
    computed: { label: (row: { title: string }) => row.title + suffix.value },
  }),
});
const { AbloProvider, useAblo } = createAbloReact(schema);
const clients: Ablo<(typeof schema)['models']>[] = [];
function setup() {
  const client = Ablo({ schema, persistence: 'memory', baseURL: 'http://localhost:8080' });
  clients.push(client);
  jest.spyOn(client, 'ready').mockImplementation(() => new Promise(() => { /* Keep bootstrap pending. */ }));
  const wrapper = ({ children }: { children: ReactNode }) => <AbloProvider client={client} fallback="passthrough">{children}</AbloProvider>;
  return { client, wrapper };
}
function addRow(client: Ablo<(typeof schema)['models']>, data: Record<string, unknown>) {
  const row = client._pool.create('SnapshotChat', data);
  if (!row) throw new Error('SnapshotChat construction failed');
  client._pool.add(row);
}
afterEach(async () => { await Promise.all(clients.splice(0).map(client => client.dispose())); });

it('snapshots rows nested in objects and preserves computed fields and unchanged values', () => {
  const { client, wrapper } = setup();
  addRow(client, { id: 'one', title: 'Before', metadata: { color: 'blue' } });
  const { result, rerender } = renderHook(() => useAblo(ablo => ({ row: ablo.chats.local.get('one') })), { wrapper });
  const first = result.current;
  expect(first?.row?.title).toBe('Before');
  expect(first?.row?.label).toBe('Before!');
  expect(Object.keys(first?.row ?? {})).not.toContain('label');
  rerender();
  expect(result.current).toBe(first);
  act(() => { runInAction(() => { suffix.value = '?'; }); });
  expect(result.current?.row?.label).toBe('Before?');
  expect(first?.row?.label).toBe('Before!');
  const row = client.chats.local.get('one');
  if (!row) throw new Error('Expected local row');
  act(() => { runInAction(() => { row.title = 'After'; }); });
  expect(result.current?.row?.title).toBe('After');
  expect(first?.row?.title).toBe('Before');
  expect(Object.isFrozen(result.current?.row?.metadata)).toBe(true);
});

it('does not restore an initial row after local data has arrived and been removed', () => {
  const { client, wrapper } = setup();
  const initial = { id: 'one', title: 'Server', label: 'Server!' };
  const { result } = renderHook(() => useAblo(ablo => ablo.chats, 'one', { initial }), { wrapper });
  expect(result.current.data?.title).toBe('Server');
  act(() => { addRow(client, { id: 'one', title: 'Local' }); });
  expect(result.current.data?.title).toBe('Local');
  act(() => { client._pool.remove('one'); });
  expect(result.current.data).toBeUndefined();
});

it('hydrates the supplied server row before showing fresher local data', async () => {
  const { client } = setup();
  const initial = { id: 'one', title: 'Server', label: 'Server!' };
  function View() {
    const { data } = useAblo(ablo => ablo.chats, 'one', { initial });
    return <span>{data?.title ?? 'No local row'}</span>;
  }
  const app = <AbloProvider client={client} fallback="passthrough"><View /></AbloProvider>;
  const container = document.createElement('div');
  container.innerHTML = renderToString(app);
  expect(container.textContent).toBe('Server');
  addRow(client, { id: 'one', title: 'Newer local value' });
  const onRecoverableError = jest.fn();
  let root: ReturnType<typeof hydrateRoot> | undefined;
  await act(async () => {
    root = hydrateRoot(container, app, { onRecoverableError });
    await Promise.resolve(); // Flush hydration work before checking the browser snapshot.
  });
  expect(onRecoverableError).not.toHaveBeenCalled();
  expect(container.textContent).toBe('Newer local value');
  act(() => { root?.unmount(); });
});

it('keeps selected model handles usable by other core operations', () => {
  const { client, wrapper } = setup();
  const { result } = renderHook(() => useAblo(ablo => ablo.chats), { wrapper });
  expect(result.current).toBe(client.chats);
});

it('updates ownership selected through the core claim state', () => {
  const { client, wrapper } = setup();
  const { result } = renderHook(() => useAblo(ablo => ablo.chats.claim.state({ id: 'one' })), { wrapper });
  expect(result.current).toBeNull();
  act(() => { client._ws.emit('presence_snapshot', {
    presenceSessionId: 'agent-session', participant: { id: 'agent-1', kind: 'agent' }, revision: 1,
    activities: [{
      id: 'claim:lease-1', version: 1, operation: 'claim', source: 'claim',
      target: { model: 'SnapshotChat', id: 'one' },
      startedAt: '2026-09-06T10:00:00.000Z', updatedAt: '2026-09-06T10:00:00.000Z',
      expiresAt: '2026-09-06T10:01:00.000Z',
    }], tombstones: [],
  }); });
  expect(result.current?.id).toBe('lease-1');
  act(() => { client._ws.emit('disconnected', { code: 1006, reason: 'offline' }); });
  expect(result.current).toBeNull();
});
