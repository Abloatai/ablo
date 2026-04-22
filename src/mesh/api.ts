/**
 * `@ablo/sync-engine/mesh` — API spec.
 *
 * Run multiple agents on one live entity without stomping each other.
 * Ablo's mesh makes every agent a participant on a shared sync stream
 * so they can see each other work in real time, coordinate on who's
 * editing what, and write safely against a world that's moving.
 * Customers keep their existing AI stack (Vercel AI SDK, Mastra,
 * LangChain, their own agent class) unchanged — `mesh.join(...)` is
 * the one primitive that turns an agent object into a live mesh
 * participant.
 *
 * The anti-pattern this rejects is git-worktree-style orchestration —
 * spawn sub-agents with isolated state, merge back later. That works
 * for offline batch work. It's wrong for interactive editing of a
 * shared document. Ablo's answer: everyone works on the live doc;
 * presence, intent, and watermarks are how collaboration stays safe.
 *
 * ──────────────────────────────────────────────────────────────────────
 *  MENTAL MODEL
 * ──────────────────────────────────────────────────────────────────────
 *
 *   1. Declare your schema.
 *   2. Call `mesh.join(agent, { scope, onBehalfOf })` to make any
 *      agent a participant in the sync mesh — with a live WebSocket
 *      connection that continuously streams everyone else's activity,
 *      the same `sync.X.update` API humans use, and a scoped
 *      capability token for multi-tenant safety.
 *
 *  `createMesh` (backend) and `createSyncEngine` (browser) are the
 *  same client in two runtimes. Both talk to the same sync-server,
 *  both emit the same delta wire format. Humans and agents are equal
 *  participants on that mesh — different `kind`, same data API.
 *
 * ──────────────────────────────────────────────────────────────────────
 *  WHAT ABLO OWNS (and nothing else)
 * ──────────────────────────────────────────────────────────────────────
 *
 *    mesh.join         ← make any agent-like object a mesh participant
 *    mesh.roles        ← permission templates for humans (admin-only surface)
 *    mesh.members      ← user ↔ org ↔ role bindings (admin-only surface)
 *    mesh.audit        ← append-only log (read-only)
 *    mesh.capabilities ← raw Biscuit tokens (escape hatch)
 *
 *  Tools, skills, prompts, models, agent orchestration — those stay
 *  in the customer's code, in whatever shape they already picked.
 *  Ablo doesn't model or store them. Stripe doesn't model your
 *  product catalog; we don't model your agents.
 *
 * ──────────────────────────────────────────────────────────────────────
 *  COLLABORATION IS THE PRODUCT
 * ──────────────────────────────────────────────────────────────────────
 *
 *  Every `MeshParticipant` has three always-on livestreams:
 *
 *    • PRESENCE — continuous broadcast of what this participant is
 *      doing (reading slide 5, mid-generation for slide 7, writing
 *      to the theme). Every other participant observes the stream
 *      reactively (MobX-observable, no polling). An agent's system
 *      prompt can literally include `presence.others` so the model
 *      reasons with knowledge of what other agents are doing *right
 *      now*.
 *
 *    • INTENTS — "I'm about to rewrite slide 5's title." Announced,
 *      not enforced. Other agents see the intent and yield (or pick
 *      a different slide, or queue behind it). Cooperative mutex,
 *      no central lock table. Composes with presence.
 *
 *    • CONTEXT WATERMARKS — `context.capture(...)` snapshots the
 *      state an LLM is about to reason against, and the watermark
 *      flows into every write (`readAt`, `onStale`). If the world
 *      moved during the 30-second LLM call, the write rejects and
 *      the caller regenerates against fresh state. No more "agent
 *      wrote against a stale slide that a human already changed."
 *
 *  These are not escape hatches. They are the difference between
 *  "three agents working on one deck" and "three agents all trying
 *  to edit slide 5 at once and silently overwriting each other."
 *
 * ──────────────────────────────────────────────────────────────────────
 *  DEFAULTS BIAS LEAST-PRIVILEGE
 * ──────────────────────────────────────────────────────────────────────
 *
 *  `mesh.join(agent, { onBehalfOf: session })` with no `scope` does
 *  NOT silently inherit the session's full ceiling. Under the default
 *  `delegationPolicy: 'strict'`, scope is required. Inheriting the
 *  full ceiling is opt-in per org — an audited policy choice, not a
 *  silent default. Set `delegationPolicy: 'permissive'` for dev/prototype
 *  tenants where ergonomics win.
 *
 *  Every `join` call writes a row to `mesh.audit` — who delegated what
 *  to whom, under which authority. Queryable and exportable.
 */

import type { ModelDef } from '../schema/model';
import type { InferCreate, InferModel, Schema } from '../schema/schema';

/**
 * Any JSON-serializable value. Used where the SDK accepts free-form
 * metadata that will be persisted / transported as JSON — avoids
 * `unknown` drift while preserving flexibility.
 */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };
import type { ScopableEntityNames } from './types';
import type { AgentDelta } from '../agent/SyncAgent';

/**
 * Wire-shape of a single sync delta delivered to a participant via
 * `onDelta(...)`. Identical to the transport-level `AgentDelta` — kept
 * as a mesh-facing alias so consumers don't need to import from the
 * agent subpath just to type a handler.
 */
export type DeltaEnvelope = AgentDelta;

// ─────────────────────────────────────────────────────────────────────
//  Generic resource shape (used by the admin surface only)
// ─────────────────────────────────────────────────────────────────────

/**
 * Every admin resource on the mesh implements this — same five verbs
 * everywhere. If you know one resource, you know all of them.
 */
export interface Resource<
  Item,
  CreateParams,
  UpdateParams = Partial<CreateParams>,
  ListFilters = Record<string, never>,
> {
  create(params: CreateParams): Promise<Item>;
  retrieve(id: string): Promise<Item>;
  list(filters?: ListFilters): Promise<Page<Item>>;
  update(id: string, params: UpdateParams): Promise<Item>;
  del(id: string): Promise<Deleted>;
}

/** Stripe-style pagination envelope. */
export interface Page<T> {
  readonly data: readonly T[];
  readonly hasMore: boolean;
  readonly nextCursor?: string;
}

/** Return value of every `del(id)` call. */
export interface Deleted {
  readonly id: string;
  readonly deleted: true;
}

// ─────────────────────────────────────────────────────────────────────
//  Principals — who sets the ceiling
// ─────────────────────────────────────────────────────────────────────

/**
 * A reference to whoever's authority bounds a joined participant.
 * The spawned participant can never see or do more than this principal.
 * Enforced cryptographically via Biscuit attenuation.
 *
 *   • `SessionRef`     — human is joining an agent (chat assistant flow)
 *   • `AgentRef`       — agent spawning a sub-agent (attenuation chain)
 *   • omitted          — the API key on the mesh client is the ceiling
 */
