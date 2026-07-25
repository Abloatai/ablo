/**
 * The materialiser's lifecycle: the first credential mint, identity
 * resolution, the credential-refresh machinery, and the idempotent `ready()`
 * that drives the store's initialize generator to completion. Extracted from
 * the interactive composition root (docs/plans/package-split.md):
 * the engine wires it with the prelude's credential slice and consumes
 * `ready`; resolved identity flows back through one callback, so the
 * engine-side state it seeds (the self locals, the streams) stays with the
 * engine.
 */

import type { SchemaRecord, Schema } from '@ablo/transaction/schema/schema';
import type { ParticipantKind } from '@ablo/transaction/types/participant';
import type { Logger } from '@ablo/transaction/logger';
import type { AuthCredentialSource } from '@ablo/transaction/auth/credentialSource';
import type { RefreshScheduler } from '@ablo/transaction/auth';
import type { CredentialProvider } from '@ablo/transaction/auth/apiKey';
import { resolveParticipantIdentity } from '@ablo/transaction/auth/identity';
import {
  AbloAuthenticationError,
  AbloConnectionError,
  toAbloError,
} from '@ablo/transaction/errors';
import type { AbloError } from '@ablo/transaction/errors';
import type { InternalAbloOptions } from './options.js';
import type { StoreCluster } from './storeCluster.js';

/** What identity resolution settled, handed back for the engine to seed. */
export interface IdentitySeed {
  readonly userId: string;
  readonly participantKind: ParticipantKind;
  /** The resolved account scope; null until known. */
  readonly accountScope: string | null;
  readonly syncGroups: readonly string[];
}

export interface StoreLifecycle {
  /**
   * Drives initialization to completion: first mint, identity resolution,
   * seeding, then the store's initialize generator. Idempotent — the first
   * call starts it, later calls share the promise; a failed attempt clears
   * the memo so retry triggers can re-bootstrap.
   */
  ready: () => Promise<void>;
  /** Stops the credential refresh scheduler, if identity resolution installed one. */
  dispose(): void;
}

export interface StoreLifecycleDeps<S extends SchemaRecord> {
  readonly cluster: StoreCluster;
  readonly schema: Schema<S>;
  readonly internalOptions: InternalAbloOptions<S>;
  readonly authCredentials: AuthCredentialSource;
  readonly credentialResolver: CredentialProvider | null;
  readonly configuredApiKey: string | CredentialProvider | null;
  readonly configuredAuthToken: string | null;
  readonly url: string;
  readonly kind: ParticipantKind;
  readonly logger: Logger;
  /** The engine's up-front options validation; a present error makes `ready()` reject with it. */
  readonly validationError: AbloError | null;
  /** Seeds resolved identity into the engine's own state: the self locals and the streams. */
  readonly onIdentityResolved: (seed: IdentitySeed) => void;
}

/**
 * Wires the credential machinery onto the cluster and returns the `ready`
 * the client exposes. Wiring happens now — the refresh lifecycle, the
 * lazy-query auth recovery, the executor binding, and the opt-in auto-start;
 * the first mint waits for `ready()` so the first connection carries a
 * token.
 */
