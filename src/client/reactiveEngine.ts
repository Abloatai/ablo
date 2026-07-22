/**
 * The reactive engine build — everything `humans()` means at construction
 * time (ADR 0016). `Ablo({ ... })` resolves auth and capabilities, then hands
 * this module the prelude; from here on it is all materialisation: the
 * runtime context, the internal components, the store and its credential
 * lifecycle, presence and claim streams, the typed model proxies, and the
 * commit/claim/session resources — assembled into the reactive client.
 *
 * Extracted from the factory so the composition root stays a root: resolve,
 * dispatch, return. The construction moves behind `humans().init` proper when
 * the plugin context can carry these inputs — until then the factory calls
 * this directly for the humans-installed path.
 */

import type { Schema, SchemaRecord } from '../transaction/schema/schema.js';
import type {
  RuntimeConfig,
  MutationExecutor,
} from '../interfaces/index.js';
import {
  durableCommitOperationSchema,
  type DurableCommitOperation,
} from '../transaction/transactions/settlement/commitEnvelope.js';
import { AbloAuthenticationError, AbloConnectionError, AbloValidationError, toAbloError, claimedError } from '../transaction/errors.js';
import type { ModelTarget, ModelClaim } from '../transaction/coordination/schema.js';
import { modelTarget, streamTarget, subTarget } from '../transaction/coordination/index.js';
import { initRuntime } from '../context.js';
import { getActiveRegistry } from '../ModelRegistry.js';
import {
  noopObservability,
  browserOnlineStatus,
  defaultSessionErrorDetector,
  noopAnalytics,
} from '../RuntimeContext.js';
import { alwaysOnline } from '../adapters/alwaysOnline.js';
import { validateAbloOptions } from './validateAbloOptions.js';
import { type RefreshScheduler } from '../transaction/auth/index.js';
import { mintSession } from '../transaction/auth/sessionMint.js';
import type { MintSessionContext } from '../transaction/auth/sessionMint.js';
import { modelWireNames } from '../transaction/auth/capability.js';
import { createInternalComponents } from './createInternalComponents.js';
import { resolveParticipantIdentity } from '../transaction/auth/identity.js';
import { BaseSyncedStore } from '../BaseSyncedStore.js';
import type { SyncWebSocket, CoreSyncEventMap } from '../sync/SyncWebSocket.js';
import { createClaimStream } from '../sync/createClaimStream.js';
import { awaitClaimGrant } from '../sync/awaitClaimGrant.js';
import { createSnapshot } from '../sync/createSnapshot.js';
import { createParticipantManager } from '../sync/participants.js';
import type { AttachablePresenceStream } from '../sync/createPresenceStream.js';
import type { ClaimWaitOptions, Snapshot } from '../transaction/types/streams.js';
import type { Claim } from '../transaction/types/streams.js';
import type { ApiKeySetter } from '../transaction/auth/apiKey.js';
import { resolveApiKeyValue, resolveBootstrapBaseUrl } from '../transaction/auth/apiKey.js';
import { shouldUseInMemoryPersistence } from '../transaction/persistence.js';
import type { AbloOptions } from './options.js';
import type { ClientPrelude } from './clientPrelude.js';
import type {
  AbloSession,
  ClaimCreateOptions,
  ClaimResource,
  CommitCreateOptions,
  CommitOperationInput,
  CommitReceipt,
  CommitResource,
  CreateAgentClientParams,
  CreateAgentSessionParams,
  CreateSessionParams,
} from './resourceTypes.js';
import { deriveConfigFromSchema } from './schemaConfig.js';
import { createModelProxy, type ModelOperations } from './createModelProxy.js';
import { assertWriteOptions } from '../transaction/resources/writeOptionsSchema.js';
import { registerModelsFromSchema } from './modelRegistration.js';
// Type-only import back into the factory module — erased at compile time, so
// it closes no runtime cycle (the factory value-imports this builder).
import type { Ablo } from './Ablo.js';

/**
 * What the reactive build is fed: the factory's pass over the options bag
 * ({@link ClientPrelude} — auth, url, logging, identity, shared with the other
 * client shapes), plus the four things that must exist before the store does.
 *
 * The prelude half is extended, never restated. A second copy of those fields
 * would drift the moment one side gained a resolver the other did not.
 */
export interface ReactiveEngineInputs<S extends SchemaRecord> extends ClientPrelude<S> {
  options: AbloOptions<S>;
  executor: MutationExecutor;
  /**
   * The connection, constructed by the factory before the plugin list
   * resolved — the same instance `PluginContext.transport` carries. The
   * store takes it as a dependency and owns the lifecycle.
   */
  transport: SyncWebSocket;
  /** The humans() plugin's contribution — built by its `init`, already
   *  attached to the connection the context carried. */
  presence: AttachablePresenceStream;
  /**
   * Constructs a sibling client (`ablo.agents.create(...)` mints a scoped key
   * and builds a second engine with it). Injected by the factory — a direct
   * import back into it would close a runtime cycle.
   */
  createSibling: (options: AbloOptions<S>) => Ablo<S>;
}