export type Principal = SessionRef | AgentRef;

export interface SessionRef {
  readonly kind: 'session';
  readonly id: string;
  readonly userId: string;
  readonly organizationId: string;
}

export interface AgentRef {
  readonly kind: 'agent';
  readonly id: string;
  readonly capabilityToken: string;
}

// ─────────────────────────────────────────────────────────────────────
//  mesh.join — the one primitive customers actually touch
// ─────────────────────────────────────────────────────────────────────

/**
 * Options threaded through every `MeshParticipant` mutation.
 *
 *   • `readAt` — sync id from `context.capture`. Triggers the
 *     server's stale-check when present.
 *   • `onStale` — behavior when the target moved since `readAt`.
 *     Default `'reject'` (throws AbloStaleContextError); `'force'`
 *     applies unconditionally. `'flag'` / `'merge'` are reserved.
 */
export interface ParticipantMutationOptions {
  readonly readAt?: number;
  readonly onStale?: 'reject' | 'force' | 'flag' | 'merge';
}

/**
 * Anything can be a mesh participant. Customers pass their existing
 * agent class / Vercel AI SDK tool result / Mastra agent / plain
 * object — we don't interpret its shape.
 *
 * Both fields are optional. **Prefer to omit `id` entirely** — the
 * SDK mints a fresh UUID (`agent_<uuid>`) at join time. Domain-specific
 * ids (`'dd-<matterId>'`) are an anti-pattern unless you need to
 * correlate the same agent identity across process restarts (resumable
 * long-running jobs, audit joins). Label is the human-readable name
 * peers see in presence / intents — pass that so the UI isn't anonymous.
 *
 * The customer's agent object is held by reference, not mutated. It's
 * perfectly fine to pass your whole domain agent object (with tools,
 * prompts, whatever) — the SDK only reads `id` / `label`.
 */
export interface AgentLike {
  readonly id?: string;
  readonly label?: string;
}

/**
 * Options for `mesh.join(agent, opts)`. Scope + ceiling + TTL.
 * Nothing about tools, prompts, or models — those stay with the
 * customer's code.
 *
 * Generic over the mesh's schema so `scope` keys are typechecked
 * against the declared entities. Misspelling an entity name or
 * pointing at one without `syncGroupFormat` is a compile-time error,
 * not a runtime one.
 */
export interface JoinOptions<TSchema extends Schema = Schema> {
  /**
   * Who this participant is acting *as*. Omit to use the mesh
   * client's API-key identity. Pass a `session(...)` for chat
   * assistants that act on behalf of a logged-in user. Pass an
   * `AgentRef` (usually obtained from another `MeshParticipant`)
   * for sub-agents attenuating from a parent capability.
   *
   * Plain-English alias for the legacy `onBehalfOf` field — both
   * accepted, `as` wins when both are set.
   */
  readonly as?: Principal;

  /**
   * @deprecated Use `as` — same semantics, clearer name. Will be
   * removed in the next major version.
   */
  readonly onBehalfOf?: Principal;

  /**
   * Narrow to specific entity instances. Always ⊆ the ceiling.
   * Under `delegationPolicy: 'strict'` (default), required when
   * `as` is set.
   *
   * Two accepted shapes:
   *
   * ```ts
   * // Array form — explicit, works with any ModelDef reference.
   * scope: [{ entity: schema.models.matters, ids: 'acme' }]
   *
   * // Object form — terser; keys are the schema's model names.
   * scope: { matters: 'acme' }
   * scope: { matters: ['acme', 'compco'], documents: 'd1' }
   * ```
   */
  readonly scope?: ScopeRef<TSchema>;

  /**
   * Ceiling-clamped; max 7200s by default. Accepts either a number
   * (seconds) or a duration string: `'30s'`, `'3m'`, `'24h'`.
   */
  readonly ttlSeconds?: Duration;

  /** Human-readable label for audit logs. */
  readonly label?: string;

  /**
   * When true (default), the participant's WebSocket is opened
   * automatically and the returned promise resolves only after the
   * connection is live. Pass `false` to defer opening the socket —
   * the caller is then responsible for `participant.connect()`.
   *
   * Matches the OpenAI / Anthropic / Stripe convention: the primary
   * verb returns a ready-to-use object, no second step. Opt out only
   * for the (rare) case of wanting the capability token without the
   * socket — admin tooling that mints for hand-off, for example.
   */
  readonly autoConnect?: boolean;

  /**
   * Idempotency key for retry-safe joins. When set, the server caches
   * the minted capability under this key for 24h; retries with the
   * same key return the identical `capabilityId` / `token` / `expiresAt`
   * without minting a fresh token. Exactly Stripe's `Idempotency-Key`
   * semantics — same key + different body = 409 `AbloIdempotencyError`.
   *
   * When omitted, a fresh UUIDv4 is generated per call so retries that
   * don't thread a key through still mint fresh tokens. Pass `null` to
   * opt out of the header entirely (rare; mints fresh each time).
   */
  readonly idempotencyKey?: string | null;
}

/**
 * A scopable entity — any ModelDef from the schema's model record.
 *
 * In principle we'd narrow this to only ModelDefs whose
 * `syncGroupFormat` is set. In practice, ModelDef's `syncGroupFormat`
 * is an optional string, so TypeScript's conditional narrowing
 * resolves to `never` and the `entity:` field becomes unusable at
 * value positions. We accept the full ModelDef union here and let
 * the runtime guard reject non-scopable ModelDefs with a specific
 * error. Compile-time narrowing to the exact scopable subset is a
 * follow-up that requires making `syncGroupFormat` a type parameter
 * on ModelDef.
 */
export type ScopableModelDef<TSchema extends Schema = Schema> =
  TSchema['models'][keyof TSchema['models']];

/**
 * One entity-id narrowing entry. Customers pass the `ModelDef` itself
 * — not the string name — so TypeScript catches renames and typos,
 * and IDE "find references" flows through the type system.
 *
 * ```ts
 * { entity: schema.models.matters, ids: 'acme' }
 * { entity: schema.models.matters, ids: ['acme', 'compco'] }
 * ```
 */
export interface ScopeEntry<TSchema extends Schema = Schema> {
  readonly entity: ScopableModelDef<TSchema>;
  readonly ids: string | readonly string[];
}

/**
 * Object-form scope — keys are the schema's model names, values are
 * either a single id or an array of ids.
 *
 * ```ts
 * scope: { matters: 'acme' }
 * scope: { matters: ['acme', 'compco'] }
 * scope: { matters: 'acme', teams: 't-1' }
 * ```
 *
 * Terser than the array form for the 90% path. Keys are validated
 * against the schema at compile time — misspelled model names don't
 * compile. Runtime still checks that each named model declares
 * `syncGroupFormat`; non-scopable models throw the same error as
 * the array form.
 */
