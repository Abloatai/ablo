/**
 * Builds the typed client for a single schema model — the object reached as
 * `ablo.<model>`.
 *
 * Each schema model gets one {@link ModelOperations}: the async server reads
 * `read` and `list`, with the same point lookup restricted to the local graph under
 * `local`, the writes `create`, `update`, and `delete`, the coordination
 * namespace `claim` (callable as `claim({ id })`, plus `claim.state`,
 * `claim.queue`, `claim.release`, and `claim.reorder`), `join`, and `onChange`.
 * The factory returns a plain object; the client assembles the `ablo.<model>`
 * lookup table from one of these per model.
 */

import { autorun } from 'mobx';
import {
  AbloClaimedError,
  AbloValidationError,
  toAbloError,
} from '@abloatai/transaction/errors';
import {
  reconcileFunctionalUpdate,
  type ModelUpdater,
  type FunctionalUpdateOptions,
} from '@abloatai/transaction/client/resources/functionalUpdate';
import type { MutationOptions } from '../interfaces/index.js';
import {
  claimDescription,
  type ReadDependency,
} from '@abloatai/transaction/coordination/schema';
import { Model, modelAsRow } from '../Model.js';
import { toMs } from '@abloatai/transaction/utils/duration';
import { LEASE_TTL_MS } from '@abloatai/transaction/wire/protocol';
import {
  heartbeatCadenceMs,
  resolveHeartbeatOptions,
  resolveHeartbeatPlan,
  startClaimHeartbeatLoop,
} from '@abloatai/transaction/claims';
import {
  assertWriteOptions,
  assertWriteTarget,
} from '@abloatai/transaction/client/resources/writeOptionsSchema';
import {
  createModelId,
  resolveCreatedRows,
  resolveCreateId,
} from '@abloatai/transaction/client/resources/modelCreate';
import type {
  CommitCreateOptions,
  CommitReceipt,
} from '@abloatai/transaction/client/resources/httpResources';
import type { HttpModelMutationParams } from '@abloatai/transaction/transport/http';
import {
  collectModelList,
  modelList,
  type ModelList,
} from '@abloatai/transaction/client/resources/httpResources';
import { subTarget } from '@abloatai/transaction/coordination';
// A named claim-meta crossing (see `claim-meta-crossings-are-enumerated` in
// .dependency-cruiser.cjs): the reactive model surface's self-claim targets are
// decodes that build a public claim, so their `meta` converts wire→declared
// here like the other enumerated crossings.
import { declaredMeta } from '@abloatai/transaction/claims';
import type { ModelTarget } from '@abloatai/transaction/coordination/schema';
import type { ModelRegistry } from '../ModelRegistry.js';
import type { InstanceCache } from '../InstanceCache.js';
import type { SyncClient } from '../SyncClient.js';
import type { OnDemandLoader } from '../sync/OnDemandLoader.js';
import type { JoinedParticipant } from '../sync/participants.js';
import { ModelScope } from '@abloatai/transaction/types';
import type {
  Duration,
  Claim,
  ClaimHeartbeat,
  ClaimHeartbeatOptions,
  HeldClaim,
  HeldLease,
  ClaimWaitOptions,
  ClaimTarget,
} from '@abloatai/transaction/types/streams';
import {
  bindClaimLifetime,
  claimLifetimeOf,
} from '@abloatai/transaction/claims/lifetime';

// The request contract — every option and parameter shape a caller passes to a
// read, a write, or a claim — lives in the confirmation core (ADR 0016). This
// factory binds it to reactive model instances; the shapes themselves are
// transport- and consumer-agnostic. Re-exported so `./createModelOperations` stays a
// working import path for the whole surface.
export type {
  ModelListScope,
  LocalReadOptions,
  LocalCountOptions,
  ServerReadOptions,
  ListAllOptions,
  ServerPointReadOptions,
  ClaimTargetOptions,
  ClaimParams,
  ClaimContentionOptions,
  ClaimAttemptEvent,
  ClaimQueueView,
  ClaimSkipOptions,
  ClaimSkipParams,
  ClaimLookupParams,
  ClaimReorderParams,
  ClaimOptions,
  ClaimReadApi,
  AwaitedClaimMethod,
  ClaimApi,
  ModelReadParams,
  ModelCreateParams,
  ModelUpdateParams,
  ModelDeleteParams,
  JoinOptions,
} from '@abloatai/transaction/client/resources/modelOperations';
export type { Claim, ClaimHeartbeat, ClaimHeartbeatOptions, HeldClaim, HeldLease };

import type {
  ClaimApi,
  ClaimLookupParams,
  ClaimOptions,
  ClaimParams,
  ClaimSkipOptions,
  ClaimSkipParams,
  ClaimAttemptEvent,
  ClaimQueueView,
  ClaimReorderParams,
  JoinOptions,
  LocalCountOptions,
  LocalReadOptions,
  ModelCreateManyParams,
  ModelCreateParams,
  ModelDeleteParams,
  ModelReadParams,
  ModelUpdateParams,
  ServerReadOptions,
  ListAllOptions,
} from '@abloatai/transaction/client/resources/modelOperations';
import {
  claimQueueView,
  resolveClaimContentionOptions,
} from '@abloatai/transaction/client/resources/modelOperations';
import type {
  CapturedRow,
  HttpModelClient,
} from '@abloatai/transaction/transport/http';
import type { ParticipantKind } from '@abloatai/transaction/types/participant';
import {
  capturePointRead,
  prepareReadSet,
  type ReadSetContext,
} from '@abloatai/transaction/internal/read-set';

export interface ModelClientMeta {
  readonly key: string;
  readonly typename: string;
}

const modelClientMeta = new WeakMap<object, ModelClientMeta>();

export function getModelClientMeta(modelClient: unknown): ModelClientMeta | undefined {
  if (typeof modelClient !== 'object' || modelClient === null) return undefined;
  return modelClientMeta.get(modelClient);
}


/**
 * The entity a coordination read names, without the sub-entity narrowing —
 * projected from {@link ModelTarget} so the two members are spelled once.
 */
type EntityHalf = Pick<ModelTarget, 'model' | 'id'>;

