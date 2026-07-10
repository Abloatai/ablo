/**
 * The interfaces you implement to plug the SDK into your own environment.
 *
 * The SDK depends on these contracts rather than any specific framework, so you
 * provide the concrete implementations — logging, observability, analytics,
 * session-error detection, online-status checks, and the transport that carries
 * mutations to your backend. The SDK ships sensible no-op defaults where it can.
 */

import type { StaleNotification, ReadDependency, ParticipantKind } from '../coordination/schema.js';


// ─────────────────────────────────────────────
// Logger
// ─────────────────────────────────────────────

export interface SyncLogger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

// ─────────────────────────────────────────────
// Observability
// ─────────────────────────────────────────────

/** Breadcrumb severity levels */
export type BreadcrumbLevel = 'debug' | 'info' | 'warning' | 'error';

/** Breadcrumb categories for sync engine lifecycle events */
export type SyncBreadcrumbCategory =
  | 'sync.bootstrap'
  | 'sync.transaction'
  | 'sync.websocket'
  | 'sync.offline'
  | 'sync.database'
  | 'sync.conflict'
  | 'sync.coordination'
  | 'sync.groups';

export interface RollbackDetails {
  transactionType: string;
  modelName: string;
  modelId: string;
  reason: string;
  error?: string;
  connectionState: string;
}

export interface TransactionFailureDetails {
  context: string;
  modelName?: string;
  modelId?: string;
  transactionId?: string;
  error: Error | string;
}

export interface BootstrapFailureDetails {
  attempt?: number;
  type?: string;
  navigatorOnline?: boolean;
}

export interface ReconciliationDetails {
  reason: string;
  model: string;
  modelId: string;
  syncIdNeeded?: number;
  lastSeenSyncId: number;
  retryCount: number;
  connectionState?: string;
}

export interface DeltaRetryExhaustedDetails {
  txId: string;
  model: string;
  modelId: string;
  retryCount: number;
  syncIdNeeded?: number;
}

export interface WebSocketErrorDetails {
  context: string;
  error?: string;
  code?: number;
  reason?: string;
}

export interface SelfHealingDetails {
  modelName: string;
  modelId: string;
  field: string;
  action: string;
}

export interface CommitZeroSyncIdDetails {
  operationCount: number;
  operations: string[];
}

/**
 * A single event in the life of a claim. `phase` is the state the claim has just
 * entered, and the sequence of phases is the trail you follow to see how two
 * participants collided on a row — who asked for it, who waited behind whom, who
 * was turned away, and whose lease lapsed. Each phase corresponds to a `claim_*`
 * frame on the wire.
 */
export interface ClaimEvent {
  phase:
    | 'acquired' // target was free — lease granted immediately
    | 'queued' // contended — joined the FIFO line behind the holder
    | 'granted' // reached the head of the line — lease now ours
    | 'lost' // held lease taken away (TTL lapse on disconnect, revoke)
    | 'rejected' // server denied the claim — another participant holds the target
    | 'expired'; // TTL lapsed server-side
  /** Server claim id, when the frame carries one. */
  claimId?: string;
  /** The claimed row + optional field scope. */
  model?: string;
  id?: string;
  field?: string;
  /** Participant that owns or blocks the lease (on `rejected`, the holder). */
  actor?: string;
  participantKind?: ParticipantKind;
  /** FIFO position when `queued`. */
  position?: number;
  /** Rejection or policy reason, when the server supplied one. */
  reason?: string;
}

/**
 * A committed `onStale: 'notify'` write whose premise had moved. The commit
 * succeeded, but the guarded operations were not written because the row had
 * changed since the caller's `readAt`, and the engine returned the current value
 * so the caller can reconcile. Records which rows and fields collided.
 */
export interface ConflictEvent {
  /** The client idempotency key whose write was notified. */
  clientTxId: string;
  /** The conflicted rows + the fields that collided. */
  rows: readonly {
    model: string;
    id: string;
    fields: readonly string[];
    writtenBy?: ParticipantKind;
  }[];
}

/** Span attributes for performance monitoring */
export type SpanAttributes = Record<string, string | number | boolean | undefined>;

/**
 * The observability hooks the SDK calls to report its own lifecycle. The SDK
 * ships a no-op default; provide your own to forward these events to a monitoring
 * tool such as Sentry, Datadog, or OpenTelemetry.
 */
