/**
 * The request contract for `ablo.<model>` — the option and parameter shapes a
 * caller passes to a read, a write, or a claim.
 *
 * These types describe the *change or the query being requested*, never a local
 * copy of the rows it touches, so they sit in the commit core and are shared
 * by every transport and every caller (ADR 0013 §4, ADR 0016). The factory that
 * binds them to reactive model instances — `createModelOperations` — stays with the
 * reactive consumer, along with `ModelOperations` and `ModelCollaboration`,
 * which reference the live participant handle.
 */

import type { ModelScope } from '../../types/index.js';
import type { ResolveClaimMeta } from '../../types/global.js';
import type { AbloError } from '../../errors.js';
import type { FieldRef, FieldSelector } from '../../schema/fieldRef.js';
import type { BaseModelFields, Clearable } from '../../schema/schema.js';
import type { ClaimHeartbeatPlan } from '../../claims/heartbeat.js';
import type { Duration } from '../../utils/duration.js';
import type {
  Claim,
  ClaimHeartbeat,
  ClaimHeartbeatOptions,
  HeldClaim,
  HeldLease,
  Peer,
} from '../../types/streams.js';
import type { MutationOptions } from './mutationOptions.js';
import type { LoadWhere } from './where.js';

/**
 * One authoritative status transition for a claim attempt. This is scoped
 * to the request that supplied the callback, unlike `claim.state` / `queue`,
 * which are reactive snapshots of everyone on the row.
 */
export type ClaimAttemptEvent =
  | {
      readonly type: 'queued';
      readonly claimId: string;
      /** Zero-based place in line (`0` means next behind the holder). */
      readonly position: number;
      /** Human-readable count of waiters ahead, including the current holder. */
      readonly ahead: number;
    }
  | {
      readonly type: 'granted';
      readonly claimId: string;
      /** True when this request waited in line before it was granted. */
      readonly waited: boolean;
    }
  | {
      readonly type: 'skipped';
      /** The typed contention error behind the expected `null` result. */
      readonly error: AbloError;
    }
  | {
      readonly type: 'failed';
      /** The same typed Ablo error the claim promise rejects with. */
      readonly error: AbloError;
    };

export interface ClaimContentionOptions {
  /**
   * `wait` (default) joins the FIFO line. `skip` resolves the model try-claim
   * as `null` when another participant holds the target.
   */
  readonly mode?: 'wait' | 'skip';
  /** Fail instead of joining at or beyond this zero-based queue depth. */
  readonly maxDepth?: number;
  /** Maximum queue wait in milliseconds. */
  readonly timeoutMs?: number;
  /** Abort the pending wait. Ignored after the grant. */
  readonly signal?: AbortSignal;
  /**
   * Request-scoped attempt statuses. The callback is observational:
   * throwing from it never changes whether the claim is granted or skipped.
   */
  readonly onStatus?: (event: ClaimAttemptEvent) => void;
}

export interface ResolvedClaimContentionOptions {
  readonly wait: boolean;
  readonly maxDepth?: number;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly onStatus?: (event: ClaimAttemptEvent) => void;
}

