/**
 * The types for real-time multiplayer coordination.
 *
 * Ablo treats people and AI agents alike as participants working on live
 * application entities. A participant announces what it is reading or editing,
 * claims an entity before writing to it, and captures a context snapshot before
 * starting long-running AI work. You keep your own schema, agent stack, tools,
 * prompts, and product rules; this package provides the shared coordination
 * layer underneath.
 */

import type { InferModel, Schema } from '../schema/schema.js';

// The coordination wire shapes are defined once in `../coordination/schema`.
// They are imported here so the rest of this file can reference them, and
// re-exported so consumers can keep importing them from this module.
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
 * Any JSON-serializable value. Used where the SDK accepts free-form metadata
 * that is stored or transported as JSON — more precise than `unknown` while
 * still allowing any JSON shape.
 */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

// Participant identity is defined in `./participant.ts`, which imports nothing,
// so the streams and conflict-policy types can share it without an import
// cycle. It is imported here for local use and re-exported so it can still be
// imported from this module.
import type { ParticipantRef } from './participant.js';
export type { ParticipantRef } from './participant.js';

/**
 * Whether a person explicitly approved a change. If you don't track approval,
 * leave it at the default of `'auto'`.
 */
export type ConfirmationState =
  | 'auto'
  | 'previewed'
  | 'approved'
  | 'required_human_approval'
  | 'auto_historical';

/**
 * The wire shape of a single change on the sync stream. Alongside the change
 * itself, it carries attribution fields — `actor`, `onBehalfOf`,
 * `capabilityId`, and `confirmationState` — recorded on each row for auditing.
 */
export interface AgentDelta {
  id: number;
  actionType: 'I' | 'U' | 'D' | 'A';
  modelName: string;
  modelId: string;
  data: Record<string, unknown>;
  previousData?: Record<string, unknown>;
  /** Who performed the action. */
  actor?: ParticipantRef | null;
  /** The participant on whose authority the actor acted. */
  onBehalfOf?: ParticipantRef | null;
  /** The capability that authorized this commit. */
  capabilityId?: string | null;
  /** Whether a person explicitly approved the change. */
  confirmationState?: ConfirmationState | null;
  /** The id of the agent task that caused this commit, if any. */
  causedByTaskId?: string | null;
  createdAt: string;
}

// ─────────────────────────────────────────────────────────────────────
//  Snapshots — context watermarks for long-running work
// ─────────────────────────────────────────────────────────────────────

/**
 * A flat, point-in-time view of application data returned by
 * `participant.snapshot(...)`. Capture it before long-running AI work, then
 * detect whether the data changed underneath while that work ran.
 *
 *   - Per-model buckets: `snap.<modelName>[id]` returns the entity, typed from
 *     your schema (via `InferModel`) rather than as `unknown` — so, for
 *     example, `snap.clauses[clauseId].text` is a `string`.
 *   - `stamp` — an opaque version marker. Thread it into writes as
 *     `{ readAt: snap.stamp }` so the server can reject a write made against
 *     stale data.
 *   - `signal` — an `AbortSignal` that fires if any captured entity receives a
 *     change during the window. Pass it into your LLM call so a mid-generation
 *     change aborts the token stream instead of completing against a snapshot
 *     that is no longer current.
 *   - `onChange(fn)` — a callback alternative to `signal` for cases that don't
 *     abort, such as logging, UI flags, or partial regeneration. Returns an
 *     unsubscribe function.
 *
 * The per-model buckets share the object with `stamp`, `signal`, and
 * `onChange`, so naming a model `stamp`, `signal`, or `onChange` collides.
 * Snapshot creation throws a clear error in that case.
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
 * The staleness mode for a write that follows a snapshot. When `readAt` is
 * provided without an `onStale` mode, it defaults to `'reject'`.
 */
// `OnStaleMode` is defined in `../coordination/schema` and re-exported above.

// ─────────────────────────────────────────────────────────────────────
//  Coordination primitives — a live stream, not polling
// ─────────────────────────────────────────────────────────────────────
//
// Every participant holds a live WebSocket connection, and state flows over it
// continuously in both directions:
//
//   • Each participant broadcasts its current activity whenever that activity
//     changes (started reading slide 5, mid-generation, writing this field).
//     The broadcast is synchronous from the caller's point of view —
//     `presence.update(...)` returns immediately and the frame ships on the
//     already-open connection.
//
//   • Each participant continuously receives the activity of every other
//     participant on its sync groups, exposed as a reactive value
//     (`presence.others`) — no `await`, no polling, no `list()` calls. It stays
//     current because the connection stays open.
//
// This is what separates multi-agent work on a shared document from checking
// changes in and out. Three agents editing one deck don't poll periodically to
// see what the others did; they watch each other work in real time and
// coordinate continuously.

