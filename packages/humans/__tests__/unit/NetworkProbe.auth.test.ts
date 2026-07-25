/**
 * NetworkProbe auth threading — visibility/network probes must authenticate the
 * same way bootstrap, identity resolve, and WebSocket reconnects do.
 */

import { probeNetwork } from '@abloatai/transaction/transport/networkProbe';

describe('NetworkProbe — bearer auth', () => {
  let originalFetch: typeof globalThis.fetch;
  let lastInit: RequestInit | undefined;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    lastInit = undefined;
    globalThis.fetch = jest.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      lastInit = init;
      return {
        status: 204,
        headers: { get: () => null },
      } as unknown as Response;
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('attaches Authorization when authToken is provided', async () => {
    const result = await probeNetwork({
      baseUrl: 'https://mesh.example.com',
      getAuthToken: () => 'ek_test_probe',
    });

    const headers = lastInit?.headers as Record<string, string>;
    expect(result).toEqual({
      outcome: 'reachable',
      latencyMs: expect.any(Number),
    });
    expect(lastInit?.method).toBe('HEAD');
    // Bearer-only: the probe authenticates with the `ek_`/`rk_` Bearer, not
    // cookies. The bearer-only CORS cutover removed `credentials: 'include'`
    // from SDK sync-server fetches (the bearer is the boundary), so the probe
    // does not send cookies.
    expect(lastInit?.credentials).toBeUndefined();
    expect(headers.Authorization).toBe('Bearer ek_test_probe');
    expect(headers['Cache-Control']).toBe('no-cache');
  });

  it('sends no Authorization header when no token is provided', async () => {
    await probeNetwork('https://mesh.example.com');

    const headers = lastInit?.headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
    // Bearer-only: no token ⇒ no Authorization and no cookies either.
    expect(lastInit?.credentials).toBeUndefined();
  });
});