export type FlatScopeRef<TSchema extends Schema = Schema> = {
  readonly [ModelName in keyof TSchema['models']]?: string | readonly string[];
};

/**
 * An entity-id narrowing. Two forms:
 *
 * ```ts
 * // Array form — explicit ModelDef references, works with any schema
 * // shape (including schemas we don't have compile-time knowledge of).
 * scope: [{ entity: schema.models.matters, ids: 'acme' }]
 *
 * scope: [
 *   { entity: schema.models.matters, ids: ['acme', 'compco'] },
 *   { entity: schema.models.teams,   ids: 't-1' },
 * ]
 *
 * // Object form — keys are the schema's model names. Terser.
 * scope: { matters: 'acme' }
 * scope: { matters: ['acme', 'compco'], teams: 't-1' }
 * ```
 *
 * Composes with the ceiling — never widens. Under `delegationPolicy:
 * 'strict'` (default), required when `as` is set.
 */
export type ScopeRef<TSchema extends Schema = Schema> =
  | ReadonlyArray<ScopeEntry<TSchema>>
  | FlatScopeRef<TSchema>;

/**
 * The wrapper returned by `mesh.join(agent, opts)`. Holds a reference
 * to the customer's original agent unchanged, plus everything Ablo
 * adds: capability token, WebSocket lifecycle, data API, recursive
 * `.join` for sub-agents, context watermarks, optional coordination.
 */
/**
 * Schedule shape for `participant.autoRefresh(...)`. Two modes:
 *
 *   - `beforeExpiry` — rotate when the token has `thresholdSeconds`
 *     or less remaining (default 300 = 5 minutes). Best for daemons
 *     because the interval adapts to the token's actual TTL.
 *
 *   - `interval` — rotate every `intervalSeconds`, regardless of
 *     expiry. Use when the application's rotation policy is
 *     time-based rather than expiry-based (e.g. "rotate every hour
 *     for audit rhythm").
 */
export type AutoRefreshOptions =
  | {
      readonly schedule?: 'beforeExpiry';
      /** Trigger refresh when remaining TTL drops to this many seconds. Default: 300. */
      readonly thresholdSeconds?: number;
    }
  | {
      readonly schedule: 'interval';
      readonly intervalSeconds: number;
    };

export interface MeshParticipant<TAgent extends AgentLike = AgentLike, TSchema extends Schema = Schema> {
  /** The customer's original agent, untouched. */
  readonly agent: TAgent;

  /**
   * Mesh-assigned participant id. Taken from `agent.id` when provided;
   * generated as `agent_<ulid>` when omitted.
   */
  readonly id: string;

  /**
   * Biscuit capability token. Exposed for advanced integration —
   * hand-off to other transports, external verification, cross-scope
   * auth tests. 99% of callers never touch this directly.
   */
  readonly capabilityToken: string;

  /**
   * Server-assigned capability row id (the `cap_` ulid persisted in
   * `capabilities` by the mint handler). Used by admin callers to
   * revoke the participant via `mesh.capabilities.del(id)`. Distinct
   * from `id` (the participant id) and `capabilityToken` (the signed
   * Biscuit chain) — this is the primary key of the denylist row.
   */
  readonly capabilityId: string;

  /** Current principal ceiling. `null` when the API key is the ceiling. */
  readonly onBehalfOf: Principal | null;

  readonly ttlSecondsRemaining: number;

  /** Bring the participant online — opens the WebSocket. */
  connect(): Promise<void>;
  disconnect(): Promise<void>;

  /**
   * Mint a fresh capability token for this participant and swap it
   * onto the live WebSocket. Used by long-running daemons that need
   * to survive past the original token's TTL without gap, without
   * the caller having to spawn a new participant or re-wire their
   * code.
   *
   * Preserves the same `id`, same scope, same `onBehalfOf`. The old
   * token is revoked — the server's denylist makes it fail at next
   * verify. Returns the new `capabilityId` and `capabilityToken`.
   *
   * Under the hood this is a re-mint via `mesh.capabilities.create`
   * followed by a WebSocket reconnect with the new token. The
   * offline queue covers any in-flight writes during the blip; the
   * reconnection catch-up path delivers any missed deltas.
   *
   * Safe to call concurrently with other work — the participant is
   * available again the moment the promise resolves.
   */
  refresh(): Promise<void>;

  /**
   * Run `refresh()` automatically on a schedule. Call once per
   * participant; idempotent (subsequent calls replace the prior
   * schedule). Returns an unsubscribe fn that stops the timer.
   *
   * The default schedule (`beforeExpiry` with 5 min warning) is what
   * 99% of 24/7 daemons want. Pass a custom schedule to override.
   *
   * ```ts
   * // Rotate 5 minutes before the token expires (recommended default)
   * const stop = agent.autoRefresh();
   *
   * // Rotate every hour, regardless of expiry
   * const stop = agent.autoRefresh({ schedule: 'interval', intervalSeconds: 3600 });
   * ```
   *
   * If `refresh()` throws (network blip, scope revoked, server down),
   * the error surfaces via the emitted `refresh_failed` event on the
   * participant's agent. The timer keeps running — the next scheduled
   * tick tries again.
   */
  autoRefresh(opts?: AutoRefreshOptions): () => void;

  /**
   * The latest sync id this participant has observed from the server.
   * Monotonically increasing. Advances via bootstrap on connect, live
   * deltas from other participants, and this participant's own commits.
   *
   * Used for:
   *   • Reconnection correctness — after `connect()` following a drop,
   *     this reflects the server's catch-up replay.
   *   • Context watermarking — `context.capture(...)` uses it
   *     internally, but exposed here for consumers rolling their own
   *     staleness semantics.
   */
  readonly currentSyncId: number;

  /**
   * Subscribe to every delta delivered to this participant — live
   * pushes AND reconnection catch-up. Returns an unsubscribe fn.
   *
   * Deltas shape:
   *   { id, actionType: 'I'|'U'|'D', modelName, modelId, data, ... }
   *
   * For model-scoped reactive queries, prefer the agent's
   * subscription-by-model primitive. This hook is the raw firehose.
   */
  onDelta(handler: (delta: DeltaEnvelope) => void): () => void;

  /**
   * Async-iterable firehose of delta envelopes. Yields each delta as
   * it arrives on the WebSocket — one iteration per mutation.
   *
   * ```ts
   * for await (const delta of participant.deltas) {
   *   if (delta.modelName === 'Clause' && delta.actionType === 'U') {
   *     rerenderClause(delta.modelId);
   *   }
   *   if (userAbortedTheView) break; // subscription drops
   * }
   * ```
   *
   * Each iteration creates an independent subscription. Unlike
   * `onDelta`, this integrates with `for await` / `break` /
   * `Array.from(...)` / `AbortSignal` — every async-iterator
   * primitive JavaScript already knows.
   */
  readonly deltas: AsyncIterable<DeltaEnvelope>;

