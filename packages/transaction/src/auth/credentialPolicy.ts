/**
 * Decides what a credential is and how to use it when a client connects. A
 * caller configures an Ablo client with an API key, and this module answers two
 * questions about that value: which of the four key kinds it is, and which
 * connect-time route it takes.
 *
 * The routing decision is the only thing that lives here. This module does not
 * perform the network calls that mint or exchange credentials;
 * {@link resolveCredential} delegates those to primitives the caller supplies,
 * so the decision of what to do stays separate from the work of doing it.
 *
 * {@link classifyCredentialKind} is a plain string check with no Node
 * dependencies, so it is safe to run in a browser bundle. It recognizes the key
 * prefixes `sk_` (secret), `rk_` (restricted), `ek_` (ephemeral), and `pk_`
 * (publishable), but does not validate a key's checksum or environment segment.
 */

import { AbloAuthenticationError } from '../errors.js';
import type { exchangeApiKey, mintUserSessionKey, resolveIdentity } from './runtime.js';
import {
  classifyCredentialKind,
  type CredentialKind,
} from './credentialKind.js';
import type { CredentialProvider } from './credentialResult.js';

/**
 * The shape of the function that resolves a configured `apiKey` — which may be a
 * string or an async setter — down to a concrete string, or `null` when no key
 * is available. It is declared here structurally, rather than imported, to avoid
 * a circular dependency between this module and the code that supplies the
 * function. Any function with a matching shape satisfies it.
 */
type ResolveApiKeyValueFn = (
  apiKey: string | CredentialProvider | null,
) => Promise<string | null>;

/**
 * The four kinds of Ablo API key, one per prefix: `sk_` is secret, `ek_` is
 * ephemeral, `rk_` is restricted, and `pk_` is publishable. The list is declared
 * here, rather than imported, so this browser-safe module stays free of Node-only
 * dependencies.
 */
export { classifyCredentialKind, type CredentialKind };

// ─────────────────────────────────────────────────────────────────────

/**
 * The set of authentication primitives that {@link resolveCredential} delegates
 * to. Injecting them keeps the network calls that mint and exchange credentials
 * in one place and leaves this module responsible only for the routing decision.
 * {@link resolveCredential} never calls `mintUserSessionKey` itself — an
 * ephemeral `ek_` key is minted before the client connects and arrives ready to
 * use — but it is listed here to describe the full primitive surface.
 */
export interface CredentialPrimitives {
  readonly exchangeApiKey: typeof exchangeApiKey;
  readonly mintUserSessionKey: typeof mintUserSessionKey;
  readonly resolveIdentity: typeof resolveIdentity;
  readonly resolveApiKeyValue: ResolveApiKeyValueFn;
}

export interface ResolveCredentialContext {
  readonly primitives: CredentialPrimitives;
  /**
   * The arguments for the credential exchange, minus the `apiKey`. The caller
   * derives the base URL and participant scope and supplies them here;
   * {@link resolveCredential} fills in the resolved `apiKey` and calls
   * `exchangeApiKey`.
   */
  readonly exchangeArgs: Omit<
    Parameters<typeof exchangeApiKey>[0],
    'apiKey'
  >;
}

export interface ResolveCredentialInput {
  /** Resolved string value of the configured `apiKey` (callable already invoked), or null. */
  readonly apiKeyValue: string | null;
  /** The configured `apiKey` (string or setter) — threaded onto the refresh path. */
  readonly configuredApiKey: string | CredentialProvider | null;
  /** Explicit caller-supplied capability token (`options.capabilityToken`). */
  readonly capabilityToken: string | undefined;
  /** Configured static `authToken`. */
  readonly authToken: string | null;
  /** True when the caller already knows its own identity, so no server round-trip is needed to resolve it. */
  readonly hasExplicitIdentity: boolean;
}

/**
 * The outcome of the connect-time decision, as a discriminated union over the
 * route rather than the key kind: an `ek_` and an `rk_` key both take the
 * `pre-minted` route, as does a bare capability token. The caller switches on
 * `kind` and wires up the scope and side effects each route needs.
 *
 * Every variant carries the same three fields:
 *   - `getBearer` — the token used to authenticate the bootstrap and `/auth/*`
 *     requests, and to seed the credential source.
 *   - `expiresAtMs` — when the credential expires, which drives the refresh
 *     scheduler, or `null` when there is nothing to refresh.
 *   - `controlPlaneKey` — the original configured API key when the route minted
 *     its bearer through an exchange, so a refresh can mint again; otherwise
 *     `null`.
 */
