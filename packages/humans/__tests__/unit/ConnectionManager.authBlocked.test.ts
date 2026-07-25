/**
 * ConnectionManager — `auth_blocked` terminal.
 *
 * Background: a reachable-but-non-retryable, non-expiry auth failure
 * (e.g. `api_key_required` / `jwt_issuer_untrusted` from the data plane)
 * is NEITHER a session expiry (don't sign out — the session is fine) NOR
 * transient (don't reconnect-loop — re-auth/retry won't help). Before this
 * state, such a probe result returned `sessionValid: true` and the FSM
 * looped through `reconnecting`, hammering the server.
 *
 * This pins: PROBE_AUTH_BLOCKED → `auth_blocked`, which drops the socket
 * WITHOUT calling onSessionExpired and WITHOUT reconnecting; a stray
 * disconnect can't pull it back into reconnect; a genuine session error
 * still expires.
 */

import { ConnectionManager } from '../../src/local/sync/ConnectionManager';
import type { ConnectionCallbacks } from '../../src/local/sync/ConnectionManager';

function makeManager(): {
  cm: ConnectionManager;
  callbacks: {
    onReconnect: jest.Mock;
    onSessionExpired: jest.Mock;
    onDisconnectWebSocket: jest.Mock;
    onStateChange: jest.Mock;
  };
} {
  const callbacks = {
    onReconnect: jest.fn(async () => 'success' as const),
    onSessionExpired: jest.fn(),
    onDisconnectWebSocket: jest.fn(),
    onStateChange: jest.fn(),
  };
  const cm = new ConnectionManager({ baseUrl: 'http://localhost:8080' });
  cm.start(callbacks);
  return { cm, callbacks };
}

describe('ConnectionManager — auth_blocked (non-retryable, non-expiry)', () => {
  it('PROBE_AUTH_BLOCKED → auth_blocked: drops socket, no sign-out, no reconnect', () => {
    const { cm, callbacks } = makeManager();
    cm.state = 'probing_network';

    cm.send({ type: 'PROBE_AUTH_BLOCKED' });

    expect(cm.state).toBe('auth_blocked');
    expect(callbacks.onDisconnectWebSocket).toHaveBeenCalled();
    expect(callbacks.onSessionExpired).not.toHaveBeenCalled();
    expect(callbacks.onReconnect).not.toHaveBeenCalled();
    cm.dispose();
  });

  it('a stray WS_DISCONNECTED does NOT pull auth_blocked into reconnect', () => {
    const { cm, callbacks } = makeManager();
    cm.state = 'auth_blocked';

    cm.send({ type: 'WS_DISCONNECTED' });

    expect(cm.state).toBe('auth_blocked');
    expect(callbacks.onReconnect).not.toHaveBeenCalled();
    cm.dispose();
  });

  it('a genuine WS_SESSION_ERROR still expires the session from auth_blocked', () => {
    const { cm, callbacks } = makeManager();
    cm.state = 'auth_blocked';

    cm.send({ type: 'WS_SESSION_ERROR' });

    expect(cm.state).toBe('session_expired');
    expect(callbacks.onSessionExpired).toHaveBeenCalled();
    cm.dispose();
  });
});
