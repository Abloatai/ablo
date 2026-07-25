/**
 * The reactive engine assembly (ADR 0016). `Ablo({ ... })` resolves auth and
 * capabilities; `humans().init` constructs the store cluster; the lifecycle
 * — first mint, identity, ready() — lives in `./storeLifecycle.ts`. What
 * remains here is assembly around those parts: the claim stream and
 * participant manager, options validation, the typed model proxies, and the
 * commit/claim/session resources — composed into the reactive client.
 *
 * Extracted from the factory so the composition root stays a root: resolve,
 * dispatch, return. The remaining assembly converts to decoration of a
 * host-built core client with the per-model surface split — the cut's own
 * design step (docs/plans/package-split.md).
 */

import type { Schema, SchemaRecord } from '@abloatai/transaction/schema/schema';
import {
  durableCommitOperationSchema,
  type DurableCommitOperation,
} from '@abloatai/transaction/transactions/settlement/commitEnvelope';
import { AbloAuthenticationError, AbloConnectionError, AbloValidationError, claimedError } from '@abloatai/transaction/errors';
import type { ModelTarget, ModelClaim } from '@abloatai/transaction/coordination/schema';
import type { BatchFence } from '@abloatai/transaction/coordination';
import {
	batchFence,
	fenceTokenFor,
	modelTarget,
	streamTarget,
	subTarget,
} from '@abloatai/transaction/coordination';
import { validateAbloOptions } from './validateAbloOptions.js';
import { mintSession } from '@abloatai/transaction/auth/sessionMint';
import type { MintSessionContext } from '@abloatai/transaction/auth/sessionMint';
import {
  revokeCapability,
  rotateCapability,
} from '@abloatai/transaction/auth/capabilityLifecycle';
import { modelWireNames } from '@abloatai/transaction/auth/capability';
import type { StoreCluster } from './storeCluster.js';
import { startStoreLifecycle } from './storeLifecycle.js';
import type { SyncWebSocket, CoreSyncEventMap } from '../sync/SyncWebSocket.js';
import { createClaimStream } from '../sync/createClaimStream.js';
import { awaitClaimGrant } from '@abloatai/transaction/coordination/awaitClaimGrant';
import { createSnapshot } from '../sync/createSnapshot.js';
import { createParticipantManager } from '../sync/participants.js';
import type { AttachablePresenceStream } from '../../presenceStream.js';
import type { ClaimWaitOptions, Snapshot } from '@abloatai/transaction/types/streams';
import type { Claim } from '@abloatai/transaction/types/streams';
import type { CredentialProvider } from '@abloatai/transaction/auth/apiKey';
import { resolveApiKeyValue, resolveBootstrapBaseUrl } from '@abloatai/transaction/auth/apiKey';
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
import { createModelProxy, type ModelOperations } from './createModelProxy.js';
import { assertWriteOptions } from '@abloatai/transaction/resources/writeOptionsSchema';
import type { AbloClient as Ablo } from '../../client.js';

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
   * The store cluster `humans().init` constructed from the widened context:
   * this client's runtime, the component graph, and the store. The engine
   * assembles around it and constructs none of it.
   */
  cluster: StoreCluster;
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
    transport,
    participantId,
    kind,
    presence,
    cluster,
    createSibling,
  } = inputs;
  const schema = options.schema;

  // The store cluster — this client's runtime, the component graph, the
  // registered models, and the store — was constructed by `humans().init`
  // from the widened plugin context (see `./storeCluster.ts`). The engine
  // assembles around it.
  const { components, store } = cluster;
  const {
    modelRegistry,
    objectPool,
    syncClient,
    hydration,
  } = components;

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

  // 7. The lifecycle — first mint, identity resolution, credential refresh,
  //    and the idempotent ready() driving store.initialize() — is the
  //    materialiser's own (`./storeLifecycle.ts`); the engine wires it with
  //    the prelude's credential slice and seeds its own state through the
  //    callback: the self locals (read by the model proxies' getters) and
  //    the streams' own-echo filters, before the store ever connects.
  /** Resolved account scope — seeded once identity resolution completes;
   *  exposed as the readonly `ablo.organizationId` accessor. */
  let _resolvedOrganizationId: string | null = null;
  const lifecycle = startStoreLifecycle({
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
    validationError: _validationError,
    onIdentityResolved: ({ userId, participantKind, accountScope, syncGroups }) => {
      selfParticipantId = userId;
      selfParticipantKind = participantKind;
      _resolvedOrganizationId = accountScope;
      presenceStream.setParticipant({
        id: userId,
        kind: participantKind,
        syncGroups: [...syncGroups],
      });
      claimStream.setParticipant({ id: userId });
    },
  });
  const ready = lifecycle.ready;

  const participantManager = createParticipantManager({
    ready,
    transport,
    presence: presenceStream,
    claims: claimStream,
    schema,
  });

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
	    fence: BatchFence | null,
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
	      fenceToken:
	        op.fenceToken ?? fenceTokenFor(fence, op.model, op.id ?? null) ?? undefined,
	    });
	  }

	  function normalizeCommitOperations(
	    commitOptions: CommitCreateOptions,
	    fence: BatchFence | null,
	  ): DurableCommitOperation[] {
	    if (commitOptions.operations.length === 0) {
	      throw new AbloValidationError(
	        'Commit requires a non-empty `operations` array.',
	        { code: 'commit_operation_required' },
	      );
	    }
	    return commitOptions.operations.map((op) =>
	      normalizeCommitOperation(op, commitOptions, fence),
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
	            signal: claimOptions.signal,
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

  /**
   * One held claim, as the public claim-state object.
   *
   * The live claim stream only tracks *open* claims; terminal states
   * (committed / expired / canceled) drop out of the list entirely — exactly
   * the ephemeral coordination model — so a present entry is by definition
   * `status: 'active'`.
   */
  const claimStateOf = (held: ModelClaim | undefined) => {
    if (!held) return null;
    return {
      object: 'claim' as const,
      id: held.id,
      status: 'active' as const,
      target: {
        ...streamTarget(held.target),
        ...subTarget(held.target),
      },
      description: held.description ?? 'editing',
      heldBy: held.actor,
      participantKind: held.participantKind,
      expiresAt: held.expiresAt,
      // Carried, not dropped: the coordinator writes a heartbeat's `details`
      // into `meta.progress` on the holder's record so an observer can see
      // what a long hold is doing. It reached `ModelClaim` and stopped here,
      // which left the beat writable and unreadable — a channel with a setter
      // and no getter. `target.meta` beside it stays the declared shape; this
      // is the open record, because a declared shape has no member for a key
      // the holder did not write.
      ...(held.meta !== undefined ? { meta: held.meta } : {}),
    };
  };

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
        // One row can have several holders — sub-row claims on disjoint
        // targets are all granted — so `state` and `holders` read the same
        // list and differ only in how much of it they answer with. The
        // projection lives here once: two copies of it would drift the
        // moment a field is added to one caller's answer.
        state: (target) => claimStateOf(publicClaims.list(modelTarget(target))[0]),
        holders: (target) =>
          publicClaims
            .list(modelTarget(target))
            .map((held) => claimStateOf(held))
            .filter((claim): claim is NonNullable<typeof claim> => claim !== null),
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
        // read-interest callers (`get`/`claim.state`) still `void` it and
        // stay fire-and-forget. It's soft either way — the store swallows
        // reconcile errors so read interest never makes a read reject or stall.
        enterScope: (scope) => store.enterScope(scope),
        pinScope: (scope) => store.pinScope(scope),
        // `ablo.<model>.join(ids, { ttl })` performs a scoped participant join
        // on this model's sync group(s). WebSocket only — `join` throws
        // `AbloConnectionError` if the socket isn't ready.
        // `ttl` passes straight through — both surfaces spell the lease the
        // same way now, so there is no rename here to make a field's name
        // disagree with the value it carries.
        createJoin: (modelKey, ids, options) =>
          participantManager.join({
            scope: { [modelKey]: ids },
            ...(options?.ttl !== undefined ? { ttl: options.ttl } : {}),
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
	        batchFence(claim?.target, claim?.fenceToken),
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
        // Both mint paths (`{ user }` → /v1/ephemeral_keys → `ek_`,
        // `{ agent, can }` → /v1/capabilities → scoped `rk_`) resolve their
        // control-plane context through the shared `buildMintContext`, so this
        // client, `agents.create`, and the stateless HTTP client can't drift on
        // how a token is minted.
        return mintSession(params, await buildMintContext('sessions.create'));
      },
      async revoke({ id }) {
        const context = await buildMintContext('sessions.revoke');
        return revokeCapability({
          apiKey: context.apiKey,
          baseUrl: context.baseUrl,
          id,
          ...(context.fetch ? { fetch: context.fetch } : {}),
        });
      },
      async rotate({ id, graceSeconds, ttlSeconds }) {
        const context = await buildMintContext('sessions.rotate');
        return rotateCapability({
          apiKey: context.apiKey,
          baseUrl: context.baseUrl,
          id,
          ...(graceSeconds !== undefined ? { graceSeconds } : {}),
          ...(ttlSeconds !== undefined ? { ttlSeconds } : {}),
          ...(context.fetch ? { fetch: context.fetch } : {}),
        });
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
        const apiKey: CredentialProvider = async () => {
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
      lifecycle.dispose();
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
     * Subscribe to terminal session events after the store has stopped network
     * access and completed authenticated local-state cleanup. Multiple
     * subscribers are supported; consumers typically redirect to sign-in.
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
