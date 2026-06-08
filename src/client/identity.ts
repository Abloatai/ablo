/**
 * Participant identity + scope resolution for `Ablo()`.
 *
 * Three branches, mirroring the three auth paths the SDK supports:
 *
 *   1. **Hosted-cloud** — caller passed `apiKey`. SDK exchanges it
 *      server-side for a capability token + scope blob, then sets
 *      up a refresh scheduler that re-mints transparently before
 *      expiry.
 *   2. **Self-derived** — caller passed an authToken / capability
 *      token but the SDK doesn't yet know the identity. Calls
 *      `resolveIdentity` against the bootstrap endpoint to recover
 *      `participantId` + scope from the token.
 *   3. **Legacy explicit** — self-hosted callers that pass
 *      `organizationId` + `user.id` (or `agentId`) directly. No
 *      server round-trip; SDK trusts the caller.
 *
 * Extracted from `Ablo.ts` so each branch is testable in isolation
 * and the constructor body reads as a single named call rather than
 * a 100+-line if/elif/else with three different side-effect chains.
 */

import { AbloAuthenticationError } from '../errors.js';
import { exchangeApiKey } from '../auth/index.js';
import { resolveIdentity } from '../auth/index.js';
import {
  createRefreshScheduler,
  type RefreshScheduler,
} from '../auth/index.js';
import type { BootstrapHelper } from '../sync/BootstrapHelper.js';
import type { SyncLogger } from '../interfaces/index.js';
import type { AuthCredentialSource } from '../auth/credentialSource.js';
import type { ApiKeySetter } from './auth.js';
import { resolveApiKeyValue, resolveBootstrapBaseUrl } from './auth.js';

export interface IdentityResolveInput {
  readonly options: {
    readonly capabilityToken?: string;
    readonly bootstrapBaseUrl?: string;
    readonly user?: { id: string; teamIds?: string[] };
    readonly agentId?: string;
    readonly syncGroups?: string[];
  };
  readonly internalOptions: { readonly organizationId?: string };
  readonly url: string;
  readonly kind: 'user' | 'agent' | 'system';
  readonly configuredApiKey: string | ApiKeySetter | null;
  readonly configuredAuthToken: string | null;
  readonly bootstrapHelper: BootstrapHelper;
  readonly auth: AuthCredentialSource;
  readonly logger: SyncLogger;
}

export interface ResolvedIdentity {
  readonly userId: string;
  readonly accountScope: string;
  readonly teamIds: string[] | undefined;
  readonly capabilityToken: string | undefined;
  readonly syncGroups: readonly string[] | undefined;
  readonly participantKind: 'user' | 'agent' | 'system';
  /** Non-null on the hosted-cloud path; caller stores it for shutdown. */
  readonly refreshScheduler: RefreshScheduler | null;
}

