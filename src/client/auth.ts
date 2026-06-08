/**
 * Auth + URL resolution for `Ablo()`.
 *
 * Mirrors the small, focused helpers Anthropic ships in `client.ts`
 * (`apiKeyAuth`, `bearerAuth`, `validateHeaders`). Each function does
 * one thing — resolve a value with the right precedence, or fail
 * with an actionable message — so the constructor reads as a
 * sequence of named decisions rather than a stream of `??`-chains.
 *
 * Customer-facing env surface is intentionally small: `ABLO_API_KEY`
 * is the only environment fallback. Other routing/auth overrides are
 * explicit options so generated apps do not accrete hidden env knobs.
 */

import { AbloAuthenticationError } from '../errors.js';

/**
 * Async callable that resolves to a fresh API key. Mirrors the shape
 * Anthropic / OpenAI / Stripe ship — used for credential rotation
 * (e.g. AWS STS, GCP IAM, Vault). Re-exported from `./Ablo` so
 * existing import paths work; defined here so this module has no
 * circular dependency back to `Ablo.ts`.
 */
export type ApiKeySetter = () => Promise<string>;

export interface AuthResolveInput {
  /**
   * The full options bag the caller passed to `Ablo()`. Resolvers
   * read only the fields they care about; the wide shape avoids
   * passing N parameters into each helper.
   */
  readonly options: {
    readonly apiKey?: string | ApiKeySetter | null;
    readonly authToken?: string | null;
    readonly baseURL?: string | null;
    readonly databaseUrl?: string | null;
    readonly dangerouslyAllowBrowser?: boolean;
  };
  readonly env: Record<string, string | undefined>;
}

/**
 * Read `process.env` defensively. Works in browser (where `process`
 * is undefined), Node, and edge runtimes that expose a partial
 * process polyfill.
 */
export function readProcessEnv(): Record<string, string | undefined> {
  const maybeGlobal = globalThis as typeof globalThis & {
    process?: { env?: Record<string, string | undefined> };
  };
  return maybeGlobal.process?.env ?? {};
}

export function resolveApiKey(
  input: AuthResolveInput,
): string | ApiKeySetter | null {
  return input.options.apiKey ?? input.env.ABLO_API_KEY ?? null;
}

export function resolveAuthToken(input: AuthResolveInput): string | null {
  return input.options.authToken ?? null;
}

/**
 * Resolve the direct-URL connector's Postgres connection string.
 *
 * The default Data Source path should not call this: the customer keeps
 * `DATABASE_URL` in their app and exposes `dataSource(...)`. This helper exists
 * only for the opt-in direct connector where Ablo registers a dedicated tenant
 * database. Returns null for Ablo-managed storage.
 */
export function resolveDatabaseUrl(input: AuthResolveInput): string | null {
  return input.options.databaseUrl ?? input.env.DATABASE_URL ?? null;
}

export const ABLO_HOSTED_API_DOMAIN = 'api.abloatai.com';
export const ABLO_HOSTED_HTTP_BASE_URL = `https://${ABLO_HOSTED_API_DOMAIN}`;
export const ABLO_DEFAULT_BASE_URL = `wss://${ABLO_HOSTED_API_DOMAIN}`;

const LEGACY_HOSTED_API_HOSTS = new Set([
  'mesh.ablo.finance',
  'mesh-staging.ablo.finance',
  'api.ablo.finance',
  'sync-staging.ablo.finance',
]);

/**
 * Normalize old hosted aliases to the public API domain. Self-hosted/custom
 * URLs pass through unchanged; only first-party legacy hosts are rewritten.
 */
export function normalizeAbloHostedBaseUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  if (!trimmed) return trimmed;

  // A scheme-less value (e.g. `api-staging.abloatai.com`) is a RELATIVE URL:
  // `new URL()` throws on it, and downstream `fetch` then resolves it against
  // the current page — producing `https://<app-host>/<route>/api-staging…/api/
  // auth/identity`, a 404 from the app's own origin. Prepend a scheme so the
  // base is absolute. `https` mirrors `ABLO_HOSTED_HTTP_BASE_URL`; the socket
  // layer derives `wss` from it. An existing scheme (ws/wss/http/https) is
  // preserved untouched.
  const schemed = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;

  try {
    const url = new URL(schemed);
    if (!LEGACY_HOSTED_API_HOSTS.has(url.hostname)) return schemed.replace(/\/+$/, '');

    url.hostname = ABLO_HOSTED_API_DOMAIN;
    if (url.protocol === 'http:') url.protocol = 'https:';
    if (url.protocol === 'ws:') url.protocol = 'wss:';
    return url.toString().replace(/\/+$/, '');
  } catch {
    return schemed;
  }
}

