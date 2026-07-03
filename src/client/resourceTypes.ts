/**
 * The shared resource-type surface of the client — `ModelRead`, `ModelClient`,
 * the `Commit*` / `Claim*` shapes, the session-mint params/resource, and the
 * `HttpClaimApi` derivation.
 *
 * Extracted from `Ablo.ts` so `ApiClient.ts` / `httpClient.ts` /
 * `sessionMint.ts` can take the wire-facing types WITHOUT importing the
 * factory module that runtime-imports them back (the 4-cycle cluster madge
 * flagged). This module is type-only — ZERO runtime imports — so importing it
 * can never create a cycle. `Ablo.ts` re-exports everything here, so existing
 * import paths keep resolving.
 */

import type { StaleNotification, ReadDependency } from '../coordination/schema.js';
// `ModelTarget` (the `model`/`id` locator) and `ModelClaim` (the resolved claim
// view) are canonical in `../coordination/schema` — derived there from one zod
// schema so the SDK, the HTTP client, and the sync-server routes share a single
// definition instead of hand-redeclaring it. Re-exported so the HTTP client
// modules can take the whole resource-type surface from this one leaf.
import type { ModelTarget, ModelClaim } from '../coordination/schema.js';
export type { ModelTarget, ModelClaim };
import type { SchemaRecord } from '../schema/schema.js';
import type { SyncGroupInput } from '../schema/roles.js';
import type {
  Claim,
  ClaimStream,
  ClaimWaitOptions,
  Duration,
  HeldClaim,
} from '../types/streams.js';
import type { ModelUpdater, ContentionOptions } from './functionalUpdate.js';
import type {
  ClaimOptions,
  ClaimParams,
  ClaimReadApi,
  AwaitedClaimMethod,
  ServerReadOptions,
} from './createModelProxy.js';

// ── Model proxy types ─────────────────────────────────────────────────────

/**
 * Operations available on each model in the sync engine.
 *
 * Naming aligns with Stripe / OpenAI / Anthropic conventions:
 *   `retrieve({ id })` — async single-row server read
 *   `list({ where })` — async collection server read
 *   `get(id)` / `getAll(...)` / `getCount(...)` — local graph snapshots
 *   `create({ data })` / `update({ id, data })` / `delete({ id })` — writes
 *   `claim({ id })` — durable claim handle for coordinated writes
 */
// `ModelOperations` and the model option types live in
// `./createModelProxy` alongside the factory that builds them — re-exported
// here so the existing import path (`@abloatai/ablo`) keeps resolving.
// See `createModelProxy.ts` for full JSDoc on each method.
export type {
  LocalCountOptions,
  LocalReadOptions,
  ModelListScope,
  ServerReadOptions,
  ModelRetrieveParams,
  ModelCreateParams,
  ModelUpdateParams,
  ModelDeleteParams,
  ClaimOptions,
  ClaimParams,
  ClaimLookupParams,
  ClaimReorderParams,
  Claim,
  HeldClaim,
  ModelOperations,
} from './createModelProxy.js';

export type ModelOperationAction =
  | 'create'
  | 'update'
  | 'delete'
  | 'archive'
  | 'unarchive';

export type CommitWait = 'queued' | 'confirmed';

export interface ModelRead<T = Record<string, unknown>> {
  /**
   * The row, or `undefined` when no row matched the id (or it's outside the
   * caller's scope). A miss is data-absence, not an error — `retrieve` never
   * throws "not found", mirroring the WebSocket client's `T | undefined`.
   * Branch on it: `const deal = (await ablo.deals.retrieve({ id })).data; if (!deal) …`.
   */
  readonly data: T | undefined;
  readonly stamp: number;
  readonly claims: readonly ModelClaim[];
}

export type IfClaimedPolicy = 'return' | 'fail';

export interface ClaimedOptions {
  /**
   * What to do when another participant has claimed the target: `return`
   * includes active claim metadata in the response; `fail` throws
   * `AbloClaimedError`. Waiting for a claim to clear is a claim-side concern —
   * take `ablo.<model>.claim({ id })` (it queues fairly); reads never block.
   */
  readonly ifClaimed?: IfClaimedPolicy;
}

export type { ClaimWaitOptions } from '../types/streams.js';