export async function resolveParticipantIdentity(
  input: IdentityResolveInput,
): Promise<ResolvedIdentity> {
  const {
    options,
    internalOptions,
    url,
    kind,
    configuredApiKey,
    configuredAuthToken,
    bootstrapHelper,
    auth,
    logger,
  } = input;

  const apiKeyValue = await resolveApiKeyValue(configuredApiKey);
  const initialCapToken =
    options.capabilityToken ?? configuredAuthToken ?? undefined;

  // Branch 0: publishable key (`pk_`) — a long-lived, browser-safe, READ-ONLY
  // project key. Unlike a secret `sk_` (Branch 1), it is used DIRECTLY as the
  // bearer and is NEVER exchanged for a short-lived capability — so it never
  // expires and there is nothing to refresh (no `credential_stale`, no
  // wake-from-sleep re-mint). The sync-server's `apiKeyProvider` resolves the
  // org + read-only scope from the key itself; we still call `/auth/identity`
  // (authenticated by the `pk_` bearer) to learn the account scope + syncGroups
  // for the bootstrap cache. Plain `startsWith` check because the `keys` module
  // is node-only (`node:crypto`) and must not enter the browser bundle.
  if (apiKeyValue && apiKeyValue.startsWith('pk_') && !options.capabilityToken) {
    const baseUrl = resolveBootstrapBaseUrl({
      url,
      bootstrapBaseUrl: options.bootstrapBaseUrl,
    });
    const identity = await resolveIdentity({ baseUrl, authToken: apiKeyValue });
    const callerGroups = options.syncGroups ?? [];
    const mergedSyncGroups =
      callerGroups.length > 0
        ? [...new Set([...callerGroups, ...identity.syncGroups])]
        : identity.syncGroups;
    bootstrapHelper.setCacheScope(identity.accountScope);
    bootstrapHelper.setSyncGroups(mergedSyncGroups);
    auth.setAuthToken(apiKeyValue);
    return {
      userId: identity.participantId,
      accountScope: identity.accountScope,
      teamIds: undefined,
      capabilityToken: apiKeyValue,
      syncGroups: mergedSyncGroups,
      participantKind: identity.participantKind,
      refreshScheduler: null,
    };
  }

  // Branch 1: hosted-cloud (apiKey only, no caller-supplied capability token)
  if (apiKeyValue && !options.capabilityToken) {
    return resolveHosted({
      apiKeyValue,
      configuredApiKey,
      url,
      kind,
      options,
      bootstrapHelper,
      auth,
      logger,
    });
  }

  // Branch 2: self-derived (capability token present, identity unknown)
  if (
    !internalOptions.organizationId ||
    (kind === 'agent' ? !options.agentId : !options.user?.id)
  ) {
    // Fail fast on the missing-credential case. We're here because there's no
    // apiKey (Branch 1) and the identity isn't caller-supplied (Branch 3), so
    // `initialCapToken` is the only thing that can authenticate the
    // `/auth/identity` call. When it's absent — the common cause being
    // `getToken()` resolving to `null` (no/expired session, see
    // `getSyncCapabilityToken`) — the request can only come back as the server's
    // opaque `identity_resolve_failed: no_matching_provider`. Surface the real
    // condition locally instead: `session_expired` is the registered,
    // re-authenticate-able code, and we never make a doomed round-trip.
    if (!initialCapToken) {
      throw new AbloAuthenticationError(
        'No auth token available to resolve identity — the session token is ' +
          'missing or expired. Ensure `getToken()` returns a valid token, or ' +
          'pass `apiKey` / `capabilityToken`.',
        { code: 'session_expired' },
      );
    }
    // Single source of truth for the http(s) base — coerces ws/wss → http/https
    // even when `bootstrapBaseUrl` is an explicit override (see auth.ts).
    const baseUrl = resolveBootstrapBaseUrl({
      url,
      bootstrapBaseUrl: options.bootstrapBaseUrl,
    });
    const identity = await resolveIdentity({
      baseUrl,
      authToken: initialCapToken,
	    });
	    // Merge caller-passed syncGroups with server-resolved ones rather
	    // than letting the server's response silently overwrite. Browser
	    // consumers (apps/web's SyncEngineProvider) compose
	    // `['default', 'org:${orgId}', 'user:${userId}', ...team:]` from
	    // the resolved session and pass it via `<AbloProvider syncGroups>`;
	    // before this merge, Branch 2 dropped that set on the floor in
	    // favor of `/auth/identity`'s response, which is empty for
	    // cookie-auth users today (apps/sync-server/src/routes/auth.ts only
	    // populates from `effectiveSyncGroups`, the cap-narrowed list).
	    // Empty syncGroups → server bootstrap falls back to `['default']`
	    // → no deltas fan out → live updates appear only on hard reload.
	    const callerGroups = options.syncGroups ?? [];
	    const mergedSyncGroups =
	      callerGroups.length > 0
	        ? [...new Set([...callerGroups, ...identity.syncGroups])]
	        : identity.syncGroups;
	    bootstrapHelper.setCacheScope(identity.accountScope);
	    bootstrapHelper.setSyncGroups(mergedSyncGroups);
	    auth.setAuthToken(initialCapToken);
	    return {
      userId: identity.participantId,
      accountScope: identity.accountScope,
      teamIds: undefined,
      capabilityToken: initialCapToken,
      syncGroups: mergedSyncGroups,
      participantKind: identity.participantKind,
      refreshScheduler: null,
    };
  }

  // Branch 3: legacy explicit (self-hosted, pre-Phase-3 — caller knows
  // its own organizationId + user/agentId).
  const userId = kind === 'agent' ? options.agentId! : options.user!.id;
	  const accountScope = internalOptions.organizationId;
	  bootstrapHelper.setCacheScope(accountScope);
	  bootstrapHelper.setSyncGroups(options.syncGroups);
	  auth.setAuthToken(initialCapToken);
	  return {
    userId,
    accountScope,
    teamIds: kind === 'user' ? options.user?.teamIds : undefined,
    capabilityToken: initialCapToken,
    syncGroups: options.syncGroups,
    participantKind: kind,
    refreshScheduler: null,
  };
}

