/**
 * The request contract for `ablo.<model>` — the option and parameter shapes a
 * caller passes to a read, a write, or a claim.
 *
 * These types describe the *change or the query being requested*, never a local
 * copy of the rows it touches, so they sit in the settlement core and are shared
 * by every transport and every caller (ADR 0013 §4, ADR 0016). The factory that
 * binds them to reactive model instances — `createModelProxy` — stays with the
 * reactive consumer, along with `ModelOperations` and `ModelCollaboration`,
 * which reference the live participant handle.
 */

import type { ModelScope } from '../types/index.js';
import type { ResolveClaimMeta } from '../types/global.js';
import type { AbloClaimedError } from '../errors.js';
import type { StaleNotification, TrackDependency } from '../coordination/schema.js';
import type { FieldRef, FieldSelector } from '../schema/fieldRef.js';
import type { BaseModelFields } from '../schema/schema.js';
import type { ClaimHeartbeatPlan } from '../coordination/claimHeartbeatLoop.js';
import type { Duration } from '../utils/duration.js';
import type {
  Claim,
  ClaimHeartbeat,
  ClaimHeartbeatOptions,
  HeldClaim,
  HeldLease,
  Peer,
} from '../types/streams.js';
import type { MutationOptions } from './mutationOptions.js';
import type { LoadWhere } from './where.js';

/**
 * A lifecycle filter, accepted either as the enum or as its bare string. The
 * string arm is a template projection of the enum rather than a second list, so
 * a scope added to {@link ModelScope} is spellable both ways at once.
 */
export type ModelListScope = ModelScope | `${ModelScope}`;

/**
 * Options for `track({ id })` — register a durable premise on a row.
 *
 * Derived from the wire's row-form {@link TrackDependency} rather than restated
 * beside it: the caller names the row and, optionally, the watermark it is
 * premised on, while `model` comes from the proxy the call was made on. Adding
 * a field to the dependency therefore reaches this surface automatically, and
 * removing one stops the callers compiling.
 *
 * On `readAt`: omit it to baseline at the current head — "tell me about
 * anything from here on". Pass a known watermark (the one you read the row at)
 * to also catch a change that landed between that read and this call.
 */
export type ModelTrackParams = Omit<
  Extract<TrackDependency, { model: string }>,
  'model'
>;

/** The result of `track({ id })`. */
export interface ModelTrackResult {
  /**
   * Tracks that had ALREADY fired at registration time — a change matching an
   * open track that landed before this call. Present only when something was
   * already stale; the ongoing signal arrives on the receipts of later commits.
   */
  notifications?: StaleNotification[];
}

/** Options for the synchronous local-graph reads `local.list` and `onChange` —
 *  a JavaScript `filter`, an equality `where`, and a lifecycle `state`. This is
 *  the local, reactive axis; contrast {@link ServerReadOptions}, the
 *  asynchronous server axis. */
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

/** Options for the asynchronous server reads `get` and `list` — the
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

/** Options for the single-row async server read `get({ id })`. A subset of
 *  {@link ServerReadOptions} — `where`/`limit`/`orderBy` are fixed by the id. */
export type ServerRetrieveOptions = Pick<ServerReadOptions<unknown>, 'type' | 'expand'>;
/** Canonical point-lookup options; retained separately for compatibility naming. */
export type ServerGetOptions = ServerRetrieveOptions;
/**
 * A claimable part of a row is a field declared by that model's Zod shape.
 *
 * There is deliberately no `string` escape hatch here. A claim participates in
 * write safety, so an invented field would create a lease that guards nothing.
 * Custom coordination parts remain available on the low-level coordination
 * API through {@link ClaimPart}; the model resource is the schema-bound surface
 * and therefore accepts only schema fields.
 */
export type ClaimableFields<T> = Omit<T, keyof BaseModelFields>;

export type ClaimField<T> = FieldRef<
  string,
  Extract<keyof ClaimableFields<T>, string>
>;

