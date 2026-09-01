/**
 * Shared resource types for the typed clients and private HTTP transport.
 * the commit and claim shapes, and the
 * {@link HttpClaimApi} derivation. This module holds only types and has no runtime
 * imports.
 */

import type {
  ClaimHeartbeatAckPayload,
  ReadDependency,
} from '../../coordination/schema.js';
import type { ClaimHeartbeatReply, ClaimState } from '../../claims/contract.js';
import type {
  ClientCommitReceipt,
  CommitWait,
  CommitRecord,
  CommitRecordList,
  CommitRecordListOptions,
  CommitRecordWhere,
  CommitOperationBody,
  ModelOperationAction,
} from '../../commit/contract.js';
import type { LogListResponse, LogQuery } from '../../observation/feedContract.js';
import type { ModelListEvidence } from '../../wire/modelResponses.js';
import { AbloValidationError } from '../../errors.js';
// Re-exported, not redeclared. `commit/contract.ts` owns the commit-status vocabulary
// and derives the waitable subset from it; this module serves that name to SDK
// consumers. Restating the subset here as its own union produced a type that
// matched the canonical one only by both happening to list the same two
// strings — and would have silently disagreed with the runtime `wait`
// validator the moment a third commit status existed.
export type { CommitWait };
// `ModelTarget` (the `model` and `id` locator) and `ModelClaim` (the resolved
// claim view) are defined in `../coordination/schema`, derived from a single
// schema so the client, the HTTP client, and the server share one definition.
// They are re-exported here so the resource types live behind one import.
import type { ModelTarget, ModelClaim } from '../../coordination/schema.js';
export type { ModelTarget, ModelClaim };
import type { ResolveClaimMeta } from '../../types/global.js';
import type { ParticipantKind } from '../../types/participant.js';
// The capability vocabulary — `auth/capability.ts` owns what a grant is on both
// axes, and these params are the surface a developer declares it through.
import type { EffectiveAuthority } from '../../auth/capability.js';
import type {
  Claim,
  ClaimStream,
  ClaimWaitOptions,
  Duration,
  HeldClaim,
} from '../../types/streams.js';
import type { ModelUpdater, FunctionalUpdateOptions } from './functionalUpdate.js';
import type {
  ClaimOptions,
  ClaimAttemptEvent,
  ClaimCall,
  ClaimReadApi,
  AwaitedClaimMethod,
  ModelCreateManyParams,
  ServerReadOptions,
} from './modelOperations.js';

// ── Model proxy types ─────────────────────────────────────────────────────

/**
 * The operations available on each model in the sync engine:
 *   `get({ id })` — an observational async single-row server read
 *   `read({ id })` — an async single-row server read that may guard a write
 *   `list({ where })` — an async collection server read
 *   `local.get(id)` / `local.list(...)` / `local.count(...)` — synchronous local reads
 *   `create({ data })` / `update({ id, data })` / `delete({ id })` — writes
 *   `claim({ id })` — a durable claim handle for coordinated writes
 */

export type { ModelOperationAction };


/** @internal Transport envelope; the public typed client returns the row. */
export interface HttpTransportRead<T = Record<string, unknown>> {
  /**
   * The row, or `undefined` when no row matched the id (or it's outside the
   * caller's scope). A miss is data-absence, not an error — `get` never
   * throws "not found". This envelope stays inside the HTTP transport; the
   * public typed client unwraps it to the WebSocket client's `T | undefined`.
   */
  readonly data: T | undefined;
  readonly stamp: number;
  readonly claims: readonly ModelClaim[];
}

/** @internal Exact collection envelope retained until the typed facade captures evidence. */
export interface HttpTransportList<T = Record<string, unknown>> {
  readonly data: readonly T[];
  /**
   * Whether the collection continues past this page. A list read is always a
   * page — the server applies a default size and caps the largest one — so a
   * caller that treats `data` as the whole set is right only while this is
   * `false`. It used to be dropped on the floor here, which made a truncated
   * read indistinguishable from a complete one.
   */
  readonly hasMore: boolean;
  /**
   * The cursor to pass back as `cursor` for the next page, or `null` at the end
   * of the collection.
   */
  readonly nextCursor: string | null;
  readonly evidence?: readonly ModelListEvidence[];
}