export interface ModelReadOptions extends ClaimedOptions {}

export interface ClaimCreateOptions {
  readonly target: ModelTarget;
  /** Human-readable phase shown to peers — `'editing'`, `'writing'`. The same
   *  word on every claim surface. */
  readonly reason: string;
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
  /**
   * Backpressure: reject with `AbloClaimedError('queue_too_deep')` instead of
   * waiting if the queue is already `>= maxQueueDepth` when we join.
   */
  readonly maxQueueDepth?: number;
}

export interface CommitOperationInput {
  readonly action: ModelOperationAction;
  /** The model name — matches `ablo.<model>` and the schema's `model()`. */
  readonly model?: string;
  readonly target?: ModelTarget;
  readonly id?: string | null;
  readonly data?: Record<string, unknown> | null;
  readonly transactionId?: string | null;
  readonly readAt?: number | null;
  readonly onStale?: 'reject' | 'overwrite' | 'notify' | null;
}

export interface CommitCreateOptions {
  readonly claimRef?: string | { readonly id: string } | null;
  readonly idempotencyKey?: string | null;
  readonly readAt?: number | null;
  readonly onStale?: 'reject' | 'overwrite' | 'notify' | null;
  /**
   * A claim handle from `ablo.<model>.claim({ id })` (or the HTTP claim
   * surface). Same vocabulary as the per-model writes: the handle's
   * snapshot watermark becomes the batch `readAt` default and `onStale`
   * defaults to `'reject'`, so a commit that follows a claim is guarded
   * against concurrent edits without re-stating the watermark by hand.
   * Explicit `readAt`/`onStale` on the options win.
   */
  readonly claim?: Claim | null;
  readonly operation?: CommitOperationInput;
  readonly operations?: readonly CommitOperationInput[];
  readonly wait?: CommitWait;
  /**
   * Batch-level read dependencies (the STORM "did anything I looked at change?"
   * layer). Declare the rows (`{model,id,readAt,fields?}`) or sync groups
   * (`{group,readAt}`, e.g. `deck:abc`) this batch was premised on; the server
   * validates none moved since `readAt` and fires the entry's `onStale` over the
   * batch. Distinct from the write-target `readAt` — this guards what you READ,
   * not what you write.
   */
  readonly reads?: readonly ReadDependency[] | null;
}

export interface CommitReceipt {
  readonly id: string;
  readonly status: CommitWait;
  readonly lastSyncId?: number;
  /**
   * Stale-context notifications (notify-instead-of-abort, non-coercion). Present
   * only when this commit guarded a write with `onStale: 'notify' and
   * the premise moved concurrently — the conflicting field's current value,
   * handed back as data instead of a forced `AbloStaleContextError`. The engine
   * surfaces state; the intelligent actor (agent or human) decides how to
   * resolve. Also fires on `conflict:notified`.
   */
  readonly notifications?: readonly StaleNotification[];
  /**
   * Ids of UPDATE/DELETE targets in this commit that matched ZERO rows (the row
   * doesn't exist, or is outside the caller's org). Present (non-empty) only
   * when a write missed. Typed resource wrappers turn this into a loud
   * `AbloNotFoundError`; a raw `commits.create` caller can inspect it directly.
   */
  readonly missingIds?: readonly string[];
}

export interface CommitResource {
  create(options: CommitCreateOptions): Promise<CommitReceipt>;
}

export interface ClaimResource extends ClaimStream {
  create(options: ClaimCreateOptions): Promise<Claim>;
  list(target?: Partial<ModelTarget>): readonly ModelClaim[];
  waitFor(target: Partial<ModelTarget>, options?: ClaimWaitOptions): Promise<void>;
}

export interface ModelMutationOptions extends ClaimedOptions {
  readonly claimRef?: string | { readonly id: string } | null;
  readonly idempotencyKey?: string | null;
  readonly readAt?: number | null;
  readonly onStale?: 'reject' | 'overwrite' | 'notify' | null;
  readonly wait?: CommitWait;
  readonly claim?: Claim | ClaimOptions | null;
}

