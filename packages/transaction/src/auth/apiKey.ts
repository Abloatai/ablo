/**
 * Authentication and URL resolution for the `Ablo()` client.
 *
 * Each function here makes one decision: it resolves a configuration value with
 * the right precedence, or fails with an actionable message. Together they let
 * the client constructor read as a sequence of named steps rather than a chain
 * of fallbacks.
 *
 * The environment surface is deliberately small: `ABLO_API_KEY` is the only
 * value read from the environment. Every other routing or authentication
 * override is an explicit option, so an app never picks up hidden behavior from
 * a stray environment variable.
 */

import { AbloAuthenticationError, AbloValidationError } from '../errors.js';
import { classifyCredentialKind } from './credentialKind.js';
import { ABLO_DEFAULT_BASE_URL } from './hostedEndpoints.js';
import { normalizeAbloBaseUrl } from './baseUrl.js';
import type { KeyEnvironment } from '../environment.js';
import { isCredentialEndpoint } from './credentialEndpoint.js';
import {
  credentialToken,
  type CredentialProvider,
  type CredentialProviderResult,
} from './credentialResult.js';
import type { SessionSource } from '../sessions/contract.js';
import {
  assertBrowserSafety,
  protectBrowserCredentialProvider,
} from './browserCredentialSafety.js';
import { resolveSessionCredential } from '../sessions/source.js';
export { assertBrowserSafety };

/**
 * The credential-resolver callable type. It is defined alongside
 * {@link createEndpointCredentialResolver} in `./credentialEndpoint` and
 * re-exported here so importers of this module keep working. See that module
 * for the full contract.
 */
export type { CredentialProvider } from './credentialResult.js';

/**
 * The client options that decide a credential.
 *
 * This is the ONE declaration of that set. The resolvers below read it, and the
 * transport configs that accept these options derive from it rather than
 * listing the fields again.
 */
export interface AuthClientOptions {
  readonly apiKey?: string | CredentialProvider | null;
  /** A scoped session, its renewal provider, or a browser session endpoint. */
  readonly session?: SessionSource | null;
  /** A token the caller already has, used as-is. */
  readonly authToken?: string | null;
  readonly baseURL?: string | null;
  readonly dangerouslyAllowBrowser?: boolean;
  readonly fetch?: typeof globalThis.fetch;
}

export interface AuthResolveInput {
  /**
   * The full set of options the caller passed to the client constructor. Each
   * resolver reads only the fields it needs; passing the whole object avoids
   * threading many separate parameters through every helper.
   */
  readonly options: AuthClientOptions;
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
): string | CredentialProvider | null {
  const configured = input.options.apiKey;
  const session = input.options.session;
  if (session != null) {
    if (configured != null || input.options.authToken != null) {
      throw new AbloValidationError(
        'Ablo: pass `session`, `apiKey`, or `authToken` — not more than one.',
        { code: 'invalid_options', param: 'session' },
      );
    }
    return resolveSessionCredential(session, input.options);
  }
  if (typeof configured === 'string' && isCredentialEndpoint(configured)) {
    throw new AbloValidationError(
      '`apiKey` does not accept an endpoint. Use `session: { endpoint }`.',
      { code: 'invalid_options', param: 'apiKey' },
    );
  }
  if (typeof configured === 'function') {
    return protectBrowserCredentialProvider(
      configured,
      input.options.dangerouslyAllowBrowser,
    );
  }
  return configured ?? input.env.ABLO_API_KEY ?? null;
}

/**
 * Narrow a resolved `apiKey` to the single resolver the credential lifecycle
 * needs: an async `() => token | null`, or `null` when auth is static — a plain
 * long-lived key string with no refresh, which is the common case.
 *
 * A renewable session or browser session endpoint resolves to a credential
 * provider, and the SDK then drives the whole credential lifecycle
 * from it: mint-before-connect, the proactive refresh timer with its
 * wake/online/focus re-mint, and the reactive `credential_stale` re-mint. The
 * resolver follows the provider contract end to end: resolve a token,
 * resolve `null` when the login is gone (terminal — surfaces `session_expired`
 * and signs the user out), or throw on a transient failure (backs off, without
 * signing out).
 */
export function resolveCredentialResolver(
  apiKey: string | CredentialProvider | null,
): CredentialProvider | null {
  if (typeof apiKey === 'function') return apiKey;
  return null;
}

export function resolveAuthToken(input: AuthResolveInput): string | null {
  return input.options.authToken ?? null;
}

/**
 * The credential axis, not a second copy of it. `environment.ts` documents two
 * incidents caused by conflating the plane a request runs on with the mode a
 * credential was minted in, and states the credential axis must not grow when
 * planes do — so the CLI mismatch path reads the canonical vocabulary rather
 * than restating its members here.
 */
type CliMode = KeyEnvironment;
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