export interface SyncObservabilityProvider {
  /** Set user/org context for error grouping */
  setContext(userId: string, organizationId: string): void;

  /** Update connection state tag */
  setConnectionState(state: 'connected' | 'disconnected' | 'connecting'): void;

  /** Add a breadcrumb for sync lifecycle events */
  breadcrumb(
    message: string,
    category: SyncBreadcrumbCategory,
    level?: BreadcrumbLevel,
    data?: Record<string, string | number | boolean | undefined>
  ): void;

  /** Capture optimistic rollback (data reverted) */
  captureRollback(details: RollbackDetails): void;

  /** Capture permanent transaction failure */
  captureTransactionFailure(details: TransactionFailureDetails): void;

  /** Capture bootstrap failure */
  captureBootstrapFailure(error: Error | unknown, details?: BootstrapFailureDetails): void;

  /** Capture reconciliation needed (delta confirmation timeout) */
  captureReconciliation(details: ReconciliationDetails): void;

  /** Capture delta retry exhausted */
  captureDeltaRetryExhausted(details: DeltaRetryExhaustedDetails): void;

  /** Capture WebSocket error */
  captureWebSocketError(details: WebSocketErrorDetails): void;

  /** Capture self-healing event */
  captureSelfHealing(details: SelfHealingDetails): void;

  /** Capture a claim state change (acquired / queued / granted / lost / rejected / expired) */
  captureClaim(event: ClaimEvent): void;

  /** Capture a notify-instead-of-abort stale-write collision */
  captureConflict(event: ConflictEvent): void;

  /** Capture commit returning lastSyncId: 0 */
  captureCommitZeroSyncId(details: CommitZeroSyncIdDetails): void;

  /** Wrap a synchronous function in a performance span */
  startSpan<T>(name: string, op: string, fn: () => T, attributes?: SpanAttributes): T;

  /** Wrap an async function in a performance span */
  startSpanAsync<T>(
    name: string,
    op: string,
    fn: () => Promise<T>,
    attributes?: SpanAttributes
  ): Promise<T>;
}

// ─────────────────────────────────────────────
// Analytics
// ─────────────────────────────────────────────

export interface SyncAnalytics {
  capture(event: string, properties?: Record<string, unknown>): void;
}

// ─────────────────────────────────────────────
// Session Error Detection
// ─────────────────────────────────────────────

/**
 * Detects whether an error represents an expired/invalid session.
 * The SDK uses this to decide whether to redirect to login vs retry.
 */
export interface SessionErrorDetector {
  /** Check if an error is a session error (401/403) */
  isSessionError(error: unknown): boolean;

  /** Check if an HTTP response status indicates a session error */
  isSessionErrorResponse(status: number, body?: string): boolean;
}

// ─────────────────────────────────────────────
// Online Status
// ─────────────────────────────────────────────

export interface OnlineStatusProvider {
  /** Returns true if the device is currently online */
  isOnline(): boolean;
}

// ─────────────────────────────────────────────
// Model Debug Logger
// ─────────────────────────────────────────────

export interface ModelDebugLoggerContract {
  logOperation(info: {
    modelName: string;
    modelId?: string;
    operation: string;
    fields?: Record<string, unknown>;
  }): void;
  logDebug(message: string): void;
  logError(modelName: string, operation: string, message: string, data?: unknown): void;
  logCreation(modelName: string, data: unknown, constructor: unknown): void;
  logObservableSetup(
    modelName: string,
    observableProps: string[],
    computedProps: string[]
  ): void;
}

// ─────────────────────────────────────────────
// Mutation Execution (replaces GraphQLClient coupling)
// ─────────────────────────────────────────────

/** Result of a successful `commit()` — server's sync cursor after the batch landed. */
export interface CommitResult {
  lastSyncId: number;
  /**
   * Stale-context notifications. Present only when a write guarded with
   * `onStale: 'notify'` collided with a concurrent change: rather than throwing
   * an `AbloStaleContextError`, the commit succeeds and reports the collision
   * here so the caller can reconcile. See {@link StaleNotification}.
   */
  notifications?: StaleNotification[];
  /**
   * Ids of update or delete targets that matched no rows. Present, and non-empty,
   * only when a write missed the row it addressed.
   */
  missingIds?: string[];
}