export function startStoreLifecycle<S extends SchemaRecord>(
  deps: StoreLifecycleDeps<S>,
): StoreLifecycle {
  const {
    cluster,
    schema,
    internalOptions,
    authCredentials,
    credentialResolver,
    configuredApiKey,
    configuredAuthToken,
    url,
    kind,
    logger,
    validationError,
    onIdentityResolved,
  } = deps;
  const { store, components, runtime } = cluster;
  const { bootstrapHelper, hydration, syncClient } = components;

  // Hand the credential lifecycle to the client (refresher + proactive refresh
  // timer + wake/online/focus re-mint). Installed once here so refresh works for
  // any consumer of `Ablo({ auth })`, not only those who render `<AbloProvider>`.
  // The first mint happens in `ready()` so the first connection carries a token.
  //
  // Long-lived server clients also get the pre-roll timer on windowless hosts
  // (`proactiveInNode`): their socket must renew its `rk_` or `ek_` before the
  // server's keepalive reaper closes it (4001 `credential_expired`). Two signals
  // qualify — an agent or system participant, and an absolute endpoint-string
  // `apiKey` (a relative one can't be fetched in Node, so an absolute URL is
  // unambiguously a deliberate server client). User-kind clients in Node (an
  // SSR/RSC module evaluating scaffolded browser code) stay reactive-only.
  if (credentialResolver) {
    const rawEndpoint = internalOptions.authEndpoint ?? internalOptions.apiKey;
    const absoluteEndpoint =
      typeof rawEndpoint === 'string' && /^https?:\/\//i.test(rawEndpoint);
    store.startCredentialLifecycle(credentialResolver, {
      /* eslint-disable @typescript-eslint/no-deprecated -- `kind` gates the self-hosted proactive pre-roll; hosted path derives it from the apiKey scope */
      proactiveInNode:
        internalOptions.kind === 'agent' ||
        internalOptions.kind === 'system' ||
        absoluteEndpoint,
      /* eslint-enable @typescript-eslint/no-deprecated */
    });
  }

  // Put the lazy-query lane on the same auth-recovery path as the WebSocket probe
  // and the proactive pre-roll: a 401 on `/sync/query` re-mints via the store's
  // single-flight lifecycle and replays once, instead of silently returning empty
  // rows against an expired `ek_` until the next proactive tick. Late-bound
  // because the coordinator is constructed before the store exists.
  hydration.setCredentialRecovery((recovery) => store.recoverFromAuthRejection(recovery));

  // Bind this client's executor to its MutationQueue explicitly. The queue
  // already resolves it through this client's own `runtime`, so this is the
  // same executor either way; the explicit binding also covers a queue that
  // was constructed without the instance runtime (subclass and test paths).
  syncClient.getMutationQueue().setMutationExecutor(runtime.mutationExecutor);

  // Status is tracked in store.syncStatus (MobX observable) — the single
  // source of truth. No duplicate closure variables.
  let _readyPromise: Promise<void> | null = null;
  let _refreshScheduler: RefreshScheduler | null = null;

  async function ready(): Promise<void> {
    if (_readyPromise) return _readyPromise;

    if (validationError) {
      _readyPromise = Promise.reject(validationError);
      return _readyPromise;
    }

    _readyPromise = (async () => {
      try {
        // Mint the first access credential before we connect, so the initial
        // WebSocket upgrade and bootstrap carry a valid bearer (no tokenless first
        // connect that has to self-heal). Only when a refreshing resolver is wired
        // and no static credential is already present. Follows the `apiKey`
        // resolver contract: `null` means the login is gone (terminal — fail ready
        // so the app shows sign-in); a throw means transient (rethrown; autoStart
        // swallows it and the lifecycle's online/wake triggers retry).
        if (credentialResolver && !authCredentials.getAuthToken()) {
          const outcome = await store.performCredentialRefresh();
          if (outcome === 'session_error') {
            throw new AbloAuthenticationError(
              'Auth resolver returned null before connect — the user is not signed in.',
              { code: 'auth_no_credentials' },
            );
          }
          if (outcome === 'network_error') {
            throw new AbloConnectionError(
              'The credential endpoint could not mint the initial session credential.',
              { code: 'exchange_network_error' },
            );
          }
        }

        // Resolve participant identity + scope. Three branches —
        // hosted-cloud apiKey exchange, self-derived from capability
        // token, or legacy explicit options. See `./identity.ts`.
        const resolved = await resolveParticipantIdentity({
          options: internalOptions,
          internalOptions,
          url,
          kind,
          configuredApiKey,
          // Resolve identity against the live token, not the construction-time
          // `configuredAuthToken`. Consumers using a function `apiKey` never pass
          // `authToken` at construction — the lifecycle mints the first `ek_` or
          // `rk_` and calls `setAuthToken()` before `ready()`, which updates the
          // shared credential source. Reading the frozen `configuredAuthToken`
          // here made `/auth/identity` fire with no bearer (returning
          // `no_matching_provider` / `session_expired`) even though the token was
          // present. This reads the shared credential source, like every other
          // transport.
          configuredAuthToken: authCredentials.getAuthToken() ?? configuredAuthToken,
          bootstrapHelper,
          auth: authCredentials,
          logger,
        });
        const {
          userId,
          accountScope,
          projectId,
          environment,
          sandboxId,
          teamIds,
          capabilityToken,
          syncGroups,
          participantKind,
        } = resolved;

        // Fail-loud guard: detect the degenerate "no real sync groups
        // resolved" state before opening the socket. It is the same class of bug as
        // a sensible-looking default that's functionally broken: the
        // SDK ends up subscribing only to the server-side
        // `['default']` fallback, no
        // delta has that tag, live fan-out silently never delivers.
        // For human users (kind:'user') this is almost certainly a
        // misconfiguration upstream — either the caller didn't pass
        // `syncGroups`, or auth resolution didn't derive them, or
        // both. Warn loudly so the next debugging session starts here
        // instead of with "live updates don't work, hard reload fixes
        // it."
        const resolvedSyncGroups = syncGroups ?? [];
        if (
          participantKind === 'user' &&
          (resolvedSyncGroups.length === 0 ||
            (resolvedSyncGroups.length === 1 && resolvedSyncGroups[0] === 'default'))
        ) {
          // Actionable and not self-healing (no live updates until fixed):
          // kept at warn level for consumers; the low-level diagnostic
          // fields ride the debug log below.
          logger.warn(
            'This client was started without sync groups, so it will not receive ' +
              'live updates. Pass `syncGroups` (for example ' +
              '`["org:<id>", "user:<id>"]`) or check that your auth provider supplies them.',
          );
          logger.debug('degenerate syncGroups — details', { participantKind, resolvedSyncGroups });
        }

        // Seed the resolved identity into everything that filters or stamps
        // by participant — the engine's self locals and its streams, through
        // the one callback. This runs before the store connects, so no frame
        // is ever filtered against the construction-time guess.
        onIdentityResolved({
          userId,
          participantKind,
          accountScope,
          syncGroups: resolvedSyncGroups,
        });

        if (resolved.refreshScheduler) {
          _refreshScheduler = resolved.refreshScheduler;
        }

        // Drive the generator to completion. Each yielded promise is awaited
        // then fed back — this is standard generator consumption.
        //
        // The store.initialize() generator updates store.syncStatus as it
        // progresses (syncing → idle on success, error on failure), so the
        // consumer's `sync.syncStatus` observable reflects real-time state.
        // Resolve bootstrap mode: explicit option wins; otherwise
        // agents default to 'none' (transactional participant — see
        // option doc) and everyone else defaults to 'full'.
        const resolvedBootstrapMode: 'full' | 'none' =
          internalOptions.bootstrapMode ?? (participantKind === 'agent' ? 'none' : 'full');

        const gen = store.initialize({
          userId,
          organizationId: accountScope,
          projectId,
          environment,
          sandboxId,
          teamIds,
          kind: participantKind,
          capabilityToken,
          syncGroups,
          bootstrapMode: resolvedBootstrapMode,
        });
        let current = gen.next();
        while (!current.done) {
          const yielded = current.value;
          const settled = yielded instanceof Promise ? await yielded : yielded;
          current = gen.next(settled);
        }

        const result = current.value;
        if (!result.success) {
          throw result.error
            ? toAbloError(result.error)
            : new AbloConnectionError('Sync engine initialization failed', {
                code: 'bootstrap_fetch_timeout',
              });
        }

        logger.info('Sync engine ready', { models: Object.keys(schema.models).length });
      } catch (err) {
        // Coerce so the rejection a consumer awaiting `ready()` catches is
        // always an AbloError — connection setup is held to the same
        // never-leak-untagged contract as the model operations.
        const error = toAbloError(err);
        // Make sure syncStatus reflects the failure for observer() components
        store.syncStatus.state = 'error';
        store.syncStatus.error = error;
        // Log the typed envelope (type + code + status), not just the bare
        // message — so the console line names it as an Ablo error and carries
        // the code (e.g. AbloAuthenticationError/identity_resolve_failed on a
        // 401) instead of reading like an untagged failure.
        logger.error('Sync engine failed to initialize', {
          type: error.type,
          code: error.code,
          httpStatus: error.httpStatus,
          error: error.message,
        });
        // Clear the memo so a future `ready()` re-attempts bootstrap instead of
        // replaying this rejection forever. Bootstrap failures here are transient
        // by nature — offline, an IndexedDB open timeout, a bootstrap fetch
        // hiccup — and the early `if (_readyPromise) return _readyPromise` guard
        // would otherwise hand every later caller this same dead promise, bricking
        // the engine until a full page reload. Nulling it lets the provider's
        // online/wake/retry triggers drive a clean re-bootstrap. (The terminal
        // `validationError` branch above intentionally stays cached — config
        // can't change without recreating the engine.)
        _readyPromise = null;
        throw error;
      }
    })();

    return _readyPromise;
  }

  // Optional auto-start for convenience. Opt-in because silent background
  // init has historically been the #1 source of "why isn't my data loading"
  // bug reports. Explicit `await sync.ready()` is the default — errors
  // surface immediately instead of being swallowed.
  if (!validationError && internalOptions.autoStart) {
    void ready().catch(() => {
      // Error is captured in store.syncStatus; consumers should check
      // `sync.syncStatus.state === 'error'` to detect failures.
    });
  }

  return {
    ready,
    dispose(): void {
      _refreshScheduler?.dispose();
      _refreshScheduler = null;
    },
  };
}