  // ── Mutations ────────────────────────────────────────────────────
  //
  // Batch-always by standard. Every mutation takes an array and lands
  // as one `CommitMessage` with N operations — Postgres-atomic, one
  // `clientTxId`, one ack. A single-item write is just an array of
  // length one: `create('Slide', [{title}])`.
  //
  // This matches Drizzle/Kysely `.values([...])` and collapses the
  // Prisma-style `create` / `createMany` duplication into one mental
  // model. Options carry cross-cutting concerns (idempotency,
  // watermarks). Wire-level supported for free — the wire was always
  // array.

  create<ModelName extends keyof TSchema['models'] & string>(
    modelName: ModelName,
    data: ReadonlyArray<InferCreate<TSchema, ModelName>>,
    options?: ParticipantMutationOptions,
  ): Promise<ReadonlyArray<InferModel<TSchema, ModelName>>>;

  update<ModelName extends keyof TSchema['models'] & string>(
    modelName: ModelName,
    patches: ReadonlyArray<
      { readonly id: string } & Partial<InferCreate<TSchema, ModelName>>
    >,
    options?: ParticipantMutationOptions,
  ): Promise<void>;

  del<ModelName extends keyof TSchema['models'] & string>(
    modelName: ModelName,
    ids: ReadonlyArray<string>,
    options?: ParticipantMutationOptions,
  ): Promise<void>;

  /** Soft-delete — sets `archivedAt` on every id. Restorable via `unarchive`. */
  archive<ModelName extends keyof TSchema['models'] & string>(
    modelName: ModelName,
    ids: ReadonlyArray<string>,
    options?: ParticipantMutationOptions,
  ): Promise<void>;

  /** Restore previously archived entities. */
  unarchive<ModelName extends keyof TSchema['models'] & string>(
    modelName: ModelName,
    ids: ReadonlyArray<string>,
    options?: ParticipantMutationOptions,
  ): Promise<void>;

  /**
   * Recursive join. The child's capability is attenuated from this
   * participant's token — child ≤ parent, guaranteed by the Biscuit
   * chain. Revocation of the parent cascades to all descendants at
   * next verify.
   */
  join<TChildAgent extends AgentLike>(
    childAgent: TChildAgent,
    opts: Omit<JoinOptions<TSchema>, 'onBehalfOf'>,
  ): Promise<MeshParticipant<TChildAgent, TSchema>>;

  /**
   * Context watermarking — core, not advanced. Snapshot the state
   * the agent is about to reason against; pass `{ readAt: watermark }`
   * on every write that depends on that snapshot; the server rejects
   * (or flags, or merges) writes whose context has drifted.
   *
   * Prefer the flat `participant.snapshot({ clauses: [id] })` form;
   * `context.capture(...)` is kept as a legacy alias.
   */
  readonly context: ContextAPI;

  /**
   * Snapshot the state of one or more entities and get back a frozen
   * view plus the concurrency primitives you need to write honestly
   * against it.
   *
   * ```ts
   * const snap = await participant.snapshot({ clauses: [clauseId] });
   * snap.clauses[clauseId]   // the entity
   * snap.signal              // AbortSignal — fires if any captured entity moves
   * snap.stamp               // opaque marker — pass as `readAt` on writes
   * ```
   *
   * Keys mirror the flat scope form: `{ <modelName>: id | ids }`.
   * Reserved names (`stamp`, `signal`, `onChange`) on the returned
   * snapshot are preserved for the concurrency surface — a schema
   * model with one of those names throws a clear error at snapshot
   * time.
   */
  snapshot<ModelName extends keyof TSchema['models'] & string>(
    entities: { readonly [M in ModelName]: string | readonly string[] },
  ): Promise<Snapshot<TSchema, ModelName>>;

  // ── Coordination primitives (always on; this is the product) ────
  //
  // Multi-agent collaboration on a shared entity is the whole point
  // of joining. Every participant livestreams its activity + sees
  // every other participant's activity in real time. These are not
  // opt-in.
  readonly presence: PresenceStream;
  readonly intents: IntentStream;
}

// ─────────────────────────────────────────────────────────────────────
//  Context watermarking (on every participant)
// ─────────────────────────────────────────────────────────────────────

export interface ContextAPI {
  capture(params: ContextCaptureParams): Promise<CapturedContext>;
}

/**
 * Flat snapshot view returned from `participant.snapshot(...)`.
 *
 *   - Per-model buckets: `snap.<modelName>[id] → entity` — typed from
 *     the schema via `InferModel`, NOT `unknown`. So
 *     `snap.clauses[clauseId].text` has `string` (or whatever Zod
 *     inferred from the model's shape).
 *   - `stamp` — opaque version marker; thread into writes as
 *     `{ readAt: snap.stamp }` so the server can reject stale writes.
 *   - `signal` — AbortSignal that fires if any captured entity
 *     receives a delta during the window. Pass into the LLM call so
 *     mid-generation invalidations abort the token stream instead of
 *     completing against a dead snapshot.
 *   - `onChange(fn)` — callback form for non-abort use cases (logging,
 *     UI flags, partial regeneration). Returns an unsubscribe.
 *
 * The per-model buckets collide with the three concurrency fields if
 * you name a model `stamp` / `signal` / `onChange`. We throw at
 * snapshot time with a clear error so the mistake is loud.
 */
export type Snapshot<
  TSchema extends Schema = Schema,
  ModelName extends keyof TSchema['models'] = keyof TSchema['models'],
> = {
  readonly stamp: string;
  readonly signal: AbortSignal;
  onChange(listener: (change: ContextChange) => void): () => void;
} & {
  readonly [M in ModelName]: Readonly<Record<string, InferModel<TSchema, M>>>;
};

/**
 * @deprecated Use `participant.snapshot({ ... })` — that API is typed
 * against the schema. This legacy shape keeps per-entity fields as
 * `JsonValue` for back-compat with callers that still reach into
 * `context.capture(...)` directly.
 */
export interface ContextCaptureParams {
  readonly entities: ReadonlyArray<{
    readonly type: string; // schema entity name
    readonly ids?: readonly string[];
    readonly where?: Readonly<Record<string, JsonValue>>;
  }>;
}

/**
 * @deprecated Use `participant.snapshot({ ... })`. This legacy shape
 * holds untyped entity payloads; the new `Snapshot<TSchema, ModelName>`
 * type infers the entity fields from the schema.
 */
export interface CapturedContext {
  readonly data: Readonly<Record<string, Readonly<Record<string, JsonValue>>>>;
  /** Sync-engine watermark at capture time. Pass as `readAt` on writes. */
  readonly watermark: string;
  onChange(listener: (change: ContextChange) => void): () => void;
}

