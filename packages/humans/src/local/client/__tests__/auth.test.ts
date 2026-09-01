/**
 * @jest-environment node
 *
 * Runs in the node environment (not jsdom): the `assertBrowserSafety` and
 * `warnIfCliKeyMismatch` suites toggle the global `window` to simulate a
 * browser vs. a Node/CLI runtime (assigning a synthetic `window = {}` for the
 * browser cases, deleting it for the Node cases). jsdom 26 (jest 30) makes
 * `window` a non-configurable accessor that can't be reassigned or deleted; in
 * node it's absent and freely settable, which is exactly what these need.
 *
 * Auth + URL resolution helpers. API keys support option -> env
 * precedence; other overrides are explicit options. The browser guard confirms
 * that the only case where it fires is `sk_*` keys outside an
 * explicit `dangerouslyAllowBrowser` opt-in.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  ABLO_DEFAULT_BASE_URL,
  assertBrowserSafety,
  modeFromApiKey,
  resolveApiKey,
  resolveApiKeyValue,
  resolveAuthToken,
  resolveBaseURL,
  resolveBootstrapBaseUrl,
} from '@abloatai/transaction/auth/apiKey';
import { normalizeAbloBaseUrl } from '@abloatai/transaction/auth/baseUrl';

describe('resolveApiKey', () => {
  it('prefers explicit option over env', () => {
    expect(
      resolveApiKey({
        options: { apiKey: 'sk_explicit' },
        env: { ABLO_API_KEY: 'sk_env' },
      }),
    ).toBe('sk_explicit');
  });

  it('falls back to env when option is missing', () => {
    expect(
      resolveApiKey({
        options: {},
        env: { ABLO_API_KEY: 'sk_env' },
      }),
    ).toBe('sk_env');
  });

  it('uses a session returned by sessions.create as the bearer', () => {
    expect(
      resolveApiKey({
        options: {
          session: {
            object: 'session',
            token: 'rk_worker',
            expiresAt: '2030-01-01T00:00:00.000Z',
          },
        },
        env: { ABLO_API_KEY: 'sk_env' },
      }),
    ).toBe('rk_worker');
  });

  it('caches a session provider until its credential approaches expiry', async () => {
    const session = jest.fn().mockResolvedValue({
      object: 'session' as const,
      token: 'rk_worker',
      expiresAt: '2030-01-01T00:00:00.000Z',
    });
    const resolved = resolveApiKey({ options: { session }, env: {} });
    if (typeof resolved !== 'function') throw new Error('expected a session provider');

    await expect(resolved()).resolves.toMatchObject({ token: 'rk_worker' });
    await expect(resolved()).resolves.toMatchObject({ token: 'rk_worker' });
    expect(session).toHaveBeenCalledTimes(1);
  });

  it('refuses an ambiguous session and apiKey', () => {
    expect(() =>
      resolveApiKey({
        options: {
          session: {
            object: 'session',
            token: 'rk_worker',
            expiresAt: '2030-01-01T00:00:00.000Z',
          },
          apiKey: 'sk_other',
        },
        env: {},
      }),
    ).toThrow(/not more than one/);
  });

  it('returns null when neither is set', () => {
    expect(resolveApiKey({ options: {}, env: {} })).toBeNull();
  });

  it('wraps a credential provider with browser-secret validation', async () => {
    const setter = () => Promise.resolve('sk_rotated');
    const resolved = resolveApiKey({ options: { apiKey: setter }, env: {} });
    expect(typeof resolved).toBe('function');
    await expect((resolved as typeof setter)()).resolves.toBe('sk_rotated');
  });
});

describe('resolveAuthToken', () => {
  it('returns explicit option', () => {
    expect(
      resolveAuthToken({
        options: { authToken: 'tok_explicit' },
        env: { ABLO_AUTH_TOKEN: 'tok_env' },
      }),
    ).toBe('tok_explicit');
  });

  it('ignores env fallback', () => {
    expect(
      resolveAuthToken({ options: {}, env: { ABLO_AUTH_TOKEN: 'tok_env' } }),
    ).toBeNull();
  });

  it('returns null when neither is set', () => {
    expect(resolveAuthToken({ options: {}, env: {} })).toBeNull();
  });
});

describe('resolveBaseURL', () => {
  it('returns explicit option', () => {
    expect(
      resolveBaseURL({
        options: { baseURL: 'wss://override.example' },
        env: { ABLO_BASE_URL: 'wss://env.example' },
      }),
    ).toBe('https://override.example'); // canonical http family
  });

  it('ignores env fallback', () => {
    expect(
      resolveBaseURL({ options: {}, env: { ABLO_BASE_URL: 'wss://env.example' } }),
    ).toBe(ABLO_DEFAULT_BASE_URL);
  });

  it('falls back to the hosted cloud default when nothing is set', () => {
    expect(resolveBaseURL({ options: {}, env: {} })).toBe(ABLO_DEFAULT_BASE_URL);
  });

  it('uses api.abloatai.com as the hosted cloud default', () => {
    expect(ABLO_DEFAULT_BASE_URL).toBe('https://api.abloatai.com');
    expect(resolveBootstrapBaseUrl({ url: ABLO_DEFAULT_BASE_URL })).toBe(
      'https://api.abloatai.com/api',
    );
  });

  it('accepts all four schemes and canonicalizes to the http family (WHATWG model)', () => {
    // The socket layer derives ws/wss back from the canonical http/https form;
    // fetch consumers use it as-is. A ws:// baseURL previously wedged startup.
    expect(normalizeAbloBaseUrl('ws://localhost:8181')).toBe('http://localhost:8181');
    expect(normalizeAbloBaseUrl('wss://sync.customer.example')).toBe(
      'https://sync.customer.example',
    );
    expect(normalizeAbloBaseUrl('http://localhost:8181')).toBe('http://localhost:8181');
  });

  it('leaves self-hosted URLs unchanged', () => {
    expect(normalizeAbloBaseUrl('https://sync.customer.example/api')).toBe(
      'https://sync.customer.example/api',
    );
  });

  it('falls back to the hosted default when the override is empty', () => {
    // An empty env var is an unset env var. Returning '' handed the transports
    // a base that no request could be built against.
    expect(normalizeAbloBaseUrl('')).toBe(ABLO_DEFAULT_BASE_URL);
    expect(normalizeAbloBaseUrl('   ')).toBe(ABLO_DEFAULT_BASE_URL);
  });
});

// Every request carries the API key against this origin, so `baseURL` decides
// where the credential travels. These are the values that would send it
// somewhere it must not go, or send it in the clear.
describe('normalizeAbloBaseUrl refuses unsafe credential destinations', () => {
  it('refuses plaintext http to a remote host', () => {
    expect(() => normalizeAbloBaseUrl('http://sync.customer.example')).toThrow(
      /must use https/,
    );
    expect(() => normalizeAbloBaseUrl('ws://sync.customer.example')).toThrow(
      /must use https/,
    );
  });

  it('allows plaintext http to the local machine', () => {
    // The whole 127.0.0.0/8 block, IPv6 loopback, and reserved `.localhost`
    // names all reach this machine, so nothing is on the wire to read.
    expect(normalizeAbloBaseUrl('http://127.0.0.2:8080')).toBe('http://127.0.0.2:8080');
    expect(normalizeAbloBaseUrl('http://[::1]:8080')).toBe('http://[::1]:8080');
    expect(normalizeAbloBaseUrl('http://ablo.localhost:3000')).toBe(
      'http://ablo.localhost:3000',
    );
  });

  it('refuses a URL that embeds its own credentials', () => {
    expect(() =>
      normalizeAbloBaseUrl('https://api.abloatai.com:tok@evil.example'),
    ).toThrow(/must not embed a username or password/);
  });

  it('refuses a query string or fragment, which a path cannot be appended to', () => {
    expect(() => normalizeAbloBaseUrl('https://sync.customer.example?to=evil')).toThrow(
      /must not carry a query string or fragment/,
    );
    expect(() => normalizeAbloBaseUrl('https://sync.customer.example/#/x')).toThrow(
      /must not carry a query string or fragment/,
    );
  });

  it('refuses a trailing-dot host, which evades every host check', () => {
    expect(() => normalizeAbloBaseUrl('https://api.abloatai.com.')).toThrow(
      /must not end its host in a dot/,
    );
  });

  it('refuses a scheme outside the http family', () => {
    expect(() => normalizeAbloBaseUrl('file:///etc/passwd')).toThrow(
      /must be an https URL/,
    );
  });

  it('refuses an unparseable value instead of failing later at fetch time', () => {
    expect(() => normalizeAbloBaseUrl('https://host:notaport')).toThrow(
      /is not a valid URL/,
    );
  });
});

describe('resolveBootstrapBaseUrl', () => {
  it('prepends https:// to a scheme-less host (else it becomes a relative URL → 404)', () => {
    // The staging-outage root cause: NEXT_PUBLIC_SYNC_SERVER_URL=api-staging.abloatai.com
    expect(normalizeAbloBaseUrl('api-staging.abloatai.com')).toBe(
      'https://api-staging.abloatai.com',
    );
    expect(normalizeAbloBaseUrl('api-staging.abloatai.com/api')).toBe(
      'https://api-staging.abloatai.com/api',
    );
  });

  it('canonicalizes ws-family schemes to the http family, preserving host/port/path', () => {
    expect(normalizeAbloBaseUrl('wss://api-staging.abloatai.com')).toBe(
      'https://api-staging.abloatai.com',
    );
    expect(normalizeAbloBaseUrl('http://localhost:8080')).toBe('http://localhost:8080');
  });

  it('prefers an explicit bootstrapBaseUrl override over the client url', () => {
    expect(
      resolveBootstrapBaseUrl({
        url: 'wss://ignored.example',
        bootstrapBaseUrl: 'https://api-staging.abloatai.com/api',
      }),
    ).toBe('https://api-staging.abloatai.com/api');
  });

  it('coerces a ws/wss override scheme to http/https for HTTP fetches', () => {
    // apps/web passes `${baseUrl}/api` as the override, where `baseUrl` can
    // carry a WebSocket scheme. The override path must still yield an http(s)
    // base — otherwise the identity/exchange `fetch` rejects "URL scheme wss".
    expect(
      resolveBootstrapBaseUrl({
        url: 'wss://sync.customer.example',
        bootstrapBaseUrl: 'wss://sync.customer.example/api',
      }),
    ).toBe('https://sync.customer.example/api');
    expect(
      resolveBootstrapBaseUrl({
        url: 'ws://localhost:8080',
        bootstrapBaseUrl: 'ws://localhost:8080/api',
      }),
    ).toBe('http://localhost:8080/api');
  });

  it('leaves an http(s) override scheme untouched', () => {
    expect(
      resolveBootstrapBaseUrl({
        url: 'https://sync.customer.example',
        bootstrapBaseUrl: 'https://sync.customer.example/api',
      }),
    ).toBe('https://sync.customer.example/api');
  });

  it('appends the /api route segment when an override omits it', () => {
    // Hosted customers who set a custom base URL without `/api` used to land on
    // `…/v1/capabilities` (404 → exchange_failed). The override branch now
    // guarantees the suffix, matching the derive branch and the server mount.
    expect(
      resolveBootstrapBaseUrl({
        url: 'wss://ignored.example',
        bootstrapBaseUrl: 'https://sync.customer.example',
      }),
    ).toBe('https://sync.customer.example/api');
    expect(
      resolveBootstrapBaseUrl({
        url: 'wss://ignored.example',
        bootstrapBaseUrl: 'wss://sync.customer.example',
      }),
    ).toBe('https://sync.customer.example/api');
    expect(
      resolveBootstrapBaseUrl({
        url: 'wss://ignored.example',
        bootstrapBaseUrl: 'http://localhost:8080/',
      }),
    ).toBe('http://localhost:8080/api');
  });

  it('is idempotent — does not double-append /api', () => {
    expect(
      resolveBootstrapBaseUrl({
        url: 'wss://ignored.example',
        bootstrapBaseUrl: 'https://sync.customer.example/api',
      }),
    ).toBe('https://sync.customer.example/api');
  });

  it('treats "api" only as a path segment, not a host substring', () => {
    // `api.abloatai.com` has "api" in the HOST — the path is still empty and
    // must receive `/api`. The default (no override) path exercises this too.
    expect(resolveBootstrapBaseUrl({ url: 'wss://api.abloatai.com' })).toBe(
      'https://api.abloatai.com/api',
    );
  });
});

describe('assertBrowserSafety', () => {
  const realWindow = (globalThis as { window?: unknown }).window;
  beforeEach(() => {
    (globalThis as { window?: unknown }).window = {};
  });
  afterEach(() => {
    if (realWindow === undefined) {
      delete (globalThis as { window?: unknown }).window;
    } else {
      (globalThis as { window?: unknown }).window = realWindow;
    }
  });

  it('throws on sk_* key in browser without dangerouslyAllowBrowser', () => {
    expect(() =>
      { assertBrowserSafety({
        apiKey: 'sk_live_abc',
        dangerouslyAllowBrowser: undefined,
      }); },
    ).toThrow(/reached the browser/);
  });

  it('passes when dangerouslyAllowBrowser is true', () => {
    expect(() =>
      { assertBrowserSafety({
        apiKey: 'sk_live_abc',
        dangerouslyAllowBrowser: true,
      }); },
    ).not.toThrow();
  });

  it('passes for non-sk keys (minted session tokens are safe in browser)', () => {
    expect(() =>
      { assertBrowserSafety({
        apiKey: 'ek_live_abc',
        dangerouslyAllowBrowser: undefined,
      }); },
    ).not.toThrow();
  });

  it('passes for callable apiKey (rotation hides the actual key)', () => {
    const setter = () => Promise.resolve('sk_live_abc');
    expect(() =>
      { assertBrowserSafety({
        apiKey: setter,
        dangerouslyAllowBrowser: undefined,
      }); },
    ).not.toThrow();
  });

  it('blocks a secret returned by a browser credential provider', async () => {
    const resolved = resolveApiKey({
      options: { apiKey: () => Promise.resolve('sk_live_abc') },
      env: {},
    });
    await expect(
      (resolved as () => Promise<string | null>)(),
    ).rejects.toMatchObject({ code: 'browser_apikey_blocked' });
  });

  it('passes when window is undefined (Node, edge runtimes)', () => {
    delete (globalThis as { window?: unknown }).window;
    expect(() =>
      { assertBrowserSafety({
        apiKey: 'sk_live_abc',
        dangerouslyAllowBrowser: undefined,
      }); },
    ).not.toThrow();
  });
});

describe('warnIfCliKeyMismatch', () => {
  const freshWarn = async () => {
    let mod!: typeof import('@abloatai/transaction/auth/apiKey');
    await jest.isolateModulesAsync(async () => {
      mod = await import('@abloatai/transaction/auth/apiKey');
    });
    return mod.warnIfCliKeyMismatch;
  };

  const writeCliFiles = (
    dir: string,
    config: Record<string, unknown>,
    credentials: Record<string, unknown>,
  ) => {
    writeFileSync(join(dir, 'config.json'), JSON.stringify(config));
    writeFileSync(join(dir, 'credentials.json'), JSON.stringify(credentials));
  };

  const withoutWindow = async (fn: () => Promise<void>) => {
    const hadWindow = Object.prototype.hasOwnProperty.call(globalThis, 'window');
    const realWindow = (globalThis as { window?: unknown }).window;
    delete (globalThis as { window?: unknown }).window;
    try {
      await fn();
    } finally {
      if (hadWindow) {
        (globalThis as { window?: unknown }).window = realWindow;
      } else {
        delete (globalThis as { window?: unknown }).window;
      }
    }
  };

  it('maps key prefixes to CLI modes', () => {
    expect(modeFromApiKey('sk_test_abc')).toBe('sandbox');
    expect(modeFromApiKey('rk_test_abc')).toBe('sandbox');
    expect(modeFromApiKey('sk_live_abc')).toBe('production');
    expect(modeFromApiKey('rk_live_abc')).toBe('production');
    expect(modeFromApiKey('pk_test_abc')).toBeUndefined();
  });

  it('warns when ABLO_API_KEY points at production while the CLI is in sandbox', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ablo-sdk-auth-'));
    try {
      writeCliFiles(
        dir,
        { mode: 'sandbox' },
        { profiles: { default: { sandbox: { apiKey: 'sk_test_9CB2_sandbox' } } } },
      );
      const warn = jest.fn();

      await withoutWindow(async () => {
        await (await freshWarn())(
          { options: {}, env: { ABLO_CONFIG_DIR: dir, ABLO_API_KEY: 'sk_live_2R5o_prod' } },
          warn,
        );
      });

      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toContain('ABLO_API_KEY is a production key');
      expect(warn.mock.calls[0][0]).toContain('CLI is in sandbox mode');
      expect(warn.mock.calls[0][0]).toContain('active stored key sk_test_9CB2…');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('warns when ABLO_API_KEY overrides a different stored key in the active mode', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ablo-sdk-auth-'));
    try {
      writeCliFiles(
        dir,
        { mode: 'sandbox' },
        { profiles: { default: { sandbox: { apiKey: 'sk_test_stored' } } } },
      );
      const warn = jest.fn();

      await withoutWindow(async () => {
        await (await freshWarn())(
          { options: {}, env: { ABLO_CONFIG_DIR: dir, ABLO_API_KEY: 'sk_test_env_key' } },
          warn,
        );
      });

      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toContain('overrides');
      expect(warn.mock.calls[0][0]).toContain('stored');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('stays silent for rotating apiKey callables', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ablo-sdk-auth-'));
    try {
      writeCliFiles(
        dir,
        { mode: 'sandbox' },
        { profiles: { default: { sandbox: { apiKey: 'sk_test_stored' } } } },
      );
      const warn = jest.fn();

      await withoutWindow(async () => {
        await (await freshWarn())(
          {
            options: { apiKey: () => Promise.resolve('sk_live_rotated') },
            env: { ABLO_CONFIG_DIR: dir, ABLO_API_KEY: 'sk_live_env' },
          },
          warn,
        );
      });

      expect(warn).not.toHaveBeenCalled();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('stays silent in production mode', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ablo-sdk-auth-'));
    try {
      writeCliFiles(
        dir,
        { mode: 'sandbox' },
        { profiles: { default: { sandbox: { apiKey: 'sk_test_stored' } } } },
      );
      const warn = jest.fn();

      await withoutWindow(async () => {
        await (await freshWarn())(
          {
            options: {},
            env: {
              ABLO_CONFIG_DIR: dir,
              ABLO_API_KEY: 'sk_live_env',
              NODE_ENV: 'production',
            },
          },
          warn,
        );
      });

      expect(warn).not.toHaveBeenCalled();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('resolveApiKeyValue', () => {
  it('returns the static string unchanged', async () => {
    expect(await resolveApiKeyValue('sk_static')).toBe('sk_static');
  });

  it('invokes the CredentialProvider and returns its resolved value', async () => {
    expect(
      await resolveApiKeyValue(() => Promise.resolve('sk_rotated')),
    ).toBe('sk_rotated');
  });

  it('returns null when the key is null', async () => {
    expect(await resolveApiKeyValue(null)).toBeNull();
  });
});