// `TargetRange` is defined in `../coordination/schema` and re-exported above.

/**
 * A pointer to one entity, optionally narrowed to a part of it. `type` and `id`
 * come from your schema; `path`, `range`, `field`, and `meta` are
 * general-purpose hints for finer-grained coordination in tools like code
 * editors, document editors, and design tools.
 */
export interface ClaimTarget {
  readonly type: string;
  readonly id: string;
  readonly path?: string;
  readonly range?: TargetRange;
  readonly field?: string;
  readonly meta?: Record<string, unknown>;
}

/**
 * A pointer to the entity a participant is acting on. Either a
 * {@link ClaimTarget} object or a `[type, id]` tuple such as `['Clause', 'cl_3']`
 * for concise inline use. The verb methods below accept either form.
 */
export type PresenceTarget = ClaimTarget | readonly [type: string, id: string];

/**
 * A reactive, always-on stream of what every participant is doing. Each
 * participant has one, and it stays current for as long as the connection is
 * open.
 */
export interface PresenceStream {
  /**
   * This participant's own broadcast state — the same thing every other
   * participant sees for it. Read-only here; change it through `update(...)`.
   */
  readonly self: Peer;

  /**
   * Broadcast a new activity. Synchronous — the frame ships on the already-open
   * connection, with no request-response round-trip to await. Call it as often
   * as the activity meaningfully changes: on read, on generation start, on
   * partial output, on write, on done.
   *
   * For the common actions, prefer the verb methods below (`editing`,
   * `viewing`, and so on): they read as one line and save you from remembering
   * the action strings.
   */
  update(activity: Activity): void;

  // ── Verb shortcuts — one call, one sentence ──────────────────────
  //
  // Conveniences over `update({ entityType, entityId, action })` — same wire
  // frame. The set is intentionally small: a few concrete actions a peer can
  // observe and act on. More abstract phases (analyzing, thinking, planning)
  // go through `update({ action: 'custom-string' })`, in your app's own
  // vocabulary.

  /** Participant is actively modifying this entity. */
  editing(target: PresenceTarget, detail?: string): void;
  /** Participant is reading this entity; no modifications. */
  reading(target: PresenceTarget, detail?: string): void;
  /** Participant is reading this entity; no modifications. */
  viewing(target: PresenceTarget, detail?: string): void;
  /** Participant has stepped away from any specific entity. */
  idle(): void;

  /**
   * A reactive view of every other participant's current activity on this
   * participant's sync groups. Reading it returns the current snapshot; pair it
   * with `onChange(listener)` below to be notified when it changes.
   *
   * You can drop `presence.others` into an LLM's system prompt so the model
   * reasons about what other agents are doing right now — for example,
   * "copy-bot is generating a new title for slide 5; don't duplicate that work."
   */
  readonly others: readonly Peer[];

  /** Subset of `others` filtered to a specific sync group. */
  othersIn(syncGroup: string): readonly Peer[];

  /**
   * A framework-agnostic reactivity hook. Register a callback that fires
   * whenever `others` or `othersIn(...)` changes — a peer joined, left, or
   * updated its activity. Returns a function that unsubscribes.
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
   * An async-iterable view of the peer roster. Each iteration yields the
   * current `others` snapshot whenever it changes, so you can watch the world
   * update without registering a callback.
   *
   * ```ts
   * for await (const peers of participant.presence) {
   *   renderAvatars(peers);
   *   if (peers.length === 0) break; // iteration stops, subscription drops
   * }
   * ```
   *
   * Each `for await` gets an independent iterator — two loops on the same
   * stream both see every update rather than stealing values from each other.
   * Breaking out of the loop, or throwing, tears the subscription down cleanly.
   */
  [Symbol.asyncIterator](): AsyncIterableIterator<readonly Peer[]>;
}