export interface ContextChange {
  readonly model: string;
  readonly id: string;
  readonly severity: 'semantic' | 'metadata';
}

/**
 * Mutation-time staleness mode. Passed on every write that follows a
 * `context.capture(...)`. Defaults to `'reject'` when `readAt` is
 * provided without `onStale`.
 */
export type OnStaleMode =
  | 'reject' // throw AbloStaleContextError; caller regenerates
  | 'flag' // apply, emit a `stale` event (caller decides)
  | 'merge' // apply iff field-level disjoint; reject if overlap
  | 'force'; // apply unconditionally (cosmetic cleanup bots only)

// ─────────────────────────────────────────────────────────────────────
//  Coordination primitives — livestream, not polling
// ─────────────────────────────────────────────────────────────────────
//
// Every participant holds a live WebSocket to the sync-server. State
// is pushed continuously in both directions:
//
//   • Each participant broadcasts its current activity on every change
//     (started reading slide 5, mid-generation, writing this field).
//     The broadcast is synchronous from the caller's perspective —
//     `presence.update(...)` returns immediately; the sync-engine
//     ships the frame on the open connection.
//
//   • Each participant continuously receives the activity stream of
//     every other participant on its sync groups. That stream is
//     exposed as a reactive observable (`presence.others`) — no
//     `await` needed, no polling, no `list()` calls. The state is
//     always up-to-date because the connection is always open.
//
// This is what makes multi-agent work on a shared doc different from
// git-worktree orchestration. Three agents editing one deck don't
// "check in" periodically to see what the others did; they watch
// each other work in real time and coordinate continuously.

/**
 * A pointer to one entity the participant is acting on. Either a
 * typed `EntityRef` (`{ type, id }`), or a tuple `['Clause', 'cl_3']`
 * for ergonomic inline use. The verb methods below accept both.
 */
export type PresenceTarget = EntityRef | readonly [type: string, id: string];

/**
 * Reactive livestream of what every participant in the mesh is doing.
 * Every `MeshParticipant` gets one; it's always on, always current.
 */
export interface PresenceStream {
  /**
   * This participant's own broadcast state. Mirrors what every other
   * participant sees for this one. Read-only from the owner's side —
   * mutate via `update(...)` below.
   */
  readonly self: PresenceEntry;

  /**
   * Push a new activity to the livestream. Synchronous — the sync
   * engine ships the frame on the already-open WebSocket; there's
   * no request-response round-trip to wait on. Callers update as
   * often as state meaningfully changes (on read, on generate-start,
   * on partial-output, on write, on done).
   *
   * Prefer the verb methods below (`editing`, `viewing`, ...) for
   * canonical actions — they read as one-line sentences and don't
   * force the caller to remember the action-string vocabulary.
   */
  update(activity: Activity): void;

  // ── Verb shortcuts — one call, one sentence ──────────────────────
  //
  // Pure conveniences over `update({ entityType, entityId, action })`.
  // Same wire protocol, zero server change. Deliberately small set:
  // three concrete actions a peer can observe + act on. Anything
  // more abstract (analyzing, thinking, planning) goes through
  // `update({ action: 'custom-string' })` — those belong in app
  // vocabulary, not the SDK surface.

  /** Participant is actively modifying this entity. */
  editing(target: PresenceTarget, detail?: string): void;
  /** Participant is reading this entity; no modifications. */
  viewing(target: PresenceTarget, detail?: string): void;
  /** Participant has stepped away from any specific entity. */
  idle(): void;

  /**
   * Reactive view of every OTHER participant's current activity on
   * this participant's sync groups. Reads return the current snapshot;
   * pair with `subscribe(listener)` below to get notified on changes.
   *
   * An LLM pipeline can include `presence.others` in its system prompt
   * so the model literally reasons with knowledge of what other
   * agents are doing right now: "copy-bot is generating a new title
   * for slide 5; don't duplicate that work."
   */
  readonly others: ReadonlyArray<PresenceEntry>;

  /** Subset of `others` filtered to a specific sync group. */
  othersIn(syncGroup: string): ReadonlyArray<PresenceEntry>;

  /**
   * Framework-agnostic reactivity primitive. Register a callback that
   * fires every time `others` / `othersIn(...)` content changes (a
   * peer joined, left, or updated its activity). Returns an
   * unsubscribe fn.
   *
   * React binding:
   * ```ts
   * const others = useSyncExternalStore(
   *   presence.subscribe,
   *   () => presence.others,
   * );
   * ```
   *
   * MobX binding:
   * ```ts
   * autorun(() => {
   *   // Triggered on every presence change because the observable
   *   // version counter inside presence is read here.
   *   const peers = presence.others;
   *   // ...
   * });
   * ```
   */
  subscribe(listener: () => void): () => void;

  /**
   * Async-iterable view of the peer roster. Each iteration yields the
   * current `others` snapshot on every mutation — so the consumer
   * sees the world as it changes without registering a callback.
   *
   * ```ts
   * for await (const peers of participant.presence) {
   *   renderAvatars(peers);
   *   if (peers.length === 0) break; // iteration stops, subscription drops
   * }
   * ```
   *
   * Each `for await` creates an independent iterator — two loops on
   * the same stream both see every update; they don't steal values
   * from each other. Breaking out of the loop (or throwing) tears
   * down the underlying subscription cleanly via the iterator's
   * `return()` hook.
   */
  [Symbol.asyncIterator](): AsyncIterableIterator<ReadonlyArray<PresenceEntry>>;
}

/**
 * What a participant is currently doing. Mirrors the server's existing
 * `AgentActivity` shape so the wire protocol is unchanged — the mesh
 * broadcasts presence on the same WebSocket frame format
 * (`presence_update`) the sync-server has always accepted.
 *
 * Every activity is about a single entity-in-focus. Agents that reason
 * over multiple entities call `presence.update(...)` whenever focus
 * shifts; other participants see the transition in real time.
 */
export interface Activity {
  /** Entity type the participant is focused on (e.g. "Slide", "Document"). */
  readonly entityType: string;
  /** Specific entity id. */
  readonly entityId: string;
  /**
   * What the participant is doing to that entity. Canonical values:
   * `'editing'` / `'reviewing'` / `'generating'` / `'analyzing'` /
   * `'executing'`. Free-form strings are accepted for app-specific
   * phases.
   */
  readonly action: string;
  /** Human-readable detail — "slide 3", "cell A1:B5", etc. */
  readonly detail?: string;
}

/** A reference to a specific entity instance — used in intent claims. */
export interface EntityRef {
  readonly type: string;
  readonly id: string;
}

/**
 * One participant's live state as seen by the rest of the mesh.
 */
