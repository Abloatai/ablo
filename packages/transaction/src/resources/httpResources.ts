/**
 * Shared resource types for the typed clients and private HTTP transport.
 * the commit and claim shapes, the session-mint params and resource, and the
 * {@link HttpClaimApi} derivation. This module holds only types and has no runtime
 * imports.
 */

import type {
  ClaimHeartbeatAckPayload,
  OnStaleMode,
  ReadDependency,
  TrackDependency,
} from '../coordination/schema.js';
import type { ClaimHeartbeatReply, ClaimState } from '../wire/claims.js';
import type {
  ClientCommitReceipt,
  CommitWait,
  CommitRecord,
  CommitRecordList,
  CommitRecordListOptions,
  CommitRecordWhere,
  CommitOperationBody,
  ModelOperationAction,
} from '../wire/commit.js';
import type { LogListResponse, LogQuery } from '../wire/feedEvent.js';
import type { ModelListEvidence } from '../wire/modelResponses.js';
import { AbloValidationError } from '../errors.js';
// Re-exported, not redeclared. `wire/commit.ts` owns the commit-status vocabulary
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
import type { ModelTarget, ModelClaim } from '../coordination/schema.js';
export type { ModelTarget, ModelClaim };
import type { ResolveClaimMeta } from '../types/global.js';
import type { ParticipantKind } from '../types/participant.js';
import type { SchemaRecord } from '../schema/schema.js';
import type { SyncGroupInput } from '../schema/roles.js';
// The capability vocabulary — `auth/capability.ts` owns what a grant is on both
// axes, and these params are the surface a developer declares it through.
import type {
  CapabilityCan,
  CapabilityOperation,
  EffectiveAuthority,
} from '../auth/capability.js';
import type {
  Claim,
  ClaimStream,
  ClaimWaitOptions,
  Duration,
  HeldClaim,
} from '../types/streams.js';
import type { ModelUpdater, FunctionalUpdateOptions } from './functionalUpdate.js';
import type {
  ClaimOptions,
  ClaimAttemptEvent,
  ClaimParams,
  ClaimSkipParams,
  ClaimReadApi,
  AwaitedClaimMethod,
  ModelTrackParams,
  ModelTrackResult,
  ModelCreateManyParams,
  ServerReadOptions,
} from './modelOperations.js';

// ── Model proxy types ─────────────────────────────────────────────────────

/**
 * The operations available on each model in the sync engine:
 *   `get({ id })` — an async single-row server read
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

export type { ClaimWaitOptions } from '../types/streams.js';

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

export interface CommitCreateOptions {
  readonly idempotencyKey?: string | null;
  readonly readAt?: number | null;
  readonly onStale?: OnStaleMode | null;
  /**
   * A claim handle from `ablo.<model>.claim({ id })` (or the HTTP claim
   * surface). Same vocabulary as the per-model writes: the handle's
   * snapshot watermark becomes the batch `readAt` default and `onStale`
   * defaults to `'reject'`, so a commit that follows a claim is guarded
   * against concurrent edits without re-stating the watermark by hand.
   * Explicit `readAt`/`onStale` on the options win.
   */
  readonly claim?: Claim | null;
  /** One atomic batch. Use a one-element array for a single operation. */
  readonly operations: readonly CommitOperationInput[];
  readonly wait?: CommitWait;
  /**
   * The batch premise — the "did anything I looked at change?" guard.
   * Declare the rows (`{ model, id, readAt, fields? }`) or sync groups
   * (`{ group, readAt }`, for example `report:abc`) this batch was premised on; the
   * server checks that none moved since `readAt` and fires the entry's `onStale`
   * over the batch. This is distinct from the write-target `readAt`: it guards what
   * you read, not what you write.
   */
  readonly reads?: readonly ReadDependency[] | null;
  /**
   * Durable premises to register as part of this batch — the persisted
   * sibling of `reads`. Where `reads` guards only this commit, a `track` entry
   * (`{ model, id, readAt? }` for a row or `{ group, readAt? }` for a sync group)
   * lives on past it: a later matching change rides back on a future receipt's
   * `notifications`. A track-only batch (just `track`, an empty `operations`) is
   * the batch form of `ablo.<model>.track()`.
   */
  readonly track?: readonly TrackDependency[] | null;
}

/** Public projection inferred from the canonical runtime schema. */
export type CommitReceipt = ClientCommitReceipt;