export type ResolvedCredential =
  /** `pk_` — long-lived browser-safe read-only project key. Used directly as the
   *  bearer; never exchanged, never refreshed. Identity resolved via `/auth/identity`. */
  | {
      readonly kind: 'publishable';
      readonly getBearer: string;
      readonly expiresAtMs: null;
      readonly controlPlaneKey: null;
    }
  /** `sk_` (no explicit cap token) — hosted-cloud. Exchanged for a capability
   *  token via `exchangeApiKey`; the refresh scheduler re-mints before expiry. */
  | {
      readonly kind: 'exchange';
      /** Result of the initial `exchangeApiKey` call. */
      readonly exchange: Awaited<ReturnType<typeof exchangeApiKey>>;
      readonly getBearer: string;
      readonly expiresAtMs: number;
      /** The configured apiKey (string or setter) — read fresh on each refresh. */
      readonly controlPlaneKey: string | CredentialProvider;
    }
  /** A pre-minted `ek_` or `rk_` key, or an explicit capability or auth token,
   *  used as the bearer without any exchange. Identity resolved via `/auth/identity`. */
  | {
      readonly kind: 'pre-minted';
      readonly getBearer: string;
      readonly expiresAtMs: null;
      readonly controlPlaneKey: null;
    }
  /** The caller already knows its own organization and user or agent id, so there
   *  is no server round-trip; the optional bearer is the initial capability token. */
  | {
      readonly kind: 'explicit';
      readonly getBearer: string | undefined;
      readonly expiresAtMs: null;
      readonly controlPlaneKey: null;
    };

/**
 * Routes a configured API key to its connect-time outcome. It classifies the
 * key, then returns one of four {@link ResolvedCredential} variants, delegating
 * any credential exchange to the injected `exchangeApiKey` primitive. The caller
 * switches on the result's `kind` to wire up scope and the refresh scheduler.
 *
 * The routes, in the order they are tried:
 *   0. A `pk_` key with no explicit capability token becomes `publishable`: used
 *      directly as the bearer, with no refresh.
 *   1. Any other exchangeable key (one that is not a pre-minted `ek_` or `rk_`)
 *      with no explicit capability token becomes `exchange`: a round-trip mints a
 *      capability token, and the refresh scheduler renews it before it expires.
 *   2. Otherwise, when the caller's identity is not yet known, the result is
 *      `pre-minted`: the capability token is used as-is. Throws `session_expired`
 *      when there is no token to authenticate `/auth/identity`.
 *   3. Otherwise, when the caller already knows its identity, the result is
 *      `explicit`, with no round-trip.
 */
export async function resolveCredential(
  input: ResolveCredentialInput,
  ctx: ResolveCredentialContext,
): Promise<ResolvedCredential> {
  const { apiKeyValue, capabilityToken, authToken, hasExplicitIdentity } = input;

  const kind = apiKeyValue != null ? classifyCredentialKind(apiKeyValue) : null;

  // A pre-minted capability bearer (an ephemeral `ek_` or restricted `rk_` key)
  // is not exchangeable: it was minted before connect and is used directly as the
  // bearer on Route 2, never sent through `exchangeApiKey`, which expects an `sk_`.
  const isPreMintedCapabilityBearer =
    kind === 'ephemeral' || kind === 'restricted';

  const initialCapToken =
    capabilityToken ??
    (isPreMintedCapabilityBearer ? apiKeyValue : undefined) ??
    authToken ??
    undefined;

  // Route 0: a publishable `pk_` key — long-lived, browser-safe, and read-only.
  // Used directly as the bearer; it is never exchanged, so it never expires and
  // there is nothing to refresh.
  if (apiKeyValue != null && kind === 'publishable' && capabilityToken == null) {
    return {
      kind: 'publishable',
      getBearer: apiKeyValue,
      expiresAtMs: null,
      controlPlaneKey: null,
    };
  }

  // Route 1: an exchangeable key (such as a secret `sk_`) with no caller-supplied
  // capability token. A pre-minted `ek_` or `rk_` is not exchangeable and falls
  // through to the next route.
  if (
    apiKeyValue != null &&
    capabilityToken == null &&
    !isPreMintedCapabilityBearer
  ) {
    const exchange = await ctx.primitives.exchangeApiKey({
      ...ctx.exchangeArgs,
      apiKey: apiKeyValue,
    });
    return {
      kind: 'exchange',
      exchange,
      getBearer: exchange.token,
      expiresAtMs: Date.parse(exchange.expiresAt),
      controlPlaneKey: input.configuredApiKey ?? apiKeyValue,
    };
  }

  // Route 2: pre-minted — use the capability token as-is. Reached when the
  // caller's identity was not supplied.
  if (!hasExplicitIdentity) {
    if (initialCapToken == null) {
      // With no key to exchange and no caller-supplied identity, this token is the
      // only thing that could authenticate `/auth/identity`. When it is absent —
      // commonly a function `apiKey` resolver returning `null` for a missing or
      // expired session — report the re-authenticable condition here instead of
      // making a round-trip that is bound to fail.
      throw new AbloAuthenticationError(
        'No auth token available to resolve identity — the session token is ' +
          'missing or expired. Ensure your `apiKey` resolver returns a valid token, or ' +
          'pass a static `apiKey` / `capabilityToken`.',
        { code: 'session_expired' },
      );
    }
    return {
      kind: 'pre-minted',
      getBearer: initialCapToken,
      expiresAtMs: null,
      controlPlaneKey: null,
    };
  }

  // Route 3: explicit — the caller already knows its own organization and user
  // or agent id.
  return {
    kind: 'explicit',
    getBearer: initialCapToken,
    expiresAtMs: null,
    controlPlaneKey: null,
  };
}