/**
 * The options on a claim, in four axes — each answers one question, and no
 * member sits in two:
 *
 * - **what you claim** — `fields`, selected from the model's Zod shape;
 *   narrowed below the row;
 * - **what others see** — `description` / `meta`, the presence half;
 * - **how you wait** — `queue` / `maxQueueDepth` / `waitTimeoutMs` /
 *   `signal`, admission to the line;
 * - **how long you hold** — `ttl` / `heartbeat`, the lease.
 */
export interface ClaimTargetOptions<T = Record<string, unknown>> {
  // ── What you claim — the target, narrowed below the row ────────────────

  /**
   * Narrow the claim to Zod-declared fields of the row. Return one field
   * directly or an array for several: `fields: (task) => task.status`.
   *
   * Exclusion follows the target: claims on the same row conflict only where
   * their sets intersect, so a holder on `['title']` and a holder on
   * `['status']` proceed concurrently, while a whole-row claim (no target)
   * conflicts with both. The per-field claimed-state badge is a consequence of
   * the narrower lease, not its purpose.
   */
  fields?: FieldSelector<ClaimableFields<T>>;

  // ── What others see — the presence half ────────────────────────────────

  /** Peer-visible description of the work being performed — the sentence a
   *  contending participant reads to decide whether to wait, work elsewhere, or
   *  move on. Defaults to `'editing'`. The same field on every claim surface. */
  description?: string;
  /**
   * App-defined structured metadata, carried verbatim to every participant
   * that observes the claim. Declare its shape once, on `Register`'s
   * `ClaimMeta` slot, and what you write here is what every reader is typed to
   * find — the write side and the read side are the same declaration.
   */
  meta?: ResolveClaimMeta;

  // ── How you wait — admission to the line ───────────────────────────────

  /**
   * Behavior under contention. `true` (the default) queues behind the current
   * holder and resolves once the row is yours. `false` is fail-fast: if another
   * participant already holds the row, it rejects immediately with
   * {@link AbloClaimedError} instead of waiting. Use `false` to deduplicate
   * distributed work ("if someone else has this job, skip it"), where waiting
   * would mean double-processing.
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
   * Cap on how long a queued claim waits for its grant before rejecting with
   * {@link AbloClaimedError} (`grant_timeout`). Omit to wait as long as the
   * line takes. Same meaning on both transports; on the stateless HTTP client
   * a timed-out wait also leaves the line, so the slot is not left to expire.
   */
  waitTimeoutMs?: number;
  /**
   * Abort a pending wait from outside — the same signal that cancels
   * everything else in the program, so a cancelled agent task or an unmounted
   * component takes its queued claim with it. Rejects with
   * {@link AbloClaimedError} (`claim_wait_aborted`); over HTTP the abort also
   * leaves the line. Ignored once the grant has arrived — a held lease is
   * never torn down by a late abort; release it instead.
   */
  signal?: AbortSignal;

  // ── How long you hold — the lease ──────────────────────────────────────

  /** Crash-cleanup TTL — the claim auto-releases if the holder dies. */
  ttl?: Duration;
  /**
   * Keep the lease alive for the duration of real work by beating on a
   * cadence — the pattern for background workers whose task outlives the
   * crash-cleanup TTL. `true` beats every third of the TTL (so two beats can
   * fail before the lease is at risk, and a crashed worker's lease still
   * lapses within one beat window); a duration such as `'2m'` sets the
   * cadence explicitly; the structured {@link ClaimHeartbeatPlan} carries the
   * cadence and both callbacks in one place —
   * `heartbeat: { every: '2m', onBeat, onLost }`. The loop stops on release.
   * You can also beat manually with `held.heartbeat()`.
   */
  heartbeat?: true | Duration | ClaimHeartbeatPlan;
}

/** Options for `claim({ id, ... })`. */
export interface ClaimParams<T = Record<string, unknown>>
  extends ClaimTargetOptions<T> {
  readonly id: string;
}

export interface ClaimLookupParams<T = Record<string, unknown>> {
  readonly id: string;
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
 *     fields: (task) => task.title,
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
   *
   * `target.meta` reads as the shape declared on `Register`'s `ClaimMeta`
   * slot, so no read of it needs a guard. Pass `M` only to override that
   * declaration for one call — `state<OtherMeta>({ id })` — which a program
   * carrying more than one meta shape occasionally needs.
   */
  state<M = ResolveClaimMeta>(
    params: ClaimLookupParams<T>,
  ): Claim<Record<string, unknown>, M> | null;

