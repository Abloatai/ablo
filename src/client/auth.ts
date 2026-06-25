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
import { classifyCredentialKind } from '../auth/credentialPolicy.js';

/**
 * Async callable that resolves the current credential. Mirrors the shape
 * Anthropic / OpenAI / Stripe ship — used for credential rotation
 * (e.g. AWS STS, GCP IAM, Vault) AND the short-lived per-user browser
 * path (mint a fresh `ek_`/`rk_` from the signed-in session). Re-exported
 * from `./Ablo` so existing import paths work; defined here so this module
 * has no circular dependency back to `Ablo.ts`.
 *
 * Contract: resolve a token; resolve `null` when the login itself is gone
 * (terminal → the credential lifecycle treats this as `session_expired` and
 * signs out); or THROW on a transient failure (→ back off and retry, never
 * sign out). A long-lived static `apiKey` string needs none of this — it is
 * used as-is. This is the single credential resolver the SDK supports.
 */
export type ApiKeySetter = () => Promise<string | null>;

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

type CliMode = 'sandbox' | 'production';
type StaticApiKeySource = 'option' | 'env';

interface StaticApiKey {
  readonly key: string;
  readonly source: StaticApiKeySource;
}

interface CliCredentialSnapshot {
  readonly mode: CliMode;
  readonly activeProfile: string;
  readonly storedKey?: string;
}

export interface CliKeyMismatch {
  readonly source: StaticApiKeySource;
  readonly configuredKeyPrefix: string;
  readonly configuredMode?: CliMode;
  readonly cliMode: CliMode;
  readonly storedKeyPrefix?: string;
  readonly kind: 'mode_mismatch' | 'key_override';
  readonly message: string;
}

function keyPrefix(key: string): string {
  return `${key.slice(0, 12)}…`;
}

/** Infer sandbox/production from Ablo key prefixes without importing CLI code. */
export function modeFromApiKey(key: string): CliMode | undefined {
  if (/^(sk|rk)_test_/.test(key)) return 'sandbox';
  if (/^(sk|rk)_live_/.test(key)) return 'production';
  return undefined;
}

function resolveStaticApiKey(input: AuthResolveInput): StaticApiKey | null {
  if (typeof input.options.apiKey === 'string') {
    return { key: input.options.apiKey, source: 'option' };
  }
  if (input.options.apiKey !== undefined && input.options.apiKey !== null) {
    return null;
  }
  const envKey = input.env.ABLO_API_KEY;
  if (typeof envKey === 'string' && envKey.length > 0) {
    return { key: envKey, source: 'env' };
  }
  return null;
}

function readProfileKeys(
  value: unknown,
): Record<string, Record<CliMode, { apiKey?: string } | undefined>> {
  if (!value || typeof value !== 'object') return {};
  const profiles: Record<string, Record<CliMode, { apiKey?: string } | undefined>> = {};
  for (const [name, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!raw || typeof raw !== 'object') continue;
    const row = raw as Record<string, unknown>;
    const sandbox = row.sandbox;
    const production = row.production;
    profiles[name] = {
      sandbox: sandbox && typeof sandbox === 'object' ? sandbox as { apiKey?: string } : undefined,
      production: production && typeof production === 'object' ? production as { apiKey?: string } : undefined,
    };
  }
  return profiles;
}

function legacyProfileKeys(
  value: Record<string, unknown> | null,
): Record<CliMode, { apiKey?: string } | undefined> {
  if (!value) return { sandbox: undefined, production: undefined };
  const sandbox = value.sandbox;
  const production = value.production;
  if (
    (sandbox && typeof sandbox === 'object') ||
    (production && typeof production === 'object')
  ) {
    return {
      sandbox: sandbox && typeof sandbox === 'object' ? sandbox as { apiKey?: string } : undefined,
      production: production && typeof production === 'object' ? production as { apiKey?: string } : undefined,
    };
  }
  if (typeof value.apiKey === 'string') {
    return { sandbox: { apiKey: value.apiKey }, production: undefined };
  }
  return { sandbox: undefined, production: undefined };
}

function normalizeCliMode(value: unknown): CliMode | undefined {
  return value === 'sandbox' || value === 'production' ? value : undefined;
}

function activeProjectSlug(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const slug = (value as { slug?: unknown }).slug;
  return typeof slug === 'string' && slug.length > 0 ? slug : undefined;
}

