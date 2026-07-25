import { BootstrapFetcher } from '../../src/local/sync/BootstrapFetcher';
import { createAuthCredentialSource } from '@abloatai/transaction/auth/credentialSource';

describe('BootstrapFetcher — shared auth source', () => {
  let originalFetch: typeof globalThis.fetch;
  let lastInit: RequestInit | undefined;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    lastInit = undefined;
    globalThis.fetch = jest.fn((_url: RequestInfo | URL, init?: RequestInit) => {
      lastInit = init;
      const body = {
          type: 'full',
          lastSyncId: 1,
          models: {},
          timestamp: Date.now(),
      };
      return Promise.resolve({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: { get: () => null },
        json: () => Promise.resolve(body),
        text: () => Promise.resolve(JSON.stringify(body)),
      } as unknown as Response);
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('reads the current token from getAuthToken for each bootstrap request', async () => {
    const auth = createAuthCredentialSource('token-a');
    const helper = new BootstrapFetcher({
      baseUrl: 'https://api.example.com/api',
      getAuthToken: () => auth.getAuthToken(),
    });

    await helper.fetchBootstrap();

    let headers = lastInit?.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer token-a');

    auth.setAuthToken('token-b');

    await helper.fetchBootstrap();

    headers = lastInit?.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer token-b');
  });

  it('uses the same auth source in the ETag bootstrap path', async () => {
    const auth = createAuthCredentialSource('token-etag');
    const helper = new BootstrapFetcher({
      baseUrl: 'https://api.example.com/api',
      getAuthToken: () => auth.getAuthToken(),
    });

    await helper.fetchBootstrapWithETag();

    const headers = lastInit?.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer token-etag');
  });
});
