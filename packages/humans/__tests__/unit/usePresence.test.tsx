/** @jest-environment jsdom */

import { act, renderHook, waitFor } from '@testing-library/react';
import { z } from 'zod';
import { Ablo } from '../../src/Ablo.js';
import { usePresence } from '../../src/react/usePresence.js';
import { createAbloReact } from '../../src/react/createAbloReact.js';
import type { ReactNode } from 'react';
import { defineSchema } from '@abloatai/transaction/schema/schema';
import { model } from '@abloatai/transaction/schema/model';

const schema = defineSchema({
  chats: model({ title: z.string() }, { typename: 'Chat' }),
});

describe('usePresence', () => {
  const clients: { dispose(): Promise<void> }[] = [];

  afterEach(async () => {
    await Promise.all(clients.splice(0).map((client) => client.dispose()));
  });

  it('binds a model record to the component lifecycle and updates reactively', async () => {
    const client = Ablo({
      schema,
      persistence: 'memory',
      baseURL: 'http://localhost:8080',
    });
    clients.push(client);
    jest.spyOn(client._ws, 'isConnected').mockReturnValue(true);
    const send = jest.spyOn(client._ws, 'sendPresenceCommand').mockImplementation(() => undefined);
    const enterScope = jest.spyOn(client._store, 'enterScope').mockResolvedValue(undefined);
    const leaveScope = jest.spyOn(client._store, 'leaveScope').mockResolvedValue(undefined);

    const { result, rerender, unmount } = renderHook(
      ({ id }: { id: string }) => usePresence(client.chats, id, { excludeSelf: true }),
      { initialProps: { id: 'chat-1' } },
    );

    expect(enterScope).toHaveBeenCalledWith({ chats: 'chat-1' });
    await waitFor(() => {
      expect(send).toHaveBeenCalledWith(expect.objectContaining({
        type: 'read.upsert',
        target: { model: 'Chat', id: 'chat-1' },
      }));
    });
    expect(result.current).toEqual([]);

    act(() => {
      client._ws.emit('presence_snapshot', {
        presenceSessionId: 'session-peer',
        participant: { id: 'user-peer', kind: 'user' },
        revision: 1,
        activities: [{
          id: 'read-peer',
          version: 1,
          operation: 'read',
          target: { model: 'Chat', id: 'chat-1' },
          source: 'session',
          startedAt: '2026-09-05T10:00:00.000Z',
          updatedAt: '2026-09-05T10:00:00.000Z',
          expiresAt: '2026-09-05T10:01:00.000Z',
        }],
        tombstones: [],
      });
    });

    act(() => {
      client._ws.emit('presence_session', { presenceSessionId: 'session-peer' });
    });
    expect(result.current).toEqual([]);
    act(() => {
      client._ws.emit('presence_session', { presenceSessionId: 'own-session' });
    });
    expect(result.current).toHaveLength(1);
    expect(result.current[0]?.participant.id).toBe('user-peer');

    rerender({ id: 'chat-2' });
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: 'read.remove' }));
    await waitFor(() => {
      expect(send).toHaveBeenCalledWith(expect.objectContaining({
        type: 'read.upsert',
        target: { model: 'Chat', id: 'chat-2' },
      }));
    });
    expect(result.current).toEqual([]);

    unmount();
    expect(leaveScope).toHaveBeenCalledWith({ chats: 'chat-2' });
    expect(send.mock.calls.at(-1)?.[0]).toEqual(expect.objectContaining({
      type: 'read.remove',
    }));
  });

  it('is schema-bound through createAbloReact and accepts a model selector', async () => {
    const client = Ablo({
      schema,
      persistence: 'memory',
      baseURL: 'http://localhost:8080',
    });
    clients.push(client);
    jest.spyOn(client, 'ready').mockResolvedValue(undefined);
    jest.spyOn(client._ws, 'isConnected').mockReturnValue(true);
    const send = jest.spyOn(client._ws, 'sendPresenceCommand').mockImplementation(() => undefined);
    jest.spyOn(client._store, 'enterScope').mockResolvedValue(undefined);
    const binding = createAbloReact(schema);
    const Wrapper = ({ children }: { children: ReactNode }) => (
      <binding.AbloProvider client={client} fallback="passthrough">
        {children}
      </binding.AbloProvider>
    );

    const { unmount } = renderHook(
      () => binding.usePresence((ablo) => ablo.chats, 'chat-1'),
      { wrapper: Wrapper },
    );

    await waitFor(() => {
      expect(send).toHaveBeenCalledWith(expect.objectContaining({
        type: 'read.upsert',
        target: { model: 'Chat', id: 'chat-1' },
      }));
    });
    unmount();
  });
});