// Model-agnostic by construction: every member below names a target by
// `{ model, id }` and answers in claim/snapshot terms, so the row type never
// appears. It carried a `<T>` that nothing in the body read, which made
// `ModelCollaboration<Item>` and `ModelCollaboration<Invoice>` the same type
// while reading as though they differed.
export interface ModelCollaboration {
  /** Exact point evidence from the HTTP read boundary (stamp captured before data). */
  readPoint(model: string, id: string): Promise<{ data: unknown; stamp: number }>;
  /**
   * The batch commit lane, for a create handed a list of rows.
   *
   * A reactive client's single writes go through the mutation queue and land
   * optimistically, because a rejected write rolls one row back. A batch
   * cannot: it is atomic, so applying the rows one at a time would paint a
   * half-written state the server may then decline whole. It goes down the
   * same commit door the stateless client uses and the rows arrive on the
   * ordinary stream, the way a teammate's would.
   */
  commitBatch(options: CommitCreateOptions): Promise<CommitReceipt>;
  createClaim(options: {
    /**
     * The locator, in the spelling the SDK surface and the HTTP routes use.
     * The canonical {@link ModelTarget} rather than a shape spelled here: this
     * boundary is what a claim's narrowing has to cross, and a member missing
     * from it dies before the socket sees it.
     */
    target: ModelTarget;
    /** Peer-visible description of the work (`'rewriting the risk section'`). */
    description?: string;
    ttl?: Duration;
    /**
     * Block on the server's fair FIFO queue when the target is held, rather
     * than failing. Resolves only once the lease is genuinely ours (the head
     * of the line). `takeClaim` sets this so writers serialize on contention.
     */
    queue?: boolean;
    /** Reject (don't wait) if the queue is already this deep when we join. */
    maxQueueDepth?: number;
    /** Cap on the queued wait before rejecting with `grant_timeout`. */
    waitTimeoutMs?: number;
    /** Abort the queued wait — rejects with `claim_wait_aborted`. */
    signal?: AbortSignal;
    /** Request-scoped queued / granted / skipped / failed status events. */
    onStatus?: (event: ClaimAttemptEvent) => void;
  }): Promise<Claim>;
  /** Current applied/acked watermark, captured after a claim's fresh read. */
  currentReadAt(): number;
  /**
   * Current coordination state on a target — who (if anyone) holds it.
   * Synchronous reactive snapshot read off the presence/claim stream;
   * `null` when the target is free. The wiring site computes it because
   * only it knows the local participant id (needed to distinguish "I
   * hold it" from "someone else holds it").
   *
   * Named `state` to match the public `ablo.<model>.claim.state({ id })` read —
   * one verb for "who holds this" across every claim surface; the only
   * difference is this internal contract takes an explicit `{ model, id }`
   * target because it isn't bound to a single model.
   */
  state(target: EntityHalf): Claim | null;
  /**
   * Every active claim on a target, not just one. Sub-row claims on disjoint
   * parts of a row are all granted, so a row can have several holders at once
   * and `state` answers with only the first of them.
   */
  holders(target: EntityHalf): readonly Claim[];
  /**
   * The reactive wait queue on a target — the FIFO line of queued claims
   * behind the holder. Synchronous snapshot off the synced claim stream.
   */
  queue(target: EntityHalf): readonly Claim[];
  /**
   * Re-rank the wait queue on a target (privileged — server-gated). `order` is
   * the desired front-of-line ordering, taken from `queue(target)`.
   */
  reorder(target: EntityHalf, order: readonly Claim[]): void;
  /**
   * Resolve once no participant holds an active claim on the target.
   * The contender's "wait until it's free" — delegates to the claim
   * stream's `waitFor`.
   */
  waitFor(
    target: EntityHalf,
    options?: ClaimWaitOptions,
  ): Promise<void>;
  /**
   * The local participant's id. Used to distinguish "I already hold this"
   * from "someone else holds it" in `claimOrWait`.
   */
  readonly selfParticipantId: string;
  /**
   * The local participant's kind (`'user' | 'agent' | 'system'`). Used to stamp
   * the synthesized self-claim returned from `claim.state` when this client
   * holds the lease: server presence frames exclude a holder's own claims, so
   * the holder builds its own view.
   */
  readonly selfParticipantKind?: ParticipantKind;
  /**
   * Subscribes the connection to a scope's sync group(s) — read interest. The
   * typed surface calls this on single-entity reads and claim observation so a
   * client lands in the same entity-scoped group the holder's claim presence
   * fans out on; a peer subscribed only to broader `org:` or `user:` groups
   * would otherwise never see claim broadcasts. Fire-and-forget and best-effort:
   * read interest must never make a read reject or stall. Optional so minimal
   * test doubles can omit it.
   */
  enterScope?(scope: Record<string, string>): void | Promise<void>;
  /**
   * Pins a scope's sync group(s) — write intent: a row this client holds an
   * active claim on stays subscribed regardless of navigation. Same
   * fire-and-forget, best-effort semantics as `enterScope`.
   */
  pinScope?(scope: Record<string, string>): void | Promise<void>;
  /**
   * Opens a presence and claim subscription on this model's sync group(s) and
   * returns the live participant handle. Backs `ablo.<model>.join(ids)`.
   * WebSocket only, since presence needs a live socket; it is absent on other
   * client constructions, where the surface throws a clear error.
   */
  createJoin?(
    modelKey: string,
    ids: string | readonly string[],
    options?: JoinOptions,
  ): Promise<JoinedParticipant>;
}


/**
 * The synchronous, local-only reads — reached as `ablo.<model>.local.*`.
 *
 * Every verb mirrors its asynchronous sibling on the base surface, and the one
 * word in front is the whole difference. It is a narrowing, not a claim about
 * the other side: `read` consults the local graph and then the network,
 * while `local.get` is restricted to what is already resident — which is
 * also why it can return a value instead of a promise. There is nothing to
 * await.
 *
 * These reads exist only here. Exposing them at the top level too would undo
 * the distinction the namespace draws.
 */
export interface LocalReads<T> {
  /**
   * Snapshot of a single row from the local graph. `undefined` when the row is
   * not resident — a graph that is still empty, or a `lazy` model not yet
   * loaded. Pairs with reactive selectors:
   * `useAblo((ablo) => ablo.<model>.local.get(id))`.
   */
  get(id: string): T | undefined;

  /**
   * Snapshot of a filtered collection from the local graph. Empty until
   * `get`, `list`, or bootstrap has warmed the graph.
   */
  list(options?: LocalReadOptions<T>): T[];

  /** Count rows in the local graph. */
  count(options?: LocalCountOptions<T>): number;
}

/**
 * What a reactive client adds on top of the base per-model surface: a live
 * graph to read (`local`), the synchronous projection of the claim reads, and
 * the two subscriptions a persistent socket makes possible.
 *
 * `claim` is here rather than inherited because the two transports carry
 * deliberately different claim types, and the difference is load-bearing: a
 * stateless client has no local copy, so `state`/`queue`/`reorder` must be
 * awaited, while a reactive client resolves them synchronously — which is
 * precisely what lets a React render read claim state inline. The stateless
 * form is *derived* from this one through {@link AwaitedClaimMethod}, so the
 * only permitted difference between them is that promise wrapper.
 */
interface ReactiveModelSurface<T, Fields = T> {
  /** The synchronous local-graph reads. */
  local: LocalReads<T>;

  /**
   * Claim a row so other writers wait or are rejected until you're done, and
   * inspect or manage that coordination through the same namespace. Call it to
   * take a claim handle; reach for its members to observe and steer the wait line:
   *
   * - `claim.state({ id })` — who holds the row now, or `null` when free
   * - `claim.queue({ id })` — who's lined up behind the holder
   * - `claim.release({ id })` — drop a claim early (usually implicit on scope exit)
   * - `claim.reorder({ id, order })` — re-rank the wait line
   *
   * ```ts
   * const claim = await ablo.weatherReports.claim({
   *   id: 'report_stockholm',
   *   description: 'Fetching fresh weather before updating the report.',
   * });
   * const weather = await getWeather(claim.data.location);
   * await ablo.weatherReports.update({
   *   id: claim.target.id,
   *   data: { forecast: weather },
   *   claim,
   * });
   * await claim.release();
   *
   * const holder = ablo.weatherReports.claim.state({ id: 'report_stockholm' });
   * ```
   */
  claim: ClaimApi<T, Fields>;

  /**
   * Joins the sync group(s) for one or more rows of this model and returns a
   * live participant handle — presence (`.peers`), the scoped claim stream
   * (`.claims`), and `.leave()` / `await using` disposal. This is a presence
   * subscription: it reports who else is here and what they hold, not row
   * values changing — for the latter, use `onChange`.
   *
   * WebSocket only: presence needs a live socket, so this is absent on HTTP
   * clients and throws on any non-WebSocket construction.
   *
   * ```ts
   * await using participant = await ablo.sections.join(sectionIds, { ttl: '5m' });
   * participant.peers; // who else is here
   * ```
   */
  join(
    ids: string | readonly string[],
    options?: JoinOptions,
  ): Promise<JoinedParticipant>;

  /** Subscribe to changes; the callback runs on every change. */
  onChange(
    callback: (entities: T[]) => void,
    options?: LocalReadOptions<T>,
  ): () => void;
}

/**
 * Everything reachable as `ablo.<model>` on a reactive client.
 *
 * The base is not written here — it is the transport-independent per-model
 * surface, taken whole. A reactive client is that surface plus what a live
 * graph makes possible, so this type states the relationship instead of
 * restating the members, and a verb added to the base arrives here on its own.
 *
 * `claim` is the one member the base cannot supply directly: the two forms
 * differ by an awaitedness transform, so it is replaced rather than inherited.
 * See {@link ReactiveModelSurface}.
 */
export type ModelOperations<T, CreateInput> = Omit<
  HttpModelClient<T, CreateInput>,
  'claim'
