/**
 * The reactive engine assembly (ADR 0016). `Ablo({ ... })` resolves auth and
 * capabilities; `humans().init` constructs the store cluster; the lifecycle
 * — first mint, identity, ready() — lives in `./storeLifecycle.ts`. What
 * remains here is assembly around those parts: the claim and presence streams,
 * options validation, the typed model proxies, and the
 * commit and claim resources — composed into the reactive client.
 *
 * Extracted from the factory so the composition root stays a root: resolve,
 * dispatch, return. The remaining assembly converts to decoration of a
 * host-built core client with the per-model surface split — the cut's own
 * design step (docs/plans/package-split.md).
 */

import type { SchemaRecord } from '@abloatai/transaction/schema/schema';
import { omittedModelError } from '@abloatai/transaction/schema/select';
import {
  durableCommitOperationSchema,
  type DurableCommitOperation,
} from '@abloatai/transaction/commit';
import { AbloConnectionError, AbloValidationError, claimedError } from '@abloatai/transaction/errors';
import type { ModelTarget, ModelClaim } from '@abloatai/transaction/coordination/schema';
import type { BatchFence } from '@abloatai/transaction/coordination';
import {
	batchFence,
	claimIdFor,
	fenceTokenFor,
	modelTarget,
	streamTarget,
	subTarget,
} from '@abloatai/transaction/coordination';
import { validateAbloOptions } from './validateAbloOptions.js';
import type { StoreCluster } from './storeCluster.js';
import { startStoreLifecycle } from './storeLifecycle.js';
import type { SyncWebSocket, CoreSyncEventMap } from '../sync/SyncWebSocket.js';
import { createClaimStream } from '../sync/createClaimStream.js';
import { awaitClaimGrant } from '@abloatai/transaction/claims';
import {
  bindClaimLifetime,
  claimLifetimeOf,
} from '@abloatai/transaction/claims/lifetime';
import type { AttachablePresenceStream } from '../../presenceStream.js';
import type { ClaimWaitOptions } from '@abloatai/transaction/types/streams';
import type { Claim } from '@abloatai/transaction/types/streams';
import { resolveApiKeyValue, resolveBootstrapBaseUrl } from '@abloatai/transaction/auth/apiKey';
import type { AbloOptions } from './options.js';
import type { ClientPrelude } from './clientPrelude.js';
import type {
  ClaimCreateOptions,
  ClaimResource,
  CommitCreateOptions,
  CommitOperationInput,
  CommitReceipt,
  CommitResource,
} from './resourceTypes.js';
import {
  claimAttemptFailure,
  emitClaimStatus,
} from '@abloatai/transaction/client/resources/modelOperations';
import { createModelOperations, type ModelOperations } from './createModelOperations.js';
import { assertWriteOptions } from '@abloatai/transaction/client/resources/writeOptionsSchema';
import type { AbloClient as Ablo } from '../../client.js';
import {
  modelReadResponseSchema,
  commitRecordSchema,
  commitRecordListSchema,
  commitRecordWhereSchema,
} from '@abloatai/transaction/wire';
import {
  translateHttpError,
  type AbloStaleContextError,
} from '@abloatai/transaction/errors';
import {
  kReadEvidence,
  prepareReadSet,
} from '@abloatai/transaction/internal/read-set';
import { contextOnChange } from '../sync/contextOnChange.js';
import type { ReadDependency } from '@abloatai/transaction/coordination';
import type { CapturedRow } from '@abloatai/transaction/transport/http';

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
  } = inputs;
  const schema = options.schema;
  const pointReadBaseUrl = resolveBootstrapBaseUrl({
    url,
    bootstrapBaseUrl: internalOptions.bootstrapBaseUrl,
  });

  async function readPoint(model: string, id: string): Promise<{ data: unknown; stamp: number }> {
    const fetchImpl = internalOptions.fetch ?? globalThis.fetch;
    const response = await fetchImpl(
      `${pointReadBaseUrl}/v1/models/${encodeURIComponent(model)}/${encodeURIComponent(id)}`,
      { headers: authCredentials.withAuthHeaders() },
    );
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    if (!response.ok) throw translateHttpError(response.status, body);
    const parsed = modelReadResponseSchema.safeParse(body);
    if (!parsed.success) {
      throw new AbloConnectionError('Model point-read response failed validation.', {
        code: 'commit_no_result',
        cause: parsed.error,
      });
    }
    return { data: parsed.data.data, stamp: parsed.data.stamp };
  }

  // The store cluster — this client's runtime, the component graph, the
  // registered models, and the store — was constructed by `humans().init`
  // from the widened plugin context (see `./storeCluster.ts`). The engine
  // assembles around it.
  const { components, store, readSetContext } = cluster;
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
        'them (or mint a scoped session with `Sessions({ schema, apiKey }).create({ agent })` ' +
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
  let _resolvedIdentity: import('@abloatai/transaction/auth').EffectiveAuthority | null = null;
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
    onIdentityResolved: ({ userId, participantKind, accountScope, syncGroups, authority }) => {
      selfParticipantId = userId;
      selfParticipantKind = participantKind;
      _resolvedOrganizationId = accountScope;
      _resolvedIdentity = authority;
      presenceStream.setParticipant({
        id: userId,
        kind: participantKind,
        syncGroups: [...syncGroups],
      });
      claimStream.setParticipant({ id: userId });
    },
  });
  const ready = lifecycle.ready;

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
	    defaults: Pick<CommitCreateOptions, 'readAt'>,
	    fence: BatchFence | null,
	    claim: Claim | null,
	  ): DurableCommitOperation {
	    const type = op.action.toUpperCase();
	    const id = op.id ?? '';
	    return durableCommitOperationSchema.parse({
	      type,
	      model: op.model.toLowerCase(),
	      id,
	      input: op.data ?? undefined,
	      transactionId: op.transactionId ?? undefined,
	      claimId:
	        op.claimId ?? claimIdFor(claim?.target, claim?.id, op.model, op.id ?? null) ?? undefined,
	      readAt: op.readAt ?? defaults.readAt ?? undefined,
	      fenceToken:
	        op.fenceToken ?? fenceTokenFor(fence, op.model, op.id ?? null) ?? undefined,
	    });
	  }

	  function normalizeCommitOperations(
	    commitOptions: Pick<CommitCreateOptions, 'operations' | 'readAt' | 'claim'>,
	    fence: BatchFence | null,
	  ): DurableCommitOperation[] {
	    if (commitOptions.operations.length === 0) {
	      throw new AbloValidationError(
	        'Commit requires a non-empty `operations` array.',
	        { code: 'commit_operation_required' },
	      );
	    }
	    return commitOptions.operations.map((op) =>
	      normalizeCommitOperation(op, commitOptions, fence, commitOptions.claim ?? null),
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
	    readAt?: number,
	  ): Claim {
	    const release = (): Promise<void> => {
	      claim.revoke?.();
	      return Promise.resolve();
	    };
	    // The token is server-stamped and arrives on the grant frame, so prefer
	    // the one `awaitClaimGrant` read there; retain the handle fallback for
	    // wire-compatible transports that already stamped it locally.
	    const resolvedFenceToken = fenceToken ?? claim.fenceToken;
	    const wrapped = {
	      object: 'claim',
	      id: claim.id,
	      description: claim.description,
	      target: claim.target,
	      waited,
	      ...(readAt !== undefined ? { readAt } : {}),
	      ...(resolvedFenceToken !== undefined ? { fenceToken: resolvedFenceToken } : {}),
	      release,
	      revoke: claim.revoke,
	      // The lease-control members are forwarded explicitly — this wrapper
	      // rebuilds the handle field by field, so anything not named here is
	      // silently dropped from the public claim.
	      heartbeat: claim.heartbeat,
	      [Symbol.asyncDispose]: release,
	    } satisfies Claim;
	    const lifetime = claimLifetimeOf(claim);
	    return lifetime ? bindClaimLifetime(wrapped, lifetime) : wrapped;
	  }

	  const publicClaims: ClaimResource = Object.assign(claimStream, {
	    async create(claimOptions: ClaimCreateOptions): Promise<Claim> {
	      await ready();
	      // Subscribe before announcing the claim. A fast rejection can arrive
	      // in the same turn as `send` in tests and on a low-latency socket; if
	      // the listener is installed afterwards, that authoritative answer is
	      // lost and the locally minted handle looks like a grant.
	      const claimId = crypto.randomUUID();
	      const grant = awaitClaimGrant(transport, claimId, {
	        timeoutMs: claimOptions.waitTimeoutMs,
	        maxQueueDepth: claimOptions.maxQueueDepth,
	        signal: claimOptions.signal,
	        logger,
	        onQueued: ({ position }) => {
	          emitClaimStatus(claimOptions.onStatus, {
	            type: 'queued',
	            claimId,
	            position,
	            ahead: position + 1,
	          });
	        },
	        onGranted: ({ waited }) => {
	          emitClaimStatus(claimOptions.onStatus, {
	            type: 'granted',
	            claimId,
	            waited,
	          });
	        },
	        onFailed: (error) => {
	          emitClaimStatus(
	            claimOptions.onStatus,
	            claimAttemptFailure(claimOptions.queue !== false, error),
	          );
	        },
	      });
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
	        claimId,
	      );
	      // A claim is ours only after the server says so. This applies equally
	      // to queued claims and try-claims (`queue: false`): the latter must
	      // observe `claim_rejected` instead of returning a phantom handle.
	      const { waited, fenceToken, readAt } = await grant.catch((err: unknown) => {
	        // Give up the local/reconnect record after any rejection, timeout,
	        // abort, or lost lease. For queued claims this also leaves the line.
	        claim.revoke?.();
	        throw err;
	      });
	      return wrapClaimHandle(claim, waited, fenceToken, readAt);
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
    modelProxies[schemaKey] = createModelOperations(
      schemaKey,
      registeredModelName,
      objectPool,
      syncClient,
      modelRegistry,
      hydration,
      {
        createClaim: (claimOptions) => publicClaims.create(claimOptions),
        // Lazily referenced: `commits` is declared below this loop, and this
        // only runs when someone actually writes a batch.
        commitBatch: (commitOptions) => commits.create(commitOptions),
        readPoint,
        // A claim needs the post-read watermark, not the legacy snapshot
        // object. `readFloor` is max(applied, acked-own-write), so a claim
        // taken immediately after its own confirmed mutation is not stale
        // against an echo that has not materialised locally yet.
        currentReadAt: () => syncClient.position.readFloor,
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
      },
      readSetContext,
    );
  }

	  const commits: CommitResource<ReadDependency | CapturedRow> = {
	    async create(
        commitOptions: CommitCreateOptions<ReadDependency | CapturedRow>,
      ): Promise<CommitReceipt> {
	      await ready();
	      const prepared = prepareReadSet(
          cluster.readSetContext,
          syncClient,
          commitOptions.readAt,
          commitOptions.idempotencyKey,
          commitOptions.reads,
        );
	      // Same runtime contract as the per-model writes — one schema.
	      assertWriteOptions(
	        {
	          idempotencyKey: prepared.idempotencyKey,
	          readAt: prepared.readAt,
	          wait: commitOptions.wait,
	          claim: commitOptions.claim,
	          reads: prepared.reads,
	        },
	        'commits.create',
	      );
	      const clientTxId = createClientTxId(prepared.idempotencyKey);
	      // A claim handle supplies the batch stale-guard defaults — same
	      // semantics as `ablo.<model>.update({ id, data, claim })`, so the
	      // two write doors speak one claim vocabulary. Explicit options win.
	      const claim = commitOptions.claim ?? null;
	      const operations = normalizeCommitOperations(
	        {
	          operations: commitOptions.operations,
	          ...(commitOptions.claim !== undefined ? { claim: commitOptions.claim } : {}),
	          readAt: prepared.readAt ?? claim?.readAt ?? null,
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
	        ...(prepared.reads ? { reads: [...prepared.reads] } : {}),
	      });

	      if (wait === 'queued') {
	        return { id: clientTxId, status: 'queued' };
	      }

	      const { lastSyncId, missingIds, operationResults } =
	        await queue.waitForCommitReceipt(clientTxId);
	      return {
	        id: clientTxId,
	        status: 'confirmed',
	        lastSyncId,
	        ...(missingIds && missingIds.length > 0 ? { missingIds } : {}),
	        ...(operationResults && operationResults.length > 0 ? { operationResults } : {}),
	      };
	    },
	    async get({ id }) {
	      await ready();
	      const response = await (internalOptions.fetch ?? globalThis.fetch)(
	        `${pointReadBaseUrl}/v1/commits/${encodeURIComponent(id)}`,
	        { headers: authCredentials.withAuthHeaders() },
	      );
	      const body: unknown = await response.json().catch(() => null);
	      if (!response.ok) throw translateHttpError(response.status, body);
	      return commitRecordSchema.nullable().parse(body);
	    },
	    async list(listOptions = {}) {
	      await ready();
	      const where = commitRecordWhereSchema.parse(listOptions.where ?? {});
	      const params = new URLSearchParams();
	      if (where.actorId) params.set('actorId', where.actorId);
	      if (where.status) params.set('status', where.status);
	      const query = params.size > 0 ? `?${params.toString()}` : '';
	      const response = await (internalOptions.fetch ?? globalThis.fetch)(
	        `${pointReadBaseUrl}/v1/commits${query}`,
	        { headers: authCredentials.withAuthHeaders() },
	      );
	      const body: unknown = await response.json().catch(() => null);
	      if (!response.ok) throw translateHttpError(response.status, body);
	      return commitRecordListSchema.parse(body);
	    },
	  };

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

    get identity() {
      return _resolvedIdentity;
    },

    nudgeReconnect() {
      store.nudgeReconnect();
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

  } as Ablo<S>;

  Object.defineProperty(engine, kReadEvidence, {
    value: {
      context: cluster.readSetContext,
      client: syncClient as object,
      onChange: (
        reads: readonly ReadDependency[],
        listener: (error: AbloStaleContextError) => void,
      ) =>
        contextOnChange(syncClient, objectPool, reads, listener),
    },
    enumerable: false,
  });

  // A model the schema projection left out answers with an error naming the
  // model and the fix, not `undefined`. An app can compile against the full
  // source schema while running a projection, so the type system never sees
  // this gap; without the stub the caller crashes one property later with a
  // bare TypeError ("reading 'local'") that names neither. Non-enumerable so
  // spread, Object.keys, and JSON.stringify walk past the stubs untriggered.
  for (const name of schema.omittedModels ?? []) {
    if (name in engine) continue;
    Object.defineProperty(engine, name, {
      get() {
        throw omittedModelError(name);
      },
      enumerable: false,
      configurable: true,
    });
  }

  return engine;
}
