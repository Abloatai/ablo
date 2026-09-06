/**
 * @jest-environment jsdom
 *
 * `AbloProvider` is now a REACTIVE binding over a prebuilt `client` (instance-only,
 * the Stripe `<Elements stripe={...}>` model). Auth + the credential lifecycle —
 * first mint, refresh, wake/online/focus re-mint, throw=transient / null=terminal —
 * live in the CLIENT now (`Ablo({ getToken })` + `BaseSyncedStore`), NOT the
 * provider. The offline-logout regressions those rules guard against are covered
 * at the client layer (NetworkProbe.recovery, ConnectionManager.credentialRefresh).
 *
 * What remains the PROVIDER's job, pinned here:
 *   1. drive `client.ready()` on mount,
 *   2. forward the client's completed terminal-session transition, and
 *   3. NOT dispose a consumer-owned client on unmount.
 */

import { useEffect } from 'react';
import { runInAction } from 'mobx';
import { useSyncStatus } from '../../src/react/useSyncStatus.js';
import { act, render, waitFor } from '@testing-library/react';
import { z } from 'zod';

import { AbloProvider } from '../../src/react/AbloProvider.js';
import { Ablo } from '../../src/Ablo.js';
import { defineSchema } from '@abloatai/transaction/schema/schema';
import { model } from '@abloatai/transaction/schema/model';

const schema = defineSchema({
  chats: model({ title: z.string() }, { typename: 'Chat' }),
});

/**
 * A REAL `Ablo` client (no mock object, no cast) — `persistence: 'memory'` and
 * no auth resolver make construction inert (no IndexedDB, no timers, no connect).
 * We `jest.spyOn` only the connecting methods so the unit test never touches the
 * network. `spyOn` preserves the real types, so the client stays a genuine
 * `Ablo<…>` the way an app would pass it.
 */
function makeClient() {
  const client = Ablo({ schema, persistence: 'memory', baseURL: 'http://localhost:8080' });
  jest.spyOn(client, 'ready').mockResolvedValue(undefined);
  jest.spyOn(client, 'purge').mockResolvedValue(undefined);
  jest.spyOn(client, 'dispose').mockResolvedValue(undefined);

  let sessionCb: ((err: Error) => void | Promise<void>) | null = null;
  jest.spyOn(client, 'onSessionError').mockImplementation((cb) => {
    sessionCb = cb;
    return () => {
      sessionCb = null;
    };
  });

  return { client, emitSessionError: (err: Error) => sessionCb?.(err) };
}

describe('AbloProvider — reactive binding over a prebuilt client', () => {
  it('drives client.ready() on mount', async () => {
    const { client } = makeClient();
    render(
      <AbloProvider client={client} fallback="passthrough">
        <div>child</div>
      </AbloProvider>,
    );
    await waitFor(() => { expect(client.ready).toHaveBeenCalledTimes(1); });
  });

  it('forwards a completed client session error → onSessionExpired', async () => {
    const { client, emitSessionError } = makeClient();
    const onError = jest.fn();
    const onSessionExpired = jest.fn();

    render(
      <AbloProvider
        client={client}
        onError={onError}
        onSessionExpired={onSessionExpired}
        fallback="passthrough"
      >
        <div>child</div>
      </AbloProvider>,
    );

    await waitFor(() => { expect(client.onSessionError).toHaveBeenCalled(); });
    await emitSessionError(new Error('session rejected by server'));

    await waitFor(() => { expect(onSessionExpired).toHaveBeenCalledTimes(1); });
    // Cleanup is client-owned and has already completed before this event.
    expect(client.purge).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalled();
  });

  it('does NOT dispose the client on unmount (the consumer owns its lifecycle)', async () => {
    const { client } = makeClient();
    const { unmount } = render(
      <AbloProvider client={client} fallback="passthrough">
        <div>child</div>
      </AbloProvider>,
    );
    await waitFor(() => { expect(client.ready).toHaveBeenCalled(); });
    unmount();
    expect(client.dispose).not.toHaveBeenCalled();
  });
});

// Status must be usable before identity resolves, including a custom fallback.
describe('AbloProvider startup status', () => {
  function Status() {
    const status = useSyncStatus();
    return <span data-testid="status">{status.name}</span>;
  }

  it('renders status in passthrough and preserves child state across readiness', async () => {
    const { client } = makeClient();
    let ready!: () => void;
    jest.spyOn(client, 'ready').mockImplementation(() => new Promise<void>((resolve) => { ready = resolve; }));
    let mounts = 0;
    function Workspace() {
      useEffect(() => { mounts++; }, []);
      return <Status />;
    }
    const view = render(<AbloProvider client={client} fallback="passthrough"><Workspace /></AbloProvider>);
    expect(view.getByTestId('status')).toBeTruthy();
    jest.spyOn(client._store, 'orgId', 'get').mockReturnValue('account-a');
    await act(async () => { ready(); await Promise.resolve(); });
    expect(mounts).toBe(1);
    act(() => { runInAction(() => { client._store.syncStatus.state = 'reconnecting'; }); });
    expect(view.getByTestId('status').textContent).toBe('reconnecting');
  });

  it('subscribes to a replacement client even when its initial status is identical', () => {
    const first = makeClient().client;
    const second = makeClient().client;
    jest.spyOn(first, 'ready').mockImplementation(() => new Promise(() => { /* Keep identity unresolved for this render. */ }));
    jest.spyOn(second, 'ready').mockImplementation(() => new Promise(() => { /* Keep identity unresolved for this render. */ }));
    const view = render(<AbloProvider client={first} fallback="passthrough"><Status /></AbloProvider>);
    view.rerender(<AbloProvider client={second} fallback="passthrough"><Status /></AbloProvider>);
    act(() => { runInAction(() => { second._store.syncStatus.state = 'reconnecting'; }); });
    expect(view.getByTestId('status').textContent).toBe('reconnecting');
    act(() => { runInAction(() => { first._store.syncStatus.state = 'offline'; }); });
    expect(view.getByTestId('status').textContent).toBe('reconnecting');
  });

  it('supports a status indicator in the initial fallback', () => {
    const { client } = makeClient();
    jest.spyOn(client, 'ready').mockImplementation(() => new Promise(() => { /* Keep identity unresolved for this render. */ }));
    const view = render(<AbloProvider client={client} fallback={<Status />}><div>workspace</div></AbloProvider>);
    expect(view.getByTestId('status')).toBeTruthy();
  });

  it('does not reuse the previous client scope while switching accounts', async () => {
    const first = makeClient().client;
    const second = makeClient().client;
    jest.spyOn(first._store, 'orgId', 'get').mockReturnValue('account-a');
    jest.spyOn(second, 'ready').mockImplementation(() => new Promise(() => { /* Keep identity unresolved for this render. */ }));
    const view = render(<AbloProvider client={first}><div>private workspace</div></AbloProvider>);
    await act(async () => { await Promise.resolve(); });
    view.rerender(<AbloProvider client={second} fallback={<Status />}><div>private workspace</div></AbloProvider>);
    expect(view.queryByText('private workspace')).toBeNull();
    expect(view.getByTestId('status')).toBeTruthy();
  });
});