/**
 * What a participant is currently doing. This type is both the SDK shape and
 * the wire shape: a presence broadcast on the `presence_update` frame carries
 * exactly these fields.
 *
 * Every activity is about one entity in focus. An agent working across several
 * entities calls `presence.update(...)` each time its focus shifts, and other
 * participants see the change in real time.
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
   * A backpressure signal in the range `[0.0, 1.0]`. When set, orchestrator
   * agents reading peer activity can route work away from busy participants:
   * `0.0` means idle, `1.0` means at capacity, and values in between mean "I
   * have headroom but would rather not." Optional — agents that don't take part
   * in load-aware routing leave it unset, and orchestrators ignore them when
   * balancing load. The server passes it through without interpreting it.
   */
  readonly loadFactor?: number;
  /**
   * A backpressure gate for new work assignments. It defaults to `true` when
   * unset, so everyone accepts work by default. Set it to `false` during
   * graceful shutdown, at capacity, or while committed to a long step that
   * can't be interrupted. Orchestrators should skip a peer showing `false`, and
   * treat `true` with a high `loadFactor` as available but lower priority.
   */
  readonly acceptingNewWork?: boolean;
}

/**
 * One participant's live state as seen by everyone else in scope — its
 * identity, sync groups, current {@link Activity}, and any open claims.
 */
export interface Peer {
  readonly participantKind: ParticipantKind;
  readonly participantId: string;
  readonly label?: string;
  readonly syncGroups: readonly string[];
  readonly activity: Activity;
  /** Server timestamp of the most recent frame from this participant. */
  readonly lastActive: string;
  /** The claims this participant currently holds. */
  readonly activeClaims?: readonly Claim[];
}

// ─────────────────────────────────────────────────────────────────────
//  Wire-format extras
// ─────────────────────────────────────────────────────────────────────

// `Claim` and `PresenceKind` are defined in `../coordination/schema` and
// re-exported above.

/** Outbound `presence_update` payload. */
export interface PresenceUpdatePayload {
  readonly status: 'online' | 'away' | 'offline' | (string & {});
  readonly activity?: Activity;
  readonly isAgent?: boolean;
}

/**
 * A claim is a broadcast that says "I'm about to work on this entity." Claims
 * travel on the same connection as presence, so every participant sees them in
 * real time. They are cooperative rather than enforced: a claim announces
 * intent, and other agents observe it and yield. This is lighter and more
 * flexible than a central lock table and composes with presence.
 */
/**
 * The options shared by every verb-style claim announcement
 * (`claims.analyzing`, `claims.drafting`, and so on). The only required piece
 * is the target; everything else has a sensible default. Prefer the verb
 * methods on {@link ClaimStream} — for example `analyzing(entity, { ttl: '3m' })`
 * — over the raw `announce(...)` call.
 */
export interface ClaimLeaseOptions {
  /**
   * How long before the server auto-expires this claim if the participant
   * hasn't finished. Accepts a number of seconds or a duration string such as
   * `'500ms'`, `'30s'`, `'3m'`, or `'24h'`.
   */
  readonly ttl?: Duration;
}

/** The duration value type used by `ttl`, re-exported for convenience. */
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
   * On contention, join the server's fair first-in-first-out queue instead of
   * being rejected. The grant then arrives asynchronously — immediately if the
   * target was free, or once you reach the head of the line. To wait for the
   * grant, use `ablo.<model>.claim`, which pairs this flag with the wait.
   */
  readonly queue?: boolean;
}

// The claim stream is observation-only. You take a claim through
// `ablo.<model>.claim({ id })`, which reads the row under the lease and returns
// a handle carrying its `data`. There is deliberately no low-level
// `claims.claim(target)` here — a second way to take a claim, one without the
// row, only made it harder to know which method to reach for — so this stream
// exposes only the reactive reads below.
export interface ClaimStream {
  /**
   * A reactive view of every other participant's active claims. Reading it
   * returns the current snapshot; pair it with `onChange(...)` to be notified
   * when it changes.
   */
  readonly others: readonly Claim[];

  /**
   * A reactive view of the wait queue on one target — the ordered line of
   * queued claims behind the current holder, each carrying its `reason`,
   * `heldBy`, and `position`. Empty when no one is waiting. Pair it with
   * `onChange(...)` for change notifications.
   */
  queueFor(target: PresenceTarget): readonly Claim[];

