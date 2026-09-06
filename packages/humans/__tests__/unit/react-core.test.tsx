/** @jest-environment jsdom */
import { act, fireEvent, render, renderHook } from '@testing-library/react';
import { runInAction } from 'mobx';
import { z } from 'zod';
import { Ablo } from '../../src/Ablo.js';
import { createAbloReact } from '../../src/react/createAbloReact.js';
import { useAblo } from '../../src/react/useAblo.js';
import { defineSchema } from '@abloatai/transaction/schema/schema';
import { model } from '@abloatai/transaction/schema/model';
import { StrictMode, useState, type ReactNode } from 'react';

const schema = defineSchema({ chats: model({ title: z.string() }, { typename: 'Chat' }) });
const binding = createAbloReact(schema);

function setup() {
  const client = Ablo({ schema, persistence: 'memory', baseURL: 'http://localhost:8080' });
  jest.spyOn(client, 'ready').mockImplementation(() => new Promise(() => { /* Keep startup pending while exercising local status. */ }));
  const wrapper = ({ children }: { children: ReactNode }) => (
    <binding.AbloProvider client={client} fallback="passthrough">{children}</binding.AbloProvider>
  );
  return { client, wrapper };
}

describe('React reads the core client', () => {
  it('keeps child state when schema bindings are recreated', async () => {
    const { client } = setup();
    const first = createAbloReact(schema);
    const second = createAbloReact(schema);
    function Counter() {
      const [count, setCount] = useState(0);
      return <button onClick={() => { setCount(count + 1); }}>{count}</button>;
    }
    const view = render(<StrictMode><first.AbloProvider client={client} fallback="passthrough"><Counter /></first.AbloProvider></StrictMode>);
    fireEvent.click(view.getByRole('button'));
    expect(view.getByRole('button').textContent).toBe('1');
    view.rerender(<StrictMode><second.AbloProvider client={client} fallback="passthrough"><Counter /></second.AbloProvider></StrictMode>);
    expect(view.getByRole('button').textContent).toBe('1');
    view.unmount();
    await client.dispose();
  });

  it('shares status, progress, pending changes and auth state with bound and unbound selectors', async () => {
    const { client, wrapper } = setup();
    const { result, unmount } = renderHook(() => ({
      bound: binding.useAblo(ablo => ablo.status),
      unbound: useAblo(ablo => ablo.status),
    }), { wrapper });
    const expectShared = () => {
      expect(result.current.bound).toEqual(client.status);
      expect(result.current.unbound).toEqual(client.status);
    };
    expectShared();
    act(() => { runInAction(() => { client._store.syncStatus.progress = 42; }); });
    expect(result.current.bound).toEqual({ name: 'connecting', progress: 42 });
    expectShared();
    act(() => { runInAction(() => { client._store.syncStatus.progress = 100; client._store.syncStatus.pendingChanges = 1; }); });
    expect(result.current.bound).toEqual({ name: 'connected', hasUnsyncedChanges: true });
    expectShared();
    act(() => { runInAction(() => { client._store.syncStatus.pendingChanges = 0; }); });
    expect(result.current.bound).toEqual({ name: 'connected', hasUnsyncedChanges: false });
    expectShared();
    act(() => { runInAction(() => { client._store.syncStatus.state = 'offline'; }); });
    expect(result.current.bound).toEqual({ name: 'disconnected', reason: 'offline' });
    expectShared();
    act(() => { runInAction(() => { client._store.syncStatus.isSessionError = true; }); });
    expect(result.current.bound).toEqual({ name: 'needs-auth' });
    expectShared();
    unmount();
    await client.dispose();
  });
});
