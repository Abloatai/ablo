/**
 * ConnectionManager — `refreshing_credential` (the wake-from-sleep fix).
 *
 * When a probe reports the short-lived access key stale (`credential_stale` →
 * `PROBE_CREDENTIAL_STALE`), the FSM must RE-MINT the key and re-probe — NOT
 * sign the user out and NOT wedge in `auth_blocked`. Only a re-mint that fails
 * because the long-lived login itself is gone (`session_error`) reaches
 * `session_expired`; a transient mint failure backs off. A freshly-minted
 * credential pushed in from outside (`CREDENTIAL_REFRESHED`, e.g. on OS wake)
 * pulls a parked connection back into a re-probe.
 *
 * Before this state, an expired `ek_` produced `auth_blocked` and the
 * connection stuck (then the watchdog hard-reloaded ~3min later) — the literal
 * "logged out after the laptop slept" symptom.
 */

import { ConnectionManager } from '../../src/local/sync/ConnectionManager';
import type { ConnectionCallbacks } from '../../src/local/sync/ConnectionManager';

// Keep the post-refresh re-probe off the network. 'unreachable' → PROBE_FAILED
// → waiting_for_network, a deterministic resting state we don't assert on.
// The probe moved into the confirmation core with the transport (ADR 0016);
// mock the core module — the sync-engine path re-exports it, so both the
// manager's internal import and this test's import resolve to this mock.
jest.mock('@abloatai/transaction/transport/networkProbe', () => ({
  probeNetwork: jest.fn(async () => ({ outcome: 'unreachable', latencyMs: null })),
}));

const flush = () => new Promise((r) => setTimeout(r, 0));

function makeManager(refreshResult?: 'refreshed' | 'session_error' | 'network_error') {
  const callbacks = {
    onReconnect: jest.fn(async () => 'success' as const),
    onRefreshCredential: jest.fn(async () => refreshResult ?? ('refreshed' as const)),
    onSessionExpired: jest.fn(),
    onDisconnectWebSocket: jest.fn(),
    onStateChange: jest.fn(),
  };
  const cm = new ConnectionManager({ baseUrl: 'http://localhost:8080' });
  cm.start(callbacks);
  return { cm, callbacks };
}

describe('ConnectionManager — refreshing_credential', () => {
  it('PROBE_CREDENTIAL_STALE routes to refreshing_credential (not auth_blocked, not session_expired)', () => {
    const { cm, callbacks } = makeManager();
    cm.state = 'probing_network';

    cm.send({ type: 'PROBE_CREDENTIAL_STALE' });

    expect(cm.state).toBe('refreshing_credential');
    expect(callbacks.onSessionExpired).not.toHaveBeenCalled();
    cm.dispose();
  });

  it('a successful re-mint re-probes (CREDENTIAL_REFRESHED) and NEVER signs out', async () => {
    const { cm, callbacks } = makeManager('refreshed');
    cm.state = 'probing_network';

    cm.send({ type: 'PROBE_CREDENTIAL_STALE' });
    await flush();

    expect(callbacks.onRefreshCredential).toHaveBeenCalledTimes(1);
    expect(callbacks.onSessionExpired).not.toHaveBeenCalled();
    // After re-mint we re-probe; the mocked probe is unreachable so we settle
    // in waiting_for_network — the point is we left refreshing_credential via a
    // re-probe, not a sign-out.
    expect(cm.state).not.toBe('session_expired');
    expect(cm.state).not.toBe('auth_blocked');
    cm.dispose();
  });

  it('a re-mint that finds the login gone (session_error) is the ONLY path to sign-out', async () => {
    const { cm, callbacks } = makeManager('session_error');
    cm.state = 'probing_network';

    cm.send({ type: 'PROBE_CREDENTIAL_STALE' });
    await flush();

    expect(cm.state).toBe('session_expired');
    expect(callbacks.onSessionExpired).toHaveBeenCalledTimes(1);
    cm.dispose();
  });

  it('a transient re-mint failure (network_error) backs off — never signs out', async () => {
    const { cm, callbacks } = makeManager('network_error');
    cm.state = 'probing_network';

    cm.send({ type: 'PROBE_CREDENTIAL_STALE' });
    await flush();

    expect(cm.state).toBe('backoff');
    expect(callbacks.onSessionExpired).not.toHaveBeenCalled();
    cm.dispose();
  });

  it('an external CREDENTIAL_REFRESHED nudge re-probes from a parked state', () => {
    for (const parked of ['offline', 'backoff', 'auth_blocked', 'waiting_for_network'] as const) {
      const { cm } = makeManager();
      cm.state = parked;
      cm.send({ type: 'CREDENTIAL_REFRESHED' });
      expect(cm.state).toBe('probing_network');
      cm.dispose();
    }
  });

  it('CREDENTIAL_REFRESHED is a no-op while connected (does not disturb a healthy connection)', () => {
    const { cm } = makeManager();
    cm.state = 'connected';
    cm.send({ type: 'CREDENTIAL_REFRESHED' });
    expect(cm.state).toBe('connected');
    cm.dispose();
  });

  it('with NO refresher wired, a stale-key probe re-probes instead of looping or signing out', async () => {
    const callbacks = {
      onReconnect: jest.fn(async () => 'success' as const),
      // onRefreshCredential intentionally omitted (e.g. a static apiKey deploy)
      onSessionExpired: jest.fn(),
      onDisconnectWebSocket: jest.fn(),
      onStateChange: jest.fn(),
    };
    const cm = new ConnectionManager({ baseUrl: 'http://localhost:8080' });
    cm.start(callbacks);
    cm.state = 'probing_network';

    cm.send({ type: 'PROBE_CREDENTIAL_STALE' });
    await flush();

    expect(callbacks.onSessionExpired).not.toHaveBeenCalled();
    expect(cm.state).not.toBe('session_expired');
    cm.dispose();
  });
});
