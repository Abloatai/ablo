/**
 * ConnectionManager — recovery after a WebSocket drop on a HEALTHY network.
 *
 * Reproduces the production incident (deck editor, 2026-06-16): a deck's
 * `SlideLayer` DELETE rolled back with `ws_not_ready (manual_close)` ~8.5s
 * after the socket dropped with code 1006, and the connection did not come
 * back on its own.
 *
 * Mechanism (the WHY):
 *  - Code 1006 is generated LOCALLY by the browser when the socket's TCP
 *    connection vanishes (server restart / LB idle-timeout / proxy drop). It
 *    is never sent over the wire and says NOTHING about NIC connectivity, so
 *    on a healthy machine the browser fires NO `online`/`offline` event and
 *    `navigator.onLine` stays `true`.
 *  - On the human path the FSM handled `WS_DISCONNECTED` by transitioning to
 *    `offline` and calling `onDisconnectWebSocket()` — which sets
 *    SyncWebSocket's `isManualClose=true`, cancelling the `scheduleReconnect`
 *    that `SyncWebSocket.onclose` had just queued (the "two recovery systems
 *    fight" documented in BaseSyncedStore.createConnectionManager).
 *  - `offline` has NO self-scheduled escape: it leaves only on a browser
 *    event (`online`/visibility) or a `MANUAL_RETRY`. With none of those
 *    arriving, the ONLY thing that revived it was the 30s watchdog — long
 *    after the MutationQueue burned through its 15 commit retries and
 *    rolled the DELETE back.
 *
 * Desired behavior (the fix these tests pin):
 *  - A socket drop (`WS_DISCONNECTED`) actively probes IMMEDIATELY — and
 *    still tears the dead socket down so SyncWebSocket's own reconnect stays
 *    suppressed (single reconnect authority on the human path).
 *  - Only a genuine OS-level `NETWORK_LOST` waits passively in `offline` for
 *    the `online` event — probing a downed NIC would just burn cycles.
 *
 * These are deterministic FSM-level tests: no real sockets, no real network,
 * `probeNetwork` mocked. That is the correct altitude to prove a transition
 * gap — a Playwright/browser repro would have to drop a socket WITHOUT taking
 * the OS network down (the very condition that produces no browser event),
 * which the harness can't fake faithfully; killing the network in a browser
 * fires `offline`, masking the bug.
 */

import { ConnectionManager, type ConnectionCallbacks } from '../../src/local/sync/ConnectionManager';
import { probeNetwork } from '@abloatai/transaction/transport/networkProbe';

// The probe moved into the settlement core with the transport (ADR 0016);
// mock the core module — the sync-engine path re-exports it, so both the
// manager's internal import and this test's import resolve to this mock.
jest.mock('@abloatai/transaction/transport/networkProbe', () => ({
  probeNetwork: jest.fn(async () => ({ outcome: 'reachable', latencyMs: 1 })),
}));

const mockedProbeNetwork = probeNetwork as jest.MockedFunction<typeof probeNetwork>;

function makeCallbacks(): ConnectionCallbacks {
  return {
    onReconnect: jest.fn(async () => 'success' as const),
    onSessionExpired: jest.fn(),
    onDisconnectWebSocket: jest.fn(),
    onStateChange: jest.fn(),
  };
}

/** Drain the async probe → reconnect hops (all mocked, resolve immediately). */
const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};

describe('ConnectionManager — recovery after a WS drop on a healthy network', () => {
  beforeEach(() => {
    mockedProbeNetwork.mockClear();
    mockedProbeNetwork.mockResolvedValue({ outcome: 'reachable', latencyMs: 1 });
  });

  it('actively probes and reconnects after WS_DISCONNECTED — no browser event needed', async () => {
    const cm = new ConnectionManager({ baseUrl: 'https://mesh.example.com' });
    const cbs = makeCallbacks();
    cm.start(cbs);
    expect(cm.state).toBe('connected');

    // The 1006 abnormal close on a healthy OS network: the ONLY event the
    // FSM ever sees (no online/offline, tab stays visible).
    cm.send({ type: 'WS_DISCONNECTED' });

    // The dead socket is torn down — this is what suppresses SyncWebSocket's
    // own scheduleReconnect, keeping the FSM the single reconnect authority.
    expect(cbs.onDisconnectWebSocket).toHaveBeenCalledTimes(1);

    // ...and recovery STARTS NOW, not 30s later via the watchdog.
    await flush();
    expect(mockedProbeNetwork).toHaveBeenCalledTimes(1);
    expect(cbs.onReconnect).toHaveBeenCalledTimes(1);
    expect(cm.state).toBe('connected');

    cm.dispose();
  });

  it('a genuine NETWORK_LOST still waits passively for the `online` event', async () => {
    const cm = new ConnectionManager({ baseUrl: 'https://mesh.example.com' });
    const cbs = makeCallbacks();
    cm.start(cbs);

    cm.send({ type: 'NETWORK_LOST' });
    expect(cm.state).toBe('offline');
    expect(cbs.onDisconnectWebSocket).toHaveBeenCalledTimes(1);

    // No probe while the NIC is down — that would only burn cycles.
    await flush();
    expect(mockedProbeNetwork).not.toHaveBeenCalled();
    expect(cm.state).toBe('offline');

    // When the network returns, recovery proceeds normally.
    cm.send({ type: 'NETWORK_ONLINE' });
    await flush();
    expect(mockedProbeNetwork).toHaveBeenCalledTimes(1);
    expect(cm.state).toBe('connected');

    cm.dispose();
  });

  it('a WS drop whose probe is unreachable backs off (does not reconnect-loop)', async () => {
    mockedProbeNetwork.mockResolvedValue({ outcome: 'unreachable', latencyMs: 1 });
    const cm = new ConnectionManager({ baseUrl: 'https://mesh.example.com' });
    const cbs = makeCallbacks();
    cm.start(cbs);

    cm.send({ type: 'WS_DISCONNECTED' });
    await flush();

    // probing_network → PROBE_FAILED → waiting_for_network (then backoff).
    expect(mockedProbeNetwork).toHaveBeenCalledTimes(1);
    expect(cbs.onReconnect).not.toHaveBeenCalled();
    expect(cm.state).toBe('waiting_for_network');

    cm.dispose();
  });
});