function importNodeBuiltin<T>(specifier: string): Promise<T> {
  return import(specifier) as Promise<T>;
}

async function readJsonIfPresent(path: string): Promise<Record<string, unknown> | null> {
  try {
    const { readFile } = await importNodeBuiltin<typeof import('node:fs/promises')>(
      'node:fs/promises',
    );
    const text = await readFile(path, 'utf8');
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

async function readCliCredentialSnapshot(env: Record<string, string | undefined>): Promise<CliCredentialSnapshot | null> {
  const processLike = (globalThis as typeof globalThis & {
    process?: { versions?: { node?: string } };
  }).process;
  if (!processLike?.versions?.node) return null;
  if (typeof window !== 'undefined') return null;

  const [{ homedir }, { join }] = await Promise.all([
    importNodeBuiltin<typeof import('node:os')>('node:os'),
    importNodeBuiltin<typeof import('node:path')>('node:path'),
  ]);
  const dir = env.ABLO_CONFIG_DIR
    ?? (env.XDG_CONFIG_HOME ? join(env.XDG_CONFIG_HOME, 'ablo') : join(homedir(), '.config', 'ablo'));
  const [cfg, creds] = await Promise.all([
    readJsonIfPresent(join(dir, 'config.json')),
    readJsonIfPresent(join(dir, 'credentials.json')),
  ]);
  const mode = normalizeCliMode(cfg?.mode) ?? normalizeCliMode(creds?.mode);
  const activeProfile = activeProjectSlug(cfg?.activeProject) ?? 'default';

  const profiles = {
    ...readProfileKeys(creds?.profiles),
    ...readProfileKeys(cfg?.profiles),
  };
  if (!profiles[activeProfile]) {
    const legacy = { ...legacyProfileKeys(cfg), ...legacyProfileKeys(creds) };
    if (legacy.sandbox?.apiKey || legacy.production?.apiKey) {
      profiles[activeProfile] = legacy;
    }
  }
  const effectiveMode = mode ?? (Object.keys(profiles).length > 0 ? 'sandbox' : undefined);
  if (!effectiveMode) return null;
  return {
    mode: effectiveMode,
    activeProfile,
    ...(profiles[activeProfile]?.[effectiveMode]?.apiKey
      ? { storedKey: profiles[activeProfile]![effectiveMode]!.apiKey }
      : {}),
  };
}

export function describeCliKeyMismatch(
  configured: StaticApiKey,
  cli: CliCredentialSnapshot,
): CliKeyMismatch | null {
  const configuredMode = modeFromApiKey(configured.key);
  const configuredKeyPrefix = keyPrefix(configured.key);
  const storedKeyPrefix = cli.storedKey ? keyPrefix(cli.storedKey) : undefined;
  const sourceLabel = configured.source === 'env' ? 'ABLO_API_KEY' : 'configured apiKey';

  if (configuredMode && configuredMode !== cli.mode) {
    return {
      source: configured.source,
      configuredKeyPrefix,
      configuredMode,
      cliMode: cli.mode,
      ...(storedKeyPrefix ? { storedKeyPrefix } : {}),
      kind: 'mode_mismatch',
      message:
        `${sourceLabel} is a ${configuredMode} key (${configuredKeyPrefix}) but the Ablo CLI is in ` +
        `${cli.mode} mode${storedKeyPrefix ? ` (active stored key ${storedKeyPrefix})` : ''}. ` +
        `Requests will use ${configuredMode}. Use the ${cli.mode} key, unset ABLO_API_KEY, ` +
        `or run \`ablo mode ${configuredMode}\` intentionally.`,
    };
  }

  if (configured.source === 'env' && cli.storedKey && configured.key !== cli.storedKey) {
    return {
      source: configured.source,
      configuredKeyPrefix,
      ...(configuredMode ? { configuredMode } : {}),
      cliMode: cli.mode,
      storedKeyPrefix,
      kind: 'key_override',
      message:
        `ABLO_API_KEY (${configuredKeyPrefix}) overrides the CLI's stored active ${cli.mode} key ` +
        `(${storedKeyPrefix}). Requests will use the environment key. Unset ABLO_API_KEY to use ` +
        '`ablo status` / `ablo mode` credentials.',
    };
  }

  return null;
}

/**
 * Resolve the direct-URL connector's Postgres connection string.
 *
 * `databaseUrl` is an EXPLICIT, opt-in option: Ablo registers a dedicated
 * tenant database only when the caller passes it to `Ablo(...)`. It is NOT
 * read from `process.env.DATABASE_URL` — per this module's invariant
 * (`ABLO_API_KEY` is the only environment fallback), an app's `DATABASE_URL`
 * (commonly set for Prisma/Drizzle/docker) must never silently flip the client
 * into connection-string mode. The default Data Source path keeps `DATABASE_URL`
 * in the app and exposes `dataSource(...)`; that path leaves this null.
 * `warnIfDatabaseUrlEnvIgnored` nudges callers who set the env but omitted the option.
 */
export function resolveDatabaseUrl(input: AuthResolveInput): string | null {
  return input.options.databaseUrl ?? null;
}

/**
 * One-time migration nudge for the dropped `DATABASE_URL` env fallback.
 *
 * Earlier versions silently adopted `process.env.DATABASE_URL` when `databaseUrl`
 * was not passed, registering a direct connector behind the caller's back — which
 * surprised any app that keeps `DATABASE_URL` for another tool (Prisma, Drizzle,
 * docker-compose) and, on localhost, tried to register a database Ablo's cloud
 * cannot reach. The env value is now ignored; this points the developer at the
 * explicit option instead of flipping their mode for them. Warns once per process
 * so it never spams, and falls back to `console.warn` when no logger is supplied
 * (the `transport: 'api'` client has none).
 *
 * Suppressed entirely on the hosted/token path: if an `apiKey` resolves (option
 * or `ABLO_API_KEY` env), the caller has chosen the hosted capability-token /
 * Data Source transport, which is mutually exclusive with direct `databaseUrl`
 * mode. A `DATABASE_URL` sitting in that environment is unrelated infra (Prisma,
 * Drizzle, the sync-server) — never an omitted option — so nudging would be a
 * false positive. This is the first-party hosted app's exact shape, where the
 * stray nudge otherwise reaches end-user desktop logs.
 */
let warnedDatabaseUrlEnvIgnored = false;
export function warnIfDatabaseUrlEnvIgnored(
  input: AuthResolveInput,
  warn?: (message: string) => void,
): void {
  if (warnedDatabaseUrlEnvIgnored) return;
  if (input.options.databaseUrl != null) return;
  // Hosted/token path → DATABASE_URL is unrelated infra, not an omitted option.
  if (resolveApiKey(input) != null) return;
  const envUrl = input.env.DATABASE_URL;
  if (typeof envUrl !== 'string' || envUrl.length === 0) return;
  warnedDatabaseUrlEnvIgnored = true;
  const message =
    'Found DATABASE_URL in the environment but `databaseUrl` was not passed to Ablo(...). ' +
    'Ablo no longer auto-adopts DATABASE_URL — the environment value is ignored. ' +
    'To register your Postgres directly, pass `databaseUrl: process.env.DATABASE_URL` explicitly; ' +
    'otherwise ignore this (the hosted sandbox and signed Data Source endpoints need no databaseUrl).';
  if (warn) warn(message);
  else if (typeof console !== 'undefined') console.warn('[Ablo]', message);
}

/**
 * One-time deprecation nudge for the `databaseUrl` direct connector.
 *
 * `databaseUrl` registers the `dedicated` storage mode — Ablo opens a pool INTO
 * the caller's Postgres and writes into it directly. That is the operate-their-
 * database posture we are moving off. Ablo is Stripe-shaped: it hosts only the
 * transaction log (the ordered sync_deltas) + coordination, never your data — your
 * rows always live in your own database. The supported path is the signed Data
 * Source endpoint (`dataSource(...)`), where your app owns the write and your
 * credentials never leave it. See docs/plans/stripe-shaped-storage-posture.md.
 *
 * Still honored at runtime so existing integrations keep working; this only warns
 * once per process (so it never spams) and falls back to `console.warn` when no
 * logger is supplied (the `transport: 'http'`/`'api'` client has none).
 */
let warnedDatabaseUrlDeprecated = false;
export function warnIfDatabaseUrlDeprecated(
  input: AuthResolveInput,
  warn?: (message: string) => void,
): void {
  if (warnedDatabaseUrlDeprecated) return;
  if (input.options.databaseUrl == null) return;
  warnedDatabaseUrlDeprecated = true;
  const message =
    '`databaseUrl` (the direct connector) is deprecated and will be removed from ' +
    'the supported path. It lets Ablo dial into your database; we are moving off ' +
    'that. Ablo hosts only the transaction log — your data stays in your DB. Expose ' +
    'a signed Data Source endpoint (`dataSource(...)`) so your app owns the write, ' +
    'or self-host the engine to keep the log in your infra too. ' +
    'See docs/plans/stripe-shaped-storage-posture.md.';
  if (warn) warn(message);
  else if (typeof console !== 'undefined') console.warn('[Ablo]', message);
}

let warnedCliKeyMismatch = false;
export async function warnIfCliKeyMismatch(
  input: AuthResolveInput,
  warn?: (message: string) => void,
): Promise<void> {
  if (warnedCliKeyMismatch) return;
  if (input.env.NODE_ENV === 'production') return;
  const configured = resolveStaticApiKey(input);
  if (!configured) return;
  const cli = await readCliCredentialSnapshot(input.env);
  if (!cli) return;
  const mismatch = describeCliKeyMismatch(configured, cli);
  if (!mismatch) return;
  warnedCliKeyMismatch = true;
  if (warn) warn(mismatch.message);
  else if (typeof console !== 'undefined') console.warn('[Ablo]', mismatch.message);
}

export const ABLO_HOSTED_API_DOMAIN = 'api.abloatai.com';
export const ABLO_HOSTED_HTTP_BASE_URL = `https://${ABLO_HOSTED_API_DOMAIN}`;
export const ABLO_DEFAULT_BASE_URL = `https://${ABLO_HOSTED_API_DOMAIN}`;

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
    // Canonicalize the scheme to the HTTP family — the WHATWG WebSocket
    // model: accept all four schemes (`http`/`https`/`ws`/`wss`), normalize
    // ONCE at the entry point, and let each layer derive its own protocol
    // (the socket layer maps http→ws / https→wss; fetch uses it as-is).
    // Before this, a `ws://` baseURL reached HTTP consumers un-normalized
    // and the client wedged at startup instead of connecting.
    if (url.protocol === 'ws:') url.protocol = 'http:';
    if (url.protocol === 'wss:') url.protocol = 'https:';

    if (!LEGACY_HOSTED_API_HOSTS.has(url.hostname)) {
      return url.toString().replace(/\/+$/, '');
    }

    url.hostname = ABLO_HOSTED_API_DOMAIN;
    if (url.protocol === 'http:') url.protocol = 'https:';
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
    classifyCredentialKind(input.apiKey) === 'secret'
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
    return ensureApiSuffix(normalizeAbloHostedBaseUrl(input.bootstrapBaseUrl).replace(/^ws/, 'http'));
  }
  const url = normalizeAbloHostedBaseUrl(input.url);
  return ensureApiSuffix(url.replace(/^ws/, 'http'));
}

