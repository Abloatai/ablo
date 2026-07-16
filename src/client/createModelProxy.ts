/**
 * Builds the typed client for a single schema model — the object reached as
 * `ablo.<model>`.
 *
 * Each schema model gets one {@link ModelOperations}: the async server reads
 * `retrieve` and `list`, the synchronous local-graph snapshots `get`, `getAll`,
 * and `getCount`, the writes `create`, `update`, and `delete`, the coordination
 * namespace `claim` (callable as `claim({ id })`, plus `claim.state`,
 * `claim.queue`, `claim.release`, and `claim.reorder`), `join`, and `onChange`.
 * The factory returns a plain object; the client assembles the `ablo.<model>`
 * lookup table from one of these per model.
 */

import { autorun } from 'mobx';
import {
  AbloClaimedError,
  AbloStaleContextError,
  AbloValidationError,
  formatClaimedErrorMessage,
  toAbloError,
  type ClaimErrorClaim,
} from '../errors.js';
import {
  reconcileFunctionalUpdate,
  type ModelUpdater,
  type ContentionOptions,
} from './functionalUpdate.js';
import type { MutationOptions } from '../interfaces/index.js';
import type {
  TrackDependency,
  StaleNotification,
} from '../coordination/schema.js';
import { Model, modelAsRow } from '../Model.js';
import { toMs } from '../utils/duration.js';
import { LEASE_TTL_MS } from '../wire/protocol.js';
import {
  heartbeatCadenceMs,
  resolveHeartbeatOptions,
  startClaimHeartbeatLoop,
} from './claimHeartbeatLoop.js';
import { assertWriteOptions } from './writeOptionsSchema.js';
import type { ModelRegistry } from '../ModelRegistry.js';
import type { InstanceCache } from '../InstanceCache.js';
import type { SyncClient } from '../SyncClient.js';
import type { OnDemandLoader } from '../sync/OnDemandLoader.js';
import type { JoinedParticipant } from '../sync/participants.js';
import type { LoadWhere } from '../query/types.js';
import { ModelScope } from '../types/index.js';
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
  TargetRange,
} from '../types/streams.js';

export interface ModelClientMeta {
  readonly key: string;
  readonly typename: string;
}

const modelClientMeta = new WeakMap<object, ModelClientMeta>();

export function getModelClientMeta(modelClient: unknown): ModelClientMeta | undefined {
  if (typeof modelClient !== 'object' || modelClient === null) return undefined;
  return modelClientMeta.get(modelClient);
}

export type ModelListScope = ModelScope | 'live' | 'archived' | 'all';

/** Options for `track({ id })` — register a durable read-dependency on a row. */
export interface ModelTrackParams {
  /** The row to keep hearing about, by id. */
  id: string;
  /**
   * The sync watermark this track is premised on. Omit to baseline at the
   * current head — "tell me about anything from here on". Pass a known
   * `lastSyncId` (e.g. the one you read the row at) to also catch a change that
   * already landed between that read and this call.
   */
  readAt?: number;
}

/** The result of `track({ id })`. */
export interface ModelTrackResult {
  /**
   * Tracks that had ALREADY fired at registration time — a change matching an
   * open track that landed before this call. Present only when something was
   * already stale; the ongoing signal arrives on the receipts of later commits.
   */
  notifications?: StaleNotification[];
}

/** Options for the synchronous local-pool reads `get`, `getAll`, and
 *  `onChange` — a JavaScript `filter`, an equality `where`, and a lifecycle
 *  `state`. This is the local, reactive axis; contrast {@link ServerReadOptions},
 *  the asynchronous server axis. */
export interface LocalReadOptions<T> {
  where?: Partial<T>;
  /** Arbitrary local predicate. Applied after `where`. */
  filter?: (entity: T) => boolean;
  orderBy?: { [K in keyof T]?: 'asc' | 'desc' };
  limit?: number;
  offset?: number;
  /** Lifecycle filter — `live` (the default), `archived`, or `all`. Named
   *  `state` so it does not collide with the sync-group `scope`. */
  state?: ModelListScope;
}