> &
  ReactiveModelSurface<T, CreateInput>;

export function createModelOperations<T, C>(
  schemaKey: string,
  registeredModelName: string,
  objectPool: Pick<InstanceCache, 'get' | 'getByType' | 'getOfType'>,
  syncClient: Pick<
    SyncClient,
    | 'add'
    | 'delete'
    | 'getOrganizationId'
    | 'syncNow'
    | 'update'
    | 'waitForConfirmation'
  >,
  registry: Pick<ModelRegistry, 'getModelByName'>,
  /**
   * The one thing this factory asks of the loader: fetch rows for a model.
   *
   * Declared as the slice rather than the whole `OnDemandLoader` because the
   * whole is a class, and a parameter typed as a class can only ever be
   * satisfied by an instance of it — so every caller that has a narrower
   * collaborator, a test most of all, is pushed into a cast through `unknown`
   * to supply the one method that is actually read.
   */
  hydration: Pick<OnDemandLoader, 'fetch'> &
    Partial<Pick<OnDemandLoader, 'getReadEvidence'>>,
  collaboration?: ModelCollaboration,
  readSetContext?: ReadSetContext,
): ModelOperations<T, C> {
  const readSetClientIdentity = syncClient as object;
  /**
   * Resolve a row **this** resource owns.
   *
   * The pool is one id space, so `objectPool.get(id)` happily returns another
   * model's row. Every write path below addresses rows by bare id, so without
   * this an id from a sibling model resolves and gets written — silently
   * corrupting a row the caller never named.
   *
   * `undefined` means genuinely absent. A row belonging to another model throws:
   * unlike a read, a cross-model *write* is never a legitimate outcome, and
   * naming both models turns a silent corruption into a one-line diagnosis.
   */
  const ownRowOrThrow = (id: string): Model | undefined => {
    const own = objectPool.getOfType(id, registeredModelName);
    if (own) return own;
    const foreign = objectPool.get(id);
    if (!foreign) return undefined;
    const owner = foreign.getModelName();
    throw new AbloValidationError(
      `No ${registeredModelName} with id ${id} — that id belongs to a ${owner}. ` +
        `Read or write it through ${owner}.`,
      { code: 'entity_not_found' },
    );
  };

  const ModelClass = registry.getModelByName(registeredModelName);
  if (!ModelClass) {
    throw new AbloValidationError(
      `Ablo: schema model "${schemaKey}" resolved to "${registeredModelName}", ` +
        'but no matching constructor was registered.',
      { code: 'model_not_registered' },
    );
  }

  // The coordination plane must speak the same wire dialect as the commit
  // plane: the lowercased typename (`item`), not the schema key (`items`). The
  // server's commit-time claim guard probes the lease store with the commit
  // operation's model name, so a lease recorded under the schema key never
  // matches — which would silently disarm the guard for every model whose
  // schema key differs from its typename (a plural key against a singular
  // typename, i.e. nearly all of them). Public surfaces such as
  // `Claim.target.model` keep the schema key; only the wire and coordination
  // targets use this.
  const wireModel = registeredModelName.toLowerCase();

  // Last-line guarantee for the public surface: any rejection from a lower
  // layer (transport timeout, IndexedDB failure, a third-party throw) is
  // coerced to an AbloError before it reaches the consumer. The SDK's
  // contract is that callers only ever catch tagged errors — `instanceof
  // AbloError` / `e.type` always hold. Internal helpers stay unwrapped; only
  // the methods exposed on `operations` are guarded.
  const guard = <A extends unknown[], R>(
    fn: (...args: A) => Promise<R>,
  ): ((...args: A) => Promise<R>) => {
    return async (...args: A): Promise<R> => {
      try {
        return await fn(...args);
      } catch (err) {
        throw toAbloError(err);
      }
    };
  };

  const guardWrite = <A extends unknown[], R>(
    fn: (...args: A) => Promise<R>,
  ): ((...args: A) => Promise<R>) => {
    const guarded = guard(fn);
    return (...args: A): Promise<R> => {
      const confirmation = guarded(...args);
      // Optimistic writes are intentionally useful without awaiting them. The
      // transaction pipeline already reports a later refusal through
      // `onMutationFailure`; attach an observer here as well so choosing not to
      // await does not create an unhandled-rejection process error. Returning
      // the original promise preserves normal rejection for callers that do
      // await or attach their own catch handler.
      void confirmation.catch(() => undefined);
      return confirmation;
    };
  };

  const load = async (options?: ServerReadOptions<T>): Promise<T[]> => {
    if (options?.cursor !== undefined) {
      // The live client hydrates a working set into the local graph rather than
      // handing back pages, so there is no cursor for this read to resume from.
      // Accepting the option and ignoring it would return page one every time
      // while the caller believed it was advancing.
      throw new AbloValidationError(
        '`cursor` resumes a page of the stateless read. This client keeps a ' +
          'local graph and loads a working set instead of pages: narrow the ' +
          '`where`, or construct the client with `transport: \'http\'` to page.',
        { code: 'invalid_options', param: 'cursor' },
      );
    }
    const rows = await hydration.fetch<T>(schemaKey, options);
    return rows.map((row) => modelAsRow<T>(row));
  };

  const waitForMutation = async (model: Model): Promise<void> => {
    // Model writes are optimistic locally, but their promise has one stable
    // meaning: authoritative confirmation. Callers that do not need the
    // barrier can keep using the row immediately and leave the promise to the
    // global mutation-failure handler; awaiting the promise never means merely
    // "placed in the local queue".
    // Let sibling writes from the same synchronous burst enter the mutation
    // queue before forcing a drain. Without this yield, every confirmed
    // create/update calls syncNow() alone, defeating the queue's microtask
    // coalescer and producing one SQL transaction per delta.
    await Promise.resolve();
    await syncClient.syncNow();
    await syncClient.waitForConfirmation(model.getModelName(), model.id);
  };

  // Claims this model surface currently holds, keyed by the exact grant id.
  // Several disjoint sub-row claims may coexist on one entity, so entity id is
  // an index, never the identity of a lease. The old Map<entityId, claim>
  // silently overwrote the first handle when the same participant claimed a
  // second field and then released/guarded whichever happened to be last.
  //
  // `target`, `description`, and `expiresAt` are kept alongside the lease so
  // `claim.state` can synthesize a self-claim: the server excludes a holder's
  // own presence frames, so this surface is the only place that knows the client
  // holds the row. `expiresAt` is the client's best estimate from the requested
  // TTL (a real epoch-millisecond expiry, not a fabricated watermark), defaulting
  // to the server's keepalive lease window when no TTL was requested.
  interface ActiveClaim {
    readonly entityId: string;
    readonly lease: Claim;
    readonly readAt: number;
    readonly target: ClaimTarget;
    readonly description: string;
    expiresAt: number;
    stopHeartbeat?: () => void;
  }

  const activeClaims = new Map<
    string,
    ActiveClaim
  >();
  const claimIdsByEntity = new Map<string, Set<string>>();

  const claimsForEntity = (entityId: string): ActiveClaim[] =>
    [...(claimIdsByEntity.get(entityId) ?? [])].flatMap((claimId) => {
      const held = activeClaims.get(claimId);
      return held ? [held] : [];
    });

  const addActiveClaim = (claimId: string, held: ActiveClaim): void => {
    activeClaims.set(claimId, held);
    const ids = claimIdsByEntity.get(held.entityId) ?? new Set<string>();
    ids.add(claimId);
    claimIdsByEntity.set(held.entityId, ids);
  };

  const removeActiveClaim = (claimId: string): ActiveClaim | undefined => {
    const held = activeClaims.get(claimId);
    if (!held) return undefined;
    activeClaims.delete(claimId);
    const ids = claimIdsByEntity.get(held.entityId);
    ids?.delete(claimId);
    if (ids?.size === 0) claimIdsByEntity.delete(held.entityId);
    held.stopHeartbeat?.();
    return held;
  };

  const implicitClaimForEntity = (entityId: string): ActiveClaim | undefined => {
    const held = claimsForEntity(entityId);
    if (held.length <= 1) return held[0];
    throw new AbloValidationError(
      `${registeredModelName}/${entityId} has ${held.length} local claims on different parts of the row. Pass the exact claim handle to the write so Ablo can use the intended grant.`,
      { code: 'write_options_invalid', param: 'claim' },
    );
  };

  // Server keepalive lease window — the same `LEASE_TTL_MS` the wire protocol
  // declares, so the client's estimate and the server's lease cannot drift.
  // This is the fallback expiry estimate when a claim is taken without an
  // explicit TTL.
  const DEFAULT_LEASE_TTL_MS = LEASE_TTL_MS;

  const isClaimHandle = (value: unknown): value is Claim<T> =>
    typeof value === 'object' &&
    value !== null &&
    (value as { object?: unknown }).object === 'claim' &&
    typeof (value as { id?: unknown }).id === 'string' &&
    typeof (value as { release?: unknown }).release === 'function';

  const preparedMutation = (
    params:
      | ModelCreateParams<T, C>
      | ModelUpdateParams<T, C>
      | ModelDeleteParams<T, C>,
  ): MutationOptions => {
    const prepared = prepareReadSet(
      readSetContext,
      readSetClientIdentity,
      undefined,
      params.idempotencyKey,
      params.reads,
    );
    const rest: MutationOptions = {
      ...(prepared.idempotencyKey !== undefined
        ? { idempotencyKey: prepared.idempotencyKey }
        : params.idempotencyKey !== undefined
          ? { idempotencyKey: params.idempotencyKey }
        : {}),
      ...(params.label !== undefined ? { label: params.label } : {}),
      ...(prepared.reads !== undefined
        ? { reads: prepared.reads === null ? null : [...prepared.reads] }
        : params.reads !== undefined
          ? { reads: params.reads }
          : {}),
    };
    // The write-options schema — the runtime twin of the compile-time params.
    // Catches plain-JavaScript callers at the call site with a typed error
    // instead of a silent no-op or a server 400.
    assertWriteOptions(rest, `${schemaKey} write`);
    return rest;
  };

  const releaseClaim = async (claimId: string): Promise<void> => {
    const held = removeActiveClaim(claimId);
    if (!held) return;
    await held.lease.release?.();
  };

  const releaseClaimsForEntity = async (entityId: string): Promise<void> => {
    const ids = [...(claimIdsByEntity.get(entityId) ?? [])];
    await Promise.all(ids.map((claimId) => releaseClaim(claimId)));
  };

  const settleClaimsAfterWrite = async (
    entityId: string,
    explicit?: Pick<Claim<T>, 'id' | 'release'>,
  ): Promise<void> => {
    const explicitWasLocal = explicit ? activeClaims.has(explicit.id) : false;
    // The server fulfills every claim this participant holds on the written
    // entity. Mirror that terminal transition locally so claim.state/list and
    // heartbeat bookkeeping do not describe leases the commit already ended.
    // This runs after authoritative confirmation. A best-effort abandon frame
    // cannot turn a committed write into an apparent failure; the server has
    // already fulfilled the participant's claims as part of that commit.
    await releaseClaimsForEntity(entityId).catch(() => undefined);
    if (explicit && !explicitWasLocal) {
      await explicit.release?.().catch(() => undefined);
    }
  };

  const takeClaim = async (
    params: ClaimParams<C>,
  ): Promise<HeldClaim<T> | null> => {
    if (!collaboration) {
      throw new AbloValidationError(
        `Model "${schemaKey}" was built without the collaboration runtime, so claim() is unavailable here. Claiming needs no per-model config — use the standard Ablo({ schema, apiKey }) client and every model is claimable.`,
        { code: 'model_claim_not_configured' },
      );
    }
    const { id, ...options } = params;
    const contention = resolveClaimContentionOptions(options);
    const failFast = !contention.wait;

    // Ensure the row exists locally before claiming.
    let model = ownRowOrThrow(id);
    if (!model) {
      await load({ where: [['id', id]] });
      model = ownRowOrThrow(id);
    }
    if (!model) {
      throw new AbloValidationError(
        `Entity not found: ${registeredModelName}/${id}`,
        { code: 'entity_not_found' },
      );
    }

    // Write intent: enter the entity scope before acquiring the lease so the
    // holder's claim presence broadcasts to everyone in this entity group,
    // including a peer that subscribed just before us. Pinning before the lease
    // rather than after closes the subscribe-versus-broadcast race: the server
    // fans presence out at claim time, so this client must be in the group when
    // the claim lands. Awaited because the broadcast ordering depends on it;
    // still best-effort (the store swallows reconcile errors).
    await collaboration.pinScope?.({ [schemaKey]: id });

    // Acquire the lease. By default (`queue` is not false) this goes through the
    // server's fair FIFO queue: `queue: true` resolves only once the lease is
    // genuinely ours, blocking behind any current holder. Fail-fast skips the
    // queue but still awaits the server: a conflict invisible in the local
    // snapshot resolves `null`, never a speculative handle.
    let lease: Claim;
    try {
      lease = await collaboration.createClaim({
        target: {
          model: wireModel,
          id,
          // The whole sub-entity locator in one move — listing its members here
          // is what let `fields` die between the caller and the lease, so the
          // claim covered the whole row while the caller believed it named parts.
          ...subTarget(options, schemaKey),
        },
        description: claimDescription(options),
        ttl: options.ttl,
        queue: contention.wait,
        maxQueueDepth: contention.maxDepth,
        // The one wait cap, declared once on ClaimTargetOptions — the socket
        // wait and the HTTP poll-wait both honor it as `grant_timeout`.
        waitTimeoutMs: contention.timeoutMs,
        signal: contention.signal,
        onStatus: contention.onStatus,
      });
    } catch (err) {
      const normalized = toAbloError(err);
      if (
        failFast &&
        normalized instanceof AbloClaimedError &&
        normalized.code === 'claim_conflict'
      ) {
        return null;
      }
      throw normalized;
    }

    // Re-read on grant, never on contention. Holding the lease is the moment
    // this snapshot becomes the premise an expensive step is about to be spent
    // against, so it is read then — whether or not the claim queued, and
    // whether or not a local presence snapshot saw a holder.
    //
    // Gating this on contention assumed only a prior holder could have moved
    // the row, which holds while every writer passes the chokepoint and the
    // default policy refuses a non-holder's write. It does not hold for a row
    // fed by the WAL: a write that landed straight in the customer's database
    // never met a claim, so "nobody contended" was never evidence the row had
    // not changed. The HTTP claim has always read unconditionally here.
    //
    // `type: 'complete'` forces the round-trip: the hydration ledger would
    // otherwise serve the local row for an already-hydrated id, and a peer's
    // final write may not have fanned out yet — the exact stale-snapshot race
    // this closes.
    await load({ where: [['id', id]], type: 'complete' });
    model = ownRowOrThrow(id) ?? model;

    const readAt = lease.readAt ?? collaboration.currentReadAt();
    const description = claimDescription(options);
    // The self-claim's `ClaimTarget` mirrors what a peer's `claim.state` would
    // report (`state` maps `held.target.model` to `type`), so a holder and a
    // peer see the same `target.type` for one row — the wire model token.
    // Its `meta` is the DECLARED shape (the handle is a public claim), so the
    // wire-shaped projection converts back through `declaredMeta` — the same
    // crossing the HTTP handle assembly makes.
    const { meta: selfMeta, ...selfNarrowed } = subTarget(options, schemaKey);
    const selfTarget: ClaimTarget = {
      type: wireModel,
      id,
      ...selfNarrowed,
      ...(selfMeta !== undefined ? { meta: declaredMeta(selfMeta) } : {}),
    };
    const ttlMs =
      options.ttl !== undefined ? toMs(options.ttl) : DEFAULT_LEASE_TTL_MS;
    const expiresAt = Date.now() + ttlMs;
    const active: ActiveClaim = {
      entityId: id,
      lease,
      readAt,
      target: selfTarget,
      description,
      expiresAt,
    };
    addActiveClaim(lease.id, active);
    const { meta: targetMeta, ...targetNarrowed } = subTarget(options, schemaKey);
    const target = {
      type: schemaKey,
      id,
      ...targetNarrowed,
      ...(targetMeta !== undefined ? { meta: declaredMeta(targetMeta) } : {}),
    };
    // One reading of the heartbeat options — cadence and callbacks from
    // whichever spelling the caller used (plan object, shorthand, or the
    // deprecated flat callbacks).
    const plan = resolveHeartbeatPlan(options);
    // A beat resolves with the server's extended expiry; keep the local
    // self-claim estimate in step so `claim.state` renders the real window,
    // and surface every answer through the plan's `onBeat` (pressure signal).
    const heartbeat = async (
      beatOptions?: Duration | ClaimHeartbeatOptions,
    ): Promise<ClaimHeartbeat> => {
      if (!lease.heartbeat) {
        throw new AbloValidationError(
          'This claim handle has no heartbeat wiring, which the standard Ablo({ schema, apiKey }) client provides on every claim. This appears only when a claim is minted through an internal path that predates heartbeats.',
          { code: 'claim_not_wired' },
        );
      }
      const resolved = resolveHeartbeatOptions(beatOptions);
      const beat = await lease.heartbeat({
        ttl: resolved.ttl ?? options.ttl,
        ...(resolved.details !== undefined ? { details: resolved.details } : {}),
      });
      const held = activeClaims.get(lease.id);
      if (held) held.expiresAt = beat.expiresAt;
      plan.onBeat?.(beat);
      return beat;
    };

    // Opt-in auto-heartbeat: the loop beats until release, and a definitive
    // loss stops it and surfaces through the plan's `onLost`.
    const stopHeartbeatLoop = plan.loop
      ? startClaimHeartbeatLoop({
          beat: () => heartbeat(),
          intervalMs: heartbeatCadenceMs(ttlMs, plan.cadence),
          ...(plan.onLost ? { onLost: plan.onLost } : {}),
        })
      : undefined;

    active.stopHeartbeat = stopHeartbeatLoop;
    const lifetime = claimLifetimeOf(lease);
    lifetime?.onEnd(() => {
      removeActiveClaim(lease.id);
    });

    const release = () => {
      return releaseClaim(lease.id);
    };
    const handle = {
      object: 'claim',
      id: lease.id,
      readAt,
      // The fencing token the server minted for this grant, forwarded from the
      // lease so writes taken under this handle carry it (Option B).
      ...(lease.fenceToken !== undefined ? { fenceToken: lease.fenceToken } : {}),
      target,
      description,
      data: modelAsRow<T>(model),
      release,
      revoke: () => {
        void release();
      },
      heartbeat,
      [Symbol.asyncDispose]: release,
    } satisfies HeldClaim<T>;
    return lifetime ? bindClaimLifetime(handle, lifetime) : handle;
  };

  // The row-free sibling of `takeClaim`: locks a key by id alone, for a row that
  // lives only in the customer's own database and was never synced into Ablo.
  // Everything about the lease — the fail-fast contention check, the scope pin,
  // the `createClaim` grant, the heartbeat wiring, and the `activeClaims`
  // bookkeeping — is identical; what's dropped is the object-pool `load` (and its
  // `entity_not_found` throw), the post-grant re-read, and the `.data` field,
  // since there is no local row to hydrate or return.
  const takeRowFreeClaim = async (
    id: string,
    options: ClaimOptions<C>,
  ): Promise<HeldLease | null> => {
    if (!collaboration) {
      throw new AbloValidationError(
        `Model "${schemaKey}" was built without the collaboration runtime, so claim() is unavailable here. Claiming needs no per-model config — use the standard Ablo({ schema, apiKey }) client and every model is claimable.`,
        { code: 'model_claim_not_configured' },
      );
    }
    const contention = resolveClaimContentionOptions(options);
    const failFast = !contention.wait;

    // Enter the entity scope before acquiring the lease so the holder's claim
    // presence broadcasts to everyone in this entity group — the same ordering
    // the row-bearing path relies on. No pool `load` and no `entity_not_found`
    // throw: the row lives only in the customer's database, so there is nothing
    // to hydrate here and nothing to re-read after the grant.
    await collaboration.pinScope?.({ [schemaKey]: id });

    let lease: Claim;
    try {
      lease = await collaboration.createClaim({
        target: {
          model: wireModel,
          id,
          // The whole sub-entity locator in one move — listing its members here
          // is what let `fields` die between the caller and the lease, so the
          // claim covered the whole row while the caller believed it named parts.
          ...subTarget(options, schemaKey),
        },
        description: claimDescription(options),
        ttl: options.ttl,
        queue: contention.wait,
        maxQueueDepth: contention.maxDepth,
        // The one wait cap, declared once on ClaimTargetOptions — the socket
        // wait and the HTTP poll-wait both honor it as `grant_timeout`.
        waitTimeoutMs: contention.timeoutMs,
        signal: contention.signal,
        onStatus: contention.onStatus,
      });
    } catch (err) {
      const normalized = toAbloError(err);
      if (
        failFast &&
        normalized instanceof AbloClaimedError &&
        normalized.code === 'claim_conflict'
      ) {
        return null;
      }
      throw normalized;
    }

    // A row-free claim still captures the engine's current read floor. It gives
    // a later write under this lease a real `readAt` without constructing the
    // legacy row snapshot object (there is no row to put in one).
    const readAt = lease.readAt ?? collaboration.currentReadAt();
    const description = claimDescription(options);
    const selfTarget: ClaimTarget = {
      type: wireModel,
      id,
      ...subTarget(options, schemaKey),
    };
    const ttlMs =
      options.ttl !== undefined ? toMs(options.ttl) : DEFAULT_LEASE_TTL_MS;
    const expiresAt = Date.now() + ttlMs;
    const active: ActiveClaim = {
      entityId: id,
      lease,
      readAt,
      target: selfTarget,
      description,
      expiresAt,
    };
    addActiveClaim(lease.id, active);
    const target = {
      type: schemaKey,
      id,
      ...subTarget(options, schemaKey),
    };
    // One reading of the heartbeat options — cadence and callbacks from
    // whichever spelling the caller used.
    const plan = resolveHeartbeatPlan(options);
    // A beat resolves with the server's extended expiry; keep the local
    // self-claim estimate in step so `claim.state` renders the real window.
    const heartbeat = async (
      beatOptions?: Duration | ClaimHeartbeatOptions,
    ): Promise<ClaimHeartbeat> => {
      if (!lease.heartbeat) {
        throw new AbloValidationError(
          'This claim handle has no heartbeat wiring, which the standard Ablo({ schema, apiKey }) client provides on every claim. This appears only when a claim is minted through an internal path that predates heartbeats.',
          { code: 'claim_not_wired' },
        );
      }
      const resolved = resolveHeartbeatOptions(beatOptions);
      const beat = await lease.heartbeat({
        ttl: resolved.ttl ?? options.ttl,
        ...(resolved.details !== undefined ? { details: resolved.details } : {}),
      });
      const held = activeClaims.get(lease.id);
      if (held) held.expiresAt = beat.expiresAt;
      plan.onBeat?.(beat);
      return beat;
    };

    const stopHeartbeatLoop = plan.loop
      ? startClaimHeartbeatLoop({
          beat: () => heartbeat(),
          intervalMs: heartbeatCadenceMs(ttlMs, plan.cadence),
          ...(plan.onLost ? { onLost: plan.onLost } : {}),
        })
      : undefined;

    active.stopHeartbeat = stopHeartbeatLoop;
    const lifetime = claimLifetimeOf(lease);
    lifetime?.onEnd(() => {
      removeActiveClaim(lease.id);
    });

    const release = () => {
      return releaseClaim(lease.id);
    };
    const handle = {
      object: 'claim',
      id: lease.id,
      readAt,
      // Forward the grant's fencing token so writes under this row-free lease
      // carry it (Option B), exactly as the row-bearing claim does.
      ...(lease.fenceToken !== undefined ? { fenceToken: lease.fenceToken } : {}),
      target,
      description,
      release,
      revoke: () => {
        void release();
      },
      heartbeat,
      [Symbol.asyncDispose]: release,
    } satisfies HeldLease;
    return lifetime ? bindClaimLifetime(handle, lifetime) : handle;
  };

  // `claim` overloads on its first argument: an options object claims a synced
  // row and resolves to a HeldClaim (carrying `.data`); a bare id claims a key
  // whose row Ablo doesn't hold and resolves to a HeldLease (no `.data`). Both
  // route their throws through `toAbloError` via the guarded takers, so the
  // two-signature shape survives — wrapping the dispatcher itself in `guard`
  // would collapse the overloads to one.
  const guardedTakeClaim = guard(takeClaim);
  const guardedTakeRowFreeClaim = guard(takeRowFreeClaim);
  function claim(
    params: ClaimSkipParams<C>,
  ): Promise<HeldClaim<T> | null>;
  function claim(params: ClaimParams<C>): Promise<HeldClaim<T>>;
  function claim(
    id: string,
    opts: ClaimSkipOptions<C>,
  ): Promise<HeldLease | null>;
  function claim(id: string, opts?: ClaimOptions<C>): Promise<HeldLease>;
  function claim(
    arg: ClaimParams<C> | string,
    opts?: ClaimOptions<C>,
  ): Promise<HeldClaim<T> | HeldLease | null> {
    return typeof arg === 'string'
      ? guardedTakeRowFreeClaim(arg, opts ?? {})
      : guardedTakeClaim(arg);
  }

  // `claim` is a callable namespace: invoke it to take a claim, reach its
  // members to read/steer the coordination plane. Attach the readers to the
  // callable so `ablo.<model>.claim(...)` and `ablo.<model>.claim.state(...)`
  // are the same object.
  // `state` and `queue` take a caller-named `meta` shape. The runtime cannot
  // check it and is not meant to: `target.meta` is application data the
  // protocol carries verbatim and never interprets, so naming its type is the
  // caller asserting what it put there — the same bargain as parsing your own
  // JSON into an interface. These read as `Claim` here, and the one assertion
  // that applies the caller's parameter is on the assignment below, in one
  // place rather than at every call site.
  /**
   * This client's own claim on a row, as a claim-state object.
   *
   * The server excludes a holder's own presence frames and the client skips
   * them, so a row this client holds is absent from every peer-derived read.
   * Both `state` and `list` therefore synthesize it from the stored lease, and
   * they do it through here so the two answers cannot describe the same
   * holding differently.
   */
  const ownClaimStates = (id: string): Claim[] =>
    claimsForEntity(id).map((own) => ({
      object: 'claim',
      id: own.lease.id,
      status: 'active',
      target: own.target,
      description: own.description,
      heldBy: collaboration?.selfParticipantId ?? '',
      participantKind: collaboration?.selfParticipantKind ?? 'user',
      expiresAt: own.expiresAt,
      // Symmetric with the peer projection: a holder reading its own claim
      // sees the same `meta` an observer does.
      ...(own.target.meta !== undefined ? { meta: own.target.meta } : {}),
    }));

  const claimReaders = {
    state(params: ClaimLookupParams<T>): Claim | null {
      // Read interest: a passive observer of a row's claim state must enter that
      // row's entity scope, or it sits only on broader `org:`/`user:` groups and
      // never receives the holder's entity-scoped claim presence. Best-effort
      // and fire-and-forget — it never blocks or rejects the read.
      void collaboration?.enterScope?.({ [schemaKey]: params.id });
      // Self-awareness: the server excludes a holder's own presence frames and
      // the client skips them, so `state` would return null for a row this client
      // holds. Synthesize the active claim from the stored lease so the holder
      // sees its own claim, honoring the documented contract on `claim.state`.
      return (
        ownClaimStates(params.id)[0] ??
        collaboration?.state({ model: wireModel, id: params.id }) ??
        null
      );
    },

    /**
     * Every claim on the row, holders first. Sub-row claims on disjoint parts
     * are all granted, so a row can have several holders at once and
     * {@link state} answers with one of them — this is the read that renders
     * all of them. Same list envelope as {@link queue}, reactive on the same
     * snapshot, so a render reads it inline.
     */
    list(params: ClaimLookupParams<T>): { readonly object: 'list'; readonly data: readonly Claim[] } {
      void collaboration?.enterScope?.({ [schemaKey]: params.id });
      const own = ownClaimStates(params.id);
      const peers = collaboration?.holders({ model: wireModel, id: params.id }) ?? [];
      return {
        object: 'list',
        // Own claim first: the server excludes a holder's own presence frames,
        // so it is never among `peers` and the two never duplicate.
        data: [...own, ...peers],
      };
    },

    queue(params: ClaimLookupParams<T>): ClaimQueueView {
      return claimQueueView(
        collaboration?.queue({ model: wireModel, id: params.id }) ?? [],
      );
    },

    reorder(params: ClaimReorderParams<T>): void {
      collaboration?.reorder({ model: wireModel, id: params.id }, params.order);
    },

    release: guard((params: ClaimLookupParams<T> | Claim<T>): Promise<void> =>
      isClaimHandle(params)
        ? releaseClaim(params.id)
        : releaseClaimsForEntity(params.id),
    ),
  };

  // The one place the caller's `meta` parameter is applied — see the note on
  // `claimReaders`. Everything else about this object is checked structurally.
  const claimApi = Object.assign(claim, claimReaders) as ClaimApi<T, C>;

  const local: LocalReads<T> = {
    get(id: string): T | undefined {
      // Scoped to this model: an id belonging to a sibling model reads as
      // absent rather than being handed back as if it were a `T`.
      return objectPool.getOfType(id, registeredModelName) as T | undefined;
    },

    list(options): T[] {
      const all = objectPool.getByType(
        ModelClass,
        (options?.state ?? ModelScope.live) as ModelScope,
      ) as T[];
      let result = all;

      if (options?.where) {
        const where = options.where as Record<string, unknown>;
        result = result.filter((item) => {
          for (const [key, value] of Object.entries(where)) {
            if ((item as Record<string, unknown>)[key] !== value) return false;
          }
          return true;
        });
      }

      if (options?.filter) {
        result = result.filter(options.filter);
      }

      const orderEntry = options?.orderBy ? Object.entries(options.orderBy)[0] : undefined;
      if (orderEntry) {
        const [field, dir] = orderEntry;
        result = [...result].sort((a, b) => {
          const av = (a as Record<string, unknown>)[field];
          const bv = (b as Record<string, unknown>)[field];
          if (av == null || bv == null) return 0;
          const cmp = av < bv ? -1 : av > bv ? 1 : 0;
          return dir === 'desc' ? -cmp : cmp;
        });
      }

      if (options?.offset) result = result.slice(options.offset);
      if (options?.limit) result = result.slice(0, options.limit);

      return result;
    },

    count(options): number {
      return local.list(options).length;
    },
  };

  const pointRead = async (
    params: ModelReadParams,
    capture: boolean,
  ): Promise<T | undefined> => {
      // Read-interest enrolment: authoritative point reads enter the same
      // entity scope as the claim stream, while remaining settled reads.
      void collaboration?.enterScope?.({ [schemaKey]: params.id });
      const rows = await load({
        ...params,
        where: [['id', params.id]],
        limit: 1,
      });
      if (collaboration) {
        const result = await collaboration.readPoint(schemaKey, params.id);
        const data = (result.data ?? undefined) as T | undefined;
        if (!capture) return data;
        capturePointRead(
          readSetContext,
          readSetClientIdentity,
          wireModel,
          params.id,
          data,
          result.stamp,
        );
        return data;
      }
      return rows[0];
  };

  const get = guard(
    async (params: ModelReadParams): Promise<T | undefined> => pointRead(params, false),
  );

  const read = guard(
    async (params: ModelReadParams): Promise<CapturedRow<T> | undefined> =>
      pointRead(params, true) as Promise<CapturedRow<T> | undefined>,
  );

  const list = guard(async (
    options?: ServerReadOptions<T>,
  ): Promise<ModelList<T>> => {
    const rows = await load(options);
    // This transport loads a working set rather than pages, so there is no
    // cursor to hand back. `limit` can still cut the set short, and a full
    // count is exactly the case where the caller cannot tell: report it rather
    // than claim completeness this read cannot vouch for.
    return modelList<T>(rows, {
      hasMore: options?.limit !== undefined && rows.length >= options.limit,
      nextCursor: null,
    });
  });

  /**
   * Creates many rows as one atomic commit, and returns them in caller order.
   */
  const createManyRows = async (
    params: HttpModelMutationParams<ModelCreateManyParams<C>>,
  ): Promise<T[]> => {
    if (params.data.length === 0) return [];
    if (!collaboration) {
      throw new AbloValidationError(
        `Model "${schemaKey}" was built without the collaboration runtime, so a batch ` +
          `create is unavailable here. Use the standard Ablo({ schema, apiKey }) client.`,
        { code: 'model_claim_not_configured' },
      );
    }

    const prepared = prepareReadSet(
      readSetContext,
      readSetClientIdentity,
      undefined,
      params.idempotencyKey,
      params.reads,
    );
    const organizationId = syncClient.getOrganizationId() ?? undefined;
    const ids: string[] = [];
    const operations = params.data.map((row) => {
      const fields = row as Record<string, unknown>;
      const id =
        resolveCreateId(undefined, fields) ??
        createModelId(
          registeredModelName,
          params.idempotencyKey ? `${params.idempotencyKey}:${ids.length}` : null,
        );
      ids.push(id);
      return {
        action: 'create' as const,
        model: registeredModelName,
        data: { organizationId: fields.organizationId ?? organizationId, ...fields, id },
        id,
      };
    });

    const receipt = await collaboration.commitBatch({
      operations,
      wait: 'confirmed',
      ...(prepared.idempotencyKey
        ? { idempotencyKey: prepared.idempotencyKey }
        : params.idempotencyKey
          ? { idempotencyKey: params.idempotencyKey }
          : {}),
      ...(prepared.reads
        ? { reads: [...prepared.reads] }
        : {}),
    });

    const rows = await resolveCreatedRows<T>({
      modelName: registeredModelName,
      ids,
      operationResults: receipt.operationResults,
      readRow: async (id) => {
        const read = await collaboration.readPoint(registeredModelName, id);
        return read.data as T | undefined;
      },
    });
    return rows;
  };

  // `create` takes one row or a list of them. The list form is atomic and
  // is therefore NOT applied optimistically: see `createManyRows`.
  const createImpl = guardWrite(async (
    params:
      | HttpModelMutationParams<ModelCreateParams<T, C>>
      | HttpModelMutationParams<ModelCreateManyParams<C>>,
  ): Promise<T | T[]> => {
    if (Array.isArray(params.data)) {
      return createManyRows(params as HttpModelMutationParams<ModelCreateManyParams<C>>);
    }
    const single = params as ModelCreateParams<T, C>;
      const id = resolveCreateId(single.id, single.data) ?? Model.generateId();
      const claim = single.claim;
      let autoLease: Claim | undefined;
      if (claim && !isClaimHandle(claim)) {
        if (!collaboration) {
          throw new AbloValidationError(
            `Model "${schemaKey}" was built without the collaboration runtime, so claim() is unavailable here. Claiming needs no per-model config — use the standard Ablo({ schema, apiKey }) client and every model is claimable.`,
            { code: 'model_claim_not_configured' },
          );
        }
        // Write intent: enter the new row's entity scope before acquiring the
        // create-claim so the holder's claim presence broadcasts to everyone
        // already in this entity group (closing the subscribe-versus-broadcast
        // race — see `takeClaim`). Released with the lease in the `finally`
        // below. Awaited for broadcast ordering; still best-effort.
        await collaboration.pinScope?.({ [schemaKey]: id });
        const contention = resolveClaimContentionOptions(claim);
        autoLease = await collaboration.createClaim({
          target: {
            model: wireModel,
            id,
            ...subTarget(claim, schemaKey),
          },
          description: claimDescription(claim, 'creating'),
          ttl: claim.ttl,
          queue: contention.wait,
          maxQueueDepth: contention.maxDepth,
          waitTimeoutMs: contention.timeoutMs,
          signal: contention.signal,
          onStatus: contention.onStatus,
        });
      }

      // Default `organizationId` from the client's identity, matching the other
      // write path — without this, a caller that omits it would create an
      // org-unscoped row on one write path but not the other. An explicit value
      // in `data` still wins via the spread.
      const orgDefault =
        (params.data as Record<string, unknown>).organizationId ??
        syncClient.getOrganizationId();
      const model = new ModelClass({
        id,
        ...(orgDefault != null ? { organizationId: orgDefault } : {}),
        ...(params.data as Record<string, unknown>),
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      try {
        const effective: MutationOptions = {
          ...preparedMutation(single),
          ...(autoLease
            ? {
                claimRef: { id: autoLease.id },
                ...(autoLease.fenceToken !== undefined
                  ? { fenceToken: autoLease.fenceToken }
                  : {}),
              }
            : {}),
          ...(isClaimHandle(claim)
            ? {
                claimRef: { id: claim.id },
                ...(claim.fenceToken !== undefined
                  ? { fenceToken: claim.fenceToken }
                  : {}),
              }
            : {}),
        };
        syncClient.add(model, effective);
        await waitForMutation(model);
        return modelAsRow<T>(model);
      } finally {
        await autoLease?.release?.().catch(() => {});
      }
  });

  // Two public signatures over one implementation. A property arrow would
  // collapse them to their union, and a single create would start
  // resolving to `T | T[]` for every caller.
  function createRows(
    params: HttpModelMutationParams<ModelCreateParams<T, C>>,
  ): Promise<T>;
  function createRows(
    params: HttpModelMutationParams<ModelCreateManyParams<C>>,
  ): Promise<T[]>;
  function createRows(
    params:
      | HttpModelMutationParams<ModelCreateParams<T, C>>
      | HttpModelMutationParams<ModelCreateManyParams<C>>,
  ): Promise<T | T[]> {
    return createImpl(params);
  }

  const operations: ModelOperations<T, C> = {
    local,

    get,
    read,

    // No automatic scope enrolment on bulk `list`: that would subscribe to an
    // unbounded set of rows' entity groups.
    list,
    listAll: guard(async (options: ListAllOptions<T> = {}) => {
      const { maxPages, signal, ...readOptions } = options;
      signal?.throwIfAborted();
      return collectModelList(await list(readOptions), { maxPages, signal });
    }),

    create: createRows,

    // `update` is overloaded — classic `update({ id, data })` + functional
    // `update(id, current => next)`. The IIFE keeps the shared error-guard
    // wrapping while exposing the two public signatures (a plain `guard(...)`
    // would collapse them to one).
    update: ((): ModelOperations<T, C>['update'] => {
      const updateImpl = guardWrite(
        async (
          arg: ModelUpdateParams<T, C> | string,
          updater?: ModelUpdater<T>,
          contention?: FunctionalUpdateOptions<ReadDependency | CapturedRow>,
        ): Promise<T | undefined> => {
        // Functional form: update(id, current => next). Same guarantee as the
        // HTTP client (shared reconcile loop), implemented with this transport's
        // own read-fresh + confirmed compare-and-swap. A forced server round-trip
        // gets the latest row + watermark; the write is stale-guarded by it, so
        // concurrent writers reconcile instead of clobbering — no claim needed.
        if (typeof arg === 'string') {
          const id = arg;
          if (typeof updater !== 'function') {
            throw new AbloValidationError(
              `${registeredModelName}.update('${id}', updater): the second argument must ` +
                `be an updater function (current) => next. To write a fixed value, use ` +
                `update({ id, data }).`,
              { code: 'write_options_invalid' },
            );
          }
          if (!collaboration) {
            throw new AbloValidationError(
              `${registeredModelName}.update(id, updater) needs the collaboration runtime ` +
                `(a live WebSocket) to read the row's watermark for its compare-and-swap. ` +
                `Use the standard Ablo({ schema, apiKey }) client.`,
              { code: 'model_claim_not_configured' },
            );
          }
          return reconcileFunctionalUpdate<
            T,
            T,
            ReadDependency | CapturedRow
          >(updater, contention, {
            model: registeredModelName,
            id,
            readFresh: async () => {
              // `type: 'complete'` forces the round-trip — the hydration ledger
              // would otherwise serve a possibly-stale local row for a hydrated id.
              await load({ where: [['id', id]], type: 'complete' });
              const exact = await collaboration.readPoint(wireModel, id);
              capturePointRead(
                readSetContext,
                readSetClientIdentity,
                wireModel,
                id,
                exact.data,
                exact.stamp,
              );
              return {
                data: exact.data as T | undefined,
                stamp: exact.stamp,
              };
            },
            writeNext: async (patch, readAt) => {
              const model = ownRowOrThrow(id);
              if (!model) {
                throw new AbloValidationError(
                  `Entity not found: ${registeredModelName}/${id}`,
                  { code: 'entity_not_found' },
                );
              }
              const prepared = prepareReadSet(
                readSetContext,
                readSetClientIdentity,
                undefined,
                undefined,
                contention?.reads,
              );
              const effective: MutationOptions = {
                readAt: prepared.readAt ?? readAt,
                ...(prepared.idempotencyKey
                  ? { idempotencyKey: prepared.idempotencyKey }
                  : {}),
                ...(prepared.reads !== undefined
                  ? { reads: prepared.reads === null ? null : [...prepared.reads] }
                  : {}),
              };
              model.applyChanges(patch);
              syncClient.update(model, effective);
              await waitForMutation(model);
              return modelAsRow<T>(model);
            },
          });
        }
        const params = arg;
        // Named before anything reads it. Without this the row lookup below
        // reports `Entity not found: Model/undefined`, which sends the reader
        // looking for a missing row rather than at the unaddressed write.
        assertWriteTarget('update', registeredModelName, params.id);
        const autoClaim =
          params.claim && !isClaimHandle(params.claim) ? params.claim : null;
        if (autoClaim) {
          const handle = await takeClaim({ ...autoClaim, id: params.id });
          // A skipped try-claim is `null` only on the standalone verb; a
          // write that could not take its claim is a failed write.
          if (!handle) {
            throw new AbloClaimedError(
              `${registeredModelName}/${params.id} is held by another participant, so this update's claim could not be taken.`,
              { code: 'entity_claimed' },
            );
          }
          try {
            return await operations.update({ ...params, claim: handle });
          } finally {
            await handle.release();
          }
        }
        const { id } = params;
        const model = ownRowOrThrow(id);
        if (!model)
          throw new AbloValidationError(
            `Entity not found: ${registeredModelName}/${id}`,
            { code: 'entity_not_found' },
          );
        const opts = preparedMutation(params);
        const handle = isClaimHandle(params.claim) ? params.claim : undefined;
        // An exact carried handle always wins. Without one, the convenience
        // path may use the sole local claim on this row; several disjoint local
        // claims are intentionally ambiguous and require the caller to pass one.
        const claimed = handle ? activeClaims.get(handle.id) : implicitClaimForEntity(id);
        const selected = handle ?? claimed?.lease;
        const selectedReadAt = handle?.readAt ?? claimed?.readAt;
        const effective: MutationOptions = {
          ...(selectedReadAt !== undefined ? { readAt: selectedReadAt } : {}),
          ...(selected?.fenceToken !== undefined
            ? { fenceToken: selected.fenceToken }
            : {}),
          ...opts,
          ...(selected ? { claimRef: { id: selected.id } } : {}),
        };
        // Local user update: `applyChanges` keeps change tracking on so the
        // edited fields land in `modifiedProperties` and are actually sent to
        // the server. (`updateFromData` is the hydration path and would discard
        // the tracking, producing an empty `input: {}` no-op mutation.)
        model.applyChanges(params.data);
        syncClient.update(model, effective);
        await waitForMutation(model);
        const updated = modelAsRow<T>(model);
        await settleClaimsAfterWrite(id, handle);
        return updated;
        },
      );
      function update(params: ModelUpdateParams<T, C>): Promise<T>;
      function update(
        id: string,
        updater: ModelUpdater<T>,
        options?: FunctionalUpdateOptions<ReadDependency | CapturedRow>,
      ): Promise<T | undefined>;
      function update(
        arg: ModelUpdateParams<T, C> | string,
        updater?: ModelUpdater<T>,
        contention?: FunctionalUpdateOptions<ReadDependency | CapturedRow>,
      ): Promise<T | undefined> {
        return updateImpl(arg, updater, contention);
      }
      return update;
    })(),

    delete: guardWrite(async (params: ModelDeleteParams<T, C>): Promise<void> => {
      // Before the idempotent "ensure absent" below can read this as a row that
      // is simply not here. An unaddressed delete is a mistake, not an absence.
      assertWriteTarget('delete', registeredModelName, params.id);
      const autoClaim =
        params.claim && !isClaimHandle(params.claim) ? params.claim : null;
      if (autoClaim) {
        const handle = await takeClaim({ ...autoClaim, id: params.id });
        // Same rule as update: a write that could not take its claim fails.
        if (!handle) {
          throw new AbloClaimedError(
            `${registeredModelName}/${params.id} is held by another participant, so this delete's claim could not be taken.`,
            { code: 'entity_claimed' },
          );
        }
        try {
          await operations.delete({ ...params, claim: handle });
        } finally {
          await handle.release();
        }
        return;
      }
      const { id } = params;
      // Scoped: "ensure absent" stays idempotent for an id this model simply
      // doesn't hold, but an id owned by a sibling model throws rather than
      // deleting a row the caller never addressed.
      const model = ownRowOrThrow(id);
      // Idempotent delete: "ensure absent". A row that isn't in this client's
      // replicated view is already gone from its perspective, so a delete is a
      // no-op success rather than an `entity_not_found` error. This matches the
      // HTTP client and makes delete safe to retry or race (two actors deleting
      // the same row).
      if (!model) {
        const handle = isClaimHandle(params.claim) ? params.claim : undefined;
        await settleClaimsAfterWrite(id, handle);
        return;
      }
      const opts = preparedMutation(params);
      const handle = isClaimHandle(params.claim) ? params.claim : undefined;
      const claimed = handle ? activeClaims.get(handle.id) : implicitClaimForEntity(id);
      const selected = handle ?? claimed?.lease;
      const selectedReadAt = handle?.readAt ?? claimed?.readAt;
      const effective: MutationOptions = {
        ...(selectedReadAt !== undefined ? { readAt: selectedReadAt } : {}),
        ...(selected?.fenceToken !== undefined
          ? { fenceToken: selected.fenceToken }
          : {}),
        ...opts,
        ...(selected ? { claimRef: { id: selected.id } } : {}),
      };
      syncClient.delete(model, effective);
      await waitForMutation(model);
      await settleClaimsAfterWrite(id, handle);
    }),

    // `claim` is a callable namespace (take a claim) carrying the coordination
    // readers (`claim.state` / `claim.queue` / `claim.release` / `claim.reorder`).
    claim: claimApi,

    join: guard(
      (
        ids: string | readonly string[],
        options?: JoinOptions,
      ): Promise<JoinedParticipant> => {
        if (!collaboration?.createJoin) {
          throw new AbloValidationError(
            `Model "${schemaKey}" was built without a WebSocket runtime, so join() is unavailable here. Presence needs a live socket — use the standard Ablo({ schema, apiKey }) client (not the HTTP transport).`,
            { code: 'model_join_not_configured' },
          );
        }
        return collaboration.createJoin(schemaKey, ids, options);
      },
    ),

    onChange(callback, options): () => void {
      return autorun(() => {
        callback(local.list(options));
      });
    },
  };

  modelClientMeta.set(operations, {
    key: schemaKey,
    typename: registeredModelName,
  });

  return operations;
}