/**
 * What a collection read hands back: the rows, and where the collection stands.
 *
 * It is an array, so it maps, filters, spreads, and iterates like the rows it
 * always was. `hasMore` and `nextCursor` ride along as non-enumerable
 * properties, which keeps `JSON.stringify` and a spread producing exactly the
 * array they produced before.
 *
 * They ride along because a list read is a page: the server applies a default
 * size and caps the largest one. Returning only the rows made a truncated read
 * and a complete one the same value, so the caller with 500 matching rows got
 * 20 and no way to find out.
 */
export type ModelList<T> = T[] & Pick<HttpTransportList<T>, 'hasMore' | 'nextCursor'> &
  AsyncIterable<T>;

/**
 * How far a `for await` over a list will walk before it gives up.
 *
 * A cursor that stops advancing would otherwise spin forever. The bound is
 * high enough that no real collection reaches it and low enough that a broken
 * server is a failed read rather than a hung process.
 */
const AUTO_PAGE_LIMIT = 10_000;
const LIST_ALL_PAGE_LIMIT = 100;

const nextPageFor = new WeakMap<object, (cursor: string) => Promise<ModelList<unknown>>>();

export interface ModelListWalkOptions {
  readonly maxPages?: number;
  readonly signal?: AbortSignal;
}

async function* walkModelList<T>(
  first: ModelList<T>,
  options: ModelListWalkOptions = {},
): AsyncGenerator<T> {
  const maxPages = options.maxPages ?? AUTO_PAGE_LIMIT;
  if (!Number.isInteger(maxPages) || maxPages < 1) {
    throw new AbloValidationError('maxPages must be a positive integer.', {
      code: 'invalid_options',
      param: 'maxPages',
    });
  }

  let current = first;
  for (let visited = 0; visited < maxPages; visited += 1) {
    options.signal?.throwIfAborted();
    for (let i = 0; i < current.length; i += 1) {
      options.signal?.throwIfAborted();
      yield current[i] as T;
    }
    const cursor = current.nextCursor;
    const fetchNext = nextPageFor.get(current) as
      | ((nextCursor: string) => Promise<ModelList<T>>)
      | undefined;
    if (!current.hasMore || cursor === null || fetchNext === undefined) return;
    const next = await fetchNext(cursor);
    if (next.nextCursor === cursor) {
      throw new AbloValidationError(
        `Walking this list received the same continuation cursor twice (${JSON.stringify(cursor)}). ` +
          'The collection may be incomplete, so traversal stopped with an error.',
        { code: 'malformed_response', param: 'nextCursor' },
      );
    }
    current = next;
  }
  throw new AbloValidationError(
    `Walking this list passed ${maxPages} pages without reaching the end. ` +
      `Narrow the read with \`where\` or raise \`maxPages\` deliberately.`,
    { code: 'invalid_options', param: 'maxPages' },
  );
}

/** Collect a complete list through the same guarded cursor loop as async iteration. */
export async function collectModelList<T>(
  first: ModelList<T>,
  options: ModelListWalkOptions = {},
): Promise<T[]> {
  const rows: T[] = [];
  for await (const row of walkModelList(first, {
    maxPages: options.maxPages ?? LIST_ALL_PAGE_LIMIT,
    signal: options.signal,
  })) rows.push(row);
  return rows;
}

/**
 * Attach the page state to the rows, and make the list walk its own pages.
 *
 * `hasMore` and `nextCursor` are non-enumerable, so the result stays
 * indistinguishable from a plain array everywhere they are not read: it maps,
 * filters, spreads, and `JSON.stringify`s exactly as the rows always did.
 *
 * The async iterator is the answer to the question that shape raises. A list
 * read is a page — the server applies a default size and caps the largest —
 * and a page of 20 looks precisely like a complete answer of 20, so every
 * caller either checked `hasMore` or, far more often, reasoned about a
 * truncated set without knowing it. Hand-rolled page walkers were the common
 * result, and each one re-derived the same cursor loop and the same
 * non-advancing-cursor guard.
 *
 * So iterate the value to get the page, and `for await` it to get the
 * collection:
 *
 * ```ts
 * const page = await ablo.issue.list({ where: { teamId } });
 * for (const issue of page) …            // the 20 rows that came back
 * for await (const issue of page) …      // every issue, paged as it goes
 * ```
 */