export type LocalCountOptions<T> = Pick<
  LocalReadOptions<T>,
  'where' | 'filter' | 'state'
>;

/** Options for the asynchronous server reads `retrieve` and `list` — the
 *  operator `where` filter, `type`, and `expand`. This is the server axis;
 *  contrast {@link LocalReadOptions}, the local, reactive axis. */
export interface ServerReadOptions<T> {
  /**
   * Filter for the lookup. Accepts two forms:
   *   - object form — `{ name: 'foo' }`: equality, where an array value means `IN`
   *   - tuple form — `[['name', 'ILIKE', '%Goldman%']]`: explicit operators
   *
   * See {@link LoadWhere} for the full grammar. The wire protocol matches on AND
   * only; for OR semantics, run two `list()` calls and union the results.
   */
  where?: LoadWhere<T>;
  orderBy?: { [K in keyof T]?: 'asc' | 'desc' };
  limit?: number;
  /**
   * `complete` waits for the server. `unknown` returns whatever is local
   * immediately and refreshes in the background.
   */
  type?: 'complete' | 'unknown';
  /**
   * Schema-declared relation names to hydrate alongside the primary
   * rows. The server's compiler resolves each name via the schema's
   * relation metadata (`relation.belongsTo` / `relation.hasMany`)
   * and emits the JOIN.
   */
  expand?: readonly string[];
}

/** Options for the single-row async server read `retrieve({ id })`. A subset of
 *  {@link ServerReadOptions} — `where`/`limit`/`orderBy` are fixed by the id. */
export type ServerRetrieveOptions = Pick<ServerReadOptions<unknown>, 'type' | 'expand'>;