/**
 * Guarantee the HTTP base ends in the `/api` route segment the sync-server
 * mounts every endpoint under (`apps/sync-server/src/index.ts` — `app.route('/api', …)`).
 *
 * The derive branch always appended `/api`; the override branch did NOT,
 * trusting the caller (apps/web passes `${baseUrl}/api`). But a hosted
 * customer setting a custom `baseURL`/`bootstrapBaseUrl` (their own subdomain,
 * staging, etc.) without the suffix sent every credential exchange to
 * `…/auth/capability` instead of `…/api/auth/capability` → a 404 surfaced as
 * `exchange_failed`. Since the SDK hardcodes routes relative to this base and
 * there is no valid Ablo deployment that serves them off the root, normalizing
 * to a single trailing `/api` here is always correct — and idempotent for
 * callers who already include it.
 */
function ensureApiSuffix(httpBase: string): string {
  const trimmed = httpBase.replace(/\/+$/, '');
  try {
    const u = new URL(trimmed);
    const segments = u.pathname.split('/').filter(Boolean);
    if (segments[segments.length - 1] === 'api') return trimmed;
    u.pathname = `${u.pathname.replace(/\/+$/, '')}/api`;
    return u.toString().replace(/\/+$/, '');
  } catch {
    // Should be unreachable post-`normalizeAbloHostedBaseUrl` (which yields an
    // absolute URL), but fall back to a string check rather than throwing.
    return /\/api$/.test(trimmed) ? trimmed : `${trimmed}/api`;
  }
}