export interface CommitResource {
  create(options: CommitCreateOptions): Promise<CommitReceipt>;
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
  readonly claimRef?: string | { readonly id: string } | null;
  readonly idempotencyKey?: string | null;
  readonly readAt?: number | null;
  readonly onStale?: OnStaleMode | null;
  /** Commit-lifetime read dependencies checked before this mutation lands. */
  readonly reads?: readonly ReadDependency[] | null;
  /** Persisted read dependencies registered by this mutation. */
  readonly track?: readonly TrackDependency[] | null;
  readonly claim?: Claim | ClaimOptions | null;
  /** Fencing token (Option B) from the claim; server-validated at commit. */
  readonly fenceToken?: number | null;
}

/**
 * The stateless HTTP claim surface. Most code puts a `claim` directly on the write
 * (`update({ id, data, claim })`) and lets the SDK release it; reach for this
 * namespace for multi-step handles and coordination screens.
 *
 * It is the same surface as the reactive claim API, but because every read is a
 * server round-trip, `state`, `queue`, and `reorder` are awaited here. The
 * WebSocket client resolves those synchronously from its local cache, which is what
 * lets it read a claim's state inside a React render; a stateless client has no
 * cache to read, so the promise is unavoidable.
 *
 * It is derived from `ClaimReadApi` through {@link AwaitedClaimMethod} so the two
 * transports cannot drift: the only difference is the promise wrapper that
 * statelessness forces. `claim({ id })` is identical on both (already async);
 * `state`, `queue`, `reorder`, and `release` are the awaited form.
 */
export type HttpClaimApi<
  T = Record<string, unknown>,
  Fields = T,
> =
  // The try-claim first: `queue: false` resolves `null` on a held target —
  // an expected outcome, not an error — while the queued default always
  // resolves a held claim or rejects with a queue error.
  ((params: ClaimSkipParams<Fields>) => Promise<HeldClaim<T> | null>) &
  ((params: ClaimParams<Fields>) => Promise<HeldClaim<T>>) & {
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
  /** Canonical point lookup for the schema-agnostic transport. */
  get(params: ModelReadOptions & { readonly id: string }): Promise<HttpTransportRead<T>>;
  /** @deprecated Use `get({ id })`; retained for the private transport compatibility seam. */
  retrieve(params: ModelReadOptions & { readonly id: string }): Promise<HttpTransportRead<T>>;
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
  /**
   * Registers a durable premise on a row — request/response, no socket. A track
   * declares what a caller is watching; it keeps no local copy of the row, so it
   * belongs to every transport rather than to the reactive client (ADR 0013 §4).
   * The typed public clients expose it as `ablo.<model>.track`.
   */
  track(params: ModelTrackParams): Promise<ModelTrackResult>;
}

/** A single data operation a scoped **agent** session may perform on a model.
 *  The SDK-facing name for {@link CapabilityOperation}; the vocabulary itself is
 *  declared once, as a schema, in `auth/capability.ts`. */
export type SessionOperation = CapabilityOperation;

/** Parameters for minting an end-user session. Mints an `ek_` token.
 *  `user.id` is your end user's id from your
 *  own identity provider and becomes the session's `participantId`; Ablo does not
 *  model your users, so it is treated as an opaque string at the trust boundary. */
export interface CreateUserSessionParams<S extends SchemaRecord> {
  /** Your end user. `id` becomes the token's `participantId`. */
  user: { id: string };
  /** Mint the session into this organization instead of the key's own — for a
   *  platform that serves many tenants from one backend. Requires the `sk_` key to
   *  carry the `organization:act-as` scope; omit it for the normal
   *  single-tenant case. */
  organizationId?: string;
  /** Resolve this session's schema from a shared project while its data stays
   *  scoped to `organizationId`. Cross-organization mints default to the
   *  platform key's own project, so most platforms can omit this. Specify it
   *  only to override that default. Requires `organization:act-as`. */
  schemaProject?: {
    organizationId: string;
    projectId: string;
  };
  /** Sync groups this session may subscribe to — typed (`'default'` or
   *  `<namespace>:<id>`; build with `syncGroup(kind, id)` from
   *  `@abloatai/transaction/schema`). Omit for the server default:
   *  `[org:<your org>, user:<user.id>]`. */
  syncGroups?: readonly SyncGroupInput[];
  /** Required least-privilege grant. */
  can: CapabilityCan<S>;
  /** Token lifetime in seconds. Defaults to 900 (15 minutes). */
  ttlSeconds?: number;
  /** Opaque identity blob echoed back to the client as `ablo.user`. */
  userMeta?: Record<string, unknown>;
  agent?: never;
}

/** Mint params for a scoped **agent** session — mints a restricted `rk_` token
 *  gated to exactly the operations named in `can`. `can` is typed off your
 *  schema (no magic `'item.update'` strings): `{ Item: ['update'], Report: ['read'] }`
 *  — the SDK serializes each entry to the wire allowlist (`item.update`). */
