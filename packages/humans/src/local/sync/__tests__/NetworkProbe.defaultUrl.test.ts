/**
 * Pins the probe's DEFAULT target: no explicit baseUrl → the canonical hosted
 * endpoint — NOT the removed Go engine's `NEXT_PUBLIC_GO_SERVER_URL` and NOT
 * `http://localhost:8080` (the old fallbacks, which made a probe without a
 * baseUrl report a healthy production deployment as offline).
 */
import { probeNetwork } from '@ablo/transaction/transport/networkProbe';
import { ABLO_DEFAULT_BASE_URL } from '@ablo/transaction/auth/hostedEndpoints';

/** The response surface probeNetwork reads — status + auth-failure header. */
interface MinimalProbeResponse {
  status: number;
  headers: { get(name: string): string | null };
}

describe('probeNetwork default URL (post Go-engine removal)', () => {
  const seen: string[] = [];
  const originalFetch: unknown = globalThis.fetch;

  beforeEach(() => {
    seen.length = 0;
    const fetchMock = jest.fn(
      async (input: RequestInfo | URL): Promise<MinimalProbeResponse> => {
        seen.push(String(input));
        return { status: 204, headers: { get: () => null } };
      },
    );
    (globalThis as Record<string, unknown>).fetch = fetchMock;
  });

  afterEach(() => {
    (globalThis as Record<string, unknown>).fetch = originalFetch;
    delete process.env.NEXT_PUBLIC_GO_SERVER_URL;
  });

  it('probes the canonical hosted endpoint when no baseUrl is given', async () => {
    const result = await probeNetwork();
    expect(seen).toEqual([`${ABLO_DEFAULT_BASE_URL}/api/auth/check`]);
    expect(result.outcome).toBe('reachable');
  });

  it('ignores the removed Go engine env var entirely', async () => {
    process.env.NEXT_PUBLIC_GO_SERVER_URL = 'http://localhost:8080';
    await probeNetwork();
    expect(seen).toEqual([`${ABLO_DEFAULT_BASE_URL}/api/auth/check`]);
  });

  it('still honors an explicit baseUrl, normalizing ws→http and trailing slashes', async () => {
    await probeNetwork('wss://example.test:8443/');
    expect(seen).toEqual(['https://example.test:8443/api/auth/check']);
  });
});
