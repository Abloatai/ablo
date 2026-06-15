/**
 * Multiplayer stream types.
 *
 * Ablo treats humans and agents as participants on live application
 * entities. Participants announce what they are reading or editing,
 * claim before writing, and capture context watermarks before
 * long-running AI work. The customer keeps their own schema, agent
 * stack, tools, prompts, and product policy; the sync engine provides
 * the shared coordination substrate.
 */

import type { ModelDef } from '../schema/model.js';
import type { InferCreate, InferModel, Schema } from '../schema/schema.js';

// Coordination wire shapes have ONE canonical home — `../coordination/schema`.
// These are imported (so the rest of this file can reference them) and
// re-exported (so existing SDK consumers keep their `from '.../streams'`
// import paths). See that module for the three-layer model.
import type {
  TargetRange,
  OnStaleMode,
  WireClaim,
  ClaimRejection,
  PresenceKind,
  ParticipantKind,
} from '../coordination/schema.js';
export type { TargetRange, OnStaleMode, WireClaim, ClaimRejection, PresenceKind, ParticipantKind };

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

/**
 * Identity reference for an actor / on-behalf-of slot. Generic
 * protocol vocabulary; works for sessions, agents, and system roles.
 */
export interface ParticipantRef {
  kind: 'user' | 'agent' | 'system';
  id: string;
}

/**
 * Whether the human explicitly approved a change. Open-source
 * consumers that don't track approval keep `auto` as the default.
 */
export type ConfirmationState =
  | 'auto'
  | 'previewed'
  | 'approved'
  | 'required_human_approval'
  | 'auto_historical';

/**
 * Wire-shape of a single sync delta. Carries the dual-attribution
 * fields (`actor`, `onBehalfOf`, `capabilityId`, `confirmationState`,
 * `causedByTaskId`) that the audit substrate stamps onto each row.
 */
export interface AgentDelta {
  id: number;
  actionType: 'I' | 'U' | 'D' | 'A';
  modelName: string;
  modelId: string;
  data: Record<string, unknown>;
  previousData?: Record<string, unknown>;
  /** Who DID the action. */
  actor?: ParticipantRef | null;
  /** On WHOSE AUTHORITY the actor acted. */
  onBehalfOf?: ParticipantRef | null;
  /** Capability that authorized this commit. */
  capabilityId?: string | null;
  /** Whether the human explicitly approved the change. */
  confirmationState?: ConfirmationState | null;
  /** Agent-task id that caused this commit, if any. Dormant on new client
   *  writes (turns/tasks removed); may hold historical values. */
  causedByTaskId?: string | null;
  createdAt: string;
}

// ─────────────────────────────────────────────────────────────────────
//  Principals — who sets the ceiling
// ─────────────────────────────────────────────────────────────────────

/**
 * A reference to whoever's authority bounds a joined participant.
 * The spawned participant can never see or do more than this principal.
 * Enforced server-side: the spawned agent gets its own restricted
 * (`rk_`) key whose scope is a subset of the parent's.
 *
 *   • `SessionRef`     — human is joining an agent (chat assistant flow)
 *   • `AgentRef`       — agent spawning a sub-agent (attenuation chain)
 *   • omitted          — the API key on the Ablo client is the ceiling
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
//  Snapshots — context watermarks for long-running work
// ─────────────────────────────────────────────────────────────────────

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
  readonly stamp: number;
  readonly signal: AbortSignal;
  onChange(listener: (change: ContextChange) => void): () => void;
} & {
  readonly [M in ModelName]: Readonly<Record<string, InferModel<TSchema, M>>>;
};

export interface ContextChange {
  readonly model: string;
  readonly id: string;
  readonly severity: 'semantic' | 'metadata';
}

/**
 * Mutation-time staleness mode. Passed on every write that follows a
 * snapshot. Defaults to `'reject'` when `readAt` is provided without
 * `onStale`.
 */
// `OnStaleMode` is canonical in `../coordination/schema` (re-exported above).

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

// `TargetRange` is canonical in `../coordination/schema` (re-exported above).

/**
 * A pointer to one entity, optionally narrowed to a structured
 * subtarget. `type` and `id` are customer schema vocabulary; `path`,
 * `range`, `field`, and `meta` are generic coordination hints for
 * products like code editors, document editors, and design tools.
 */
export interface EntityRef {
  readonly type: string;
  readonly id: string;
  readonly path?: string;
  readonly range?: TargetRange;
  readonly field?: string;
  readonly meta?: Record<string, unknown>;
}