/** One compatibility boundary for structured contention and legacy queue options. */
export function resolveClaimContentionOptions(options: {
  readonly queue?: boolean;
  readonly contention?: ClaimContentionOptions;
  readonly maxQueueDepth?: number;
  readonly waitTimeoutMs?: number;
  readonly signal?: AbortSignal;
}): ResolvedClaimContentionOptions {
  const structured = options.contention;
  const maxDepth = structured?.maxDepth ?? options.maxQueueDepth;
  const timeoutMs = structured?.timeoutMs ?? options.waitTimeoutMs;
  const signal = structured?.signal ?? options.signal;
  return {
    wait: structured
      ? structured.mode !== 'skip'
      : options.queue !== false,
    ...(maxDepth !== undefined ? { maxDepth } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(signal !== undefined ? { signal } : {}),
    ...(structured?.onStatus !== undefined
      ? { onStatus: structured.onStatus }
      : {}),
  };
}

/** Emit a status without letting an observer alter the claim attempt. */
export function emitClaimStatus(
  listener: ((event: ClaimAttemptEvent) => void) | undefined,
  event: ClaimAttemptEvent,
): void {
  try {
    listener?.(event);
  } catch {
    // The claim attempt is authoritative; telemetry/UI callbacks are not.
  }
}

/** Separate expected skipped work from an actual failed claim attempt. */
export function claimAttemptFailure(
  wait: boolean,
  error: AbloError,
): ClaimAttemptEvent {
  const code = error.code;
  return !wait && (code === 'claim_conflict' || code === 'entity_claimed')
    ? { type: 'skipped', error }
    : { type: 'failed', error };
}

/**
 * A lifecycle filter, accepted either as the enum or as its bare string. The
 * string arm is a template projection of the enum rather than a second list, so
 * a scope added to {@link ModelScope} is spellable both ways at once.
 */
export type ModelListScope = ModelScope | `${ModelScope}`;

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

/** Options for the asynchronous server reads `read` and `list` — the
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
  /**
   * Rows per page. The server has its own ceiling and applies a default when
   * this is omitted, so a collection larger than one page always comes back as
   * a page: read `hasMore` on the result before treating it as the whole set.
   */
  limit?: number;
  /**
   * Where to resume: the `nextCursor` from the previous page. Pass it back with
   * the same `where` and `orderBy` to walk a collection; the cursor encodes the
   * sort position it was issued for, so it is an opaque token rather than a row
   * id, and a read that changes either starts a new walk.
   */
  cursor?: string;
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

/** Options for an explicit complete collection traversal. */
export interface ListAllOptions<T> extends Omit<ServerReadOptions<T>, 'cursor'> {
  /** Maximum pages to read before refusing an unexpectedly broad traversal. @default 100 */
  maxPages?: number;
  /** Stops traversal between page requests and row yields. */
  signal?: AbortSignal;
}

/** Options for the single-row async server `read({ id })`. A subset of
 *  {@link ServerReadOptions} — `where`/`limit`/`orderBy` are fixed by the id. */
export type ServerPointReadOptions = Pick<ServerReadOptions<unknown>, 'type' | 'expand'>;
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
 * - **how you wait** — structured `queue`, admission to the line;
 * - **how long you hold** — `ttl` / `heartbeat`, the lease.
 */
export interface ClaimTargetOptions<T = Record<string, unknown>> {
  // ── What you claim — the target, narrowed below the row ────────────────

  /**
   * Narrow the claim to Zod-declared fields of the row. Return one field
   * directly or an array for several: `fields: (item) => item.status`.
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

  // ── How you handle contention ──────────────────────────────────────────

  /**
   * Behavior under contention. Prefer the structured form so the decision,
   * bounds, cancellation, and request-scoped notifications stay together:
   * `contention: { mode: 'wait', maxDepth, timeoutMs, signal, onStatus }`.
   * `{ mode: 'skip' }` is claim-or-skip dedup.
   */
  contention?: ClaimContentionOptions;
  /** Concise compatibility shorthand: `true` waits and `false` skips. */
  queue?: boolean;
  /**
   * @deprecated Prefer `contention: { maxDepth }`.
   *
   * Backpressure: queue, but not behind too many others. If the server reports a
   * position at or beyond `maxQueueDepth` when the client joins the line, it
   * rejects with {@link AbloClaimedError} (`queue_too_deep`) instead of waiting.
   * Omit to wait however deep the queue is.
   */
  maxQueueDepth?: number;
  /**
   * @deprecated Prefer `contention: { timeoutMs }`.
   *
   * Cap on how long a queued claim waits for its grant before rejecting with
   * {@link AbloClaimedError} (`grant_timeout`). Omit to wait as long as the
   * line takes. Same meaning on both transports; on the stateless HTTP client
   * a timed-out wait also leaves the line, so the slot is not left to expire.
   */
  waitTimeoutMs?: number;
  /**
   * @deprecated Prefer `contention: { signal }`.
   *
   * Abort a pending wait from outside — the same signal that cancels
   * everything else in the program, so a cancelled agent item or an unmounted
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
   * cadence — the pattern for background workers whose item outlives the
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

/** The two fail-fast spellings, kept as one overload discriminator. */
export type ClaimSkipParams<T = Record<string, unknown>> =
  ClaimParams<T> & {
    readonly queue: false;
  } | ClaimParams<T> & {
    readonly contention: ClaimContentionOptions & { readonly mode: 'skip' };
  };

export interface ClaimLookupParams<T = Record<string, unknown>> {
  readonly id: string;
}

export interface ClaimReorderParams<T = Record<string, unknown>>
  extends ClaimLookupParams<T> {
  readonly order: readonly Claim[];
}

/**
 * One wait-line snapshot. `data` preserves the standard list-envelope shape;
 * the named aliases make coordination code read without unpacking conventions.
 */
export interface ClaimQueueView<M = ResolveClaimMeta> {
  readonly object: 'list';
  readonly data: readonly Claim<Record<string, unknown>, M>[];
  /** The same ordered array as `data`, named for what it contains. */
  readonly waiting: readonly Claim<Record<string, unknown>, M>[];
  readonly size: number;
  /** The next participant to receive the lease, or `null` when the line is empty. */
  readonly next: Claim<Record<string, unknown>, M> | null;
}

export function claimQueueView<M = ResolveClaimMeta>(
  waiting: readonly Claim<Record<string, unknown>, M>[],
): ClaimQueueView<M> {
  return {
    object: 'list',
    data: waiting,
    waiting,
    size: waiting.length,
    next: waiting[0] ?? null,
  };
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

export type ClaimSkipOptions<T = Record<string, unknown>> =
  ClaimOptions<T> & {
    readonly queue: false;
  } | ClaimOptions<T> & {
    readonly contention: ClaimContentionOptions & { readonly mode: 'skip' };
  };

/**
 * The coordination surface for a model, exposed as a callable namespace.
 *
 * Most callers do not need this namespace directly. Put `claim: { ... }` on a
 * write and the SDK acquires/releases around that one mutation:
 *
 * ```ts
 * await ablo.items.update({
 *   id,
 *   data: { title },
 *   claim: {
 *     fields: (item) => item.title,
 *     description: 'Renaming the item to match the project brief.',
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
  ): ClaimQueueView<M>;

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
  // `[R]` keeps the check non-distributive. `state` returns `Claim | null`, and
  // a bare `R extends …` split that into two function types, one per union
  // member, so the HTTP `state` was typed as a union of functions rather than
  // one function returning the union. The cast that hid it is gone.
  ? [R] extends [Promise<unknown>]
    ? (...args: A) => R
    : (...args: A) => Promise<R>
  : F;

/**
 * The four ways to take a claim. Already async on every transport, so this is
 * the ONE definition of the callable half of a claim namespace: the reactive
 * {@link ClaimApi} and the stateless {@link HttpClaimApi} both extend it, and an
 * overload added here reaches both. (The two used to restate these by hand, and
 * the row-free pair below existed on one surface and not the other.)
 */
export interface ClaimCall<
  T,
  Fields = T,
> {
  /**
   * The try-claim: `contention: { mode: 'skip' }` (or `queue: false`)
   * treats a held target as an expected outcome, not an error — it resolves
   * `null`, so claim-or-skip dedup reads
   * `if (!claim) return` with no try/catch. Who holds it, and why, stays
   * readable through `claim.state({ id })`. (A write to a row someone else
   * holds still rejects with `entity_claimed` — a failed write is an error;
   * a skipped try is not.)
   */
  (params: ClaimSkipParams<Fields>): Promise<HeldClaim<T> | null>;
  /**
   * Takes a claim and returns an explicit held-work handle — a {@link HeldClaim}.
   * `data`, `release`, `revoke`, and the async disposer are always present (this
   * call re-reads the row under the lease), so callers can use `handle.data`
   * directly and `await using` works without a guard. A row that does not
   * exist rejects with `AbloNotFoundError` after the lease is given back; to
   * hold a key before its row exists, use the id-only form below.
   */
  (params: ClaimParams<Fields>): Promise<HeldClaim<T>>;
  /** The row-free try-claim — `null` when the key is already held. */
  (id: string, opts: ClaimSkipOptions<Fields>): Promise<HeldLease | null>;
  /**
   * Takes a claim by id alone, for a row that lives only in the customer's own
   * database or does not exist yet — Ablo has nothing to re-read, so no read is
   * made after the grant. Returns a {@link HeldLease}: the same lease controls
   * as {@link HeldClaim} (`release`, `revoke`, `heartbeat`, `await using`) but
   * no `.data`. Locking a key you know by id is exactly this — serialize
   * writers without first syncing the row into Ablo, or claim an id before
   * creating its row so two actors cannot both create it.
   */
  (id: string, opts?: ClaimOptions<Fields>): Promise<HeldLease>;
}

export interface ClaimApi<
  T,
  Fields = T,
> extends ClaimReadApi<T>, ClaimCall<T, Fields> {}

export interface ModelReadParams extends ServerPointReadOptions {
  readonly id: string;
}

/**
 * Options shared by schema model writes.
 *
 * Reactive clients apply the row change optimistically before returning from
 * the call. The returned promise has one stable confirmation contract across
 * reactive and stateless clients: it resolves only after authoritative
 * confirmation. Callers that need an earlier queued receipt use the lower-level
 * `commits.create` resource instead.
 */
export type ModelWriteOptions = Omit<
  MutationOptions,
  'wait' | 'readAt' | 'fenceToken' | 'claimRef'
>;

export interface ModelCreateParams<T, CreateInput>
  extends ModelWriteOptions {
  readonly data: CreateInput;
  readonly id?: string | null;
  readonly claim?: Claim<T> | ClaimTargetOptions<CreateInput> | null;
}

/**
 * Creating many rows at once: the same verb, handed a list.
 *
 * One atomic commit, so the batch lands whole or not at all, and the rows come
 * back in the order they were given. There is no `id` beside `data` here the
 * way there is for a single create, since one id cannot address many rows;
 * write it into each row instead, which the create input has always allowed.
 */
export type ModelCreateManyParams<CreateInput> = Pick<
  ModelWriteOptions,
  'idempotencyKey' | 'reads'
> & {
  readonly data: readonly CreateInput[];
};

export interface ModelUpdateParams<T, Fields = T>
  extends ModelWriteOptions {
  readonly id: string;
  /**
   * Patch only fields declared by the model's Zod input shape. Hydrated rows
   * also carry framework fields, relations, methods, and computed values; none
   * of those are writable data.
   *
   * Send a field to change it, omit it to leave it, send `null` to clear it —
   * see {@link Clearable}. `undefined` is not a clear: it is dropped from the
   * payload and the old value survives.
   */
  readonly data: Clearable<ClaimableFields<Fields>>;
  readonly claim?: Claim<T> | ClaimTargetOptions<Fields> | null;
}

export interface ModelDeleteParams<T, Fields = T>
  extends ModelWriteOptions {
  readonly id: string;
  readonly claim?: Claim<T> | ClaimTargetOptions<Fields> | null;
}