/**
 * The HTTP/stateless claim surface. Normal tools usually put `claim` directly
 * on the write (`update({ id, data, claim })`) and let the SDK release it. Use
 * this namespace for multi-step handles and coordination screens.
 *
 * Same surface as the reactive {@link ClaimApi}, but every read is a server
 * round-trip, so `state`/`queue`/`reorder` are **awaited** here (the WebSocket
 * client resolves them synchronously from its local pool — which is what lets
 * `useAblo((ablo) => ablo.x.claim.state({ id }))` work inside a React render; a
 * stateless client has no pool to read, so the `Promise` is unavoidable).
 *
 * Mechanically DERIVED from `ClaimReadApi` via {@link AwaitedClaimMethod} so the
 * two transports can never drift: the ONLY difference is the uniform `Promise`
 * wrapper that statelessness forces. `claim({ id })` is identical (already async
 * on both); `state`/`queue`/`reorder`/`release` are the awaited form.
 */
export type HttpClaimApi<T = Record<string, unknown>> =
  ((params: ClaimParams<T>) => Promise<HeldClaim<T>>) & {
    [K in keyof ClaimReadApi<T>]: AwaitedClaimMethod<ClaimReadApi<T>[K]>;
  };

export interface ModelClient<T = Record<string, unknown>> {
  /**
   * Single-row read over HTTP. **Returns an envelope, not the bare row** — the
   * row is on `.data`, alongside the `.stamp` watermark (for stale-context
   * guards on the following write) and any active `.claims`. A stateless HTTP
   * client can't synthesize the watermark from a local snapshot, so the
   * envelope is load-bearing here (the WebSocket client's `retrieve` returns
   * `T | undefined` because it reads from the hydrated pool).
   *
   * ```ts
   * const deal = await ablo.deals.retrieve({ id });
   * deal.data?.recommendation;   // ← the row is on .data
   * deal.stamp;                  // watermark — pass to the next write's readAt
   * ```
   */
  retrieve(params: ModelReadOptions & { readonly id: string }): Promise<ModelRead<T>>;
  /**
   * Collection read over HTTP (server round-trip). Equality `where`, `orderBy`,
   * `limit`. Present on the stateless protocol client; the store-backed
   * `.model(name)` accessor omits it (use the typed `ablo.<model>.list` there).
   */
  list?(options?: ServerReadOptions<T>): Promise<T[]>;
  /**
   * Create a row and return it — the confirmed, authoritative server row (with
   * framework defaults like `createdAt`/`createdBy`), mirroring the WebSocket
   * client's `create`. A re-create of an existing caller-supplied id is
   * idempotent and returns the EXISTING row, not the input.
   */
  create(params: ModelMutationOptions & { readonly data: Record<string, unknown>; readonly id?: string | null }): Promise<T>;
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
    options?: ContentionOptions,
  ): Promise<CommitReceipt | undefined>;
  delete(params: ModelMutationOptions & { readonly id: string }): Promise<CommitReceipt>;
  /**
   * Durable lease + FIFO wait-line over HTTP — coordination without a socket.
   * Present on the stateless protocol client (`Ablo({ schema: null })` /
   * `createAbloHttpClient`); the store-backed `.model(name)` accessor omits it
   * (the typed `ablo.<model>.claim` proxy is the full reactive namespace there).
   */
  claim?: HttpClaimApi<T>;
}

/** A single data operation a scoped **agent** session may perform on a model. */
export type SessionOperation = 'read' | 'create' | 'update' | 'delete';

/** Mint params for an **end-user** session — full data authority within the
 *  org (the Stripe `ephemeralKeys.create` / Supabase session shape). Mints an
 *  `ek_` token. `user.id` is your end user's external IdP id (becomes the
 *  session's `participantId`); Ablo does not model your users, so it's an
 *  honest string at the trust boundary. */
export interface CreateUserSessionParams {
  /** Your end user. `id` becomes the token's `participantId`. */
  user: { id: string };
  /** Mint the session into THIS organization instead of the key's own org — the
   *  Stripe Connect `Stripe-Account` pattern, for a platform serving many tenants
   *  from one backend. Requires the `sk_` to carry the `ephemeral:mint-any-org`
   *  scope; omit for the normal single-tenant case. */
  organizationId?: string;
  /** Sync groups this session may subscribe to — typed (`'default'` or
   *  `<namespace>:<id>`; build with `syncGroup(kind, id)` from
   *  `@abloatai/ablo/schema`). Omit for the server default:
   *  `[org:<your org>, user:<user.id>]`. */
  syncGroups?: readonly SyncGroupInput[];
  /** Token lifetime in seconds. Defaults to 900 (15m, the Stripe ephemeral default). */
  ttlSeconds?: number;
  /** Opaque identity blob echoed back to the client as `ablo.user`. */
  userMeta?: Record<string, unknown>;
  agent?: never;
  can?: never;
}