export interface ModelCollaboration<T> {
  createClaim(options: {
    target: {
      model: string;
      id: string;
      field?: string;
      path?: string;
      range?: TargetRange;
      meta?: Record<string, unknown>;
    };
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
  state(target: { model: string; id: string }): Claim | null;
  /**
   * The reactive wait queue on a target — the FIFO line of queued claims
   * behind the holder. Synchronous snapshot off the synced claim stream.
   */
  queue(target: { model: string; id: string }): readonly Claim[];
  /**
   * Re-rank the wait queue on a target (privileged — server-gated). `order` is
   * the desired front-of-line ordering, taken from `queue(target)`.
   */
  reorder(target: { model: string; id: string }, order: readonly Claim[]): void;
  /**
   * Resolve once no participant holds an active claim on the target.
   * The contender's "wait until it's free" — delegates to the claim
   * stream's `waitFor`.
   */
  waitFor(
    target: { model: string; id: string },
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
  readonly selfParticipantKind?: 'user' | 'agent' | 'system';
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

export interface ClaimTargetOptions<T = Record<string, unknown>> {
  /** Peer-visible description of the work being performed — the sentence a
   *  contending participant reads to decide whether to wait, work elsewhere, or
   *  move on. Defaults to `'editing'`. The same field on every claim surface. */
  description?: string;
  /** Field-level target, for fine-grained claimed-state badges. */
  field?: string;
  /** Optional path for document/file-like targets. */
  path?: string;
  /** Optional range for document/file-like targets. */
  range?: TargetRange;
  /** App-defined structured metadata. */
  meta?: Record<string, unknown>;
  /** Crash-cleanup TTL — the claim auto-releases if the holder dies. */
  ttl?: Duration;
  /**
   * Behavior under contention. `true` (the default) queues behind the current
   * holder and resolves once the row is yours. `false` is fail-fast: if another
   * participant already holds the row, it rejects immediately with
   * {@link AbloClaimedError} instead of waiting. Use `false` to deduplicate
   * distributed work ("if someone else has this job, skip it"), where waiting
   * would mean double-processing.
   *
   * The high-level typed claim defaults this on because it serializes writers;
   * the low-level lease and the HTTP client default it off, since they resolve
   * immediately and cannot transparently wait for a grant.
   */
  queue?: boolean;
  /**
   * Backpressure: queue, but not behind too many others. If the server reports a
   * position at or beyond `maxQueueDepth` when the client joins the line, it
   * rejects with {@link AbloClaimedError} (`queue_too_deep`) instead of waiting.
   * Omit to wait however deep the queue is.
   */
  maxQueueDepth?: number;
  /**
   * Keep the lease alive for the duration of real work by beating on a
   * cadence — the pattern for background workers whose task outlives the
   * crash-cleanup TTL. `true` beats every third of the TTL (so two beats can
   * fail before the lease is at risk, and a crashed worker's lease still
   * lapses within one beat window); a duration such as `'2m'` sets the
   * cadence explicitly. The loop stops on release. A beat answered with a
   * definitive loss stops the loop and calls {@link onHeartbeatLost}; you can
   * also beat manually with `held.heartbeat()`.
   */
  heartbeat?: true | Duration;
  /**
   * Called once if the auto-heartbeat learns the lease is no longer yours
   * (expired and possibly granted onward). The loop has already stopped;
   * abandon the work or re-claim. Any write attempted under the old lease is
   * independently rejected by its `readAt` guard.
   */
  onHeartbeatLost?: (error: AbloClaimedError) => void;
  /**
   * Called after every successful beat (manual or auto) with the server's
   * answer — chiefly `queueDepth`, the number of participants waiting in
   * line behind this lease. A worker that can checkpoint may read pressure
   * here and release early when others wait.
   */
  onHeartbeat?(beat: ClaimHeartbeat): void;
}

/** Options for `claim({ id, ... })`. */
export interface ClaimParams<T = Record<string, unknown>>
  extends ClaimTargetOptions<T> {
  readonly id: string;
}

export interface ClaimLookupParams<T = Record<string, unknown>> {
  readonly id: string;
  readonly field?: string;
}

export interface ClaimReorderParams<T = Record<string, unknown>>
  extends ClaimLookupParams<T> {
  readonly order: readonly Claim[];
}

/**
 * A claim handle: the held entity data plus an explicit release hook.
 *
 * ```ts
 * const claim = await ablo.weatherReports.claim({
 *   id: 'report_stockholm',
 *   description: 'Fetching current weather before writing the forecast.',
 * });
 * try {
 *   await ablo.weatherReports.update({
 *     id: claim.target.id,
 *     data: { status: 'ready' },
 *     claim,
 *   });
 * } finally {
 *   await claim.release();
 * }
 * ```
 *
 * `data` is a snapshot taken after the lease is held. Write through the flat
 * `ablo.<model>.update({ id, data, claim })` verb — the handle carries the
 * lease id and snapshot watermark for attribution and stale-write protection.
 */
// The canonical claim handle types live in `../types/streams`. They are
// re-exported here so existing import paths keep working.
export type { Claim, ClaimHeartbeat, ClaimHeartbeatOptions, HeldClaim, HeldLease };

export type ClaimOptions<T = Record<string, unknown>> = ClaimTargetOptions<T>;

/**
 * The coordination surface for a model, exposed as a callable namespace.
 *
 * Most callers do not need this namespace directly. Put `claim: { ... }` on a
 * write and the SDK acquires/releases around that one mutation:
 *
 * ```ts
 * await ablo.tasks.update({
 *   id,
 *   data: { title },
 *   claim: {
 *     field: 'title',
 *     description: 'Renaming the task to match the project brief.',
 *   },
 * });
 * ```
 *
 * Use `claim({ id, ... })` when a tool spans multiple writes and needs one
 * handle. `state`, `queue`, and `reorder` are coordination reads/scheduler
 * controls for UI and operators.
 */
/**
 * The coordination reads and scheduler controls on a claim namespace, in their
 * reactive (synchronous) form: `state`, `queue`, and `reorder` resolve against
 * the local pool with no round-trip, which is what lets a reactive selector read
 * coordination state inside a React render.
 *
 * This is the single source of truth for the claim read surface. The stateless
 * HTTP client exposes the awaited projection of exactly these methods (derived
 * via {@link AwaitedClaimMethod}), so the two transports cannot drift — change a
 * signature here and the HTTP surface follows.
 */
export interface ClaimReadApi<T = Record<string, unknown>> {
  /**
   * Current holder for a row, or `null` when free. Use this for UI badges and
   * preflight checks, not for the normal write path.
   */
  state(params: ClaimLookupParams<T>): Claim | null;

  /**
   * FIFO wait line behind the current holder. Advanced: useful for operator
   * UIs and schedulers.
   */
  queue(params: ClaimLookupParams<T>): { readonly object: 'list'; readonly data: readonly Claim[] };

  /**
   * Re-rank the wait line. Advanced and permission-gated.
   */
  reorder(params: ClaimReorderParams<T>): void;

  /** Release a manual claim handle early. Single-write claims auto-release. */
  release(params: ClaimLookupParams<T> | Claim<T>): Promise<void>;
}

/**
 * The awaited form of a claim method: a synchronous return becomes a `Promise`,
 * an already-async one (`release`) is left untouched. Used to derive the
 * stateless HTTP claim surface from the reactive {@link ClaimReadApi}.
 */
export type AwaitedClaimMethod<F> = F extends (...args: infer A) => infer R
  ? R extends Promise<unknown>
    ? (...args: A) => R
    : (...args: A) => Promise<R>
  : F;

export interface ClaimApi<T> extends ClaimReadApi<T> {
  /**
   * Takes a claim and returns an explicit held-work handle — a {@link HeldClaim}.
   * `data`, `release`, `revoke`, and the async disposer are always present (this
   * call re-reads the row under the lease), so callers can use `handle.data`
   * directly and `await using` works without a guard.
   */
  (params: ClaimParams<T>): Promise<HeldClaim<T>>;
  /**
   * Takes a claim by id alone, for a row that lives only in the customer's own
   * database — Ablo has never seen it, so there is nothing to re-read. Returns a
   * {@link HeldLease}: the same lease controls as {@link HeldClaim}
   * (`release`, `revoke`, `heartbeat`, `await using`) but no `.data`. Locking a
   * key you know by id is exactly this — serialize writers without first
   * syncing the row into Ablo.
   */
  (id: string, opts?: ClaimOptions<T>): Promise<HeldLease>;
}

export interface ModelRetrieveParams extends ServerRetrieveOptions {
  readonly id: string;
}

export interface ModelCreateParams<T, CreateInput>
  extends MutationOptions {
  readonly data: CreateInput;
  readonly id?: string | null;
  readonly claim?: Claim<T> | ClaimTargetOptions<T> | null;
}

export interface ModelUpdateParams<T>
  extends MutationOptions {
  readonly id: string;
  readonly data: Partial<T>;
  readonly claim?: Claim<T> | ClaimTargetOptions<T> | null;
}

export interface ModelDeleteParams<T>
  extends MutationOptions {
  readonly id: string;
  readonly claim?: Claim<T> | ClaimTargetOptions<T> | null;
}

/** Options for the WebSocket-only `ablo.<model>.join(ids, options?)`. */
export interface JoinOptions {
  /**
   * Lease TTL for the underlying presence claim — the participant
   * auto-releases after this if the holder dies. Compact duration string
   * (`'5m'`) or ms number, mirroring the claim `ttl`.
   */
  ttl?: Duration;
}

export interface ModelOperations<T, CreateInput> {
  /**
   * Reads a single entity by id from the server; asynchronous. Resolves through
   * a three-tier lookup — local pool, then IndexedDB, then a network
   * `POST /sync/query` — and lands the row in the local graph. Resolves to
   * `undefined` when no such row exists.
   *
   * This is the default "get me this entity" read, and the one a stateless
   * client wants, since its local graph starts empty. For a synchronous read of
   * an already-warm graph (such as a React selector) use `get(id)`.
   */
  retrieve(params: ModelRetrieveParams): Promise<T | undefined>;

  /**
   * Lists entities matching a filter from the server; asynchronous. Uses the
   * same three-tier lookup and graph hydration as `retrieve`, deduplicated so
   * concurrent identical calls share one request. Returns the matched rows. For
   * a synchronous read of the local graph use `getAll(...)`.
   */
  list(options?: ServerReadOptions<T>): Promise<T[]>;

  /**
   * Synchronous snapshot of a single entity from the local graph; no network.
   * Returns `undefined` when the row is not resident (a client whose graph is
   * still empty, or a `lazy` model not yet loaded). Pairs with reactive
   * selectors: `useAblo((ablo) => ablo.<model>.get(id))`.
   */
  get(id: string): T | undefined;

  /**
   * Synchronous snapshot of a filtered collection from the local graph; no
   * network round-trip. Empty until `retrieve`, `list`, or bootstrap has warmed
   * the graph.
   */
  getAll(options?: LocalReadOptions<T>): T[];

  /** Count entities in the local graph; synchronous, no network. */
  getCount(options?: LocalCountOptions<T>): number;

  /**
   * Create a new entity — **optimistic, offline-first**. Resolves once
   * the mutation is queued locally, not when the server confirms.
   * Server rejection rolls back automatically; watch `sync.syncStatus`.
   */
  create(params: ModelCreateParams<T, CreateInput>): Promise<T>;

  /** Update an entity by id — optimistic, offline-first (see `create`). */
  update(params: ModelUpdateParams<T>): Promise<T>;
  /**
   * Updates under contention with a function of the latest state —
   * `update(id, current => next)`. The client reads the freshest row, runs your
   * updater, writes the result as a compare-and-swap, and re-reads and re-runs
   * on any concurrent write. Nothing about claims, identity, or conflict codes
   * surfaces: the write either lands or throws {@link AbloContentionError} once
   * its reconcile budget is spent. Return `null` or `undefined` from the updater
   * to skip the write. Resolves to the reconciled row, or `undefined` when the
   * updater opted out.
   */
  update(
    id: string,
    updater: ModelUpdater<T>,
    options?: ContentionOptions,
  ): Promise<T | undefined>;

  /** Delete an entity by id — optimistic, offline-first (see `create`). */
  delete(params: ModelDeleteParams<T>): Promise<void>;

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
  claim: ClaimApi<T>;

  /**
   * Register a durable read-dependency on a row of this model — keep hearing
   * about it after this call returns. Where the per-write `reads` gate lives for
   * exactly one commit, a track persists on the server: any change that lands on
   * the tracked row rides back on the `notifications` of your next commit, so a
   * long-running actor learns its context went stale without re-reading. A track
   * you already have is refreshed, not duplicated (it is an idempotent upsert).
   *
   * ```ts
   * await ablo.tasks.track({ id: 'task_42' });
   * // …minutes of other work later, on your next write…
   * const res = await ablo.tasks.update({ id: 'task_42', data: { done: true } });
   * res.notifications; // populated if task_42 changed under you in the meantime
   * ```
   *
   * The returned `notifications` are only the tracks that had ALREADY fired at
   * registration time; the ongoing signal arrives on later receipts.
   */
  track(params: ModelTrackParams): Promise<ModelTrackResult>;

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
   * await using participant = await ablo.slides.join(slideIds, { ttl: '5m' });
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

export function createModelProxy<T, C>(
  schemaKey: string,
  registeredModelName: string,
  objectPool: InstanceCache,
  syncClient: SyncClient,
  registry: ModelRegistry,
  hydration: OnDemandLoader,
  collaboration?: ModelCollaboration<T>,
): ModelOperations<T, C> {
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
    // The coordinator returns Model instances. ModelOperations is
    // typed against the schema-inferred row shape (`T`), which is
    // structurally what the model exposes through its property
    // accessors — cast at the boundary.
    return rows as unknown as T[];
  };

  const waitForMutation = async (
    model: Model,
    options?: MutationOptions,
  ): Promise<void> => {
    if (options?.wait !== 'confirmed') return;
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

  const claimMeta = (
    options: ClaimTargetOptions<T> | undefined,
  ): Record<string, unknown> | undefined => options?.meta;

  const claimContextFromClaim = (claim: Claim): ClaimErrorClaim => {
    return {
      id: claim.id,
      actor: claim.heldBy,
      participantKind: claim.participantKind,
      description: claim.description,
      field: claim.target.field,
      status: claim.status,
      expiresAt: claim.expiresAt,
      target: {
        model: claim.target.type,
        id: claim.target.id,
        path: claim.target.path,
        range: claim.target.range,
        field: claim.target.field,
        meta: claim.target.meta,
      },
    };
  };

  const mutationOptions = (
    params:
      | ModelCreateParams<T, C>
      | ModelUpdateParams<T>
      | ModelDeleteParams<T>,
  ): MutationOptions => {
    const { id: _id, data: _data, claim: _claim, ...rest } =
      params as unknown as Record<string, unknown>;
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
    params: ClaimParams<T>,
  ): Promise<HeldClaim<T>> => {
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

    // Fail-fast (`queue: false`): if another participant already holds it,
    // reject now instead of queuing. Best-effort at the client (a racing
    // claim not yet synced into our snapshot slips through here) — the
    // commit-time claim guard is the authoritative backstop that rejects
    // the loser's first write. For work-distribution dedup that's exactly
    // right: don't wait (that would double-process), skip.
    if (failFast && contended) {
      const claim = claimContextFromClaim(held);
      throw new AbloClaimedError(
        formatClaimedErrorMessage({
          targetLabel: `${registeredModelName}/${id}`,
          heldBy: held.heldBy,
          claim,
          fallback: `${registeredModelName}/${id} is held by ${held.heldBy ?? 'another participant'}.`,
        }),
        { code: 'entity_claimed', claims: [claim] },
      );
    }

    // Ensure the row exists locally before claiming.
    let model = objectPool.get(id);
    if (!model) {
      await load({ where: [['id', id]] });
      model = objectPool.get(id);
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
        ...(options.field ? { field: options.field } : {}),
        ...(options.path ? { path: options.path } : {}),
        ...(options.range ? { range: options.range } : {}),
        ...(claimMeta(options) ? { meta: claimMeta(options) } : {}),
      },
      description: options.description ?? 'editing',
      ttl: options.ttl,
      queue: !failFast,
      maxQueueDepth: options.maxQueueDepth,
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
      model = objectPool.get(id) ?? model;
    }

    const snapshot = collaboration.createSnapshot(schemaKey, id);
    const description = options.description ?? 'editing';
    // The self-claim's `ClaimTarget` mirrors what a peer's `claim.state` would
    // report (`state` maps `held.target.model` to `type`), so a holder and a
    // peer see the same `target.type` for one row — the wire model token.
    const selfTarget: ClaimTarget = {
      type: wireModel,
      id,
      ...(options.field ? { field: options.field } : {}),
      ...(options.path ? { path: options.path } : {}),
      ...(options.range ? { range: options.range } : {}),
      ...(claimMeta(options) ? { meta: claimMeta(options) } : {}),
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
      ...(options.field ? { field: options.field } : {}),
      ...(options.path ? { path: options.path } : {}),
      ...(options.range ? { range: options.range } : {}),
      ...(claimMeta(options) ? { meta: claimMeta(options) } : {}),
    };
    // A beat resolves with the server's extended expiry; keep the local
    // self-claim estimate in step so `claim.state` renders the real window,
    // and surface every answer through `onHeartbeat` (pressure signal).
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
      options.onHeartbeat?.(beat);
      return beat;
    };

    // Opt-in auto-heartbeat: the loop beats until release, and a definitive
    // loss stops it and surfaces through `onHeartbeatLost`.
    const stopHeartbeatLoop = options.heartbeat
      ? startClaimHeartbeatLoop({
          beat: () => heartbeat(),
          intervalMs: heartbeatCadenceMs(ttlMs, options.heartbeat),
          ...(options.onHeartbeatLost
            ? { onLost: options.onHeartbeatLost }
            : {}),
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
    options: ClaimOptions<T>,
  ): Promise<HeldLease> => {
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

    // Fail-fast (`queue: false`): reject now if a holder is already visible.
    // Best-effort at the client — a row this participant never synced usually
    // carries no local claim state either, so a peer gets the deterministic
    // rejection only once it has observed the holder (entered the row's entity
    // scope). The server's queue is the backstop for the queuing path.
    if (failFast && contended) {
      const claim = claimContextFromClaim(held);
      throw new AbloClaimedError(
        formatClaimedErrorMessage({
          targetLabel: `${registeredModelName}/${id}`,
          heldBy: held.heldBy,
          claim,
          fallback: `${registeredModelName}/${id} is held by ${held.heldBy ?? 'another participant'}.`,
        }),
        { code: 'entity_claimed', claims: [claim] },
      );
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
        ...(options.field ? { field: options.field } : {}),
        ...(options.path ? { path: options.path } : {}),
        ...(options.range ? { range: options.range } : {}),
        ...(claimMeta(options) ? { meta: claimMeta(options) } : {}),
      },
      description: options.description ?? 'editing',
      ttl: options.ttl,
      queue: !failFast,
      maxQueueDepth: options.maxQueueDepth,
    });

    // A watermark-only snapshot: `createSnapshot` still reads the engine's
    // current `lastSyncId` even though the pool holds no row (the bucket is
    // empty). It costs nothing extra and gives a write taken under this lease a
    // real `readAt` to guard against changes since the lease was acquired.
    const snapshot = collaboration.createSnapshot(schemaKey, id);
    const description = options.description ?? 'editing';
    const selfTarget: ClaimTarget = {
      type: wireModel,
      id,
      ...(options.field ? { field: options.field } : {}),
      ...(options.path ? { path: options.path } : {}),
      ...(options.range ? { range: options.range } : {}),
      ...(claimMeta(options) ? { meta: claimMeta(options) } : {}),
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
      ...(options.field ? { field: options.field } : {}),
      ...(options.path ? { path: options.path } : {}),
      ...(options.range ? { range: options.range } : {}),
      ...(claimMeta(options) ? { meta: claimMeta(options) } : {}),
    };
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
      options.onHeartbeat?.(beat);
      return beat;
    };

    const stopHeartbeatLoop = options.heartbeat
      ? startClaimHeartbeatLoop({
          beat: () => heartbeat(),
          intervalMs: heartbeatCadenceMs(ttlMs, options.heartbeat),
          ...(options.onHeartbeatLost
            ? { onLost: options.onHeartbeatLost }
            : {}),
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
  function claim(params: ClaimParams<T>): Promise<HeldClaim<T>>;
  function claim(id: string, opts?: ClaimOptions<T>): Promise<HeldLease>;
  function claim(
    arg: ClaimParams<T> | string,
    opts?: ClaimOptions<T>,
  ): Promise<HeldClaim<T> | HeldLease> {
    return typeof arg === 'string'
      ? guardedTakeRowFreeClaim(arg, opts ?? {})
      : guardedTakeClaim(arg);
  }

  // `claim` is a callable namespace: invoke it to take a claim, reach its
  // members to read/steer the coordination plane. Attach the readers to the
  // callable so `ablo.<model>.claim(...)` and `ablo.<model>.claim.state(...)`
  // are the same object.
  const claimApi: ClaimApi<T> = Object.assign(claim, {
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
      const own = activeClaims.get(params.id);
      if (own) {
        return {
          object: 'claim',
          id: own.lease.id,
          status: 'active',
          target: own.target,
          description: own.description,
          heldBy: collaboration?.selfParticipantId ?? '',
          participantKind: collaboration?.selfParticipantKind ?? 'user',
          expiresAt: own.expiresAt,
        };
      }
      return collaboration?.state({ model: wireModel, id: params.id }) ?? null;
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
  });

  const operations: ModelOperations<T, C> = {
    retrieve: guard(
      async (params: ModelRetrieveParams): Promise<T | undefined> => {
        // Read-interest enrolment: reading a row enters its entity scope, so a
        // client lands in the same group the holder's claim presence fans out
        // on and `claim.state`/`claim.queue` report peers. Best-effort and
        // fire-and-forget — it never makes the read reject or run slower.
        void collaboration?.enterScope?.({ [schemaKey]: params.id });
        const rows = await load({
          ...params,
          where: [['id', params.id]],
          limit: 1,
        });
        return rows[0];
      },
    ),

    // No automatic scope enrolment on bulk `list`/`getAll`: that would subscribe
    // to an unbounded set of rows' entity groups.
    list: guard(load),

    get(id: string): T | undefined {
      return objectPool.get(id) as T | undefined;
    },

    getAll(options): T[] {
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

    getCount(options): number {
      return this.getAll(options).length;
    },

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
            ...(claim.field ? { field: claim.field } : {}),
            ...(claim.path ? { path: claim.path } : {}),
            ...(claim.range ? { range: claim.range } : {}),
            ...(claimMeta(claim) ? { meta: claimMeta(claim) } : {}),
          },
          description: claim.description ?? 'creating',
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
          arg: ModelUpdateParams<T> | string,
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
              const fresh = objectPool.get(id);
              const snapshot = collaboration.createSnapshot(schemaKey, id);
              return {
                data: fresh ? modelAsRow<T>(fresh) : undefined,
                stamp: snapshot.stamp,
              };
            },
            writeNext: async (patch, readAt) => {
              const model = objectPool.get(id);
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
          try {
            return await operations.update({ ...params, claim: handle });
          } finally {
            await handle.release();
          }
        }
        const { id } = params;
        const model = objectPool.get(id);
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
              readAt: claimed.snapshot.stamp,
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
      function update(params: ModelUpdateParams<T>): Promise<T>;
      function update(
        id: string,
        updater: ModelUpdater<T>,
        options?: ContentionOptions,
      ): Promise<T | undefined>;
      function update(
        arg: ModelUpdateParams<T> | string,
        updater?: ModelUpdater<T>,
        contention?: ContentionOptions,
      ): Promise<T | undefined> {
        return updateImpl(arg, updater, contention);
      }
      return update;
    })(),

    delete: guard(async (params: ModelDeleteParams<T>): Promise<void> => {
      const autoClaim =
        params.claim && !isClaimHandle(params.claim) ? params.claim : null;
      if (autoClaim) {
        const handle = await takeClaim({ ...autoClaim, id: params.id });
        try {
          await operations.delete({ ...params, claim: handle });
        } finally {
          await handle.release();
        }
        return;
      }
      const { id } = params;
      const model = objectPool.get(id);
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
            readAt: claimed.snapshot.stamp,
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
      // server's track-only path registers the dependency and reports anything
      // that already fired. Reuse the same lane the batch `commits.create` door
      // uses rather than opening a bespoke transport.
      const clientTxId =
        typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
          ? crypto.randomUUID()
          : `tx_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
      const queue = syncClient.getTransactionQueue();
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
        const entities = this.getAll(options);
        callback(entities);
      });
    },
  };

  modelClientMeta.set(operations, {
    key: schemaKey,
    typename: registeredModelName,
  });

  return operations;
}