/**
 * Per-call options accepted by any mutation, passed as the last argument.
 * Every field is optional; omitted fields fall back to sensible defaults.
 *
 * - `idempotencyKey` — when set, the server caches the response for 24 hours and
 *   returns the cached result on any retry using the same key. When omitted, the
 *   SDK generates a fresh UUID per mutation, so every call is retry-safe by
 *   default. Pass `{ idempotencyKey: null }` for the rare case where you want a
 *   write that is not retry-safe.
 * - `label` — a human-readable tag recorded with the mutation for debugging, such
 *   as "nightly cleanup" or "user click".
 */
export interface MutationOptions {
  idempotencyKey?: string | null;
  label?: string;
  wait?: 'queued' | 'confirmed';
  readAt?: number | null;
  onStale?: 'reject' | 'overwrite' | 'notify' | null;
  /** The id (or `{ id }`) of the claim this write belongs to. This is the
   *  low-level reference the commit carries so the write is attributed to a claim
   *  and can pass the holder's own lock. It is distinct from the `claim` handle on
   *  the model write parameters, which is the higher-level object you usually pass. */
  claimRef?: string | { readonly id: string } | null;
  /**
   * Reserved lineage field, forwarded on the wire as `causedByTaskId`. The client
   * always sends `null`; write attribution now travels on the claim id instead.
   */
  causedByTaskId?: string | null;
  /**
   * Batch-level read dependencies — the answer to "did anything I looked at
   * change?" Each entry is a row (`{ model, id, readAt, fields? }`) or a sync
   * group (`{ group, readAt }`) that this write was premised on. The server
   * checks that none of them moved since their `readAt` and applies the entry's
   * `onStale` behavior to the whole batch. This is distinct from the per-operation
   * `readAt`, which guards only the row being written.
   */
  reads?: ReadDependency[] | null;
}

/**
 * The subset of {@link MutationOptions} that travels with each write as it is
 * queued offline and sent on the wire. A single shared type keeps the public
 * parameters, the offline queue, and the wire format from diverging. `wait` and
 * `claim` are deliberately absent: both are resolved on the client before a write
 * is staged, so neither reaches this layer.
 */
export type WriteOptions = Pick<
  MutationOptions,
  'readAt' | 'onStale' | 'idempotencyKey' | 'label'
>;

/** A single mutation within a batch. Its `options` travel with it so the server
 *  can cache and replay the operation for idempotent retries. */
export interface MutationOperation {
  type: string;
  model: string;
  id: string;
  input?: Record<string, unknown>;
  /**
   * A client-side id for this single operation. The server stamps it onto the
   * resulting `sync_deltas.transaction_id`, so when the confirming delta arrives
   * back over the sync stream the client can recognize it as an echo of its own
   * optimistic write and skip re-applying it locally.
   *
   * This is distinct from the batch-level `client_tx_id` that idempotency uses:
   * that key de-duplicates a retried batch (a request-level cache), whereas this
   * id identifies one row within a batch (for echo matching). Both can appear on
   * the wire at once.
   */
  transactionId?: string;
  readAt?: number | null;
  onStale?: 'reject' | 'overwrite' | 'notify' | null;
  /**
   * Per-operation idempotency and audit metadata. `idempotencyKey` is also the
   * cache key the server uses to de-duplicate retries; `label` is stored for
   * debugging. These are the only {@link MutationOptions} fields sent on the wire.
   */
  options?: Pick<MutationOptions, 'idempotencyKey' | 'label'>;
}

/**
 * The transport that carries mutations to your backend. The SDK calls the
 * methods on this interface; you implement them over whatever transport you use —
 * an HTTP API, a WebSocket, or something else.
 */
export interface MutationExecutor {
  /**
   * Commits a batch of mutations atomically and returns the sync
   * acknowledgement. The `options` argument applies to the whole batch, while
   * per-operation `idempotencyKey` and `label` live on each
   * {@link MutationOperation}. The method name matches the `{ type: 'commit' }`
   * frame on the wire.
   */
  commit(
    operations: MutationOperation[],
    options?: MutationOptions,
  ): Promise<CommitResult>;

  /** Execute a create mutation for a specific model */
  executeCreate(
    modelName: string,
    id: string,
    input: Record<string, unknown>,
    clientMutationId?: string,
    options?: MutationOptions,
  ): Promise<void>;