/** Mint params for a scoped **agent** session — mints a restricted `rk_` token
 *  gated to exactly the operations named in `can`. `can` is typed off your
 *  schema (no magic `'task.update'` strings): `{ Task: ['update'], Deck: ['read'] }`
 *  — the SDK serializes each entry to the wire allowlist (`task.update`). */
export interface CreateAgentSessionParams<S extends SchemaRecord> {
  /** Your agent. `id` becomes the token's `participantId`. */
  agent: { id: string };
  /** Per-model operation allowlist, typed against the schema's model names. */
  can: Partial<Record<keyof S & string, readonly SessionOperation[]>>;
  /** Sync groups this session may subscribe to — typed (`'default'` or
   *  `<namespace>:<id>`; build with `syncGroup(kind, id)` from
   *  `@abloatai/ablo/schema`). Omit for the server default: the org
   *  anchor (`org:<your org>`) + the agent's own anchor. */
  syncGroups?: readonly SyncGroupInput[];
  /** Token lifetime in seconds. Defaults to 900 (15m, the Stripe ephemeral default). */
  ttlSeconds?: number;
  /** Opaque identity blob echoed back to the client as `ablo.agent`. */
  userMeta?: Record<string, unknown>;
  user?: never;
}

/** Params for {@link Ablo.sessions}.create — a discriminated union: pass
 *  `{ user }` for a full-authority end-user session (`ek_`) or `{ agent, can }`
 *  for a scoped agent session (`rk_`). */
export type CreateSessionParams<S extends SchemaRecord> =
  | CreateUserSessionParams
  | CreateAgentSessionParams<S>;

/** Params for {@link Ablo.agents}.create — a flattened agent descriptor (no
 *  `{ agent }` discriminator: `agents.create` only ever mints an agent). Unlike
 *  {@link CreateSessionParams} it resolves to a connected, scoped {@link Ablo}
 *  client rather than a raw token. */
export interface CreateAgentClientParams<S extends SchemaRecord> {
  /** Wire participant identity (`agent:<id>`) — what claim exclusion and the
   *  FIFO queue gate on. OMIT to get a fresh `crypto.randomUUID()`: a distinct,
   *  independent participant (the default, and what you want for concurrent
   *  agents). Pass a STABLE string only when one logical agent must re-attach
   *  to its own held claims across reconnects/restarts. */
  id?: string;
  /** Human-readable label for logs / attribution (carried in `userMeta.name`).
   *  INDEPENDENT of `id`: two agents that share a `name` still receive distinct
   *  ids and coordinate as SEPARATE participants — `name` never derives or
   *  collapses identity. */
  name?: string;
  /** Per-model operation allowlist, typed against the schema's model names. */
  can: Partial<Record<keyof S & string, readonly SessionOperation[]>>;
  /** Sync groups this agent may subscribe to — typed (`'default'` or
   *  `<namespace>:<id>`). Omit for the server default (org anchor + the
   *  agent's own anchor). */
  syncGroups?: readonly SyncGroupInput[];
  /** Token lifetime in seconds. Defaults to 900 (15m); the returned client
   *  auto-re-mints before expiry, so a long-running agent never handles
   *  rotation itself. */
  ttlSeconds?: number;
  /** Extra opaque identity blob echoed on the session scope. Merged with
   *  `name` (the `name` param wins if you also set `userMeta.name`). */
  userMeta?: Record<string, unknown>;
}

/** A minted session token — the Stripe ephemeral-key / Supabase session
 *  resource. `token` is the secret the holder presents as its bearer. */
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
  scope: {
    organizationId: string;
    syncGroups: readonly string[];
    operations: readonly string[];
    participantKind: 'user' | 'agent' | 'system';
    participantId: string;
  };
  userMeta: Record<string, unknown>;
}