export function modelList<T>(
  rows: readonly T[],
  page: Pick<HttpTransportList<unknown>, 'hasMore' | 'nextCursor'>,
  /** Reads the page after `cursor`. Omitted where no transport can follow. */
  fetchNext?: (cursor: string) => Promise<ModelList<T>>,
): ModelList<T> {
  const list = Object.defineProperties([...rows], {
    hasMore: { value: page.hasMore, enumerable: false },
    nextCursor: { value: page.nextCursor, enumerable: false },
    [Symbol.asyncIterator]: { value: () => walkModelList(list), enumerable: false },
  }) as ModelList<T>;
  if (fetchNext) {
    nextPageFor.set(list, fetchNext as (cursor: string) => Promise<ModelList<unknown>>);
  }
  return list;
}

export type IfClaimedPolicy = 'return' | 'fail';

export interface ClaimedOptions {
  /**
   * What to do when another participant has claimed the target: `return` lets
   * the read proceed; `fail` throws `AbloClaimedError`. Inspect claim state via
   * `ablo.<model>.claim.state({ id })`. Waiting is a claim-side concern — take
   * `ablo.<model>.claim({ id })` (it queues fairly); reads never block.
   */
  readonly ifClaimed?: IfClaimedPolicy;
}

export type { ClaimWaitOptions } from '../../types/streams.js';

export interface ModelReadOptions extends ClaimedOptions {}

/**
 * The target a caller names when creating a claim: {@link ModelTarget} with its
 * one caller-authored member typed — `meta` is the shape declared on
 * `Register`'s `ClaimMeta` slot, the same declaration every reader of the claim
 * is given back.
 *
 * Derived rather than restated, and narrowed only here: `modelTargetSchema`
 * keeps parsing `meta` as an open record, because a peer on a newer build must
 * still be understood. The wire stays permissive; the DTO the caller writes
 * does not.
 */
export type ModelTargetInput = Omit<ModelTarget, 'meta'> & {
  readonly meta?: ResolveClaimMeta;
};

export interface ClaimCreateOptions {
  readonly target: ModelTargetInput;
  /** Peer-visible description of the work — the same field on every claim
   *  surface. Defaults to `'editing'` when omitted. */
  readonly description?: string;
  readonly ttl?: Duration;
  /**
   * Join the server's fair FIFO queue when the target is already claimed,
   * rather than failing immediately. `create` then resolves only once the
   * lease is actually ours (the server pushes `claim_acquired` if the target
   * was free, or `claim_granted` when we reach the head of the line). Without
   * this, a contended claim throws. Used by `ablo.<model>.claim` so writers
   * serialize instead of racing.
   */
  readonly queue?: boolean;
  /** Cap on how long to wait for a queued grant before rejecting. */
  readonly waitTimeoutMs?: number;
  /** Abort a pending wait from outside — rejects with `claim_wait_aborted`.
   *  Ignored once the grant has arrived. */
  readonly signal?: AbortSignal;
  /**
   * Backpressure: reject with `AbloClaimedError('queue_too_deep')` instead of
   * waiting if the queue is already `>= maxQueueDepth` when we join.
   */
  readonly maxQueueDepth?: number;
  /** Request-scoped queued / granted / skipped / failed status events. */
  readonly onStatus?: (event: ClaimAttemptEvent) => void;
}

/** Public commit operation inferred from the canonical request-body schema. */
export type CommitOperationInput = CommitOperationBody;

export type CommitClaim = Omit<Claim<unknown>, 'data'>;