export function resolveBaseURL(input: AuthResolveInput): string {
  return normalizeAbloHostedBaseUrl(input.options.baseURL ?? ABLO_DEFAULT_BASE_URL);
}

/**
 * Browser guard — apiKey is server-side-only by default. Same check
 * Anthropic, OpenAI, and Stripe ship: shipping `sk_live_...` to a
 * browser exposes it in every visitor's network tab. Consumers opt
 * in explicitly when the browser holds a minted session token
 * (`ek_`/`rk_`) or routes through a server proxy.
 */
export function assertBrowserSafety(input: {
  apiKey: string | ApiKeySetter | null;
  databaseUrl?: string | null;
  dangerouslyAllowBrowser: boolean | undefined;
}): void {
  const inBrowser = typeof window !== 'undefined';
  if (
    !input.dangerouslyAllowBrowser &&
    inBrowser &&
    typeof input.apiKey === 'string' &&
    input.apiKey.startsWith('sk_')
  ) {
    throw new AbloAuthenticationError(
      "It looks like you're running in a browser-like environment.\n\n" +
        'This is disabled by default — your secret API key would be ' +
        "exposed to every visitor's network tab. If you understand the risks " +
        'and have appropriate mitigations in place, you can set the ' +
        '`dangerouslyAllowBrowser` option to `true`, e.g.,\n\n' +
        '    Ablo({ schema, apiKey, dangerouslyAllowBrowser: true });\n',
      { code: 'browser_apikey_blocked' },
    );
  }
  // `databaseUrl` carries DB credentials and is NEVER browser-safe, so
  // `dangerouslyAllowBrowser` does not override it. Register your database from
  // a server-side runtime.
  if (inBrowser && typeof input.databaseUrl === 'string' && input.databaseUrl.length > 0) {
    throw new AbloAuthenticationError(
      'Ablo `databaseUrl` cannot be used in a browser-like environment — it ' +
        'carries your database credentials. Initialize the client with ' +
        '`databaseUrl` from a server-side runtime only.',
      { code: 'browser_database_url_blocked' },
    );
  }
}

/**
 * Resolve an `ApiKeySetter` callable to its current string value.
 * Used at request time so a rotating credential picks up rotations
 * between requests. Returns `null` when no key was configured.
 *
 * Mirrors Anthropic's pattern of supporting both a static string and
 * a callable for credential rotation.
 */
export async function resolveApiKeyValue(
  apiKey: string | ApiKeySetter | null,
): Promise<string | null> {
  if (apiKey == null) return null;
  if (typeof apiKey === 'function') return apiKey();
  return apiKey;
}

/**
 * Translate a sync-engine WebSocket URL to the matching HTTP API
 * base URL, defaulting to `${url}/api` when the caller hasn't
 * overridden `bootstrapBaseUrl`. Used by `BootstrapHelper`,
 * `HydrationCoordinator`, the apiKey-exchange flow, and the
 * self-derived identity flow — same derivation in all four spots,
 * so it lives here as a single source of truth.
 *
 * Note: when both `wss://` and `https://` are valid, `replace(/^ws/, 'http')`
 * preserves the protocol family (ws → http, wss → https).
 */
export function resolveBootstrapBaseUrl(input: {
  readonly url: string;
  readonly bootstrapBaseUrl?: string;
}): string {
  if (input.bootstrapBaseUrl) {
    // Coerce ws/wss → http/https on the override path too. This base URL is
    // used for HTTP fetches (identity resolve, apiKey exchange, bootstrap) and
    // the browser `fetch` rejects ws/wss schemes outright ("URL scheme \"wss\"
    // is not supported"). apps/web derives this override as `${baseUrl}/api`
    // where `baseUrl` may carry a WebSocket scheme, so the override can
    // legitimately arrive as `wss://…` — normalize it here rather than
    // faceplanting at fetch time. The derive branch below already does this;
    // the override branch silently skipped it.
    return normalizeAbloHostedBaseUrl(input.bootstrapBaseUrl).replace(/^ws/, 'http');
  }
  const url = normalizeAbloHostedBaseUrl(input.url);
  return `${url.replace(/^ws/, 'http')}/api`;
}