  /**
   * Re-rank the wait queue on a target: move the listed waiters to the front in
   * the given order, leaving the rest in their existing relative order behind
   * them. Pass the claims from `queueFor(target)` in the order you want. This
   * is privileged — the server rejects a participant that lacks the
   * `claim.reorder` capability — and fire-and-forget: the new order arrives
   * reactively through `queueFor`.
   */
  reorder(target: PresenceTarget, order: readonly Claim[]): void;

  /**
   * A framework-agnostic reactivity hook, with the same contract as
   * {@link PresenceStream.onChange}: register a listener that fires on every
   * change — a claim announced, revoked, or expired — and returns a function
   * that unsubscribes. Use `useSyncExternalStore` in React or `autorun` in
   * MobX.
   */
  onChange(listener: () => void): () => void;

  /**
   * Observe claims the server rejected. Fires when a claim you tried to take is
   * refused because another participant already holds an open claim on the same
   * target.
   *
   * Use it to surface conflicts to the user:
   * ```ts
   * participant.claims.onRejected((r) => {
   *   toast.error(`${r.heldBy} is editing — try again in a moment`);
   * });
   * ```
   *
   * Returns a function that unsubscribes.
   */
  onRejected(listener: (rejection: ClaimRejection) => void): () => void;

  /**
   * Observe losing a claim you held — distinct from `onRejected`, which is a
   * claim the server refused to grant. Fires when the server reports the loss,
   * carrying why: `'preempted'` (a privileged participant evicted you) or
   * `'expired'` (your lease lapsed). This lets a holder react — re-plan or
   * re-claim — rather than discovering the lease gone through presence.
   *
   * ```ts
   * participant.claims.onLost((lost) => {
   *   if (lost.reason === 'preempted') replanAgainst(lost.target);
   *   else reclaim(lost.target);
   * });
   * ```
   *
   * Returns a function that unsubscribes.
   */
  onLost(listener: (lost: ClaimLost) => void): () => void;

  /**
   * An async-iterable view of everyone else's open claims. Each iteration
   * yields the current snapshot whenever it changes.
   *
   * ```ts
   * for await (const openClaims of participant.claims) {
   *   if (openClaims.some((i) => i.target.id === clauseId)) wait();
   * }
   * ```
   */
  [Symbol.asyncIterator](): AsyncIterableIterator<readonly Claim[]>;
}

/**
 * A notification that you lost a claim you were holding — distinct from
 * {@link ClaimRejection}, which is a claim the server refused to grant.
 * Delivered through `onLost`.
 */