export function buildReactiveEngine<const S extends SchemaRecord>(
  inputs: ReactiveEngineInputs<S>,
): Ablo<S> {
  const {
    options,
    internalOptions,
    url,
    logger,
    configuredApiKey,
    configuredAuthToken,
    credentialResolver,
    authCredentials,
    executor,
    transport,
    participantId,
    kind,
    presence,
    createSibling,
  } = inputs;
  const schema = options.schema;

  // 1. Derive config from schema
  // 1. Derive config from schema, then layer caller-supplied overrides on top.
  //    `configOverrides` is a shallow merge: caller takes precedence per key.
  const config: RuntimeConfig = {
    ...deriveConfigFromSchema(schema),
    ...internalOptions.configOverrides,
  };


  // 3. Initialize SDK context (one call — hides all DI wiring).
  //    Each provider can be overridden individually; the noop defaults
  //    are preserved for the zero-config consumer path.
  initRuntime({
    logger,
    observability: internalOptions.observability ?? noopObservability,
    analytics: internalOptions.analytics ?? noopAnalytics,
    sessionErrorDetector: internalOptions.sessionErrorDetector ?? defaultSessionErrorDetector,
    onlineStatus:
      internalOptions.onlineStatus ??
      (shouldUseInMemoryPersistence(options)
        ? alwaysOnline()
        : browserOnlineStatus),
    config,
    mutationExecutor: executor,
    getModelMetadata: (name) => getActiveRegistry().getMetadata(name),
  });

  // 4. Create internal components (user never sees these). See
  //    `./createInternalComponents.ts` for the construction order
  //    and what each component does. Model registration happens
  //    here (via `registerModelsFromSchema`, in `./modelRegistration.ts`)
  //    because the schema-to-Model-class translation is client-construction
  //    wiring that isn't worth pulling into the components module.
  const {
    modelRegistry,
    objectPool,
    bootstrapHelper,
    database,
    syncClient,
    hydration,
  } = createInternalComponents({
    schema,
    url,
    options: internalOptions,
    auth: authCredentials,
  });
  registerModelsFromSchema(schema, modelRegistry);

  // 5. BaseSyncedStore handles the initialization orchestration
  //    (open DB → hydrate IDB → connect WS → fetch bootstrap → hydrate again →
  //    ready) and exposes the observable `syncStatus` we expose on the engine.
  //
  //    Phase 2: pass the schema into the store so `deriveSyncPlanFromSchema`
  //    can auto-populate version vector keys, FK indexes, and enrichment
  //    rules from the declarative `belongsTo({ index, enrich })` annotations.
  //    Consumers using class-based subclasses with `new SyncedStore(...)`
  //    directly can pass explicit config arrays instead.
  const store = new BaseSyncedStore(
    {
      syncClient,
      database,
      objectPool,
      modelRegistry,
      syncWebSocket: transport,
      schema,
      url,
      auth: authCredentials,
    },
    // Collaboration vocabulary is the application's: the SDK subscribes to the
    // event types the caller declares and to nothing by default.
    { collaborationEvents: internalOptions.collaborationEvents ?? [] },
  );

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

  // Bind this executor to this client's MutationQueue. Without it, the queue
  // resolves `mutationExecutor` from the module-level `getContext()`, which
  // `initRuntime()` overwrites on every client construction. In multi-client
  // flows (for example a worker plus a per-job peer) the second `initRuntime()`
  // call would silently redirect the first client's queue through the second
  // client's executor closure, so the first client's commits would dispatch
  // over the wrong connection.
  syncClient.getMutationQueue().setMutationExecutor(executor);

  // Self identity, late-bound the same way the connection's values are: the
  // construction-time guess seeds it (correct on the self-hosted path, empty
  // on the hosted path), and `ready()` overwrites it with what identity
  // resolution derives from the credential's scope. The model proxies read
  // it through getters, so the is-this-claim-mine checks always compare
  // against the resolved identity.
  let selfParticipantId = participantId;
  let selfParticipantKind = kind;

  // Presence + claim streams — the same reference for the engine's lifetime,
  // attached to the connection at construction (it exists — the host built
  // it; sends before the socket opens are dropped by the transport's
  // send-during-reconnect contract, and each stream re-announces on
  // `connected`). The presence stream is the humans() plugin's contribution,
  // built and attached by its `init` (ADR 0016); the claim stream is core
  // coordination, so the root constructs it regardless of the list. Both
  // filter own echoes by participant id, seeded in `ready()` alongside the
  // locals above.
  const presenceStream = presence;
  const claimStream = createClaimStream({ participantId, logger }, transport);
  const participantManager = createParticipantManager({
    ready,
    transport,
    presence: presenceStream,
    claims: claimStream,
    schema,
  });

  // 6. Validate options up front — fail loudly on obviously wrong inputs so
  //    strangers don't get silent empty results. Validation errors are written
  //    into `store.syncStatus` (the single source of truth).
  const _validationError = validateAbloOptions({
    options: internalOptions,
    url,
    configuredApiKey,
    configuredAuthToken,
  });
  if (_validationError) {
    logger.error(_validationError.message);
    store.syncStatus.state = 'error';
    store.syncStatus.error = _validationError;
  }

  // Deprecated identity overrides are a silent no-op under hosted cloud: when an
  // `apiKey` is configured the SERVER derives participant kind + id from the
  // key's scope, so `kind` / `agentId` passed here are ignored. Setting them and
  // trusting them is the trap (you think you're an agent; the key says user).
  // Warn loudly rather than removing the fields — `agentId` is still load-bearing
  // on the self-hosted path (no apiKey; paired with `capabilityToken`).
  // eslint-disable-next-line @typescript-eslint/no-deprecated -- reads the deprecated fields precisely to warn callers off them under a configured apiKey
  if (configuredApiKey && (internalOptions.kind || internalOptions.agentId)) {
    logger.warn(
      'Ablo: `kind` / `agentId` are ignored when an `apiKey` is configured — ' +
        'the server derives participant identity from the key’s scope. Remove ' +
        'them (or mint a scoped session via `ablo.sessions.create({ agent })` ' +
        'for a distinct agent identity). They apply only to the self-hosted ' +
        '`capabilityToken` path.',
    );
  }

  // 7. The ready() promise drives the BaseSyncedStore.initialize() generator
  //    to completion. First call kicks off the initialization; subsequent
  //    calls return the same promise (idempotent).
  //
  //    Status is tracked in store.syncStatus (MobX observable) — the single
  //    source of truth. No duplicate closure variables.
	  let _readyPromise: Promise<void> | null = null;
	  let _refreshScheduler: RefreshScheduler | null = null;
	  /** Resolved account scope — set once identity resolution completes in
	   *  `ready()`; exposed as the readonly `ablo.organizationId` accessor. */
	  let _resolvedOrganizationId: string | null = null;

  async function ready(): Promise<void> {
    if (_readyPromise) return _readyPromise;

    if (_validationError) {
      _readyPromise = Promise.reject(_validationError);
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
          const token = await credentialResolver();
          if (!token) {
            throw new AbloAuthenticationError(
              'Auth resolver returned null before connect — the user is not signed in.',
              { code: 'auth_no_credentials' },
            );
          }
          authCredentials.setAuthToken(token);
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
          teamIds,
          capabilityToken,
	          syncGroups,
	          participantKind,
	        } = resolved;

	        // Fail-loud guard: detect the degenerate "no real sync groups
	        // resolved" state before opening the socket. It is the same class of bug as
	        // a
	        // sensible-looking default that's functionally broken: the
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

        _resolvedOrganizationId = accountScope;

        // Seed the resolved identity into everything that filters or stamps
        // by participant: the presence and claim streams (own-echo filters,
        // the presence `self` entry) and the model proxies' collaboration
        // checks (via the getters over the locals). This runs before the
        // store connects, so no frame is ever filtered against the
        // construction-time guess.
        selfParticipantId = userId;
        selfParticipantKind = participantKind;
        presenceStream.setParticipant({
          id: userId,
          kind: participantKind,
          syncGroups: resolvedSyncGroups,
        });
        claimStream.setParticipant({ id: userId });

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
          teamIds,
          kind: participantKind,
          capabilityToken,
          syncGroups,
          bootstrapMode: resolvedBootstrapMode,
        });
        let current = gen.next();
        while (!current.done) {
          const yielded = current.value;
          const resolved = yielded instanceof Promise ? await yielded : yielded;
          current = gen.next(resolved);
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
        // `_validationError` branch above intentionally stays cached — config
        // can't change without recreating the engine.)
        _readyPromise = null;
        throw error;
      }
    })();

    return _readyPromise;
  }

  // 9. Optional auto-start for convenience. Opt-in because silent background
  //    init has historically been the #1 source of "why isn't my data loading"
  //    bug reports. Explicit `await sync.ready()` is the default — errors
  //    surface immediately instead of being swallowed.
  if (!_validationError && internalOptions.autoStart) {
    void ready().catch(() => {
      // Error is captured in store.syncStatus; consumers should check
      // `sync.syncStatus.state === 'error'` to detect failures.
    });
  }

  // 9b. waitForFlush — drains pending mutations using the store's
  //     pendingChanges counter (already maintained by BaseSyncedStore based
  //     on MutationQueue events). Polls every 50ms; uses the existing
  //     observable rather than introducing a new event channel.
	  async function waitForFlush(timeoutMs?: number): Promise<void> {
	    const start = Date.now();
	    while (store.syncStatus.pendingChanges > 0) {
	      if (timeoutMs !== undefined && Date.now() - start > timeoutMs) {
	        throw new AbloConnectionError(
          `Flush timeout: ${store.syncStatus.pendingChanges} pending mutations after ${timeoutMs}ms`,
          { code: 'flush_timeout' },
        );
      }
	      await new Promise((resolve) => setTimeout(resolve, 50));
	    }
	  }

	  function createClientTxId(idempotencyKey?: string | null): string {
	    if (idempotencyKey && idempotencyKey.length > 0) return idempotencyKey;
	    return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
	      ? crypto.randomUUID()
	      : `tx_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
	  }

	  function normalizeCommitOperation(
	    op: CommitOperationInput,
	    defaults: Pick<CommitCreateOptions, 'readAt' | 'onStale'>,
	    fenceToken?: number | null,
	  ): DurableCommitOperation {
	    const type = op.action.toUpperCase();
	    const id = op.id ?? '';
	    return durableCommitOperationSchema.parse({
	      type,
	      model: op.model.toLowerCase(),
	      id,
	      input: op.data ?? undefined,
	      transactionId: op.transactionId ?? undefined,
	      readAt: op.readAt ?? defaults.readAt ?? undefined,
	      onStale: op.onStale ?? defaults.onStale ?? undefined,
	      // The batch's claim (if any) supplies one token for every op, mirroring
	      // how it supplies the batch `readAt`.
	      fenceToken: op.fenceToken ?? fenceToken ?? undefined,
	    });
	  }

	  function normalizeCommitOperations(
	    commitOptions: CommitCreateOptions,
	    fenceToken?: number | null,
	  ): DurableCommitOperation[] {
	    if (commitOptions.operations.length === 0) {
	      throw new AbloValidationError(
	        'Commit requires a non-empty `operations` array.',
	        { code: 'commit_operation_required' },
	      );
	    }
	    return commitOptions.operations.map((op) =>
	      normalizeCommitOperation(op, commitOptions, fenceToken),
	    );
	  }

	  function modelClaimFromActive(claim: Claim): ModelClaim {
	    const target = {
	      ...modelTarget(claim.target),
	      ...subTarget(claim.target),
	    };
	    return {
	      id: claim.id,
	      actor: claim.heldBy ?? "",
	      participantKind: claim.participantKind ?? "user",
	      description: claim.description,
	      field: claim.target.field,
	      status: 'active',
	      expiresAt: claim.expiresAt ?? 0,
	      target,
	      // The claim's metadata read as the open record it is on the wire, so a
	      // key the coordinator wrote — a heartbeat's `progress` — is readable.
	      // `target.meta` is the same bag under the shape the program declared,
	      // and a declared shape has no member for something the holder did not
	      // write.
	      ...(target.meta !== undefined ? { meta: target.meta } : {}),
	    };
	  }

	  function targetMatchesModel(
	    target: { readonly model?: string; readonly id?: string; readonly field?: string },
	    claim: Claim,
	  ): boolean {
	    if (
	      target.model &&
	      claim.target.type.toLowerCase() !== target.model.toLowerCase()
	    ) {
	      return false;
	    }
	    if (target.id && claim.target.id !== target.id) return false;
	    if (target.field && claim.target.field !== target.field) return false;
	    return true;
	  }

	  function listModelClaims(target?: Partial<ModelTarget>): readonly ModelClaim[] {
	    return claimStream.others
	      .filter((claim) => (target ? targetMatchesModel(target, claim) : true))
	      .map(modelClaimFromActive);
	  }

	  function waitForModelUnclaimed(
	    target: Partial<ModelTarget>,
	    options?: ClaimWaitOptions,
	  ): Promise<void> {
	    if (listModelClaims(target).length === 0) return Promise.resolve();

	    return new Promise((resolve, reject) => {
	      let settled = false;
	      let timeoutId: ReturnType<typeof setTimeout> | undefined;

	      const cleanup = () => {
	        if (timeoutId) clearTimeout(timeoutId);
	        unsubscribe();
	        options?.signal?.removeEventListener('abort', onAbort);
	      };

	      const finish = (fn: () => void) => {
	        if (settled) return;
	        settled = true;
	        cleanup();
	        fn();
	      };

	      const check = () => {
	        if (listModelClaims(target).length === 0) {
	          finish(resolve);
	        }
	      };

	      const abortError = () =>
	        new AbloConnectionError('Claim wait aborted.', {
	          code: 'claim_wait_aborted',
	          cause: options?.signal?.reason,
	        });

	      const onAbort = () => {
	        finish(() => { reject(abortError()); });
	      };

	      // Answered before the subscription, the listener, and the timer exist,
	      // so there is nothing for `cleanup` to undo — and nothing that would
	      // read `unsubscribe` ahead of the line that binds it.
	      if (options?.signal?.aborted) {
	        reject(abortError());
	        return;
	      }

	      const unsubscribe = claimStream.onChange(check);
	      options?.signal?.addEventListener('abort', onAbort, { once: true });

	      if (options?.timeout != null) {
	        timeoutId = setTimeout(() => {
	          finish(() =>
	            { reject(
	              claimedError(
	                target,
	                listModelClaims(target),
	                'model_claimed_timeout',
	              ),
	            ); },
	          );
	        }, options.timeout);
	      }
	    });
	  }

	  function wrapClaimHandle(
	    claim: Claim,
	    waited = false,
	    fenceToken?: number,
	  ): Claim {
	    const release = (): Promise<void> => {
	      claim.revoke?.();
	      return Promise.resolve();
	    };
	    // The token is server-stamped and arrives on the grant frame, so prefer
	    // the one `awaitClaimGrant` read there; fall back to any the local handle
	    // already carried (immediate, non-queued grants).
	    const resolvedFenceToken = fenceToken ?? claim.fenceToken;
	    return {
	      object: 'claim',
	      id: claim.id,
	      description: claim.description,
	      target: claim.target,
	      waited,
	      ...(resolvedFenceToken !== undefined ? { fenceToken: resolvedFenceToken } : {}),
	      release,
	      revoke: claim.revoke,
	      // The lease-control members are forwarded explicitly — this wrapper
	      // rebuilds the handle field by field, so anything not named here is
	      // silently dropped from the public claim.
	      heartbeat: claim.heartbeat,
	      [Symbol.asyncDispose]: release,
	    };
	  }

	  const publicClaims: ClaimResource = Object.assign(claimStream, {
	    async create(claimOptions: ClaimCreateOptions): Promise<Claim> {
	      await ready();
	      const claim = claimStream.claim(
	        {
	          ...streamTarget(claimOptions.target),
	          ...subTarget(claimOptions.target),
	        },
	        {
	          description: claimOptions.description,
	          ttl: claimOptions.ttl,
	          queue: claimOptions.queue,
	        },
	      );
	      // With `queue`, the claim is only really *ours* once the server says
	      // so (`claim_acquired` if the target was free, `claim_granted` once
	      // we reach the head of the FIFO line). Block here on that grant so
	      // callers — chiefly `ablo.<model>.claim` — get a handle that already
	      // holds the lease, never a half-claimed one racing the queue.
	      let waited = false;
	      let fenceToken: number | undefined;
	      if (claimOptions.queue) {
	        try {
	          ({ waited, fenceToken } = await awaitClaimGrant(transport, claim.id, {
	            timeoutMs: claimOptions.waitTimeoutMs,
	            maxQueueDepth: claimOptions.maxQueueDepth,
	            logger,
	          }));
	        } catch (err) {
	          // Gave up waiting (queue too deep, timed out, or lost) — abandon
	          // the queued claim so we don't leave a phantom entry in the
	          // line that would block or mislead other claimers.
	          claim.revoke?.();
	          throw err;
	        }
	      }
	      return wrapClaimHandle(claim, waited, fenceToken);
	    },
	    list(target?: Partial<ModelTarget>): readonly ModelClaim[] {
	      return listModelClaims(target);
	    },
	    waitFor(target: Partial<ModelTarget>, options?: ClaimWaitOptions): Promise<void> {
	      return waitForModelUnclaimed(target, options);
	    },
	  });

  // Build the typed proxy — one property per model. Done after publicClaims
  // exists so model clients can expose workflow helpers such as
  // `ablo.files.edit(...)` without importing protocol wiring.
  const modelProxies: Record<string, ModelOperations<unknown, unknown>> = {};
  for (const [schemaKey, modelDef] of Object.entries(schema.models)) {
    const registeredModelName = modelDef.typename ?? schemaKey;
    modelProxies[schemaKey] = createModelProxy(
      schemaKey,
      registeredModelName,
      objectPool,
      syncClient,
      modelRegistry,
      hydration,
      {
        createClaim: (claimOptions) => publicClaims.create(claimOptions),
        createSnapshot: (modelKey, id) =>
          createSnapshot({
            pool: objectPool,
            transport,
            // `position.readFloor` is the value claims and snapshots stamp as
            // `readAt` (max of the pool-applied cursor and the acked
            // watermark for our own writes — see logPosition.ts).
            // Stamping a bare stream cursor made a claim taken right after
            // an ack-confirmed write stale against that write's own delta.
            // The socket/store cursors are persistence-gated and therefore
            // never ahead of `applied` — no extra max() needed here.
            getLastSyncId: () => syncClient.position.readFloor,
            entities: { [modelKey]: id },
          }),
        queue: (target) =>
          publicClaims.queueFor(streamTarget(target)),
        reorder: (target, order) =>
          { publicClaims.reorder(streamTarget(target), order); },
        state: (target) => {
          // The live claim stream only tracks *open* (active) claims;
          // terminal states (committed / expired / canceled) drop out of
          // the list entirely — exactly the ephemeral coordination model.
          // So a present entry is, by definition, `status: 'active'`.
          const held = publicClaims.list(modelTarget(target))[0];
          if (!held) return null;
          return {
            object: 'claim',
            id: held.id,
            status: 'active',
            target: {
              ...streamTarget(held.target),
              ...subTarget(held.target),
            },
            description: held.description ?? 'editing',
            heldBy: held.actor,
            participantKind: held.participantKind,
            expiresAt: held.expiresAt,
          };
        },
        waitFor: (target, waitOptions) =>
          publicClaims.waitFor(modelTarget(target), waitOptions),
        // Getters, not copies: identity is late-bound (seeded in `ready()`),
        // and the contended / heldBy checks must compare against whoever
        // this client resolved to, not the construction-time guess.
        get selfParticipantId() { return selfParticipantId; },
        get selfParticipantKind() { return selfParticipantKind; },
        // Read-interest / write-intent enrolment for the typed surface.
        // `enterScope`/`pinScope` resolve the `{ [schemaKey]: id }` scope
        // through the same resolver the claim path uses, landing this client in
        // the entity-scoped group the holder's claim presence fans out on.
        // Returns the store promise so the claim write path can await pinScope
        // before acquiring the lease (closing the subscribe-vs-broadcast race);
        // read-interest callers (`retrieve`/`claim.state`) still `void` it and
        // stay fire-and-forget. It's soft either way — the store swallows
        // reconcile errors so read interest never makes a read reject or stall.
        enterScope: (scope) => store.enterScope(scope),
        pinScope: (scope) => store.pinScope(scope),
        // `ablo.<model>.join(ids, { ttl })` performs a scoped participant join
        // on this model's sync group(s). WebSocket only — `join` throws
        // `AbloConnectionError` if the socket isn't ready.
        createJoin: (modelKey, ids, options) =>
          participantManager.join({
            scope: { [modelKey]: ids },
            ...(options?.ttl !== undefined ? { ttlSeconds: options.ttl } : {}),
          }),
      },
      // The client-wide `wait` default; a per-call `wait` still wins.
      internalOptions.wait,
    );
  }

	  const commits: CommitResource = {
	    async create(commitOptions: CommitCreateOptions): Promise<CommitReceipt> {
	      await ready();
	      // Same runtime contract as the per-model writes — one schema.
	      assertWriteOptions(
	        {
	          idempotencyKey: commitOptions.idempotencyKey,
	          readAt: commitOptions.readAt,
	          onStale: commitOptions.onStale,
	          wait: commitOptions.wait,
	          claim: commitOptions.claim,
	        },
	        'commits.create',
	      );
	      const clientTxId = createClientTxId(commitOptions.idempotencyKey);
	      // A claim handle supplies the batch stale-guard defaults — same
	      // semantics as `ablo.<model>.update({ id, data, claim })`, so the
	      // two write doors speak one claim vocabulary. Explicit options win.
	      const claim = commitOptions.claim ?? null;
	      const operations = normalizeCommitOperations(
	        {
	          ...commitOptions,
	          readAt: commitOptions.readAt ?? claim?.readAt ?? null,
	          onStale:
	            commitOptions.onStale ?? (claim?.readAt !== undefined ? 'reject' : null),
	        },
	        claim?.fenceToken ?? null,
	      );
	      const wait = commitOptions.wait ?? 'confirmed';
	      // Route through the MutationQueue's commit lane so the call
	      // tolerates WS disconnects: the envelope stays in memory until
	      // reconnect, mutationExecutor.commit() owns transport-level
	      // retry, and `mutation_log` server-side dedupes replays by
	      // clientTxId. Replaces the direct ws.sendCommit /
	      // sendCommitQueued path that threw synchronously on
	      // `ws.readyState !== OPEN`. The queue lives on the internal
	      // SyncClient we already hold from createInternalComponents —
	      // no need to leak an accessor through BaseSyncedStore.
	      const queue = syncClient.getMutationQueue();
	      await queue.enqueueCommit(clientTxId, operations, {
	        ...(commitOptions.reads ? { reads: [...commitOptions.reads] } : {}),
	        ...(commitOptions.track ? { track: [...commitOptions.track] } : {}),
	      });

	      if (wait === 'queued') {
	        return { id: clientTxId, status: 'queued' };
	      }

	      const { lastSyncId, notifications, missingIds } =
	        await queue.waitForCommitReceipt(clientTxId);
	      return {
	        id: clientTxId,
	        status: 'confirmed',
	        lastSyncId,
	        ...(notifications && notifications.length > 0 ? { notifications } : {}),
	        ...(missingIds && missingIds.length > 0 ? { missingIds } : {}),
	      };
	    },
	  };

	  /**
	   * The control-plane credential: always the original configured secret key.
	   * Never reads `authCredentials` — that holds the exchanged sync credential
	   * (a wide-scope `rk_` on the hosted path), which control-plane routes
	   * rightly refuse (e.g. the user-session mint is sk_-gated). Counterpart to
	   * `getAuthToken()`, which resolves the sync-plane token.
	   *
	   * The secret-key-only rule is enforced on the server; the credential-kind taxonomy
	   * (secret/restricted/ephemeral/publishable) lives in `auth/credentialPolicy`.
	   */
	  async function controlPlaneApiKey(): Promise<string | null> {
	    return resolveApiKeyValue(configuredApiKey);
	  }

	  /**
	   * Resolve the control-plane context a session/agent mint needs (sk_ +
	   * bootstrap base URL + the schema-key→typename map the server gates on).
	   * Shared by `sessions.create` and `agents.create` so the two mint doors
	   * can never drift on how a token is minted. Throws if no `sk_` is present —
	   * minting is a backend-only operation.
	   */
	  async function buildMintContext(resource: string): Promise<MintSessionContext> {
	    const apiKey = await controlPlaneApiKey();
	    if (!apiKey) {
	      throw new AbloAuthenticationError(
	        `${resource} requires a secret (sk_) API key — call it from your backend, not the browser.`,
	        { code: 'apikey_missing' },
	      );
	    }
	    return {
	      apiKey,
	      baseUrl: resolveBootstrapBaseUrl({
	        url,
	        bootstrapBaseUrl: internalOptions.bootstrapBaseUrl,
	      }),
	      ...(internalOptions.fetch ? { fetch: internalOptions.fetch } : {}),
	      // Map every `can` schema-key to the wire typename the server gates on, so a
	      // typename override (`documents` → `Document`) doesn't mint a capability
	      // the server then denies. Derived from this client's schema by the one rule
	      // the HTTP client and the mint route also read. See `MintSessionContext`.
	      modelTypenames: modelWireNames(schema.models),
	    };
	  }

	  const engine = {
    ...modelProxies,

    ready,
    waitForFlush,

    /** Durable frame subscription — delegates to the store's registry, which
     *  re-attaches across socket rebuilds. */
    subscribe: <K extends keyof CoreSyncEventMap>(
      event: K,
      handler: (...args: CoreSyncEventMap[K]) => void,
    ): (() => void) => store.subscribe(event, handler),

    setAuthToken(token: string) {
      // The single credential source is read lazily by bootstrap HTTP,
      // lazy query HTTP, network probes, and WebSocket reconnect URL auth.
      // Updating it here is enough for the next request/connect to use the
      // refreshed token; no per-transport patching.
      authCredentials.setAuthToken(token);
      // A fresh credential is useless to a connection parked in offline /
      // backoff / auth_blocked until the next probe trigger — so kick one now.
      // Harmless while connected (the FSM ignores the nudge there).
      store.nudgeReconnect();
    },

    async getAuthToken(): Promise<string | null> {
      // The live short-lived bearer (set via `setAuthToken` / `apiKey`-resolver refresh)
      // is the canonical credential; fall back to a configured API key.
      //
      // This is the sync-plane token (bootstrap, WebSocket, query HTTP). Control-plane
      // calls (sessions.create, datasource registration) never use it — they
      // present the original secret key via `controlPlaneApiKey()` below. The
      // split matters: after the startup exchange this resolver returns the
      // derived wide-scope `rk_`, a credential the control-plane routes
      // correctly refuse (an agent token must never mint humans).
      return (
        authCredentials.getAuthToken() ??
        (await resolveApiKeyValue(configuredApiKey)) ??
        configuredAuthToken ??
        null
      );
    },

    setCredentialRefresher(refresher: (() => Promise<string | null>) | null) {
      store.setCredentialRefresher(refresher);
    },

    // The org this client resolved to — null until `ready()` completes. Exposed
    // as a property so integrators can read it programmatically.
    get organizationId(): string | null {
      return _resolvedOrganizationId;
    },

    nudgeReconnect() {
      store.nudgeReconnect();
    },

    sessions: {
      // A backend (holding `sk_`) mints a short-lived scoped token for one end
      // user or one agent.
      //
      // Both arms authenticate with the original secret key
      // (`controlPlaneApiKey()`), never the wide-scope `rk_` the startup exchange
      // installed as the sync credential. A derived agent credential silently
      // replacing the secret key on control-plane calls is how humans would get
      // minted as agents — and correct attribution is the point.
      async create(params: CreateSessionParams<S>): Promise<AbloSession> {
        // Both mint paths (`{ user }` → /auth/ephemeral-keys → `ek_`,
        // `{ agent, can }` → /auth/capability → scoped `rk_`) resolve their
        // control-plane context through the shared `buildMintContext`, so this
        // client, `agents.create`, and the stateless HTTP client can't drift on
        // how a token is minted.
        return mintSession(params, await buildMintContext('sessions.create'));
      },
    },

    // Mint a scoped agent identity and hand back a connected client bound to it —
    // `sessions.create({ agent })` plus a typed `Ablo({ schema, apiKey })` client,
    // for agents that run in this (secret-key-holding) process. Omitting `id`
    // yields a fresh uuid per call, so concurrent agents are distinct participants
    // that queue behind each other (even when they share a `name`). Humans don't
    // get a server-built client — ship them a token via `sessions.create({ user })`.
    agents: {
      async create(params: CreateAgentClientParams<S>): Promise<Ablo<S>> {
        // Distinct participant by default: omit `id` → a fresh uuid, so even two
        // agents that share a `name` are independent participants and queue
        // behind one another. `name` is display only (→ userMeta.name); it never
        // derives the id. Pass an explicit `id` only to re-attach an agent to
        // its own held claims.
        const id = params.id ?? globalThis.crypto.randomUUID();
        const userMeta =
          params.name !== undefined ? { ...params.userMeta, name: params.name } : params.userMeta;
        const sessionParams = {
          agent: { id },
          can: params.can,
          ...(params.syncGroups ? { syncGroups: params.syncGroups } : {}),
          ...(params.ttlSeconds !== undefined ? { ttlSeconds: params.ttlSeconds } : {}),
          ...(userMeta ? { userMeta } : {}),
        } satisfies CreateAgentSessionParams<S>;
        // Re-mint the `rk_` on every resolver call so a long-lived agent client
        // never hits token expiry; the `sk_` stays in this process — the child
        // only ever sees its own short-lived `rk_`.
        const mintToken = async (): Promise<string> =>
          (await mintSession(sessionParams, await buildMintContext('agents.create')))
            .token;
        // Mint once up front so a bad key / denied scope throws HERE, not later
        // inside the child's bootstrap; reuse that first token, re-mint on refresh.
        let pending: string | null = await mintToken();
        const apiKey: ApiKeySetter = async () => {
          if (pending !== null) {
            const token = pending;
            pending = null;
            return token;
          }
          return mintToken();
        };
        return createSibling({ ...(internalOptions as AbloOptions<S>), apiKey });
      },
    },

    async dispose() {
      _refreshScheduler?.dispose();
      _refreshScheduler = null;
      try {
        await store.disconnect();
      } catch (err) {
        // Best-effort teardown — a disposal hiccup isn't consumer-actionable → debug.
        logger.debug('Error during sync engine disposal', { error: (err as Error).message });
      }
      presenceStream.dispose();
      claimStream.dispose();
      syncClient.dispose();
    },

    /**
     * Destroy every IndexedDB database owned by this engine. Disconnects
     * the WebSocket, releases timers, and deletes all `ablo_*` / `ablo-*`
     * databases. Typically called on session expiry or explicit logout.
     * Best-effort — errors from individual deletions are swallowed.
     */
    async purge() {
      await store.purge();
      syncClient.dispose();
    },

    /**
     * Subscribe to session-error events. Fires when the server rejects
     * the session (WebSocket close code 1008/4001/4003 or a session_error
     * frame). Multiple subscribers supported; returns an unsubscribe
     * function. Consumers typically use this to trigger auth-failed UI
     * flows (e.g., redirect to sign-in). Does not automatically purge the
     * IndexedDB — call `engine.purge()` from the listener if you need
     * that behavior (the SDK's `<AbloProvider>` does this by default).
     */
    onSessionError(listener: (error: Error) => void) {
      return store.subscribeSessionError(listener);
    },

    onMutationFailure(
      listener: (payload: {
        transaction: import('../transactions/mutations/MutationQueue.js').QueuedMutation;
        error: Error;
        permanent?: boolean;
      }) => void,
    ) {
      return store.subscribeMutationFailure(listener);
    },

    onCommitLatency(
      listener: (
        sample: import('../transactions/mutations/commitLatency.js').CommitLatencySample,
      ) => void,
    ) {
      return store.subscribeCommitLatency(listener);
    },

    waitForConfirmation(modelName: string, modelId: string) {
      return store.waitForConfirmation(modelName, modelId);
    },

    // Expose the store's MobX observable directly — single source of truth.
    // React components using observer() will re-render automatically on
    // any state change (syncing, error, offline, pendingChanges, progress).
    get syncStatus() {
      return store.syncStatus;
    },

    schema,

    // ── Internal accessors for framework integration ─────────────────
    // These expose internal components for consumers that need direct
    // access (e.g., SyncEngineProvider wiring SyncContext, collaboration
    // events accessing the WebSocket handle, demand loaders accessing
    // the pool). Prefixed with _ to signal "internal but stable."

    /** The BaseSyncedStore — implements SyncStoreContract for SyncContext.Provider. */
    get _store() { return store; },

    /** The InstanceCache — for demand loaders that need pool.createFromData(). */
    get _pool() { return objectPool; },

    /** The SyncWebSocket — for collaboration events (selection, cursors). */
    get _ws() { return store.getSyncWebSocket(); },

    /** Presence livestream — same socket as entity sync, no second
     *  connection. Stable reference across the engine's lifetime. */
    presence: presenceStream,

	    /** Claim livestream — same socket. Stable reference. */
	    claims: publicClaims,

	    commits,

    /** Context-staleness snapshot — see `engine.snapshot(...)` JSDoc. */
    snapshot<ModelName extends keyof S & string>(
      entities: Readonly<Record<ModelName, string | readonly string[]>>,
    ): Snapshot<Schema<S>, ModelName> {
      return createSnapshot<Schema<S>, ModelName>({
        pool: objectPool,
        transport,
        getLastSyncId: () => transport.getLastSyncId(),
        entities,
      });
    },
  } as Ablo<S>;

  return engine;
}
