/**
 * Multiplayer stream types.
 *
 * Ablo treats humans and agents as participants on live application
 * entities. Participants announce what they are reading or editing,
 * claim intent before writing, and capture context watermarks before
 * long-running AI work. The customer keeps their own schema, agent
 * stack, tools, prompts, and product policy; the sync engine provides
 * the shared coordination substrate.
 */

import type { ModelDef } from '../schema/model.js';
import type { InferCreate, InferModel, Schema } from '../schema/schema.js';

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
  /** Turn handle that caused this commit. */
  causedByTaskId?: string | null;
  createdAt: string;
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

export interface TargetRange {
  readonly startLine: number;
  readonly endLine: number;
  readonly startColumn?: number;
  readonly endColumn?: number;
}

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
   * pair with `subscribe(listener)` below to get notified on changes.
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
  readonly participantKind: 'human' | 'agent';
  readonly participantId: string;
  readonly label?: string;
  readonly syncGroups: readonly string[];
  readonly activity: Activity;
  /** Server timestamp of the most recent frame from this participant. */
  readonly lastActive: string;
  /** Pending-mutation intents this participant has declared. */
  readonly activeIntents?: ReadonlyArray<IntentClaim>;
}

// ─────────────────────────────────────────────────────────────────────
//  Wire-format extras — same file, no second module
// ─────────────────────────────────────────────────────────────────────

/**
 * Pending-mutation intent on the wire. Declared via `intent_begin`,
 * cleared on `intent_abandon` / commit / disconnect / TTL expiry.
 * Server stamps `declaredAt` and `expiresAt` (ms epoch). The SDK's
 * `IntentStream.others` exposes a richer `ActiveIntent` view (defined
 * below) that adds `heldBy` so callers know which participant owns it.
 */
export interface IntentClaim {
  readonly intentId: string;
  readonly entityType: string;
  readonly entityId: string;
  readonly path?: string;
  readonly range?: TargetRange;
  readonly action: string;
  readonly field?: string;
  readonly meta?: Record<string, unknown>;
  readonly declaredAt: number;
  readonly expiresAt: number;
}

/**
 * Transition type carried on every presence frame from the server.
 *   - `'enter'`  — first frame the receiver sees for this peer.
 *   - `'update'` — activity / intent change on an already-known peer.
 *   - `'leave'`  — peer departed (explicit disconnect or TTL expiry).
 */
export type PresenceKind = 'enter' | 'update' | 'leave';

/** Outbound `presence_update` payload. */
export interface PresenceUpdatePayload {
  readonly status: 'online' | 'away' | 'offline' | (string & {});
  readonly activity?: Activity;
  readonly isAgent?: boolean;
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
export type Duration = import('../utils/duration.js').Duration;

export interface ClaimOptions extends IntentOptions {
  /**
   * Free-form reason describing why you're claiming. Surfaces in conflict
   * messages and the activity overlay. Defaults to `'editing'`. Common
   * values: `'editing'`, `'writing'`, `'reviewing'`, custom strings for
   * app-specific phases.
   */
  readonly reason?: string;
}

export interface IntentStream {
  /**
   * Claim an exclusive intent on a target. Returns a handle — call
   * `.revoke()` to cancel, let it expire via TTL, or use `await using`
   * (TC39 explicit resource management) to auto-revoke on scope exit.
   *
   * Server rejects via `intent_rejected` when another participant
   * already holds a claim on the same target. Default `reason` is
   * `'editing'`; pass `{reason: 'writing'}` (or any string) to override.
   *
   * The frame ships on the open WS immediately. One method, one shape —
   * the verb shortcuts (`editing`, `writing`, `announce`) and the
   * scoped `claim(reason, opts)` overload were collapsed into this
   * single primitive.
   */
  claim(target: PresenceTarget, opts?: ClaimOptions): Claim;

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
  readonly target: {
    readonly entityType: string;
    readonly entityId: string;
    readonly path?: string;
    readonly range?: TargetRange;
    readonly field?: string;
    readonly meta?: Record<string, unknown>;
  };
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
export interface Claim extends AsyncDisposable {
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
