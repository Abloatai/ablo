/**
 * NetworkProbe outcome routing — the probe maps an `/api/auth/check` response
 * into a single {@link ProbeOutcome} via the recovery taxonomy. The headline
 * behaviour the wake-from-sleep fix depends on: an expired ephemeral key
 * (`X-Auth-Failure: apikey_expired`) yields `credential_stale` (→ re-mint),
 * NOT `auth_blocked` (the old, wedging behaviour) and NOT `session_expired`
 * (sign-out).
 */

import { probeNetwork } from '@abloatai/transaction/transport/networkProbe';

interface FetchResponse {
  status: number;
  headers: { get: (k: string) => string | null };
}

function mockFetchOnce(res: FetchResponse): void {
  globalThis.fetch = jest.fn(async () => res as unknown as Response);
}

function withAuthFailure(status: number, code: string | null): FetchResponse {
  return {
    status,
    headers: { get: (k: string) => (k.toLowerCase() === 'x-auth-failure' ? code : null) },
  };
}

describe('probeNetwork — outcome routing', () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const probe = () =>
    probeNetwork({ baseUrl: 'https://mesh.example.com', getAuthToken: () => 'ek_x' });

  it('204 → reachable', async () => {
    mockFetchOnce({ status: 204, headers: { get: () => null } });
    expect((await probe()).outcome).toBe('reachable');
  });

  it('expired ephemeral key (apikey_expired) → credential_stale (re-mint, NOT sign-out / NOT auth_blocked)', async () => {
    mockFetchOnce(withAuthFailure(401, 'apikey_expired'));
    expect((await probe()).outcome).toBe('credential_stale');
  });

  it('genuine login expiry (session_expired) → session_expired', async () => {
    mockFetchOnce(withAuthFailure(401, 'session_expired'));
    expect((await probe()).outcome).toBe('session_expired');
  });

  it('bare 401 with no READABLE code → credential_stale (re-mint, NOT sign-out)', async () => {
    // A bare 401 is ambiguous: most often it's an `apikey_expired` whose
    // `X-Auth-Failure` header was stripped cross-origin (not exposed via CORS),
    // i.e. the network-change logout bug. It must attempt a re-mint, never sign
    // out directly — only a re-mint resolving null is terminal.
    mockFetchOnce(withAuthFailure(401, null));
    expect((await probe()).outcome).toBe('credential_stale');
  });

  it('credential-type rejection (api_key_required) → auth_blocked', async () => {
    mockFetchOnce(withAuthFailure(401, 'api_key_required'));
    expect((await probe()).outcome).toBe('auth_blocked');
  });

  it('403 permission denial (forbidden) → auth_blocked (stop, do not sign out)', async () => {
    mockFetchOnce(withAuthFailure(403, 'forbidden'));
    expect((await probe()).outcome).toBe('auth_blocked');
  });

  it('unknown auth-tagged code → auth_blocked (do not loop, do not sign out)', async () => {
    mockFetchOnce(withAuthFailure(401, 'some_new_server_code'));
    expect((await probe()).outcome).toBe('auth_blocked');
  });

  it('network throw → unreachable', async () => {
    globalThis.fetch = jest.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    expect((await probe()).outcome).toBe('unreachable');
  });
});
