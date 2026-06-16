/**
 * Credential POLICY — the single source of truth for "what KIND of credential
 * did the caller hand us, and what do we DO with it at connect time".
 *
 * Before this module the prefix-dispatch decision (`sk_`/`ek_`/`rk_`/`pk_`) was
 * re-implemented with raw `startsWith()` sniffs in ~5 places (identity.ts ×3,
 * auth.ts browser guard, cli/dev.ts, cli/push.ts) and the connect-time routing
 * lived as a 4-branch if/elif tree inside `resolveParticipantIdentity`. Folding
 * the policy here keeps the kind-taxonomy and the connect decision in ONE place;
 * the consumers below just call into it.
 *
 * This module is deliberately POLICY-ONLY. It does NOT own the auth primitives
 * (`exchangeApiKey` / `mintUserSessionKey` / `resolveIdentity`), the credential
 * lifecycle (`startCredentialLifecycle` / refresh scheduler), or the connection
 * FSM — those are correctly distributed consumers. `resolveCredential` DELEGATES
 * to injected primitives rather than reimplementing any HTTP mint call.
 *
 * Browser-safe: `classifyCredentialKind` is a pure-string helper and MUST NOT
 * import the Node-only `keys` module (`node:crypto`). The key-prefix contract it
 * encodes mirrors `keys/index.ts`'s `KIND_BY_PREFIX` (the Stripe-style model:
 * sk_=secret, rk_=restricted, ek_=ephemeral, pk_=publishable) but stays a plain
 * prefix lookup so it can ship in the client bundle.
 */

import { AbloAuthenticationError } from '../errors.js';
import type { exchangeApiKey, mintUserSessionKey, resolveIdentity } from './index.js';
import type { resolveApiKeyValue } from '../client/auth.js';

/**
 * The four Ablo API-key kinds (Stripe-style). Prefix contract — kept in lockstep
 * with `keys/index.ts` `API_KEY_KINDS` / `KIND_BY_PREFIX`, but declared locally
 * so this browser-safe module never pulls in `node:crypto`.
 */
export type CredentialKind = 'secret' | 'ephemeral' | 'restricted' | 'publishable';

const KIND_BY_PREFIX: ReadonlyArray<readonly [string, CredentialKind]> = [
  ['sk_', 'secret'],
  ['ek_', 'ephemeral'],
  ['rk_', 'restricted'],
  ['pk_', 'publishable'],
];

/**
 * Lightweight, browser-safe prefix → kind classifier. The SINGLE source of truth
 * for prefix dispatch across the SDK (connect routing, the browser guard, the
 * CLI key-gating). Returns `null` for a value that carries no recognized Ablo
 * key prefix (a caller-supplied capability/auth token, an empty/garbage value).
 *
 * Pure string check — does NOT validate the checksum or environment segment
 * (that's `keys/index.ts` `parseApiKey`, which is Node-only). This is only the
 * "which of the four buckets" decision.
 */