export interface CreateAgentSessionParams<S extends SchemaRecord> {
  /** Your agent. `id` becomes the token's `participantId`. */
  agent: { id: string };
  /** Per-model operation allowlist, typed against the schema's model names. */
  can: CapabilityCan<S>;
  /** Sync groups this session may subscribe to — typed (`'default'` or
   *  `<namespace>:<id>`; build with `syncGroup(kind, id)` from
   *  `@abloatai/transaction/schema`). Omit for the server default: the org
   *  anchor (`org:<your org>`) + the agent's own anchor. */
  syncGroups?: readonly SyncGroupInput[];
  /** Token lifetime in seconds. Defaults to 900 (15 minutes). */
  ttlSeconds?: number;
  /** Opaque identity blob echoed back to the client as `ablo.agent`. */
  userMeta?: Record<string, unknown>;
  user?: never;
}

/** Params for {@link Ablo.sessions}.create — a discriminated union: pass
 *  `{ user, can }` for an end-user session (`ek_`) or `{ agent, can }`
 *  for a scoped agent session (`rk_`). */
export type CreateSessionParams<S extends SchemaRecord> =
  | CreateUserSessionParams<S>
  | CreateAgentSessionParams<S>;

/** Params for {@link Ablo.agents}.create — a flattened agent descriptor (no
 *  `{ agent }` discriminator: `agents.create` only ever mints an agent). Unlike
 *  {@link CreateSessionParams} it resolves to a connected, scoped {@link Ablo}
 *  client rather than a raw token. */
export interface CreateAgentClientParams<S extends SchemaRecord> {
  /** The wire participant identity (`agent:<id>`) that claim exclusion and the
   *  FIFO queue gate on. Omit it to get a fresh random id — a distinct, independent
   *  participant, which is the default and what you want for concurrent agents.
   *  Pass a stable string only when one logical agent must re-attach to its own
   *  held claims across reconnects or restarts. */
  id?: string;
  /** A human-readable label for logs and attribution (carried in `userMeta.name`).
   *  It is independent of `id`: two agents that share a `name` still receive
   *  distinct ids and coordinate as separate participants — `name` never derives or
   *  collapses identity. */
  name?: string;
  /** Per-model operation allowlist, typed against the schema's model names. */
  can: CapabilityCan<S>;
  /** Sync groups this agent may subscribe to — typed (`'default'` or
   *  `<namespace>:<id>`). Omit for the server default (org anchor + the
   *  agent's own anchor). */
  syncGroups?: readonly SyncGroupInput[];
  /** Token lifetime in seconds. Defaults to 900 (15 minutes); the returned client
   *  re-mints before expiry, so a long-running agent never handles rotation
   *  itself. */
  ttlSeconds?: number;
  /** Extra opaque identity blob echoed on the session scope. Merged with
   *  `name` (the `name` param wins if you also set `userMeta.name`). */
  userMeta?: Record<string, unknown>;
}

/** A minted session. `token` is the secret the holder presents as its bearer. */
export interface AbloSession {
  object: 'session';
  /** Stable id of the minted credential (for revocation). */
  id: string;
  /** The short-lived session token — `ek_` for a `{ user }` session, `rk_`
   *  for an `{ agent }` session. Hand this to the participant's runtime. */
  token: string;
  /** ISO-8601 expiry. */
  expiresAt: string;
  organizationId: string;
  /** The grant this token carries, on both axes — the same shape the key row
   *  stores and the gates enforce. */
  scope: EffectiveAuthority;
  userMeta: Record<string, unknown>;
}

/** Result of revoking a user or agent session. */
export interface SessionRevocation {
  id: string;
  deleted: true;
  activeSessionsClosed: number;
}

/** Rotation-with-overlap result for an agent session. */
export interface SessionRotation {
  id: string;
  token: string;
  expiresAt: string | null;
  organizationId: string;
  scope: EffectiveAuthority;
  rotatedFrom: {
    id: string;
    expiresAt: string;
  };
}

export interface RevokeSessionParams {
  id: string;
}

export interface RotateSessionParams {
  id: string;
  /** How long the previous token remains valid. Defaults to 24 hours. */
  graceSeconds?: number;
  /** Optional lifetime for the replacement token. */
  ttlSeconds?: number;
}

export interface SessionResource<S extends SchemaRecord> {
  create(params: CreateSessionParams<S>): Promise<AbloSession>;
  /** Immediately revoke an `ek_` or `rk_` session and close live connections. */
  revoke(params: RevokeSessionParams): Promise<SessionRevocation>;
  /**
   * Rotate an agent `rk_` session with an overlap window. Browser `ek_`
   * sessions rotate through their `authEndpoint` instead.
   */
  rotate(params: RotateSessionParams): Promise<SessionRotation>;
}