/**
 * A pointer to one entity the participant is acting on. Either a
 * typed `EntityRef` (`{ type, id, ... }`), or a tuple
 * `['Clause', 'cl_3']` for ergonomic inline use. The verb methods
 * below accept both.
 */
export type PresenceTarget = EntityRef | readonly [type: string, id: string];

/**
 * Reactive livestream of what every multiplayer participant is doing.
 * Every participant gets one; it's always on, always current.
 */
export interface PresenceStream {
  /**
   * This participant's own broadcast state. Mirrors what every other
   * participant sees for this one. Read-only from the owner's side —
   * mutate via `update(...)` below.
   */
  readonly self: Peer;

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
  reading(target: PresenceTarget, detail?: string): void;
  /** Participant is reading this entity; no modifications. */
  viewing(target: PresenceTarget, detail?: string): void;
  /** Participant has stepped away from any specific entity. */
  idle(): void;

  /**
   * Reactive view of every OTHER participant's current activity on
   * this participant's sync groups. Reads return the current snapshot;
   * pair with `onChange(listener)` below to get notified on changes.
   *
   * An LLM pipeline can include `presence.others` in its system prompt
   * so the model literally reasons with knowledge of what other
   * agents are doing right now: "copy-bot is generating a new title
   * for slide 5; don't duplicate that work."
   */
  readonly others: ReadonlyArray<Peer>;

  /** Subset of `others` filtered to a specific sync group. */
  othersIn(syncGroup: string): ReadonlyArray<Peer>;

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
  onChange(listener: () => void): () => void;

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
  [Symbol.asyncIterator](): AsyncIterableIterator<ReadonlyArray<Peer>>;
}

/**
 * What a participant is currently doing. This is BOTH the SDK and the
 * wire shape — Ablo broadcasts presence on the same WebSocket frame
 * format (`presence_update`) the sync-server has always accepted, so
 * the canonical activity type and the wire activity field are one and
 * the same.
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
  /** Optional path for file/document-like targets. */
  readonly path?: string;
  /** Optional line/column range for partial-entity coordination. */
  readonly range?: TargetRange;
  /** Optional field/property path for field-level coordination. */
  readonly field?: string;
  /** App-defined structured metadata. Display-only unless app policy uses it. */
  readonly meta?: Record<string, unknown>;
  /**
   * What the participant is doing to that entity. Canonical values:
   * `'editing'` / `'reviewing'` / `'generating'` / `'analyzing'` /
   * `'executing'`. Free-form strings are accepted for app-specific
   * phases.
   */
  readonly action: string;
  /** Human-readable detail — "slide 3", "cell A1:B5", etc. */
  readonly detail?: string;
  /**
   * Backpressure signal — load factor in `[0.0, 1.0]`. When set,
   * orchestrator agents reading peer activity can route work around
   * overloaded fleet members. Convention: `0.0` = idle, `1.0` = at
   * capacity, intermediate values = "I have headroom but prefer not."
   * Optional — agents that don't participate in load-aware routing
   * leave this unset; orchestrators ignore them in load calculations.
   * Hub treats it opaquely.
   */
  readonly loadFactor?: number;
  /**
   * Backpressure gate — explicit signal for new work assignments.
   * Defaults to true when unset (everyone accepts work by default).
   * Set false during graceful shutdown, capacity exhaustion, or when
   * the agent is committed to a long-running step it cannot preempt.
   * Orchestrators MUST treat false as "skip this peer for new work,"
   * and SHOULD treat true with high `loadFactor` as "available but
   * deprioritize."
   */
  readonly acceptingNewWork?: boolean;
}

/**
 * One participant's live state as seen by everyone else in scope.
 *
 * This is the canonical engine vocabulary. The server's older wire
 * frame still emits `userId` / `isAgent` / `updatedAt`; those names
 * are deprecated and translated at the inbound boundary
 * (`createPresenceStream`) into the names below. New code reads and
 * writes this shape only.
 */
export interface Peer {
  readonly participantKind: ParticipantKind;
  readonly participantId: string;
  readonly label?: string;
  readonly syncGroups: readonly string[];
  readonly activity: Activity;
  /** Server timestamp of the most recent frame from this participant. */
  readonly lastActive: string;
  /** Pending-mutation claims this participant has declared. */
  readonly activeClaims?: ReadonlyArray<Claim>;
}