export interface PresenceEntry {
  readonly participantKind: 'human' | 'agent';
  readonly participantId: string;
  readonly label?: string;
  readonly syncGroups: readonly string[];
  readonly activity: Activity;
  /** Server timestamp of the most recent frame from this participant. */
  readonly lastActive: string;
}

/**
 * Intent broadcasts — "I'm about to do X on Y." Broadcasts flow on
 * the same WS as presence, so every participant sees them in real
 * time. Cooperative mutex: the intent doesn't enforce exclusion; it
 * announces. Other agents observe and yield. This is cheaper and
 * more flexible than a central lock table and composes with presence.
 */
/**
 * Options common to every verb-style intent announcement
 * (`intents.analyzing`, `.drafting`, etc.).
 *
 * The one required field is the *target* — everything else is a
 * sensible default. Prefer the verb methods in `IntentStream` below
 * (`analyzing(entity, { ttl: '3m' })`) over the raw `announce(...)`
 * escape hatch.
 */
export interface IntentOptions {
  /**
   * How long before the server auto-expires this intent if the
   * participant doesn't finish the work. Accepts either a number (in
   * seconds — back-compat with `ttlSeconds`) or a duration string:
   * `'500ms'`, `'30s'`, `'3m'`, `'24h'`.
   */
  readonly ttl?: Duration;
}

/** Re-export of the duration helper shape. See `./duration.ts`. */
export type Duration = import('./duration').Duration;

export interface IntentStream {
  /**
   * Announce that this participant is about to do something. Returns
   * a handle — call `.revoke()` to cancel, let it expire via TTL, or
   * use `await using` (TC39 explicit resource management) to
   * auto-revoke on scope exit.
   *
   * The announcement ships on the open WS immediately. Prefer the
   * verb methods below for canonical actions; they take positional
   * arguments and read like English.
   */
  announce(intent: IntentDeclaration): IntentHandle;

  // ── Verb shortcuts — concrete actions that could conflict ───────
  //
  // Intents exist to prevent write conflicts. Only verbs that describe
  // an about-to-happen write belong here; read-only mental states
  // ("analyzing", "thinking") are meaningless as intents because they
  // can't conflict with anyone. Two verbs, symmetric with presence:
  //
  //   intents.editing(x)  — about to modify; peers should yield
  //   intents.writing(x)  — about to produce/replace content
  //
  // Anything else → `announce({ target, reason: 'your-verb', ttl })`.

  /** Claim the right to edit this entity — peers observing should yield. */
  editing(target: PresenceTarget, opts?: IntentOptions): IntentHandle;
  /** Claim that you're about to write / produce content for this entity. */
  writing(target: PresenceTarget, opts?: IntentOptions): IntentHandle;

  /**
   * Reactive view of every other participant's active intents.
   * Reads return the current snapshot; pair with `subscribe(...)`
   * below to get notified on change.
   */
  readonly others: ReadonlyArray<ActiveIntent>;

  /**
   * Framework-agnostic reactivity. Same contract as
   * `PresenceStream.subscribe` — register a listener fired on every
   * change (announce / revoke / TTL expiry received from the server),
   * returns an unsubscribe fn. Use `useSyncExternalStore` in React or
   * `autorun` in MobX.
   */
  subscribe(listener: () => void): () => void;

  /**
   * Observe server-side intent rejections. Fires when the server
   * rejects an `intents.writing(...)` / `announce(...)` call because
   * another participant already holds an open claim on the same
   * target (cooperative mutex → enforced at the server boundary).
   *
   * Use this to surface conflicts to the user:
   * ```ts
   * participant.intents.onRejected((r) => {
   *   toast.error(`${r.heldBy} is editing — try again in a moment`);
   * });
   * ```
   *
   * Returns an unsubscribe fn.
   */
  onRejected(listener: (rejection: IntentRejection) => void): () => void;

  /**
   * Async-iterable view of everyone else's open intents. Each
   * iteration yields the current snapshot on every mutation.
   *
   * ```ts
   * for await (const openIntents of participant.intents) {
   *   if (openIntents.some((i) => i.target.id === clauseId)) wait();
   * }
   * ```
   */
  [Symbol.asyncIterator](): AsyncIterableIterator<ReadonlyArray<ActiveIntent>>;
}

/**
 * Shape of an `intent_rejected` event delivered to
 * `IntentStream.onRejected`. Server rejects an incoming claim when
 * another participant already holds an open intent on the same target.
 */
export interface IntentRejection {
  /** The rejected claim's id (the one the caller just tried to mint). */
  readonly intentId: string;
  /** Why the server rejected it — currently always `'conflict'`. */
  readonly reason: 'conflict';
  /** The target that's already held. */
  readonly target: { readonly entityType: string; readonly entityId: string };
  /** Participant id holding the existing claim. */
  readonly heldBy: string;
  /** The existing claim's id (for audit / retry correlation). */
  readonly heldByIntentId: string;
  /** When the existing claim expires (ms since epoch). */
  readonly heldByExpiresAt: number;
}

export interface IntentDeclaration {
  readonly target: EntityRef;
  /** Human-readable reason — "rewriting title" / "restyling chart". */
  readonly reason: string;
  /**
   * Expiry — auto-revoke if the participant doesn't finish in time.
   * Number = seconds (back-compat); string = duration (`'3m'`).
   */
  readonly ttlSeconds?: Duration;
}

/**
 * Handle returned from `announce(...)` / `analyzing(...)` / etc.
 *
 * Implements `Symbol.asyncDispose` so callers can write:
 *
 * ```ts
 * {
 *   await using work = participant.intents.analyzing(clause, { ttl: '3m' });
 *   // ... do the work; intent auto-revokes when the block exits
 * }
 * ```
 */
export interface IntentHandle extends AsyncDisposable {
  readonly id: string;
  revoke(): void;
}

export interface ActiveIntent extends IntentDeclaration {
  readonly id: string;
  readonly heldBy: string;
  /**
   * Whether the holding participant is a human (session) or an agent.
   * First-class field so UIs can style "agent editing X" differently
   * from "user editing X" without string-parsing `heldBy`.
   */
  readonly participantKind: 'human' | 'agent';
  readonly announcedAt: string;
  readonly expiresAt: string;
}

// ─────────────────────────────────────────────────────────────────────
//  Admin-only resources — tenant UIs, compliance flows
// ─────────────────────────────────────────────────────────────────────
//
// The 80% developer path never touches these. A tenant admin UI
// (create roles, assign memberships, export audit) hits them.
// Structurally identical to the rest of the SDK: same five verbs per
// resource.

// ── mesh.roles ───────────────────────────────────────────────────────