  /**
   * Every holder of a row, not just one.
   *
   * A claim that names a narrower target — a `path`, a `range`, a `field` or
   * `fields` — excludes only what it overlaps, so several participants hold
   * disjoint parts of one row at the same time and
   * {@link ClaimReadApi.state} answers with one of them. This is the read
   * behind a per-region UI: a rail for each claimed block, a chip for each
   * participant. Synchronous and reactive off the same snapshot as `state`,
   * so a render reads it inline.
   *
   * Own claim first when this client holds one, then peers. Takes the same
   * `meta` parameter as {@link ClaimReadApi.state}.
   */
  list<M = ResolveClaimMeta>(
    params: ClaimLookupParams<T>,
  ): {
    readonly object: 'list';
    readonly data: readonly Claim<Record<string, unknown>, M>[];
  };

  /**
   * FIFO wait line behind the current holder. Advanced: useful for operator
   * UIs and schedulers. Takes the same `meta` parameter as
   * {@link ClaimReadApi.state}.
   */
  queue<M = ResolveClaimMeta>(
    params: ClaimLookupParams<T>,
  ): {
    readonly object: 'list';
    readonly data: readonly Claim<Record<string, unknown>, M>[];
  };

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

export interface ClaimApi<
  T,
  Fields = T,
> extends ClaimReadApi<T> {
  /**
   * The try-claim: `queue: false` treats a held target as an expected outcome,
   * not an error — it resolves `null`, so claim-or-skip dedup reads
   * `if (!claim) return` with no try/catch. Who holds it, and why, stays
   * readable through `claim.state({ id })`. (A write to a row someone else
   * holds still rejects with `entity_claimed` — a failed write is an error;
   * a declined try is not.)
   */
  (params: ClaimParams<Fields> & { queue: false }): Promise<HeldClaim<T> | null>;
  /**
   * Takes a claim and returns an explicit held-work handle — a {@link HeldClaim}.
   * `data`, `release`, `revoke`, and the async disposer are always present (this
   * call re-reads the row under the lease), so callers can use `handle.data`
   * directly and `await using` works without a guard.
   */
  (params: ClaimParams<Fields>): Promise<HeldClaim<T>>;
  /** The row-free try-claim — `null` when the key is already held. */
  (id: string, opts: ClaimOptions<Fields> & { queue: false }): Promise<HeldLease | null>;
  /**
   * Takes a claim by id alone, for a row that lives only in the customer's own
   * database — Ablo has never seen it, so there is nothing to re-read. Returns a
   * {@link HeldLease}: the same lease controls as {@link HeldClaim}
   * (`release`, `revoke`, `heartbeat`, `await using`) but no `.data`. Locking a
   * key you know by id is exactly this — serialize writers without first
   * syncing the row into Ablo.
   */
  (id: string, opts?: ClaimOptions<Fields>): Promise<HeldLease>;
}

export interface ModelRetrieveParams extends ServerRetrieveOptions {
  readonly id: string;
}

export interface ModelCreateParams<T, CreateInput>
  extends MutationOptions {
  readonly data: CreateInput;
  readonly id?: string | null;
  readonly claim?: Claim<T> | ClaimTargetOptions<CreateInput> | null;
}

export interface ModelUpdateParams<T, Fields = T>
  extends MutationOptions {
  readonly id: string;
  /**
   * Patch only fields declared by the model's Zod input shape. Hydrated rows
   * also carry framework fields, relations, methods, and computed values; none
   * of those are writable data.
   */
  readonly data: Partial<ClaimableFields<Fields>>;
  readonly claim?: Claim<T> | ClaimTargetOptions<Fields> | null;
}

export interface ModelDeleteParams<T, Fields = T>
  extends MutationOptions {
  readonly id: string;
  readonly claim?: Claim<T> | ClaimTargetOptions<Fields> | null;
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