interface HostedInput {
  readonly apiKeyValue: string;
  readonly configuredApiKey: string | ApiKeySetter | null;
  readonly url: string;
  readonly kind: 'user' | 'agent' | 'system';
  readonly options: IdentityResolveInput['options'] & {
    readonly bootstrapBaseUrl?: string;
    readonly user?: { id: string };
    readonly agentId?: string;
  };
  readonly bootstrapHelper: BootstrapHelper;
  readonly auth: AuthCredentialSource;
  readonly logger: SyncLogger;
}

async function resolveHosted(input: HostedInput): Promise<ResolvedIdentity> {
  // Pure managed-cloud shape: `Ablo({schema, apiKey})`. Server returns
  // scope + userMeta; SDK populates internals.
  const baseUrl = resolveBootstrapBaseUrl({
    url: input.url,
    bootstrapBaseUrl: input.options.bootstrapBaseUrl,
  });
  const exchangeArgs = {
    baseUrl,
    participantKind: (input.kind === 'agent' ? 'agent' : 'system') as
      | 'agent'
      | 'system',
    participantId: input.options.agentId ?? input.options.user?.id,
    wideScope: true,
    ttlSeconds: 3600,
  };
  const exchange = await exchangeApiKey({
    ...exchangeArgs,
    apiKey: input.apiKeyValue,
  });

	  input.bootstrapHelper.setCacheScope(exchange.scope.organizationId);
	  input.bootstrapHelper.setSyncGroups(exchange.scope.syncGroups);
	  input.auth.setAuthToken(exchange.token);

  // Cap tokens have a server-set TTL (3600s by default). Without
  // proactive refresh the WS would either get force-closed at expiry
  // or fail its next reconnect with 401. The scheduler re-mints
  // transparently before that fires; the consumer never sees the
  // rotation. Rationale + tradeoffs in
  //   `packages/sync-engine/src/auth/refreshScheduler.ts`
  const refreshScheduler = createRefreshScheduler({
    initialExpiresAtMs: Date.parse(exchange.expiresAt),
    refresh: async () => {
      // Read the apiKey fresh each time — supports the ApiKeySetter
      // (rotating credentials) shape.
      const freshApiKey = await resolveApiKeyValue(input.configuredApiKey);
      if (!freshApiKey) {
        throw new AbloAuthenticationError(
          'apiKey unavailable during refresh',
          { code: 'apikey_missing' },
        );
      }
	      const next = await exchangeApiKey({
	        ...exchangeArgs,
	        apiKey: freshApiKey,
	      });
	      input.auth.setAuthToken(next.token);
      return { expiresAtMs: Date.parse(next.expiresAt) };
    },
    onError: (err) => {
      input.logger.warn('cap token refresh failed; will retry', {
        error: err.message,
      });
    },
  });

  return {
    userId: exchange.scope.participantId,
    accountScope: exchange.scope.organizationId,
    // teamIds isn't needed because the server already encoded
    // team-level access into scope.syncGroups.
    teamIds: undefined,
    capabilityToken: exchange.token,
    syncGroups: exchange.scope.syncGroups,
    participantKind: input.kind,
    refreshScheduler,
  };
}