// ─────────────────────────────────────────────────────────────────────
//  Wire-format extras — same file, no second module
// ─────────────────────────────────────────────────────────────────────

// `Claim` and `PresenceKind` are canonical in `../coordination/schema`
// (re-exported above). The canonical `Claim` carries optional
// `status`/`error` (server-set lifecycle); SDK code that ignores them is
// unaffected — the superset is structurally assignable to the old view.

/** Outbound `presence_update` payload. */
export interface PresenceUpdatePayload {
  readonly status: 'online' | 'away' | 'offline' | (string & {});
  readonly activity?: Activity;
  readonly isAgent?: boolean;
}

/**
 * Claim broadcasts — "I'm about to do X on Y." Broadcasts flow on
 * the same WS as presence, so every participant sees them in real
 * time. Cooperative mutex: the claim doesn't enforce exclusion; it
 * announces. Other agents observe and yield. This is cheaper and
 * more flexible than a central lock table and composes with presence.
 */
/**
 * Options common to every verb-style claim announcement
 * (`claims.analyzing`, `.drafting`, etc.).
 *
 * The one required field is the *target* — everything else is a
 * sensible default. Prefer the verb methods in `ClaimStream` below
 * (`analyzing(entity, { ttl: '3m' })`) over the raw `announce(...)`
 * escape hatch.
 */
export interface ClaimLeaseOptions {
  /**
   * How long before the server auto-expires this claim if the
   * participant doesn't finish the work. Accepts either a number (in
   * seconds — back-compat with `ttlSeconds`) or a duration string:
   * `'500ms'`, `'30s'`, `'3m'`, `'24h'`.
   */
  readonly ttl?: Duration;
}

/** Re-export of the duration helper shape. See `./duration.ts`. */
export type Duration = import('../utils/duration.js').Duration;

export interface ClaimOptions extends ClaimLeaseOptions {
  /**
   * Free-form reason describing why you're claiming. Surfaces in conflict
   * messages and the activity overlay. Defaults to `'editing'`. Common
   * values: `'editing'`, `'writing'`, `'reviewing'`, custom strings for
   * app-specific phases.
   */
  readonly reason?: string;
  /**
   * Peer-visible explanation of the exact work being performed. This is more
   * specific than `reason`: `reason` is the phase (`'renaming'`), while
   * `description` is the instruction other agents should see.
   */
  readonly description?: string;
  /**
   * Join the server's fair FIFO queue on contention instead of being
   * rejected. The grant arrives asynchronously (`claim_acquired` if the
   * target was free, `claim_granted` once promoted to the head of the line).
   * The low-level `claim` returns its handle immediately regardless; callers
   * that need to *wait* for the grant use the awaiting wrappers
   * (`ablo.<model>.claim`), which pair this flag with `awaitClaimGrant`.
   */
  readonly queue?: boolean;
}

export interface ClaimStream {
  /**
   * Claim an exclusive claim on a target. Returns a handle — call
   * `.revoke()` to cancel, let it expire via TTL, or use `await using`
   * (TC39 explicit resource management) to auto-revoke on scope exit.
   *
   * Server rejects via `claim_rejected` when another participant
   * already holds a claim on the same target. Default `reason` is
   * `'editing'`; pass `{reason: 'writing'}` (or any string) to override.
   *
   * The frame ships on the open WS immediately. One method, one shape —
   * the verb shortcuts (`editing`, `writing`, `announce`) and the
   * scoped `claim(reason, opts)` overload were collapsed into this
   * single primitive.
   */
  claim(target: PresenceTarget, opts?: ClaimOptions): ClaimHandle;

  /**
   * Reactive view of every other participant's active claims.
   * Reads return the current snapshot; pair with `subscribe(...)`
   * below to get notified on change.
   */
  readonly others: ReadonlyArray<ActiveClaim>;

  /**
   * Reactive view of the wait queue on one target — the FIFO line of
   * `status: 'queued'` claims behind the current holder, each with its
   * `action`, `heldBy`, and `position`. Synced from the server's per-entity
   * `claim_queue` frame; empty when no one's waiting. Pair with
   * `subscribe(...)` for change notifications.
   */
  queueFor(target: PresenceTarget): readonly Claim[];

