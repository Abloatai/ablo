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

import { render, waitFor } from '@testing-library/react';
import { z } from 'zod';

import { AbloProvider } from '../../src/react/AbloProvider.js';
import { Ablo } from '../../src/Ablo.js';
import { defineSchema } from '@ablo/transaction/schema/schema';
import { model } from '@ablo/transaction/schema/model';

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