/** Infer the sandbox or production mode from an Ablo key's prefix. */
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
      sandbox: sandbox && typeof sandbox === 'object' ? sandbox : undefined,
      production: production && typeof production === 'object' ? production : undefined,
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
      sandbox: sandbox && typeof sandbox === 'object' ? sandbox : undefined,
      production: production && typeof production === 'object' ? production : undefined,
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
  // Node-only runtime import (CLI credential snapshot). The call is dead in
  // browser/edge builds — guarded by `process.versions.node` and `window`
  // checks in the callers — but bundlers still try to resolve the dynamic
  // `import()` and Turbopack fails the build on the unanalyzable specifier.
  // The magic comments tell each bundler to emit the import verbatim and never
  // resolve it. Keep both so webpack and Turbopack consumers are covered.
  return import(/* webpackIgnore: true */ /* turbopackIgnore: true */ specifier) as Promise<T>;
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
      ? { storedKey: profiles[activeProfile][effectiveMode].apiKey }
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

// Declared in `./hostedEndpoints`, the single source of the hosted domain, and
// re-exported here so existing import paths keep working.
export { ABLO_HOSTED_API_DOMAIN, ABLO_HOSTED_HTTP_BASE_URL, ABLO_DEFAULT_BASE_URL } from './hostedEndpoints.js';

export function resolveBaseURL(input: AuthResolveInput): string {
  return normalizeAbloBaseUrl(input.options.baseURL ?? ABLO_DEFAULT_BASE_URL);
}

/**
 * Guards against using a secret `apiKey` in a browser. A secret key is
 * server-side only by default: shipping an `sk_live_...` key to a browser would
 * expose it in every visitor's network tab. Callers opt in explicitly when the
 * browser instead holds a minted session token (`ek_`/`rk_`) or routes through a
 * server proxy. Throws {@link AbloAuthenticationError} when a secret key is
 * detected in a browser without opt-in.
 */
/**
 * Rejects the REMOVED `databaseUrl` dial-in option loudly. The option is gone
 * from the types, but an untyped or stale caller could still pass it — and
 * silently ignoring it would reroute their writes to Ablo-hosted storage,
 * the opposite of what that option used to promise. A construction-time throw
 * turns a wrong-storage surprise into a clear migration instruction.
 */
export function rejectRemovedDatabaseUrlOption(options: object): void {
  const legacyValue: unknown = Reflect.get(options, 'databaseUrl');
  if (legacyValue == null) return;
  throw new AbloValidationError(
    'The `databaseUrl` option was removed. Your database connects through ' +
      '`ablo connect` now: Ablo writes it directly with a scoped DML role and ' +
      'confirms through its replication stream. Run `npx ablo connect` to ' +
      'register it, then construct the client with your API key only.',
    { code: 'invalid_body' },
  );
}

/**
 * Resolves a credential provider to its current string value, or
 * returns a plain string key as-is. Called at request time so a rotating
 * credential picks up new values between requests. Returns `null` when no key
 * was configured.
 */
export async function resolveApiKeyValue(
  apiKey: string | CredentialProvider | null,
): Promise<string | null> {
  return credentialToken(await resolveCredentialValue(apiKey));
}

/** Resolve without discarding session expiry metadata needed by live clients. */
export async function resolveCredentialValue(
  apiKey: string | CredentialProvider | null,
): Promise<CredentialProviderResult> {
  if (apiKey == null) return null;
  if (typeof apiKey === 'function') return apiKey();
  return apiKey;
}

/**
 * Translates a WebSocket URL into the matching HTTP API base URL, defaulting to
 * `${url}/api` when the caller has not overridden `bootstrapBaseUrl`. The
 * bootstrap helper, the hydration coordinator, the credential-exchange flow, and
 * the identity flow all derive their base URL through this one function, so the
 * derivation stays consistent across them.
 *
 * When both `wss://` and `https://` are valid, the ws-to-http rewrite preserves
 * the protocol family: ws becomes http and wss becomes https.
 */
export function resolveBootstrapBaseUrl(input: {
  readonly url: string;
  readonly bootstrapBaseUrl?: string;
}): string {
  // Both paths go through `normalizeAbloBaseUrl`, which canonicalizes ws to
  // http and wss to https. That matters most on the override, which legitimately
  // arrives with a WebSocket scheme when a caller derives it as `${baseUrl}/api`
  // from a WebSocket base URL: this URL is used for HTTP fetches (identity
  // resolution, credential exchange, and bootstrap), and `fetch` rejects ws and
  // wss outright.
  // `||`, not `??`: an empty override is an absent override, and should fall
  // through to the client's own URL rather than to the hosted default.
  return ensureApiSuffix(normalizeAbloBaseUrl(input.bootstrapBaseUrl || input.url));
}

/**
 * Ensures the HTTP base ends in the `/api` route segment that every endpoint is
 * mounted under.
 *
 * A hosted deployment that sets a custom `baseURL` or `bootstrapBaseUrl` (a
 * custom subdomain, a staging host, and so on) without the `/api` suffix would
 * send every credential exchange to `…/v1/capabilities` instead of
 * `…/api/v1/capabilities`, producing a 404 that surfaces as `exchange_failed`.
 * Since the client builds routes relative to this base and no valid deployment
 * serves them from the root, appending a single trailing `/api` here is always
 * correct, and it is idempotent for callers who already include it.
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
    // Should be unreachable after `normalizeAbloBaseUrl`, which yields an
    // absolute URL, but fall back to a string check rather than throwing.
    return trimmed.endsWith("/api") ? trimmed : `${trimmed}/api`;
  }
}