  /** Execute an update mutation for a specific model */
  executeUpdate(
    modelName: string,
    modelId: string,
    data: Record<string, unknown>,
    clientMutationId?: string,
    options?: MutationOptions,
  ): Promise<CommitResult | null>;

  /** Execute a delete mutation for a specific model */
  executeDelete(
    modelName: string,
    modelId: string,
    clientMutationId?: string,
    options?: MutationOptions,
  ): Promise<void>;

  /** Execute an archive mutation for a specific model */
  executeArchive(
    modelName: string,
    modelId: string,
    clientMutationId?: string,
    options?: MutationOptions,
  ): Promise<void>;

  /** Execute an unarchive mutation for a specific model */
  executeUnarchive(
    modelName: string,
    modelId: string,
    clientMutationId?: string,
    options?: MutationOptions,
  ): Promise<void>;

  /** Upload an attachment (optional, not all consumers need this) */
  uploadAttachment?(
    id: string,
    input: Record<string, unknown>
  ): Promise<{ url: string }>;

  /** Batch upload attachments (optional) */
  batchUploadAttachments?(
    items: { id: string; input: Record<string, unknown> }[]
  ): Promise<{ id: string; url: string }[]>;

  /** Delete a subscription entity */
  deleteSubscription?(entityType: string, entityId: string, txId: string): Promise<void>;

  /** Delete a favorite entity */
  deleteFavorite?(modelId: string, txId: string): Promise<void>;

  /** Register a callback for session expiry detection */
  onSessionExpired?(callback: () => void): void;
}

// ─────────────────────────────────────────────
// Sync Engine Configuration
// ─────────────────────────────────────────────

/**
 * Application-specific configuration for the sync engine, describing how your
 * models relate so the engine can order and merge writes correctly.
 */
export interface SyncEngineConfig {
  /**
   * The order in which to create models, so a row is never inserted before the
   * parent row its foreign key points at. Keyed by each model's type name, with
   * lower numbers created first, so parents precede children. The engine fills
   * this in automatically by walking the schema's `belongsTo` relations — a model
   * with no parents gets 10, its children 20, their children 30, and so on,
   * stepping by 10 to leave room for overrides. You rarely set this by hand;
   * override it only when a relation the schema can't see (such as a polymorphic
   * foreign key) imposes an ordering the engine wouldn't otherwise know about.
   */
  modelCreatePriority: ReadonlyMap<string, number>;

  /**
   * The create priority for a model not listed in {@link modelCreatePriority}.
   * It sits in the middle of the range, so an unlisted model is created after
   * declared parents but before declared grandchildren — a safe default.
   */
  defaultCreatePriority: number;

  /**
   * The priority for update, delete, archive, and unarchive operations. These
   * need no ordering among themselves — the row already exists when they run —
   * so this is set higher than any create priority to ensure creates go first.
   */
  defaultNonCreatePriority: number;

  /**
   * Fields to preserve when merging a partial update into the local store. A
   * change usually carries only the fields that changed; listing a model's
   * essential fields here keeps them from being dropped during that merge.
   * For example: `{ Task: ['title', 'projectId'], Slide: ['deckId', 'order'] }`.
   */
  essentialFields: Readonly<Record<string, readonly string[]>>;

  /**
   * A fallback map from class name to model name, used to resolve a model's name
   * when the usual lookup fails — for instance, when a bundler has minified the
   * class names. For example: `{ TaskModel: 'Task', ProjectModel: 'Project' }`.
   */
  classNameFallbackMap: Readonly<Record<string, string>>;

  /**
   * The content hash of the schema this client was built against — the same hash
   * the `ablo push` command and the server compute. It exists only to detect
   * schema drift: if the server reports a different active hash when the client
   * connects, the SDK warns you to run `ablo push`, so drift surfaces as a clear
   * message rather than a confusing database error later. It is advisory, not
   * enforced.
   */
  expectedSchemaHash?: string;
}

// ─────────────────────────────────────────────
// WebSocket Event Configuration
// ─────────────────────────────────────────────

/**
 * Extends the WebSocket event map with your own collaboration events, such as
 * cursor positions or selections, beyond the core delta, presence, and
 * bootstrap events.
 */
export interface WebSocketEventConfig {
  /** Additional event type names beyond the core delta/presence/bootstrap events */
  customEventTypes?: readonly string[];
}
