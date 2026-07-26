/**
 * Builds the typed client for a single schema model — the object reached as
 * `ablo.<model>`.
 *
 * Each schema model gets one {@link ModelOperations}: the async server reads
 * `get` and `list`, with the same point lookup restricted to the local graph under
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
  type ContentionOptions,
} from '@abloatai/transaction/resources/functionalUpdate';
import type { MutationOptions } from '../interfaces/index.js';
import {
  claimDescription,
  type TrackDependency,
} from '@abloatai/transaction/coordination/schema';
import { Model, modelAsRow } from '../Model.js';
import { toMs } from '@abloatai/transaction/utils/duration';
import { LEASE_TTL_MS } from '@abloatai/transaction/wire/protocol';
import {
  heartbeatCadenceMs,
  resolveHeartbeatOptions,
  resolveHeartbeatPlan,
  startClaimHeartbeatLoop,
} from '@abloatai/transaction/coordination/claimHeartbeatLoop';
import { assertWriteOptions } from '@abloatai/transaction/resources/writeOptionsSchema';
import { subTarget } from '@abloatai/transaction/coordination';
// A named claim-meta crossing (see `claim-meta-crossings-are-enumerated` in
// .dependency-cruiser.cjs): the reactive proxy's self-claim targets are
// decodes that build a public claim, so their `meta` converts wire→declared
// here like the other enumerated crossings.
import { declaredMeta } from '@abloatai/transaction/coordination/claimMeta';
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
  Snapshot,
} from '@abloatai/transaction/types/streams';

// The request contract — every option and parameter shape a caller passes to a
// read, a write, or a claim — lives in the settlement core (ADR 0016). This
// factory binds it to reactive model instances; the shapes themselves are
// transport- and consumer-agnostic. Re-exported so `./createModelProxy` stays a
// working import path for the whole surface.
export type {
  ModelListScope,
  ModelTrackParams,
  ModelTrackResult,
  LocalReadOptions,
  LocalCountOptions,
  ServerReadOptions,
  ServerGetOptions,
  ServerRetrieveOptions,
  ClaimTargetOptions,
  ClaimParams,
  ClaimLookupParams,
  ClaimReorderParams,
  ClaimOptions,
  ClaimReadApi,
  AwaitedClaimMethod,
  ClaimApi,
  ModelRetrieveParams,
  ModelCreateParams,
  ModelUpdateParams,
  ModelDeleteParams,
  JoinOptions,
} from '@abloatai/transaction/resources/modelOperations';
export type { Claim, ClaimHeartbeat, ClaimHeartbeatOptions, HeldClaim, HeldLease };

import type {
  ClaimApi,
  ClaimLookupParams,
  ClaimOptions,
  ClaimParams,
  ClaimReorderParams,
  JoinOptions,
  LocalCountOptions,
  LocalReadOptions,
  ModelCreateParams,
  ModelDeleteParams,
  ModelRetrieveParams,
  ModelTrackParams,
  ModelTrackResult,
  ModelUpdateParams,
  ServerReadOptions,
} from '@abloatai/transaction/resources/modelOperations';
import type { HttpModelClient } from '@abloatai/transaction/transport/httpClient';
import type { ParticipantKind } from '@abloatai/transaction/types/participant';

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
// `ModelCollaboration<Task>` and `ModelCollaboration<Invoice>` the same type
// while reading as though they differed.
export interface ModelCollaboration {
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
  }): Promise<Claim>;
  createSnapshot(modelKey: string, id: string): Snapshot;
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
   * client constructions, where the proxy throws a clear error.
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
 * the other side: `get` consults the local graph and then the network,
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

export function createModelProxy<T, C>(
  schemaKey: string,
  registeredModelName: string,
  objectPool: Pick<InstanceCache, 'get' | 'getByType' | 'getOfType'>,
  syncClient: Pick<
    SyncClient,
    | 'add'
    | 'delete'
    | 'getMutationQueue'
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
  hydration: Pick<OnDemandLoader, 'fetch'>,
  collaboration?: ModelCollaboration,
  /** The client-wide `wait` default; a per-call `wait` still wins over it. */
  defaultWait?: 'queued' | 'confirmed',
): ModelOperations<T, C> {
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
  // plane: the lowercased typename (`task`), not the schema key (`tasks`). The
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

  const load = async (options?: ServerReadOptions<T>): Promise<T[]> => {
    const rows = await hydration.fetch<T>(schemaKey, options);
    return rows.map((row) => modelAsRow<T>(row));
  };

  const waitForMutation = async (
    model: Model,
    options?: MutationOptions,
  ): Promise<void> => {
    // A per-call `wait` wins; otherwise the client-wide default decides. This
    // is the single point that turns "confirmed" into actually waiting, so a
    // client configured that way rejects on a refused write everywhere rather
    // than in the one place a caller remembered to ask.
    if ((options?.wait ?? defaultWait) !== 'confirmed') return;
    // Let sibling writes from the same synchronous burst enter the mutation
    // queue before forcing a drain. Without this yield, every confirmed
    // create/update calls syncNow() alone, defeating the queue's microtask
    // coalescer and producing one SQL transaction per delta.
    await Promise.resolve();
    await syncClient.syncNow();
    await syncClient.waitForConfirmation(model.getModelName(), model.id);
  };

  // Claims this proxy currently holds, keyed by entity id. Lets the flat
  // `release({ id })` and `update({ id, data })` find the lease and snapshot a
  // `claim({ id })` took, without a per-call handle. Released on dispose,
  // explicit release, or TTL expiry.
  //
  // `target`, `description`, and `expiresAt` are kept alongside the lease so
  // `claim.state` can synthesize a self-claim: the server excludes a holder's
  // own presence frames, so this proxy is the only place that knows the client
  // holds the row. `expiresAt` is the client's best estimate from the requested
  // TTL (a real epoch-millisecond expiry, not a fabricated watermark), defaulting
  // to the server's keepalive lease window when no TTL was requested.
  const activeClaims = new Map<
    string,
    {
      lease: Claim;
      snapshot: Snapshot;
      target: ClaimTarget;
      description: string;
      expiresAt: number;
    }
  >();

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

  const mutationOptions = (
    params:
      | ModelCreateParams<T, C>
      | ModelUpdateParams<T, C>
      | ModelDeleteParams<T, C>,
  ): MutationOptions => {
    const rest: MutationOptions = {
      ...(params.idempotencyKey !== undefined
        ? { idempotencyKey: params.idempotencyKey }
        : {}),
      ...(params.label !== undefined ? { label: params.label } : {}),
      ...(params.wait !== undefined ? { wait: params.wait } : {}),
      ...(params.readAt !== undefined ? { readAt: params.readAt } : {}),
      ...(params.onStale !== undefined ? { onStale: params.onStale } : {}),
      ...(params.fenceToken !== undefined ? { fenceToken: params.fenceToken } : {}),
      ...(params.claimRef !== undefined ? { claimRef: params.claimRef } : {}),
      ...(params.reads !== undefined ? { reads: params.reads } : {}),
      ...(params.track !== undefined ? { track: params.track } : {}),
    };
    // The write-options schema — the runtime twin of the compile-time params.
    // Catches plain-JavaScript callers (for example `onStale: 'rejct'`) at the
    // call site with a typed error instead of a silent no-op or a server 400.
    assertWriteOptions(rest, `${schemaKey} write`);
    return rest;
  };

  const releaseClaim = async (id: string): Promise<void> => {
    const held = activeClaims.get(id);
    if (!held) return;
    activeClaims.delete(id);
    await held.lease.release?.();
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
    // Is someone else already on this target? Read the local coordination
    // snapshot up front — it decides whether a re-read is needed after the
    // claim (a free or already-held target cannot have changed underneath us).
    const held = collaboration.state({ model: wireModel, id });
    const contended = !!held && held.heldBy !== collaboration.selfParticipantId;
    const failFast = options.queue === false;

    // The try-claim (`queue: false`): a held target is an expected outcome,
    // not an error, so it resolves `null` — the caller reads `if (!claim)`
    // and moves on; who holds it stays readable via `claim.state`. Best-effort
    // at the client (a racing claim not yet synced into our snapshot slips
    // through here) — the commit-time claim guard is the authoritative
    // backstop that rejects the loser's first write. For work-distribution
    // dedup that's exactly right: don't wait (that would double-process), skip.
    if (failFast && contended) {
      return null;
    }

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
    // genuinely ours, blocking behind any current holder, with no check-then-act
    // gap because the server orders contenders. Fail-fast skips the queue: an
    // observed conflict was already rejected above, so this just records the lease.
    const lease = await collaboration.createClaim({
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
      queue: !failFast,
      maxQueueDepth: options.maxQueueDepth,
      // The one wait cap, declared once on ClaimTargetOptions — the socket
      // wait and the HTTP poll-wait both honor it as `grant_timeout`.
      waitTimeoutMs: options.waitTimeoutMs,
      signal: options.signal,
    });

    // Only when the claim actually waited behind another holder can the row have
    // changed underneath us — re-read so the claimed snapshot reflects what that
    // holder committed before releasing. Either of two signals suffices:
    //   - `lease.waited` — the server granted the claim after the client
    //     provably queued behind a holder. Authoritative; it works even when the
    //     local snapshot is blind, since claim fan-out is entity-scoped and a
    //     broadly-subscribed client never observes peers' claims.
    //   - `contended` — the local snapshot saw a holder up front. Kept for the
    //     no-queue paths, where no grant frame exists.
    if ((contended || lease.waited === true) && !failFast) {
      // `type: 'complete'` forces the round-trip: the hydration ledger would
      // otherwise serve the local row for an already-hydrated id, and the
      // holder's final write may not have fanned out yet — the exact
      // stale-snapshot race this re-read closes.
      await load({ where: [['id', id]], type: 'complete' });
      model = ownRowOrThrow(id) ?? model;
    }

    const snapshot = collaboration.createSnapshot(schemaKey, id);
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
    activeClaims.set(id, {
      lease,
      snapshot,
      target: selfTarget,
      description,
      expiresAt,
    });
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
      const held = activeClaims.get(id);
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

    const release = () => {
      stopHeartbeatLoop?.();
      return releaseClaim(id);
    };
    return {
      object: 'claim',
      id: lease.id,
      readAt: lease.readAt ?? snapshot.stamp,
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
    };
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
    // Is someone else already on this target? Read the local coordination
    // snapshot up front so a `queue: false` caller can reject before announcing
    // a claim the server would refuse.
    const held = collaboration.state({ model: wireModel, id });
    const contended = !!held && held.heldBy !== collaboration.selfParticipantId;
    const failFast = options.queue === false;

    // The try-claim (`queue: false`): resolve `null` if a holder is already
    // visible — an expected outcome, not an error. Best-effort at the client —
    // a row this participant never synced usually carries no local claim state
    // either, so a peer gets the deterministic `null` only once it has
    // observed the holder (entered the row's entity scope). The server's
    // queue is the backstop for the queuing path.
    if (failFast && contended) {
      return null;
    }

    // Enter the entity scope before acquiring the lease so the holder's claim
    // presence broadcasts to everyone in this entity group — the same ordering
    // the row-bearing path relies on. No pool `load` and no `entity_not_found`
    // throw: the row lives only in the customer's database, so there is nothing
    // to hydrate here and nothing to re-read after the grant.
    await collaboration.pinScope?.({ [schemaKey]: id });

    const lease = await collaboration.createClaim({
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
      queue: !failFast,
      maxQueueDepth: options.maxQueueDepth,
      // The one wait cap, declared once on ClaimTargetOptions — the socket
      // wait and the HTTP poll-wait both honor it as `grant_timeout`.
      waitTimeoutMs: options.waitTimeoutMs,
      signal: options.signal,
    });

    // A watermark-only snapshot: `createSnapshot` still reads the engine's
    // current `lastSyncId` even though the pool holds no row (the bucket is
    // empty). It costs nothing extra and gives a write taken under this lease a
    // real `readAt` to guard against changes since the lease was acquired.
    const snapshot = collaboration.createSnapshot(schemaKey, id);
    const description = claimDescription(options);
    const selfTarget: ClaimTarget = {
      type: wireModel,
      id,
      ...subTarget(options, schemaKey),
    };
    const ttlMs =
      options.ttl !== undefined ? toMs(options.ttl) : DEFAULT_LEASE_TTL_MS;
    const expiresAt = Date.now() + ttlMs;
    activeClaims.set(id, {
      lease,
      snapshot,
      target: selfTarget,
      description,
      expiresAt,
    });
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
      const held = activeClaims.get(id);
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

    const release = () => {
      stopHeartbeatLoop?.();
      return releaseClaim(id);
    };
    return {
      object: 'claim',
      id: lease.id,
      readAt: snapshot.stamp,
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
    };
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
    params: ClaimParams<C> & { queue: false },
  ): Promise<HeldClaim<T> | null>;
  function claim(params: ClaimParams<C>): Promise<HeldClaim<T>>;
  function claim(
    id: string,
    opts: ClaimOptions<C> & { queue: false },
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
  const ownClaimState = (id: string): Claim | null => {
    const own = activeClaims.get(id);
    if (!own) return null;
    return {
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
    };
  };

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
        ownClaimState(params.id) ??
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
      const own = ownClaimState(params.id);
      const peers = collaboration?.holders({ model: wireModel, id: params.id }) ?? [];
      return {
        object: 'list',
        // Own claim first: the server excludes a holder's own presence frames,
        // so it is never among `peers` and the two never duplicate.
        data: own ? [own, ...peers] : [...peers],
      };
    },

    queue(params: ClaimLookupParams<T>): { readonly object: 'list'; readonly data: readonly Claim[] } {
      return {
        object: 'list',
        data: collaboration?.queue({ model: wireModel, id: params.id }) ?? [],
      };
    },

    reorder(params: ClaimReorderParams<T>): void {
      collaboration?.reorder({ model: wireModel, id: params.id }, params.order);
    },

    release: guard((params: ClaimLookupParams<T> | Claim<T>): Promise<void> =>
      releaseClaim(isClaimHandle(params) ? params.target.id : params.id),
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

  const get = guard(
    async (params: ModelRetrieveParams): Promise<T | undefined> => {
      // Read-interest enrolment: authoritative point reads enter the same
      // entity scope as the claim stream, while remaining settled reads.
      void collaboration?.enterScope?.({ [schemaKey]: params.id });
      const rows = await load({
        ...params,
        where: [['id', params.id]],
        limit: 1,
      });
      return rows[0];
    },
  );

  const operations: ModelOperations<T, C> = {
    local,

    get,
    retrieve: get,

    // No automatic scope enrolment on bulk `list`: that would subscribe to an
    // unbounded set of rows' entity groups.
    list: guard(load),

    create: guard(async (params: ModelCreateParams<T, C>): Promise<T> => {
      const id = params.id ?? Model.generateId();
      const opts = mutationOptions(params);
      const claim = params.claim;
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
        autoLease = await collaboration.createClaim({
          target: {
            model: wireModel,
            id,
            ...subTarget(claim, schemaKey),
          },
          description: claimDescription(claim, 'creating'),
          ttl: claim.ttl,
          queue: claim.queue !== false,
          maxQueueDepth: claim.maxQueueDepth,
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
      const effective: MutationOptions = {
        ...opts,
        ...(autoLease ? { claim: autoLease } : {}),
        ...(isClaimHandle(claim) ? { claim: { id: claim.id } } : {}),
      };
      try {
        syncClient.add(model, effective);
        await waitForMutation(model, effective);
        return modelAsRow<T>(model);
      } finally {
        await autoLease?.release?.().catch(() => {});
      }
    }),

    // `update` is overloaded — classic `update({ id, data })` + functional
    // `update(id, current => next)`. The IIFE keeps the shared error-guard
    // wrapping while exposing the two public signatures (a plain `guard(...)`
    // would collapse them to one).
    update: ((): ModelOperations<T, C>['update'] => {
      const updateImpl = guard(
        async (
          arg: ModelUpdateParams<T, C> | string,
          updater?: ModelUpdater<T>,
          contention?: ContentionOptions,
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
          return reconcileFunctionalUpdate<T, T>(updater, contention, {
            model: registeredModelName,
            id,
            readFresh: async () => {
              // `type: 'complete'` forces the round-trip — the hydration ledger
              // would otherwise serve a possibly-stale local row for a hydrated id.
              await load({ where: [['id', id]], type: 'complete' });
              const fresh = ownRowOrThrow(id);
              const snapshot = collaboration.createSnapshot(schemaKey, id);
              return {
                data: fresh ? modelAsRow<T>(fresh) : undefined,
                stamp: snapshot.stamp,
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
              const effective: MutationOptions = {
                wait: 'confirmed',
                readAt,
                onStale: 'reject',
              };
              model.applyChanges(patch);
              syncClient.update(model, effective);
              await waitForMutation(model, effective);
              return modelAsRow<T>(model);
            },
          });
        }
        const params = arg;
        const autoClaim =
          params.claim && !isClaimHandle(params.claim) ? params.claim : null;
        if (autoClaim) {
          const handle = await takeClaim({ ...autoClaim, id: params.id });
          // A declined try-claim is `null` only on the standalone verb; a
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
        // If we hold a claim on this row, guard the write with its snapshot
        // watermark + lease so it's stale-rejected and attributed to the claim.
        const claimed = activeClaims.get(id);
        const opts = mutationOptions(params);
        const handle = isClaimHandle(params.claim) ? params.claim : undefined;
        const effective: MutationOptions | undefined = claimed
          ? {
              wait: 'confirmed',
              readAt: claimed.lease.readAt ?? claimed.snapshot.stamp,
              onStale: 'reject',
              claimRef: { id: claimed.lease.id },
              ...opts,
            }
          : {
              // A carried handle engages the same stale guard as a claim this
              // proxy took itself — the watermark rides on the handle, so it
              // works across clients (HTTP-minted handles included).
              ...(handle?.readAt !== undefined
                ? {
                    wait: 'confirmed' as const,
                    readAt: handle.readAt,
                    onStale: 'reject' as const,
                    ...(handle.fenceToken !== undefined
                      ? { fenceToken: handle.fenceToken }
                      : {}),
                  }
                : {}),
              ...opts,
              ...(handle ? { claim: { id: handle.id } } : {}),
            };
        // Local user update: `applyChanges` keeps change tracking on so the
        // edited fields land in `modifiedProperties` and are actually sent to
        // the server. (`updateFromData` is the hydration path and would discard
        // the tracking, producing an empty `input: {}` no-op mutation.)
        model.applyChanges(params.data);
        syncClient.update(model, effective);
        await waitForMutation(model, effective);
        return modelAsRow<T>(model);
        },
      );
      function update(params: ModelUpdateParams<T, C>): Promise<T>;
      function update(
        id: string,
        updater: ModelUpdater<T>,
        options?: ContentionOptions,
      ): Promise<T | undefined>;
      function update(
        arg: ModelUpdateParams<T, C> | string,
        updater?: ModelUpdater<T>,
        contention?: ContentionOptions,
      ): Promise<T | undefined> {
        return updateImpl(arg, updater, contention);
      }
      return update;
    })(),

    delete: guard(async (params: ModelDeleteParams<T, C>): Promise<void> => {
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
      if (!model) return;
      const claimed = activeClaims.get(id);
      const opts = mutationOptions(params);
      const handle = isClaimHandle(params.claim) ? params.claim : undefined;
      const effective: MutationOptions | undefined = claimed
        ? {
            wait: 'confirmed',
            readAt: claimed.lease.readAt ?? claimed.snapshot.stamp,
            onStale: 'reject',
            claimRef: { id: claimed.lease.id },
            ...(claimed.lease.fenceToken !== undefined
              ? { fenceToken: claimed.lease.fenceToken }
              : {}),
            ...opts,
          }
        : {
            ...(handle?.readAt !== undefined
              ? {
                  wait: 'confirmed' as const,
                  readAt: handle.readAt,
                  onStale: 'reject' as const,
                }
              : {}),
            ...opts,
            ...(handle ? { claim: { id: handle.id } } : {}),
          };
      syncClient.delete(model, effective);
      await waitForMutation(model, effective);
    }),

    // `claim` is a callable namespace (take a claim) carrying the coordination
    // readers (`claim.state` / `claim.queue` / `claim.release` / `claim.reorder`).
    claim: claimApi,

    track: guard(async (params: ModelTrackParams): Promise<ModelTrackResult> => {
      const dep: TrackDependency = {
        model: wireModel,
        id: params.id,
        ...(params.readAt !== undefined ? { readAt: params.readAt } : {}),
      };
      // A track carries no write, so it rides the commit lane as a zero-operation
      // commit: the queue tolerates disconnects and de-dupes replays, and the
      // server's track-only path registers the premise and reports anything
      // that already fired. Reuse the same lane the batch `commits.create` door
      // uses rather than opening a bespoke transport.
      const clientTxId =
        typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
          ? crypto.randomUUID()
          : `tx_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
      const queue = syncClient.getMutationQueue();
      await queue.enqueueCommit(clientTxId, [], { track: [dep] });
      const { notifications } = await queue.waitForCommitReceipt(clientTxId);
      return notifications && notifications.length > 0 ? { notifications } : {};
    }),

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
