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
import { mintUserSessionKey } from '../auth/index.js';
import { resolveIdentity } from '../auth/index.js';
import {
  createRefreshScheduler,
  type RefreshScheduler,
} from '../auth/index.js';
import {
  resolveCredential,
  type ResolvedCredential,
} from '../auth/credentialPolicy.js';
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

  // Single source of truth for the http(s) base — coerces ws/wss → http/https
  // even when `bootstrapBaseUrl` is an explicit override (see auth.ts).
  const baseUrl = resolveBootstrapBaseUrl({
    url,
    bootstrapBaseUrl: options.bootstrapBaseUrl,
  });

  // `internalOptions.organizationId` + a caller-supplied participant id is the
  // legacy explicit path: the caller already knows its own identity, so no
  // server round-trip is needed.
  const hasExplicitIdentity =
    internalOptions.organizationId != null &&
    (kind === 'agent' ? options.agentId != null : options.user?.id != null);

  // The connect-time credential ROUTING decision lives in `credentialPolicy`:
  // classify the apiKey (sk_/ek_/rk_/pk_) and route. The hosted exchange is the
  // one mint the policy performs (delegating to the injected `exchangeApiKey`);
  // every other route just hands back the bearer to use. We then switch on the
  // resolved `kind` below to wire up scope + the refresh scheduler.
  const cred = await resolveCredential(
    {
      apiKeyValue,
      configuredApiKey,
      capabilityToken: options.capabilityToken,
      authToken: configuredAuthToken,
      hasExplicitIdentity,
    },
    {
      primitives: {
        exchangeApiKey,
        mintUserSessionKey,
        resolveIdentity,
        resolveApiKeyValue,
      },
      exchangeArgs: {
        baseUrl,
        participantKind: (kind === 'agent' ? 'agent' : 'system') as
          | 'agent'
          | 'system',
        participantId: options.agentId ?? options.user?.id,
        wideScope: true,
        ttlSeconds: 3600,
      },
    },
  );

  switch (cred.kind) {
    case 'publishable':
      // `pk_` — a long-lived, browser-safe, READ-ONLY project key. Used DIRECTLY
      // as the bearer and NEVER exchanged for a short-lived capability — so it
      // never expires and there is nothing to refresh. The sync-server's
      // `apiKeyProvider` resolves the org + read-only scope from the key itself;
      // we still call `/auth/identity` (authenticated by the `pk_` bearer) to
      // learn the account scope + syncGroups for the bootstrap cache.
      return resolveViaIdentity({
        bearer: cred.getBearer,
        baseUrl,
        options,
        bootstrapHelper,
        auth,
      });

    case 'exchange':
      // Hosted-cloud (`sk_`): the policy exchanged the apiKey for a capability
      // token; here we apply the returned scope and set up the refresh scheduler.
      return resolveHosted({
        cred,
        configuredApiKey,
        baseUrl,
        kind,
        options,
        bootstrapHelper,
        auth,
        logger,
      });

    case 'pre-minted':
      // Self-derived: a pre-minted `ek_`/`rk_` bearer or an explicit capability
      // token authenticates `/auth/identity` directly (no exchange, no refresh).
      return resolveViaIdentity({
        bearer: cred.getBearer,
        baseUrl,
        options,
        bootstrapHelper,
        auth,
      });

    case 'explicit': {
      // Legacy explicit (self-hosted, pre-Phase-3 — caller knows its own
      // organizationId + user/agentId).
      const userId = kind === 'agent' ? options.agentId! : options.user!.id;
      const accountScope = internalOptions.organizationId!;
      bootstrapHelper.setCacheScope(accountScope);
      bootstrapHelper.setSyncGroups(options.syncGroups);
      auth.setAuthToken(cred.getBearer);
      return {
        userId,
        accountScope,
        teamIds: kind === 'user' ? options.user?.teamIds : undefined,
        capabilityToken: cred.getBearer,
        syncGroups: options.syncGroups,
        participantKind: kind,
        refreshScheduler: null,
      };
    }
  }
}

interface ResolveViaIdentityInput {
  readonly bearer: string;
  readonly baseUrl: string;
  readonly options: IdentityResolveInput['options'];
  readonly bootstrapHelper: BootstrapHelper;
  readonly auth: AuthCredentialSource;
}

/**
 * Shared `/auth/identity` resolution for the `pk_` (publishable) and pre-minted
 * (`ek_`/`rk_` or explicit cap token) routes: the bearer is used as-is, the
 * server resolves the identity, and caller-passed syncGroups are MERGED with the
 * server-resolved set.
 */
async function resolveViaIdentity(
  input: ResolveViaIdentityInput,
): Promise<ResolvedIdentity> {
  const { bearer, baseUrl, options, bootstrapHelper, auth } = input;
  const identity = await resolveIdentity({ baseUrl, authToken: bearer });
  // Merge caller-passed syncGroups with server-resolved ones rather than letting
  // the server's response silently overwrite. Browser consumers (apps/web's
  // SyncEngineProvider) compose `['default', 'org:${orgId}', 'user:${userId}',
  // ...team:]` from the resolved session and pass it via `<AbloProvider
  // syncGroups>`; before this merge, the self-derived path dropped that set on
  // the floor in favor of `/auth/identity`'s response, which is empty for
  // cookie-auth users today (apps/sync-server/src/routes/auth.ts only populates
  // from `effectiveSyncGroups`, the cap-narrowed list). Empty syncGroups →
  // server bootstrap falls back to `['default']` → no deltas fan out → live
  // updates appear only on hard reload.
  const callerGroups = options.syncGroups ?? [];
  const mergedSyncGroups =
    callerGroups.length > 0
      ? [...new Set([...callerGroups, ...identity.syncGroups])]
      : identity.syncGroups;
  bootstrapHelper.setCacheScope(identity.accountScope);
  bootstrapHelper.setSyncGroups(mergedSyncGroups);
  auth.setAuthToken(bearer);
  return {
    userId: identity.participantId,
    accountScope: identity.accountScope,
    teamIds: undefined,
    capabilityToken: bearer,
    syncGroups: mergedSyncGroups,
    participantKind: identity.participantKind,
    refreshScheduler: null,
  };
}

interface HostedInput {
  /** The hosted exchange result the credential policy already performed. */
  readonly cred: Extract<ResolvedCredential, { kind: 'exchange' }>;
  readonly configuredApiKey: string | ApiKeySetter | null;
  readonly baseUrl: string;
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
  // Pure managed-cloud shape: `Ablo({schema, apiKey})`. The credential policy
  // already exchanged the apiKey (delegating to `exchangeApiKey`); here we apply
  // the returned scope + userMeta and stand up the refresh scheduler.
  const { exchange } = input.cred;
  const baseUrl = input.baseUrl;
  // The refresh path re-runs `exchangeApiKey` with a freshly-resolved apiKey, so
  // it needs the same argument bag the policy used for the initial exchange.
  const exchangeArgs = {
    baseUrl,
    participantKind: (input.kind === 'agent' ? 'agent' : 'system') as
      | 'agent'
      | 'system',
    participantId: input.options.agentId ?? input.options.user?.id,
    wideScope: true,
    ttlSeconds: 3600,
  };

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
