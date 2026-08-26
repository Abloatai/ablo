/**
 * ConnectionManager probe auth — browser visibility/network probes must use the
 * latest live credential, not a construction-time token or cookie-only fallback.
 */

import { ConnectionManager } from '../../src/local/sync/ConnectionManager';
import type { ConnectionCallbacks } from '../../src/local/sync/ConnectionManager';
import type { probeNetwork } from '@abloatai/transaction/transport/connection';

// The probe is a sibling of ConnectionManager inside the core's
// `transport/connection` module (ADR 0016), so it cannot be substituted through
// the package boundary. Drive it through the declared `probe` option instead.
const mockedProbeNetwork: jest.MockedFunction<typeof probeNetwork> = jest.fn();

function makeCallbacks(): ConnectionCallbacks {
  return {
    onReconnect: jest.fn(async () => 'success' as const),
    onSessionExpired: jest.fn(),
    onDisconnectWebSocket: jest.fn(),
    onStateChange: jest.fn(),
  };
}

describe('ConnectionManager — authenticated probes', () => {
  beforeEach(() => {
    mockedProbeNetwork.mockClear();
    mockedProbeNetwork.mockResolvedValue({
      outcome: 'reachable',
      latencyMs: 1,
    });
  });

  it('passes the current auth token to probeNetwork', () => {
    let token: string | null = 'ek_initial';
    const cm = new ConnectionManager({
      baseUrl: 'https://mesh.example.com',
      getAuthToken: () => token,
      probe: mockedProbeNetwork,
    });
    cm.start(makeCallbacks());

    cm.send({ type: 'TAB_VISIBLE' });

    const firstCall = mockedProbeNetwork.mock.calls[0];
    if (!firstCall) throw new Error('expected probeNetwork to have been called');
    let args = firstCall[0] as {
      baseUrl?: string;
      getAuthToken?: () => string | null;
    };
    expect(args.baseUrl).toBe('https://mesh.example.com');
    expect(args.getAuthToken?.()).toBe('ek_initial');

    cm.state = 'connected';
    mockedProbeNetwork.mockClear();
    token = 'ek_refreshed';

    cm.send({ type: 'TAB_VISIBLE' });

    const refreshedCall = mockedProbeNetwork.mock.calls[0];
    if (!refreshedCall) throw new Error('expected probeNetwork to have been called after the token refresh');
    args = refreshedCall[0] as {
      baseUrl?: string;
      getAuthToken?: () => string | null;
    };
    expect(args.baseUrl).toBe('https://mesh.example.com');
    expect(args.getAuthToken?.()).toBe('ek_refreshed');

    cm.dispose();
  });
});