  /**
   * Re-rank the wait queue on a target — move the listed waiters to the front
   * in the given order; unlisted waiters keep their relative FIFO order behind
   * them. Pass the `Claim[]` from `queueFor(target)` in the order you want
   * (each `Claim` carries its `heldBy` + `id`). Privileged: the server gates
   * it (a participant lacking the `claim.reorder` capability is denied), so
   * this is fire-and-forget — the new order arrives reactively via `queueFor`.
   */
  reorder(target: PresenceTarget, order: readonly Claim[]): void;

  /**
   * Framework-agnostic reactivity. Same contract as
   * `PresenceStream.subscribe` — register a listener fired on every
   * change (announce / revoke / TTL expiry received from the server),
   * returns an unsubscribe fn. Use `useSyncExternalStore` in React or
   * `autorun` in MobX.
   */
  onChange(listener: () => void): () => void;

  /**
   * Observe server-side claim rejections. Fires when the server
   * rejects an `claims.writing(...)` / `announce(...)` call because
   * another participant already holds an open claim on the same
   * target (cooperative mutex → enforced at the server boundary).
   *
   * Use this to surface conflicts to the user:
   * ```ts
   * participant.claims.onRejected((r) => {
   *   toast.error(`${r.heldBy} is editing — try again in a moment`);
   * });
   * ```
   *
   * Returns an unsubscribe fn.
   */
  onRejected(listener: (rejection: ClaimRejection) => void): () => void;

  /**
   * Observe LOSING an claim you held — distinct from `onRejected` (a claim the
   * server refused). Fires on the server's `claim_lost` frame, carrying why:
   * `'preempted'` (a privileged participant evicted you) or `'expired'` (your
   * TTL lapsed). Lets a holder react — re-plan vs re-claim — instead of
   * silently discovering the lease gone via presence.
   *
   * ```ts
   * participant.claims.onLost((lost) => {
   *   if (lost.reason === 'preempted') replanAgainst(lost.target);
   *   else reclaim(lost.target);
   * });
   * ```
   *
   * Returns an unsubscribe fn.
   */
  onLost(listener: (lost: ClaimLost) => void): () => void;

  /**
   * Async-iterable view of everyone else's open claims. Each
   * iteration yields the current snapshot on every mutation.
   *
   * ```ts
   * for await (const openClaims of participant.claims) {
   *   if (openClaims.some((i) => i.target.id === clauseId)) wait();
   * }
   * ```
   */
  [Symbol.asyncIterator](): AsyncIterableIterator<ReadonlyArray<ActiveClaim>>;
}

/**
 * You LOST an claim you were HOLDING — distinct from `ClaimRejection` (a
 * claim the server refused you). Delivered via `onLost`.
 */
export interface ClaimLost {
  /** The held claim's id that you just lost. */
  readonly claimId: string;
  /**
   * How you lost it. `'preempted'`: a privileged participant (one holding the
   * `claim.preempt` capability) evicted you and took the lease — its work now
   * supersedes yours, so re-plan against the new holder rather than blindly
   * re-claiming. `'expired'`: your TTL lapsed without finishing — re-claim if
   * you still need it.
   */
  readonly reason: 'expired' | 'preempted';
  /** The target you no longer hold. */
  readonly target: {
    readonly entityType: string;
    readonly entityId: string;
    readonly path?: string;
    readonly range?: TargetRange;
    readonly field?: string;
    readonly meta?: Record<string, unknown>;
  };
}