export interface CommitCreateOptions<Read = ReadDependency> {
  readonly idempotencyKey?: string | null;
  readonly readAt?: number | null;
  /**
   * A claim handle from `ablo.<model>.claim({ id })` (or the HTTP claim
   * surface). Same vocabulary as the per-model writes: the handle's
   * snapshot watermark becomes the batch `readAt` default, so a commit that follows a claim is guarded
   * against concurrent edits without re-stating the watermark by hand.
   * An explicit `readAt` on the options wins.
   */
  readonly claim?: CommitClaim | null;
  /** One atomic batch. Use a one-element array for a single operation. */
  readonly operations: readonly CommitOperationInput[];
  readonly wait?: CommitWait;
  /**
   * The batch premise — the "did anything I looked at change?" guard.
   * Declare the rows (`{ model, id, readAt, fields? }`) or sync groups
   * (`{ group, readAt }`, for example `report:abc`) this batch was premised on; the
   * server rejects the batch if any moved since `readAt`. This is distinct from the write-target `readAt`: it guards what
   * you read, not what you write.
   */
  readonly reads?: readonly Read[] | null;
}

/** Public projection inferred from the canonical runtime schema. */
export type CommitReceipt = ClientCommitReceipt;

export interface CommitResource<Read = ReadDependency> {
  create(options: CommitCreateOptions<Read>): Promise<CommitReceipt>;
  get(options: { readonly id: string }): Promise<CommitRecord | null>;
  list(options?: CommitRecordListOptions): Promise<CommitRecordList>;
}

export interface HttpLogListOptions
  extends Omit<LogQuery, 'limit'> {
  readonly limit?: number;
  readonly signal?: AbortSignal;
}

export interface HttpLogsResource {
  list(options?: HttpLogListOptions): Promise<LogListResponse>;
}

export interface ClaimResource extends ClaimStream {
  create(options: ClaimCreateOptions): Promise<Claim>;
  list(target?: Partial<ModelTarget>): readonly ModelClaim[];
  waitFor(target: Partial<ModelTarget>, options?: ClaimWaitOptions): Promise<void>;
}

/**
 * The claim-ticket surface of the stateless HTTP client — the operations a
 * caller performs holding only a `claimId`, which is what a queued acquire
 * leaves in its hand (`AbloClaimedError('claim_queued')` carries it on
 * `error.claims`). The WebSocket client never needs these: it awaits the grant
 * on its socket.
 *
 * All three shapes are the wire's own — `claimStateSchema`,
 * `claimHeartbeatReplySchema`, and the batch ack — so this surface cannot
 * describe a response the server does not send.
 */
export interface HttpClaimsResource {
  /**
   * The claim's current state, by its id — `GET /v1/claims/{claimId}`. The
   * poll half of the queued-grant handover: a queued caller polls until
   * `status` is `'active'`, at which point `fenceToken` is present and the
   * work can begin. `position` is advisory (a privileged caller can reorder
   * the line, so it may go up); only `status` is authoritative.
   */
  retrieve(params: { readonly claimId: string }): Promise<ClaimState>;
  /**
   * One beat on the named lease — `POST /v1/claims/{claimId}/heartbeat`. On a
   * held lease it extends the TTL; on a queued ticket it refreshes the
   * waiter's slot in the line and reports `{ status: 'queued', position }`.
   */
  heartbeat(params: {
    readonly claimId: string;
    readonly ttl?: string | number;
  }): Promise<ClaimHeartbeatReply>;
  /**
   * One beat for every lease this identity holds — `POST /v1/claims/heartbeat`,
   * one ack per extended lease. The socketless twin of the realtime
   * keepalive, for a stateless worker holding many rows.
   */
  heartbeatAll(options?: {
    readonly ttl?: string | number;
  }): Promise<readonly ClaimHeartbeatAckPayload[]>;
  /**
   * Give the ticket back — `DELETE /v1/claims/{claimId}`. On a held lease this
   * releases it and promotes the head of the queue; on a queued ticket it
   * leaves the line, so the waiters behind move up instead of waiting out
   * your slot's TTL. Idempotent: releasing an already-ended claim is a no-op.
   */
  release(params: { readonly claimId: string }): Promise<void>;
}

export interface ModelMutationOptions extends ClaimedOptions {
  readonly idempotencyKey?: string | null;
  /** Commit-lifetime read dependencies checked before this mutation lands. */
  readonly reads?: readonly ReadDependency[] | null;
  readonly claim?: Claim | ClaimOptions | null;
}

