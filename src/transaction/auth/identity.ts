/**
 * Resolves a participant's identity and scope when an {@link Ablo} client is
 * constructed, following whichever of three authentication paths the caller's
 * options select:
 *
 *   1. **Hosted cloud** — the caller passed an `apiKey`. The client exchanges it
 *      for a capability token and scope, then starts a scheduler that re-mints the
 *      token before it expires, so the rotation is invisible to the caller.
 *   2. **Self-derived** — the caller passed a bearer or capability token but not
 *      an identity. The client asks the identity endpoint to recover the
 *      participant id and scope from the token.
 *   3. **Explicit** — a self-hosted caller passed the organization id and a user
 *      or agent id directly. No server round-trip; the client trusts the caller.
 *
 * Each branch is a separate function below, so it can be read and tested on its own.
 */

import { AbloAuthenticationError } from '../errors.js';
import type { ParticipantKind } from '../types/participant.js';
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
import type { BootstrapScope } from '../auth/bootstrapScope.js';
import type { Logger } from '../logger.js';
import type { AuthCredentialSource } from '../auth/credentialSource.js';
import type { ApiKeySetter } from './apiKey.js';
import { resolveApiKeyValue, resolveBootstrapBaseUrl } from './apiKey.js';

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
  readonly kind: ParticipantKind;
  readonly configuredApiKey: string | ApiKeySetter | null;
  readonly configuredAuthToken: string | null;
  readonly bootstrapHelper: BootstrapScope;
  readonly auth: AuthCredentialSource;
  readonly logger: Logger;
}

export interface ResolvedIdentity {
  readonly userId: string;
  readonly accountScope: string;
  readonly teamIds: string[] | undefined;
  readonly capabilityToken: string | undefined;
  readonly syncGroups: readonly string[] | undefined;
  readonly participantKind: ParticipantKind;
  /** Set only on the hosted-cloud path; the caller keeps it to stop refreshes on shutdown. */
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

  // Resolve the http(s) base URL, coercing ws/wss to http/https even when
  // `bootstrapBaseUrl` is an explicit override (see auth.ts).
  const baseUrl = resolveBootstrapBaseUrl({
    url,
    bootstrapBaseUrl: options.bootstrapBaseUrl,
  });

  // An organization id plus a caller-supplied participant id is the explicit path:
  // the caller already knows its own identity, so no server round-trip is needed.
  const hasExplicitIdentity =
    internalOptions.organizationId != null &&
    (kind === 'agent' ? options.agentId != null : options.user?.id != null);

  // The credential-routing decision lives in `credentialPolicy`: it classifies the
  // apiKey by prefix (`sk_`/`ek_`/`rk_`/`pk_`) and picks a route. The hosted
  // exchange is the one mint the policy performs (via the injected
  // `exchangeApiKey`); every other route simply returns the bearer to use. The
  // switch below applies scope and sets up the refresh scheduler for each case.
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
        participantKind: (kind === 'agent' ? 'agent' : 'system'),
        participantId: options.agentId ?? options.user?.id,
        wideScope: true,
        ttlSeconds: 3600,
      },
    },
  );

  switch (cred.kind) {
    case 'publishable':
      // `pk_` is a long-lived, browser-safe, read-only project key. It is used
      // directly as the bearer and is never exchanged for a short-lived
      // capability, so it never expires and there is nothing to refresh. The
      // server resolves the organization and read-only scope from the key itself;
      // we still call `/auth/identity` with the `pk_` bearer to learn the account
      // scope and sync groups for the bootstrap cache.
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
      // Explicit self-hosted identity: the caller supplied its own organization id
      // and user or agent id.
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
  readonly bootstrapHelper: BootstrapScope;
  readonly auth: AuthCredentialSource;
}

/**
 * Resolves identity through the `/auth/identity` endpoint for the publishable
 * (`pk_`) and pre-minted (`ek_`/`rk_` or explicit capability token) routes. The
 * bearer is used as-is, the server resolves the identity, and any caller-passed
 * sync groups are merged with the server-resolved set.
 */
async function resolveViaIdentity(
  input: ResolveViaIdentityInput,
): Promise<ResolvedIdentity> {
  const { bearer, baseUrl, options, bootstrapHelper, auth } = input;
  const identity = await resolveIdentity({ baseUrl, authToken: bearer });
  // Merge the caller's sync groups with the server-resolved set rather than
  // letting the server response overwrite them. A client may compose groups such
  // as `['default', 'org:<id>', 'user:<id>', 'team:<id>']` from the resolved
  // session and pass them in; the identity endpoint can return an empty set (for
  // example, for cookie-authenticated users), and an empty set makes the server
  // bootstrap fall back to `['default']`, so no deltas fan out and live updates
  // appear only on a hard reload. Merging keeps the caller's groups intact.
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
  readonly kind: ParticipantKind;
  readonly options: IdentityResolveInput['options'] & {
    readonly bootstrapBaseUrl?: string;
    readonly user?: { id: string };
    readonly agentId?: string;
  };
  readonly bootstrapHelper: BootstrapScope;
  readonly auth: AuthCredentialSource;
  readonly logger: Logger;
}

async function resolveHosted(input: HostedInput): Promise<ResolvedIdentity> {
  // The managed-cloud shape, `Ablo({ schema, apiKey })`. The credential policy has
  // already exchanged the apiKey via `exchangeApiKey`; here we apply the returned
  // scope and set up the refresh scheduler.
  const { exchange } = input.cred;
  const baseUrl = input.baseUrl;
  // The refresh path re-runs `exchangeApiKey` with a freshly-resolved apiKey, so
  // it needs the same argument bag the policy used for the initial exchange.
  const participantKind: 'agent' | 'system' = input.kind === 'agent' ? 'agent' : 'system';
  const exchangeArgs = {
    baseUrl,
    participantKind,
    participantId: input.options.agentId ?? input.options.user?.id,
    wideScope: true,
    ttlSeconds: 3600,
  };

  input.bootstrapHelper.setCacheScope(exchange.scope.organizationId);
  input.bootstrapHelper.setSyncGroups(exchange.scope.syncGroups);
  input.auth.setAuthToken(exchange.token);

  // Capability tokens carry a server-set TTL (3600s by default). Without proactive
  // refresh, the socket would be force-closed at expiry, or the next reconnect
  // would fail with a 401. The scheduler re-mints ahead of that, so the consumer
  // never sees the rotation.
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
      input.logger.debug('cap token refresh failed; will retry', {
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