export interface Role {
  readonly id: string;
  readonly name: string;
  readonly organizationId: string | null;
  readonly read: readonly string[] | '*'; // entity names
  readonly write: readonly string[] | '*';
  readonly origin: 'code' | 'tenant';
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface RoleCreateParams {
  readonly name: string;
  readonly organizationId?: string;
  readonly read?: readonly string[] | '*';
  readonly write?: readonly string[] | '*';
}

export type RolesResource = Resource<Role, RoleCreateParams>;

// ── mesh.members ─────────────────────────────────────────────────────

export interface Member {
  readonly id: string;
  readonly userId: string;
  readonly organizationId: string;
  readonly roleId: string;
  readonly scope?: ScopeRef;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface MemberCreateParams {
  readonly userId: string;
  readonly organizationId: string;
  readonly roleId: string;
  readonly scope?: ScopeRef;
}

export interface MemberListFilters {
  readonly userId?: string;
  readonly organizationId?: string;
  readonly roleId?: string;
  readonly limit?: number;
  readonly cursor?: string;
}

export type MembersResource = Resource<
  Member,
  MemberCreateParams,
  Partial<MemberCreateParams>,
  MemberListFilters
>;

// ── mesh.audit ───────────────────────────────────────────────────────

/**
 * Every `mesh.join`, every `capabilities.create`, every mutation
 * that carries a watermark writes a row here. Compliance-first
 * deployments will use this for the "who did what, under whose
 * authority, against which world" audit export.
 */
export interface AuditEntry {
  readonly id: string;
  readonly at: string;
  readonly actor: {
    readonly kind: 'user' | 'agent' | 'apiKey';
    readonly id: string;
  };
  readonly onBehalfOf: Principal | null;
  readonly action:
    | 'join'
    | 'disconnect'
    | 'capabilities.create'
    | 'capabilities.del'
    | 'members.create'
    | 'members.update'
    | 'members.del'
    | 'roles.create'
    | 'roles.update'
    | 'roles.del'
    | 'mutation';
  readonly targetResource?: string;
  readonly targetId?: string;
  readonly readAt?: string;
  readonly scope?: ScopeRef;
  readonly metadata?: Readonly<Record<string, JsonValue>>;
}

export interface AuditListFilters {
  readonly actorId?: string;
  readonly onBehalfOfId?: string;
  readonly action?: AuditEntry['action'];
  readonly since?: string;
  readonly until?: string;
  readonly limit?: number;
  readonly cursor?: string;
}

/** Read-only — the log is append-only by design. */
export interface AuditResource {
  retrieve(id: string): Promise<AuditEntry>;
  list(filters?: AuditListFilters): Promise<Page<AuditEntry>>;
}

// ── mesh.capabilities ────────────────────────────────────────────────

/**
 * Power-user surface. Mint / retrieve / revoke capability tokens
 * directly for integrating with external identity systems or
 * orchestrators that sit above `mesh.join`. Rarely touched.
 */
export interface Capability {
  readonly id: string;
  readonly token: string;
  readonly parentId: string | null;
  readonly allowedSyncGroups: readonly string[];
  readonly allowedOperations: readonly string[] | null;
  readonly expiresAt: string;
  readonly revokedAt: string | null;
}

export interface CapabilityCreateParams {
  readonly onBehalfOf?: Principal;
  readonly allowedSyncGroups: readonly string[];
  readonly allowedOperations?: readonly string[];
  readonly ttlSeconds?: number;
}

export type CapabilitiesResource = Resource<Capability, CapabilityCreateParams>;

// ─────────────────────────────────────────────────────────────────────
//  Model-scoped join shortcuts — `ablo.<model>.join(id, opts)`
// ─────────────────────────────────────────────────────────────────────

/**
 * Options for model-scoped join shortcuts. Extends `JoinOptions` with
 * `scope` removed (the model name + id provide it) and adds an `agent`
 * escape hatch for callers who want to hold their own agent object by
 * reference. When neither `agent` nor `label` is provided, the SDK
 * mints a synthetic agent with a UUID id.
 */
export interface ScopedJoinOptions<TSchema extends Schema = Schema>
  extends Omit<JoinOptions<TSchema>, 'scope'> {
  /**
   * Optional agent object to hold by reference. Typically you pass
   * `label` instead and let the SDK mint a synthetic agent.
   */
  readonly agent?: AgentLike;
}

/**
 * Joiner for one model name — returned from `ablo.<model>`.
 * `id` accepts a single string or an array; the scope is the set
 * `{ <model>: id | ids }`.
 */
export interface ScopedJoiner<TSchema extends Schema = Schema> {
  join<TAgent extends AgentLike = AgentLike>(
    id: string | readonly string[],
    opts?: ScopedJoinOptions<TSchema>,
  ): Promise<MeshParticipant<TAgent, TSchema>>;
}

/**
 * Reserved property names on `AbloClient` — only built-in fields,
 * not admin resources (those live under `ablo.admin.*`). A schema
 * model with one of these names would shadow the built-in surface,
 * so we exclude them from the scoped-joiner map at the type level.
 */
export type ReservedClientKey =
  | 'schema'
  | 'join'
  | 'describeJoin'
  | 'admin';

/**
 * Map of `model name → ScopedJoiner` typed from the schema, with
 * the tiny set of built-in keys (`schema` / `join` / `describeJoin`
 * / `admin`) excluded. Everything else on the client is a
 * customer-schema joiner.
 */
export type ScopedJoiners<TSchema extends Schema = Schema> = {
  readonly [ModelName in Exclude<keyof TSchema['models'], ReservedClientKey>]: ScopedJoiner<TSchema>;
};

// ─────────────────────────────────────────────────────────────────────
//  The mesh client — what `createMesh(...)` returns
// ─────────────────────────────────────────────────────────────────────

/**
 * Admin + server-mint resources. Lives under `ablo.admin.*` so
 * customer schema models (which could legitimately include `roles`,
 * `members`, `capabilities`, `audit` — all common domain words) own
 * the top-level namespace without collision.
 *
 *   ablo.admin.capabilities.create({ ... })   — server-side token mint (Stripe clientSecret shape)
 *   ablo.admin.capabilities.del(id)           — revoke
 *   ablo.admin.roles / .members / .audit      — tenant-admin surface
 */
export interface AdminResources {
  readonly capabilities: CapabilitiesResource;
  readonly roles: RolesResource;
  readonly members: MembersResource;
  readonly audit: AuditResource;
}

/**
 * Top-level SDK surface. `join` is the generic front page; the
 * model-scoped joiners (`ablo.matters.join(id)`) live at the same
 * level keyed by schema model names. Admin + server-mint resources
 * are namespaced under `ablo.admin.*` so customer model names never
 * collide with admin field names.
 *
 * The interface merges `AbloClientBase` with `ScopedJoiners<TSchema>`
 * so each schema model gets its own typed joiner directly on the
 * client — matching Stripe's `stripe.customers.create(...)` pattern.
 */
export interface AbloClientBase<TSchema extends Schema = Schema> {
  readonly schema: TSchema;

