/**
 * Auth + URL resolution for `Ablo()`.
 *
 * Mirrors the small, focused helpers Anthropic ships in `client.ts`
 * (`apiKeyAuth`, `bearerAuth`, `validateHeaders`). Each function does
 * one thing — resolve a value with the right precedence, or fail
 * with an actionable message — so the constructor reads as a
 * sequence of named decisions rather than a stream of `??`-chains.
 *
 * Precedence for every resolver: explicit option → environment
 * variable → built-in default. The same shape Anthropic, OpenAI,
 * and Stripe SDKs use.
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
  return input.options.authToken ?? input.env.ABLO_AUTH_TOKEN ?? null;
}

export const ABLO_DEFAULT_BASE_URL = 'wss://mesh.ablo.finance';

export function resolveBaseURL(input: AuthResolveInput): string {
  return (
    input.options.baseURL ?? input.env.ABLO_BASE_URL ?? ABLO_DEFAULT_BASE_URL
  );
}

/**
 * Browser guard — apiKey is server-side-only by default. Same check
 * Anthropic, OpenAI, and Stripe ship: shipping `sk_live_...` to a
 * browser exposes it in every visitor's network tab. Consumers opt
 * in explicitly when they have a publishable key or a server proxy.
 */
export function assertBrowserSafety(input: {
  apiKey: string | ApiKeySetter | null;
  dangerouslyAllowBrowser: boolean | undefined;
}): void {
  if (
    !input.dangerouslyAllowBrowser &&
    typeof window !== 'undefined' &&
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
  return input.bootstrapBaseUrl ?? `${input.url.replace(/^ws/, 'http')}/api`;
}