export interface ClaimLost {
  /** The id of the claim you just lost. */
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

/**
 * Every lifecycle state of a claim. `active` is the current holder — the lock
 * itself. `queued` is waiting in line behind the holder and carries a
 * `position`. The remaining states are terminal and drop the claim from the
 * synced set.
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

// ─────────────────────────────────────────────────────────────────────
//  Claim — the single claim structure
// ─────────────────────────────────────────────────────────────────────
//
// There is exactly one claim type. The same `Claim` is:
//   • what `ablo.<model>.claim({ id })` returns (a claim you hold — `data`,
//     `readAt`, and `release()` / `revoke()` are populated),
//   • what `ablo.<model>.claim.state({ id })` reads (the current holder, or
//     null),
//   • every entry in `ablo.claims.others` and `queueFor(...)` (peer claims you
//     only observe, with no `release()`).
//
// The behavioral members are optional because not every surface fills them: a
// peer claim you only observe has no `release()`, and a freshly minted lease
// has no row `data` until it is read. One name and one shape, rather than
// separate handle, active, and observed variants to disambiguate.
//
// A claim lives on the coordination plane: it is ephemeral, has a lease, is
// broadcast on the presence frame, and is never persisted to local storage or
// emitted as a sync delta.
export interface Claim<T = Record<string, unknown>> {
  readonly object: 'claim';
  /** This claim's id. */
  readonly id: string;
  /**
   * The claim's lifecycle state. `active` is the holder — the lock; `queued` is
   * waiting in line and carries a `position`. It is optional on shapes derived
   * from a presence frame, where a present entry is `active` by construction.
   */
  readonly status?: ClaimStatus;
  /** What is being coordinated. */
  readonly target: ClaimTarget;
  /**
   * Human-readable phase — `'editing'`, `'writing'`, `'reviewing'`. The same
   * field on every claim surface; distinct from the CRUD operation. Defaults to
   * `'editing'`.
   */
  readonly reason: string;
  /** Peer-visible explanation of the work being performed. */
  readonly description?: string;
  /** Participant holding it. Absent on a handle you hold for yourself. */
  readonly heldBy?: string;
  /**
   * Whether the holder is a user (session), agent, or system actor — so UIs
   * style "agent editing X" vs "user editing X" without string-parsing
   * `heldBy`. Present on observed claims; absent on your own fresh handle.
   */
  readonly participantKind?: ParticipantKind;
  /** Epoch-ms the holder opened it. */
  readonly createdAt?: number;
  /** Epoch-ms the server auto-expires it if the holder doesn't finish. */
  readonly expiresAt?: number;
  /**
   * The seconds remaining until auto-expiry — a countdown output as a plain
   * number, distinct from the `ttl: Duration` (such as `'3m'`) you pass in when
   * claiming.
   */
  readonly ttlSeconds?: number;
  /**
   * 0-based place in the FIFO line — present only when `status: 'queued'`
   * (`0` = next behind the holder). Absent for the active holder.
   */
  readonly position?: number;
  /**
   * True when the grant arrived only after waiting in the server's queue — the
   * reliable signal that the row may have changed while you waited. Absent for
   * an immediate, uncontended grant.
   */
  readonly waited?: boolean;
  /**
   * The sync watermark at which `data` was read. A write made under this claim
   * uses it as the `readAt` staleness guard. Present on a claim you hold.
   */
  readonly readAt?: number;
  /** Row snapshot under the lease — present on a claim you hold. */
  readonly data?: T;
  /**
   * Release the lease. Present only on a claim you hold (returned by
   * `ablo.<model>.claim`); absent on observed peer claims.
   */
  release?: () => Promise<void>;
  /** Synchronously abandon the lease. Present only on a claim you hold. */
  revoke?: () => void;
  /**
   * Extend the lease past the liveness window — the "still working" signal
   * for long-running tasks. Resolving means the lease is still yours, now
   * good until the returned `expiresAt`; a lease that lapsed (and may have
   * been granted to the next in line) rejects with an
   * {@link ../errors.js AbloClaimedError} carrying code `claim_lost`, so the
   * failed beat doubles as the loss notification. Each beat's extension is
   * clamped server-side — hold a long task by beating on a cadence (pass
   * `heartbeat` when claiming to have the SDK do this for you), not by
   * asking once for a huge window. Present only on a claim you hold.
   */
  heartbeat?: (
    options?: Duration | ClaimHeartbeatOptions,
  ) => Promise<ClaimHeartbeat>;
  /** Auto-release on `await using` scope exit. Present only on a held claim. */
  [Symbol.asyncDispose]?(): PromiseLike<void>;
}

/** Options for one beat — a bare {@link Duration} is shorthand for `{ ttl }`. */
export interface ClaimHeartbeatOptions {
  /** Requested extension from now; the server clamps it and never shortens. */
  readonly ttl?: Duration;
  /**
   * Lightweight progress the beat carries along (`{ pages: 42, of: 100 }`) —
   * becomes the claim's peer-visible `meta.progress` (last beat wins) and
   * dies with the lease. Durable checkpoints belong in the data itself:
   * write a row, and every subscriber already sees it.
   */
  readonly details?: Record<string, unknown>;
}

/** The resolved value of a successful {@link Claim.heartbeat} — the lease is
 *  still yours, now good until `expiresAt` (epoch milliseconds). */
export interface ClaimHeartbeat {
  readonly expiresAt: number;
  /**
   * How many participants wait in line behind this lease — cooperative-yield
   * pressure. A worker that can checkpoint may release early when others
   * wait. Absent when the server predates the field.
   */
  readonly queueDepth?: number;
}

/**
 * A claim you hold — the resolved value of `ablo.<model>.claim(...)`. It is a
 * {@link Claim} with the lease-control members (`data`, `release`, `revoke`,
 * and the async-dispose hook) made required; they are optional on the base
 * because that shape also models observed peer claims, which lack them. Making
 * them required is what lets `await using held = await ablo.x.claim(...)`
 * typecheck, since `Claim`'s optional dispose hook is not assignable to
 * `AsyncDisposable`.
 */
export type HeldClaim<T = Record<string, unknown>> = Claim<T> &
  Required<
    Pick<
      Claim<T>,
      'data' | 'release' | 'revoke' | 'heartbeat' | typeof Symbol.asyncDispose
    >
  >;