  /**
   * Make any agent-like object a participant in the sync mesh. Mints
   * a capability token, subscribes to the scope's sync groups,
   * returns a wrapper that preserves the customer's original agent
   * untouched while exposing Ablo's additions (data API, sub-agent
   * spawn, watermarks, optional coordination).
   *
   * Prefer the model-scoped shortcut `ablo.<model>.join(id, opts)`
   * for single-entity joins — this generic form exists for
   * multi-entity scopes and for callers holding their own agent
   * object.
   */
  join<TAgent extends AgentLike>(
    agent: TAgent,
    opts: JoinOptions<TSchema>,
  ): Promise<MeshParticipant<TAgent, TSchema>>;

  /**
   * Pure dry-run — derive the capability request `join` would mint,
   * without making a network call. Used by tests, by customers doing
   * local Biscuit minting, and by admin UIs previewing what an agent
   * would be allowed to do.
   */
  describeJoin(agent: AgentLike, opts: JoinOptions<TSchema>): JoinDescription;

  /**
   * Admin + server-mint resources. Namespaced so customer schema
   * model names can never collide with `capabilities` / `roles` /
   * `members` / `audit`.
   */
  readonly admin: AdminResources;
}

export type AbloClient<TSchema extends Schema = Schema> =
  AbloClientBase<TSchema> & ScopedJoiners<TSchema>;

/**
 * @deprecated Use `AbloClient`. Retained as a type alias so existing
 * imports continue compiling; will be removed in a future major.
 */
export type MeshClient<TSchema extends Schema = Schema> = AbloClient<TSchema>;

/**
 * @deprecated Use `AbloClientBase`. Retained as a type alias.
 */
export type MeshClientBase<TSchema extends Schema = Schema> = AbloClientBase<TSchema>;

/**
 * The derived shape of a capability request — what `describeJoin`
 * returns and what `join` sends to the server.
 */
export interface JoinDescription {
  readonly participantKind: 'agent';
  readonly participantId: string;
  readonly allowedSyncGroups: readonly string[];
  readonly ttlSeconds: number;
  readonly label?: string;
}

/**
 * Options passed to `createMesh`.
 *
 * Only `schema` is required. Every other field is auto-resolved from
 * the environment at call time — matching the OpenAI / Anthropic SDK
 * convention where `new OpenAI()` with no args reads `OPENAI_API_KEY`,
 * `OPENAI_BASE_URL`, etc. Explicit values always win over env.
 *
 * Env vars read:
 *   - `ABLO_API_KEY`   → `apiKey` (optional; browser sessions omit)
 *   - `ABLO_BASE_URL`  → `baseURL` (optional; defaults to
 *                        `https://mesh.ablo.finance`)
 *
 * Notably absent: `organizationId`. The API key (or session cookie)
 * already binds the caller to exactly one org server-side, and the
 * capability mint endpoint echoes `organizationId` back into the SDK —
 * customers never have to know it. Cross-org callers (admin tooling)
 * can still pin a target org via the optional `organizationId` option.
 *
 * The `delegationPolicy` flag is the one knob compliance-first
 * deployments should set deliberately; every other field is
 * boilerplate.
 */
export interface CreateMeshOptions<TSchema extends Schema> {
  readonly schema: TSchema;
  /**
   * The hosted mesh URL. Defaults to the Ablo production mesh
   * (`https://mesh.ablo.finance`) or the value of `ABLO_BASE_URL`
   * if set. Only override for staging / local-dev during Ablo's own
   * testing. The managed service is the only supported deployment
   * today — self-hosting is not offered.
   */
  readonly baseURL?: string;
  /**
   * Optional. Pin the mesh client to a specific organization UUID.
   * Almost always omitted — the API key (or session) already
   * determines the org server-side, and the SDK learns the org from
   * the capability mint response. Set this only in admin/cross-org
   * tooling where a single caller spans multiple tenants.
   */
  readonly organizationId?: string;
  /**
   * Server-side API key (`sk_live_*` / `sk_test_*`). Falls back to
   * `process.env.ABLO_API_KEY`. Browser integrations omit this and
   * use `capabilityToken` instead.
   */
  readonly apiKey?: string;

  /**
   * Pre-minted Biscuit capability token. Use this for the Stripe-style
   * browser flow:
   *
   *   1. Server-side — e.g. a Next.js route — mints a scoped token
   *      from an authenticated request:
   *      ```ts
   *      const ablo = new Ablo({ schema }); // reads ABLO_API_KEY
   *      const cap = await ablo.admin.capabilities.create({
   *        allowedSyncGroups: ['matter:techco'],
   *        ttlSeconds: '1h',
   *      });
   *      return Response.json({ token: cap.token });
   *      ```
   *   2. Browser — receives the token and constructs a client with it:
   *      ```ts
   *      const ablo = new Ablo({ schema, capabilityToken: token });
   *      const participant = await ablo.matters.join('techco');
   *      // no mint round-trip, no session cookie, no allowed-origins
   *      ```
   *
   * Matches Stripe's `clientSecret` pattern: the server scopes the
   * capability at mint time, the browser holds exactly that scoped
   * credential for the duration of the session. Revocation is
   * sub-second via `ablo.admin.capabilities.del(capId)` on the server.
   *
   * When set, `join(...)` skips the capability mint POST entirely and
   * uses this token to open the WebSocket. `apiKey` / session cookies
   * are ignored.
   */
  readonly capabilityToken?: string;

  /**
   * Optional callback used by `participant.refresh()` /
   * `participant.autoRefresh()` when `capabilityToken` is in use.
   * The SDK calls it to fetch a fresh token from YOUR server when
   * rotation is due. Return the new token string.
   *
   * ```ts
   * new Ablo({
   *   schema,
   *   capabilityToken: initialToken,
   *   onTokenRefresh: async () => {
   *     const res = await fetch('/api/ablo/token', { credentials: 'include' });
   *     const { token } = await res.json();
   *     return token;
   *   },
   * });
   * ```
   *
   * Without this callback, `refresh()` throws on capability-token
   * clients — there's no way for the SDK to re-mint without the
   * server-side API key.
   */
  readonly onTokenRefresh?: () => Promise<string>;

  readonly fetch?: typeof fetch;

  /**
   * How `mesh.join` treats missing `scope` when an `onBehalfOf`
   * principal is provided.
   *
   *   - `'strict'` (default) — scope is required when a principal is
   *     set. Inheriting the full ceiling is an explicit act. Right
   *     default for IB / M&A / regulated tenants.
   *   - `'permissive'` — omitting scope silently inherits the
   *     principal's full ceiling. The inheritance still lands in
   *     `mesh.audit` as an `'inherited'` row.
   */
  readonly delegationPolicy?: 'strict' | 'permissive';
}