export function classifyCredentialKind(value: string): CredentialKind | null {
  for (const [prefix, kind] of KIND_BY_PREFIX) {
    if (value.startsWith(prefix)) return kind;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────

/**
 * Auth primitives injected into {@link resolveCredential}. Each is the canonical
 * implementation from `auth/index.ts` / `client/auth.ts`; the policy DELEGATES to
 * them so the HTTP mint logic stays in ONE place and only the routing decision
 * lives here. `mintUserSessionKey` is carried for completeness of the primitive
 * surface (the browser/session path mints it before connect); `resolveCredential`
 * never re-mints it — a pre-minted `ek_` arrives ready to use.
 */
export interface CredentialPrimitives {
  readonly exchangeApiKey: typeof exchangeApiKey;
  readonly mintUserSessionKey: typeof mintUserSessionKey;
  readonly resolveIdentity: typeof resolveIdentity;
  readonly resolveApiKeyValue: typeof resolveApiKeyValue;
}

export interface ResolveCredentialContext {
  readonly primitives: CredentialPrimitives;
  /**
   * Build the argument bag for the hosted exchange. identity.ts owns the baseUrl
   * derivation + participant scope, so it supplies the args; the policy invokes
   * `primitives.exchangeApiKey` with them. The `apiKey` is filled in by the policy
   * from the resolved value.
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
  readonly configuredApiKey: string | (() => Promise<string | null>) | null;
  /** Explicit caller-supplied capability token (`options.capabilityToken`). */
  readonly capabilityToken: string | undefined;
  /** Configured static `authToken`. */
  readonly authToken: string | null;
  /** True once the caller knows its own identity (legacy explicit path). */
  readonly hasExplicitIdentity: boolean;
}

/**
 * The connect-time decision, expressed as a discriminated union over the routing
 * kind (NOT the raw key kind — `ek_` and `rk_` collapse into the same
 * `pre-minted` route, and a bare capability token routes the same way). The
 * caller (`identity.ts`) switches on `kind` and performs the scope/side-effect
 * wiring each route needs.
 *
 * Fields carry exactly what each branch in the old if/elif tree produced:
 *   - `getBearer`        — the token to authenticate the bootstrap/`/auth/*` HTTP
 *                          and to seed the credential source with.
 *   - `expiresAtMs`      — exchange expiry (drives the refresh scheduler) or null
 *                          when the credential never expires / nothing to refresh.
 *   - `controlPlaneKey`  — the ORIGINAL configured apiKey when the route minted
 *                          via exchange (so a refresh can re-mint), else null.
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
      readonly controlPlaneKey: string | (() => Promise<string | null>);
    }
  /** Pre-minted `ek_`/`rk_` OR an explicit capability/auth token — used AS-IS as
   *  the bearer (never exchanged). Identity resolved via `/auth/identity`. */
  | {
      readonly kind: 'pre-minted';
      readonly getBearer: string;
      readonly expiresAtMs: null;
      readonly controlPlaneKey: null;
    }
  /** Legacy explicit — caller knows its own organizationId + user/agentId. No
   *  server round-trip; the (optional) bearer is the initial cap token. */
  | {
      readonly kind: 'explicit';
      readonly getBearer: string | undefined;
      readonly expiresAtMs: null;
      readonly controlPlaneKey: null;
    };

/**
 * Connect-time credential routing — absorbs the decision tree that used to live
 * inline in `resolveParticipantIdentity`. Classifies the configured apiKey, then
 * routes to one of four outcomes, DELEGATING the actual HTTP exchange to the
 * injected `exchangeApiKey` primitive. The caller switches on
 * `ResolvedCredential.kind` to perform scope wiring + scheduler setup.
 *
 * Routing (preserves the old branch order exactly):
 *   0. `pk_` + no explicit cap token → `publishable` (direct bearer, no refresh).
 *   1. exchangeable apiKey (any prefix that ISN'T a pre-minted `ek_`/`rk_`) +
 *      no explicit cap token → `exchange` (hosted-cloud round-trip + scheduler).
 *   2. otherwise, identity unknown → `pre-minted` (use the cap token as-is). Throws
 *      `session_expired` when there is no token to authenticate `/auth/identity`.
 *   3. otherwise (identity known) → `explicit` (legacy self-hosted, no round-trip).
 */
export async function resolveCredential(
  input: ResolveCredentialInput,
  ctx: ResolveCredentialContext,
): Promise<ResolvedCredential> {
  const { apiKeyValue, capabilityToken, authToken, hasExplicitIdentity } = input;

  const kind = apiKeyValue != null ? classifyCredentialKind(apiKeyValue) : null;

  // A pre-minted capability bearer (`ek_` ephemeral / `rk_` restricted) is NOT
  // exchangeable — it was already minted into the credential source before
  // connect and must be USED DIRECTLY as the bearer (Route 2), never sent through
  // `exchangeApiKey` (Route 1, which expects an `sk_`).
  const isPreMintedCapabilityBearer =
    kind === 'ephemeral' || kind === 'restricted';

  const initialCapToken =
    capabilityToken ??
    (isPreMintedCapabilityBearer ? apiKeyValue ?? undefined : undefined) ??
    authToken ??
    undefined;

  // Route 0: publishable key (`pk_`) — long-lived, browser-safe, READ-ONLY. Used
  // DIRECTLY as the bearer; never exchanged → never expires → nothing to refresh.
  if (apiKeyValue != null && kind === 'publishable' && capabilityToken == null) {
    return {
      kind: 'publishable',
      getBearer: apiKeyValue,
      expiresAtMs: null,
      controlPlaneKey: null,
    };
  }

  // Route 1: hosted-cloud (secret/exchangeable apiKey, no caller-supplied cap
  // token). A pre-minted `ek_`/`rk_` is NOT exchangeable → falls through.
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

  // Route 2: self-derived / pre-minted (use the cap token as-is). Reached when
  // identity is NOT caller-supplied.
  if (!hasExplicitIdentity) {
    if (initialCapToken == null) {
      // No apiKey to exchange (Route 1) and no caller-supplied identity (Route 3),
      // so `initialCapToken` is the only thing that could authenticate
      // `/auth/identity`. Absent — commonly the function `apiKey` resolver
      // returning `null` (no/expired session) — surface the real, re-auth-able
      // condition locally instead of making a doomed round-trip.
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

  // Route 3: legacy explicit (self-hosted — caller knows its own
  // organizationId + user/agentId).
  return {
    kind: 'explicit',
    getBearer: initialCapToken,
    expiresAtMs: null,
    controlPlaneKey: null,
  };
}