export interface ClaimDeclaration {
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
 *   await using work = participant.claims.analyzing(clause, { ttl: '3m' });
 *   // ... do the work; claim auto-revokes when the block exits
 * }
 * ```
 */
/**
 * THE one claim handle. Returned by every claim door — the typed
 * `ablo.<model>.claim({ id })` (rich: `data`/`readAt`/`target` populated) and
 * the low-level `participant.claims.claim()` lease (minimal: `claimId` +
 * `revoke`/`release`). Row-level fields are optional precisely because the
 * low-level lease has no row snapshot; the model door fills them in.
 *
 * Implements `Symbol.asyncDispose` so callers can `await using claim = ...`
 * and have it auto-release on scope exit.
 */
export interface ClaimHandle<T = Record<string, unknown>> extends AsyncDisposable {
  readonly object: 'claim';
  readonly claimId: string;
  /**
   * True when the grant came AFTER waiting in the server's FIFO line
   * (`claim_granted`) — the authoritative "the row may have changed under us"
   * signal. Absent for an immediate grant or a non-queued lease.
   */
  readonly waited?: boolean;
  /**
   * Sync watermark of the held snapshot (`data` was read at this stamp). Writes
   * carrying the handle use it as the `readAt` stale guard. Present for
   * model-scoped claims; absent for low-level leases.
   */
  readonly readAt?: number;
  readonly target: {
    readonly model: string;
    readonly id: string;
    readonly field?: string;
    readonly path?: string;
    readonly range?: TargetRange;
    readonly meta?: Record<string, unknown>;
  };
  readonly action: string;
  readonly description?: string;
  /** Row snapshot — populated by `ablo.<model>.claim`; absent on low-level leases. */
  readonly data?: T;
  release(): Promise<void>;
  revoke(): void;
}

export interface ActiveClaim extends ClaimDeclaration {
  readonly id: string;
  readonly heldBy: string;
  /**
   * Whether the holding participant is a user (session), an agent, or a
   * system actor. First-class field so UIs can style "agent editing X"
   * differently from "user editing X" without string-parsing `heldBy`.
   * Canonical `'user' | 'agent' | 'system'` — the presence/claim stream
   * derives the value from the boolean `isAgent` wire flag (so it produces
   * only `'user'`/`'agent'`), but the type stays the full union it shares
   * with the HTTP claim surface and lease store.
   */
  readonly participantKind: ParticipantKind;
  readonly description?: string;
  /** Epoch-ms the claim was announced. */
  readonly announcedAt: number;
  /** Epoch-ms the server auto-expires it. */
  readonly expiresAt: number;
}

// ─────────────────────────────────────────────────────────────────────
//  Claim — the canonical, Stripe-shaped coordination object
// ─────────────────────────────────────────────────────────────────────
//
// One self-describing claim carries the whole coordination lifecycle
// in a single `status` field — the same move Stripe makes with
// `PaymentIntent` (`requires_confirmation → processing → succeeded`).
// This supersedes the sprawl of `Claim` / `ActiveClaim` /
// `ModelClaim` / `ClaimRejection` / `Claim`: those were five half-
// shapes of one idea. `Claim` is the idea.
//
// It stays on the *coordination plane* — ephemeral, TTL'd, broadcast on
// the presence frame, never persisted to IndexedDB and never emitted as
// a `SyncDelta`. It is read through `ablo.<model>.claim.state({ id })`, not
// `defineSchema`.

/**
 * Every lifecycle state of a coordination claim, in one enum.
 * `active` = the current holder (the lock). `queued` = waiting in the FIFO
 * line behind the holder (carries `position`). The terminal states drop the
 * claim from the synced set.
 */
export type ClaimStatus =
  | 'active'
  | 'queued'
  | 'committed'
  | 'expired'
  | 'canceled';

/** Options for waiting on a target to become free. */
export interface ClaimWaitOptions {
  readonly timeout?: number;
  readonly pollInterval?: number;
  readonly signal?: AbortSignal;
}

/**
 * The coordination state of one entity. Self-describing on the wire via
 * `object: 'claim'`. Existence with `status: 'active'` *is* the lock;
 * the fields *are* the awareness ("agent X is editing this until Y").
 *
 * Deliberately omits a Stripe-style `next_action`: a contender's only
 * response is "wait until free, then re-read", and the runtime performs
 * that uniformly — `claim` serializes behind the holder via the server
 * FIFO queue (or low-level `claims.waitFor` to wait without claiming), and the
 * stale-context guard forces the re-read. Encoding a constant instruction
 * the engine always takes would be the kind of ceremony this object exists
 * to remove.
 */
export interface Claim {
  readonly object: 'claim';
  readonly id: string;
  readonly status: ClaimStatus;
  /** What is being coordinated. */
  readonly target: EntityRef;
  /** Human-readable phase — `'editing'`, `'writing'`, `'reviewing'`. */
  readonly action: string;
  /** Peer-visible explanation of the work being performed. */
  readonly description?: string;
  /** Participant holding it. */
  readonly heldBy: string;
  readonly participantKind: ParticipantKind;
  /**
   * Epoch-ms the holder opened it. Optional until the lease wire carries
   * it — derived shapes (e.g. mapped from a presence frame) may omit it.
   */
  readonly createdAt?: number;
  /** Epoch-ms the server auto-expires it if the holder doesn't finish. */
  readonly expiresAt: number;
  /**
   * 0-based place in the FIFO line — present only when `status: 'queued'`
   * (`0` = next in line behind the holder). Absent for the active holder.
   */
  readonly position?: number;
}
