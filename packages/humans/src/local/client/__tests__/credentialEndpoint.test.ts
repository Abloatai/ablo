import { describe, expect, it, jest } from '@jest/globals';
import {
  createEndpointCredentialResolver,
  isCredentialEndpoint,
} from '@abloatai/transaction/auth/credentialEndpoint';
import { resolveApiKey } from '@abloatai/transaction/auth/apiKey';

function response(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as Response;
}

const success = {
  token: 'ek_fresh',
  expiresAt: '2026-07-25T12:00:00Z',
  credentialKind: 'ephemeral',
} as const;

describe('credential endpoint configuration', () => {
  it('recognizes only URL-shaped endpoint values', () => {
    expect(isCredentialEndpoint('/api/ablo-session')).toBe(true);
    expect(isCredentialEndpoint('https://app.test/api/ablo-session')).toBe(true);
    expect(isCredentialEndpoint('sk_test_abc')).toBe(false);
  });

  it('keeps apiKey and authEndpoint as distinct concepts', () => {
    expect(() =>
      resolveApiKey({
        options: { apiKey: '/api/ablo-session' },
        env: {},
      }),
    ).toThrow('Move this value to `authEndpoint`');
    expect(
      typeof resolveApiKey({
        options: { authEndpoint: '/api/ablo-session' },
        env: {},
      }),
    ).toBe('function');
  });

  it('rejects an ambiguous pair', () => {
    expect(() =>
      resolveApiKey({
        options: {
          apiKey: 'sk_test_abc',
          authEndpoint: '/api/ablo-session',
        },
        env: {},
      }),
    ).toThrow('not both');
  });
});

describe('credential endpoint protocol', () => {
  it('uses the injected fetch and preserves canonical expiry metadata', async () => {
    const fetcher = jest.fn<typeof fetch>(() => Promise.resolve(response(200, success)));
    const provider = createEndpointCredentialResolver('/api/ablo-session', {
      fetch: fetcher,
    });

    await expect(provider()).resolves.toEqual(success);
    expect(fetcher).toHaveBeenCalledWith(
      '/api/ablo-session',
      expect.objectContaining({
        method: 'POST',
        credentials: 'include',
        cache: 'no-store',
        headers: { accept: 'application/json' },
      }),
    );
  });

  it('treats only structured 401 session_expired as terminal', async () => {
    const terminal = createEndpointCredentialResolver('/auth', {
      fetch: () =>
        Promise.resolve(response(401, { error: { code: 'session_expired' } })),
    });
    await expect(terminal()).resolves.toBeNull();

    for (const [status, body] of [
      [401, { error: { code: 'unauthorized' } }],
      [403, { error: { code: 'permission_denied' } }],
      [500, { error: { code: 'internal_error' } }],
    ] as const) {
      const provider = createEndpointCredentialResolver('/auth', {
        fetch: () => Promise.resolve(response(status, body)),
      });
      await expect(provider()).rejects.toThrow(String(status));
    }
  });

  it('rejects malformed, extra, and mismatched success payloads', async () => {
    for (const body of [
      { token: 'ek_fresh' },
      { ...success, extra: true },
      { ...success, token: 'rk_fresh' },
      { ...success, token: 'sk_secret' },
    ]) {
      const provider = createEndpointCredentialResolver('/auth', {
        fetch: () => Promise.resolve(response(200, body)),
      });
      await expect(provider()).rejects.toThrow();
    }
  });

  it('aborts a hung mint at the configured timeout', async () => {
    const fetcher = jest.fn<typeof fetch>(
      async (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            { reject(new DOMException('aborted', 'AbortError')); },
          );
        }),
    );
    const provider = createEndpointCredentialResolver('/auth', {
      fetch: fetcher,
      timeoutMs: 1,
    });
    await expect(provider()).rejects.toThrow();
  });
});
