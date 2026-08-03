/**
 * postQuery auth threading — regression coverage for headless Node consumers
 * that authenticate via Biscuit cap token instead of
 * session cookies. Without this header, model-proxy HTTP queries return
 * 401 at startup because cookies aren't available off-browser.
 *
 * See `feedback_node_ws_reconnect_and_http_auth.md` for the bug history.
 */

import { postQuery } from '../../src/local/query/client';

describe('postQuery — capability token auth', () => {
  let originalFetch: typeof globalThis.fetch;
  let lastInit: RequestInit | undefined;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    lastInit = undefined;
    globalThis.fetch = jest.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      lastInit = init;
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({ results: [[]] }),
      } as Response;
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('attaches Authorization: Bearer when capabilityToken is provided', async () => {
    await postQuery(
      { baseUrl: 'https://api.example.com/api', capabilityToken: 'tok_abc123' },
      { queries: [{ model: 'Document', where: [['id', '=', 'doc-1']], limit: 1 }] },
    );

    const headers = lastInit?.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer tok_abc123');
    expect(headers['Content-Type']).toBe('application/json');
  });

  it('omits Authorization when no capabilityToken is provided (browser cookie path)', async () => {
    await postQuery(
      { baseUrl: 'https://api.example.com/api' },
      { queries: [{ model: 'Document', where: [['id', '=', 'doc-1']], limit: 1 }] },
    );

    const headers = lastInit?.headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
    // Bearer-only CORS cutover (2026-06-05): SDK fetches no longer send
    // cookies — the Authorization bearer is the only credential.
    expect(lastInit?.credentials).toBeUndefined();
  });

  it('preserves credentials: include even when Bearer token is present (defense in depth)', async () => {
    await postQuery(
      { baseUrl: 'https://api.example.com/api', capabilityToken: 'tok_xyz' },
      { queries: [{ model: 'Document', where: [['id', '=', 'doc-1']], limit: 1 }] },
    );

    // Bearer-only CORS cutover (2026-06-05): SDK fetches no longer send
    // cookies — the Authorization bearer is the only credential.
    expect(lastInit?.credentials).toBeUndefined();
  });

  it('prefers the live getAuthToken value over a copied capabilityToken', async () => {
    let token = 'tok_initial';

    await postQuery(
      {
        baseUrl: 'https://api.example.com/api',
        capabilityToken: 'tok_stale',
        getAuthToken: () => token,
      },
      { queries: [{ model: 'Document', where: [['id', '=', 'doc-1']], limit: 1 }] },
    );

    let headers = lastInit?.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer tok_initial');

    token = 'tok_refreshed';
    await postQuery(
      {
        baseUrl: 'https://api.example.com/api',
        capabilityToken: 'tok_stale',
        getAuthToken: () => token,
      },
      { queries: [{ model: 'Document', where: [['id', '=', 'doc-1']], limit: 1 }] },
    );

    headers = lastInit?.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer tok_refreshed');
  });
});
