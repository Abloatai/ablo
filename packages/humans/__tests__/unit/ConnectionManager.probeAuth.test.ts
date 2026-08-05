/**
 * ConnectionManager probe auth — browser visibility/network probes must use the
 * latest live credential, not a construction-time token or cookie-only fallback.
 */

import { ConnectionManager } from '../../src/local/sync/ConnectionManager';
import type { ConnectionCallbacks } from '../../src/local/sync/ConnectionManager';
import { probeNetwork } from '@abloatai/transaction/transport/networkProbe';

// The probe moved into the confirmation core with the transport (ADR 0016);
// mock the core module — the sync-engine path re-exports it, so both the
// manager's internal import and this test's import resolve to this mock.
jest.mock('@abloatai/transaction/transport/networkProbe', () => ({
  probeNetwork: jest.fn(async () => ({
    outcome: 'reachable',
    latencyMs: 1,
  })),
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
