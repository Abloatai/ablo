/**
 * Sync Engine SDK — Dependency Injection Interfaces
 *
 * These interfaces decouple the SDK from any specific app framework.
 * Consumers implement them to wire in their own logging, observability,
 * GraphQL client, session handling, and analytics.
 */

import type { StaleNotification, ReadDependency } from '../coordination/schema.js';


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
// Observability (replaces Sentry coupling)
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

export interface OfflineFlushFailureDetails {
  error: string;
}

/** Span attributes for performance monitoring */
export interface SpanAttributes {
  [key: string]: string | number | boolean | undefined;
}

/**
 * Observability provider — replaces direct Sentry dependency.
 * SDK ships a no-op default; consumers provide their own (e.g., Sentry, Datadog, OpenTelemetry).
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

  /** Capture offline flush failure */
  captureOfflineFlushFailure(details: OfflineFlushFailureDetails): void;

  /** Capture self-healing event */
  captureSelfHealing(details: SelfHealingDetails): void;

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
// Analytics (replaces PostHog coupling)
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
   * Stale-context notifications (CoAgent/MTPO notify-instead-of-abort). Present
   * only when a write guarded with `onStale: 'notify' collided with a
   * concurrent change; the committer self-heals from these rather than
   * receiving an `AbloStaleContextError`. See `StaleNotification`.
   */
  notifications?: StaleNotification[];
}

/**
 * Per-call knobs attached to any mutation. Mirrors Stripe's options
 * object — the last argument of every `stripe.X.Y(...)` call. Optional
 * everywhere; omitted fields fall back to sensible defaults.
 *
 * - `idempotencyKey` — when set, the server caches the response for 24h
 *   and returns the cached value on retries with the same key.
 *   When omitted, the SDK auto-generates a UUIDv4 per mutation so every
 *   call is retry-safe by default. Opt out with `{ idempotencyKey: null }`
 *   if you genuinely want retry-unsafe writes (rare).
 * - `label` — human-readable audit tag. Flows to `mutation_log.label`
 *   server-side for operator debugging ("nightly cleanup", "user click").
 */
export interface MutationOptions {
  idempotencyKey?: string | null;
  label?: string;
  wait?: 'queued' | 'confirmed';
  readAt?: number | null;
  onStale?: 'reject' | 'overwrite' | 'notify' | null;
  /** Claim-pin attribution: the id (or `{ id }`) of the claim this write
   *  belongs to. Distinct from the `claim` HANDLE on the model write params —
   *  this is the low-level reference the commit carries to bypass the holder's
   *  own pin. (Was `intent` before the claim-vocabulary unification.) */
  claimRef?: string | { readonly id: string } | null;
  /**
   * Dormant agent-task lineage field, forwarded as the wire-level
   * `causedByTaskId`. Turns/tasks were removed from the SDK; nothing
   * populates this anymore (write attribution rides on the claim
   * id). Kept optional for wire-compat; always `null` from the client.
   */
  causedByTaskId?: string | null;
  /**
   * Batch-level read dependencies (the STORM "did anything I looked at change?"
   * layer). Each entry is a row (`{model,id,readAt,fields?}`) or a sync group
   * (`{group,readAt}`) this write was premised on; the server validates none
   * moved since `readAt` and fires the entry's `onStale` over the batch.
   * Distinct from per-op `readAt` (which guards only the row being written).
   */
  reads?: ReadDependency[] | null;
}

/**
 * The `MutationOptions` subset carried per-write through the offline
 * transaction lane (SyncClient → TransactionQueue → wire operation).
 * ONE shared type so the proxy's public params, the queue, and the wire
 * can never narrow each other silently again — `wait` and `claim` are
 * deliberately absent because they resolve client-side before staging
 * (`wait` at the proxy's confirmation await, `claim` server-side via
 * the active lease on the entity).
 */
export type WriteOptions = Pick<
  MutationOptions,
  'readAt' | 'onStale' | 'idempotencyKey' | 'label'
>;

/** A single mutation operation in a batch. `options` rides along so the
 *  server can cache+replay via `mutation_log`. */
export interface MutationOperation {
  type: string;
  model: string;
  id: string;
  input?: Record<string, unknown>;
  /**
   * Client-side transaction id for THIS operation. The server stamps
   * it onto the resulting `sync_deltas.transaction_id` so the
   * confirming delta can be recognized as an echo of the local
   * optimistic mutation (echo detection at the receive layer drains
   * the matching id via `OptimisticEchoTracker` and skips the pool
   * mutation — see `SyncClient.applyDeltaBatchToPool`).
   *
   * Distinct from the batch-level `client_tx_id` used by
   * `mutation_log` for idempotency. The mutation_log key dedupes a
   * RETRIED batch (request-level cache); this transactionId
   * identifies a specific MUTATION within a batch (per-row identity
   * for echo matching). Both can coexist on the wire.
   */
  transactionId?: string;
  readAt?: number | null;
  onStale?: 'reject' | 'overwrite' | 'notify' | null;
  /**
   * Per-op idempotency + audit metadata. `idempotencyKey` doubles as
   * the `mutation_log.client_tx_id` cache key; `label` is persisted to
   * `mutation_log.label` for debugging. These are the only `MutationOptions`
   * fields carried over the wire.
   */
  options?: Pick<MutationOptions, 'idempotencyKey' | 'label'>;
}

/**
 * Executes mutations against the backend.
 * The SDK calls this interface; consumers implement it with their
 * specific GraphQL client, REST API, or other transport.
 */
export interface MutationExecutor {
  /**
   * Commit a batch of mutations atomically, returning the sync ack.
   * `options` apply to the whole batch (timeout, retries) — per-op
   * idempotencyKey/label live on each `MutationOperation`.
   *
   * Name matches the wire frame (`{ type: 'commit' }`) and the
   * universal mental model for atomic writes (DB transactions, git,
   * Firestore). Replaces the older `batchAck` name from the retired
   * GraphQL path.
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
    items: Array<{ id: string; input: Record<string, unknown> }>
  ): Promise<Array<{ id: string; url: string }>>;

  /** Delete a subscription entity */
  deleteSubscription?(entityType: string, entityId: string, txId: string): Promise<void>;

  /** Delete a favorite entity */
  deleteFavorite?(modelId: string, txId: string): Promise<void>;

  /** Register a callback for session expiry detection */
  onSessionExpired?(callback: () => void): void;
}

// ─────────────────────────────────────────────
// Offline Mutation Dispatcher
// ─────────────────────────────────────────────

/**
 * Dispatches queued offline mutations on reconnect.
 * Replaces the massive switch statement in OfflineFlush.ts.
 */
export interface MutationDispatcher {
  dispatch(operationName: string, variables: Record<string, unknown>): Promise<void>;
}

// ─────────────────────────────────────────────
// Sync Engine Configuration
// ─────────────────────────────────────────────

/**
 * Application-specific configuration for the sync engine.
 * Replaces the 6 hardcoded config maps that were previously
 * embedded in TransactionQueue, Database, and Model.
 */
export interface SyncEngineConfig {
  /**
   * FK-ordered create priority, keyed by the typename each model reports
   * via {@link Model.getModelName}. `TransactionQueue` consults this at
   * enqueue time and when sorting groups inside a batch — lower numbers
   * execute first, so parents precede children.
   *
   * `createSyncEngine` populates this automatically by topologically
   * walking `belongsTo` relations: a model with no FK parents gets 10, a
   * child gets 20, a grandchild 30, and so on (step = 10 to leave room
   * for consumer overrides). Apps rarely need to touch this — override
   * through `configOverrides.modelCreatePriority` only when the schema's
   * declared relations don't reflect an operational constraint (e.g. a
   * polymorphic FK the SDK can't see).
   */
  modelCreatePriority: ReadonlyMap<string, number>;

  /**
   * Priority assigned to CREATE ops for models missing from
   * {@link modelCreatePriority}. Falls between the typical top and bottom
   * of the FK chain, so an unregistered model ends up later than declared
   * parents but earlier than declared grandchildren — a safe middle.
   */
  defaultCreatePriority: number;

  /**
   * Priority for UPDATE/DELETE/ARCHIVE/UNARCHIVE ops, which don't need FK
   * ordering (the row already exists by the time they run). Must be higher
   * than any realistic CREATE priority so creates drain first.
   */
  defaultNonCreatePriority: number;

  /**
   * Essential fields preserved during partial UPDATE merges in IndexedDB.
   * Prevents losing critical fields when a delta only contains changed fields.
   * e.g., { Task: ['title', 'projectId'], Slide: ['deckId', 'order'] }
   */
  essentialFields: Readonly<Record<string, readonly string[]>>;

  /**
   * Fallback class name → model name mapping for Model.getModelName().
   * Used when the ModelRegistry lookup fails (e.g., minified class names).
   * e.g., { TaskModel: 'Task', ProjectModel: 'Project' }
   */
  classNameFallbackMap: Readonly<Record<string, string>>;
}

// ─────────────────────────────────────────────
// WebSocket Event Configuration
// ─────────────────────────────────────────────

/**
 * Allows consumers to extend the WebSocket event map with
 * application-specific collaboration events (cursors, selections, etc.).
 */
export interface WebSocketEventConfig {
  /** Additional event type names beyond the core delta/presence/bootstrap events */
  customEventTypes?: readonly string[];
}