/** Internal fields derived from a claim or functional update, never authored on a model write. */
export interface InternalModelMutationOptions extends ModelMutationOptions {
  readonly claimRef?: string | { readonly id: string } | null;
  readonly readAt?: number | null;
  /** Fencing token (Option B) from the claim; server-validated at commit. */
  readonly fenceToken?: number | null;
}

/**
 * The stateless HTTP claim surface. Most code puts a `claim` directly on the write
 * (`update({ id, data, claim })`) and lets the SDK release it; reach for this
 * namespace for multi-step handles and coordination screens.
 *
 * It is the same surface as the reactive claim API, but because every read is a
 * server round-trip, `state`, `list`, `queue`, and `reorder` are awaited here. The
 * WebSocket client resolves those synchronously from its local cache, which is what
 * lets it read a claim's state inside a React render; a stateless client has no
 * cache to read, so the promise is unavoidable.
 *
 * It is derived from `ClaimReadApi` through {@link AwaitedClaimMethod} so the two
 * transports cannot drift: the only difference is the promise wrapper that
 * statelessness forces. `claim({ id })` is identical on both (already async);
 * `state`, `list`, `queue`, `reorder`, and `release` are the awaited form.
 */
export type HttpClaimApi<
  T = Record<string, unknown>,
  Fields = T,
> = ClaimCall<T, Fields> & {
  [K in keyof ClaimReadApi<T>]: AwaitedClaimMethod<ClaimReadApi<T>[K]>;
};

/** @internal String-keyed model routing owned by the private HTTP transport. */
export interface HttpTransportModel<
  T = Record<string, unknown>,
  Fields = T,
> {
  /**
   * Single-row read over HTTP. **Returns an envelope, not the bare row** — the
   * row is on `.data`, alongside the `.stamp` watermark (for stale-context
   * guards on the following write) and any active `.claims`. This is the
   * schema-agnostic protocol surface; the typed HTTP facade unwraps it to the
   * same `T | undefined` shape as the WebSocket client.
   *
   * Public callers never see this shape; `createAbloHttpClient` unwraps it.
   */
  read(params: ModelReadOptions & { readonly id: string }): Promise<HttpTransportRead<T>>;
  /**
   * Collection read over HTTP (server round-trip). Equality `where`, `orderBy`,
   * and `limit`. The typed public client always exposes `ablo.<model>.list`;
   * this protocol shape is private transport machinery.
   */
  list(options?: ServerReadOptions<T>): Promise<HttpTransportList<T>>;
  /**
   * Creates a row and returns the confirmed server row, including framework
   * defaults such as `createdAt` and `createdBy`. Matches the stateful client's
   * `create`. Passing an id that already exists is idempotent: the existing row is
   * returned, not the input.
   */
  create(params: ModelMutationOptions & { readonly data: Record<string, unknown>; readonly id?: string | null }): Promise<T>;
  /**
   * Creates many rows as one atomic commit and returns them, in the caller's
   * order. One rejected row declines the batch. The rows are the server's own,
   * carried back on the commit rather than read again afterwards.
   */
  createMany(params: ModelCreateManyParams<Record<string, unknown>>): Promise<T[]>;
  update(params: ModelMutationOptions & { readonly id: string; readonly data: Record<string, unknown> }): Promise<CommitReceipt>;
  /**
   * Update under contention with a function of the latest state —
   * `update(id, current => next)`, the `setState(prev => next)` of the data
   * layer. The SDK reads the freshest row, runs your updater, writes it as a
   * compare-and-swap against the row's watermark, and re-reads + re-runs on any
   * concurrent write. No claim, no identity, no conflict codes surface: the
   * write either lands or throws {@link AbloContentionError} once its reconcile
   * budget is spent. Return `null`/`undefined` from the updater to skip the
   * write (resolves to `undefined`).
   */
  update(
    id: string,
    updater: ModelUpdater<T>,
    options?: FunctionalUpdateOptions,
  ): Promise<CommitReceipt | undefined>;
  delete(params: ModelMutationOptions & { readonly id: string }): Promise<CommitReceipt>;
  /**
   * Durable lease + FIFO wait-line over HTTP — coordination without a socket.
   * The typed public clients expose this through `ablo.<model>.claim`. This
   * schema-agnostic shape stays inside the HTTP transport.
   */
  claim: HttpClaimApi<T, Fields>;
}
