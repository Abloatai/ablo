/**
 * The interfaces you implement to plug the SDK into your own environment.
 *
 * The SDK depends on these contracts rather than any specific framework, so you
 * provide the concrete implementations — logging, observability, analytics,
 * session-error detection, online-status checks, and the transport that carries
 * mutations to your backend. The SDK ships sensible no-op defaults where it can.
 */

import type { MutationCommitResultInput } from '@abloatai/transaction/commit';
export type { ClaimEvent, ConflictEvent } from '@abloatai/transaction/claims/events';
import type { CoordinationObservability } from '@abloatai/transaction/observability';
export type { CoordinationObservability } from '@abloatai/transaction/observability';

// ─────────────────────────────────────────────
// Logger
// ─────────────────────────────────────────────

// The logging port carries no framework and no local state, so it lives in the
// confirmation core (ADR 0016). Re-exported here so `interfaces` stays the single
// place a consumer looks for the contracts it implements. The `import type` is
// load-bearing: `SyncLogger = Logger` below needs the name bound in this module.
export type { Logger } from '@abloatai/transaction/logger';
import type { Logger } from '@abloatai/transaction/logger';

// ─────────────────────────────────────────────
// Observability
// ─────────────────────────────────────────────

// The transport-facing slice — breadcrumbs and socket errors — moved to the
// confirmation core with the duplex transport (ADR 0016): a socket held for
// claim push must report its lifecycle with no store present. Re-exported
// here so `interfaces` stays the single place a consumer looks; the `import
// type` is load-bearing for `ObservabilityProvider extends` below.
export type {
  BreadcrumbLevel,
  BreadcrumbCategory,
  WebSocketErrorDetails,
  TransportObservability,
} from '@abloatai/transaction/observability';
import type {
  BreadcrumbCategory,
  TransportObservability,
} from '@abloatai/transaction/observability';

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

/** Span attributes for performance monitoring */
export type SpanAttributes = Record<string, string | number | boolean | undefined>;

/**
 * The observability hooks the SDK calls to report its own lifecycle. The SDK
 * ships a no-op default; provide your own to forward these events to a monitoring
 * tool such as Sentry, Datadog, or OpenTelemetry.
 */
export interface ObservabilityProvider
  extends CoordinationObservability,
    TransportObservability {
  /** Set user/org context for error grouping */
  setContext(userId: string, organizationId: string): void;

  /** Update connection state tag */
  setConnectionState(state: 'connected' | 'disconnected' | 'connecting'): void;

  // `breadcrumb` and `captureWebSocketError` are inherited from
  // `TransportObservability` in the core — the duplex transport reports its
  // own lifecycle, with no store present.

  /** Capture optimistic rollback (data reverted) */
  captureRollback(details: RollbackDetails): void;

  /**
   * Capture permanent mutation failure. Named `captureTransactionFailure`
   * before 0.35.0; the rename is announced in that release note rather than
   * aliased, because this member is required — a provider still carrying the
   * old spelling fails to satisfy the interface and the compiler names the
   * member, which an optional alias would only have hidden.
   */
  captureMutationFailure(details: TransactionFailureDetails): void;

  /** Capture bootstrap failure */
  captureBootstrapFailure(error: Error | unknown, details?: BootstrapFailureDetails): void;

  /** Capture reconciliation needed (delta confirmation timeout) */
  captureReconciliation(details: ReconciliationDetails): void;

  /** Capture delta retry exhausted */
  captureDeltaRetryExhausted(details: DeltaRetryExhaustedDetails): void;

  /** Capture self-healing event */
  captureSelfHealing(details: SelfHealingDetails): void;

  // `captureClaim` and `captureConflict` are inherited from
  // `CoordinationObservability` in the core — the confirmation layer reports those
  // two on its own behalf, with no store present.

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

export interface Analytics {
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
  logObservableSetup(modelName: string, observableProps: string[], computedProps: string[]): void;
}

// ─────────────────────────────────────────────
// Mutation Execution (replaces GraphQLClient coupling)
// ─────────────────────────────────────────────

/**
 * Result returned by an injected mutation executor. The input type is inferred
 * from the runtime compatibility schema: legacy `{lastSyncId}` remains valid,
 * while every explicit queued result requires a WAL correlation.
 */
export type MutationCommitResult = MutationCommitResultInput;

// `MutationOptions` describes how a write is issued — request identity, commit
// disposition, and the premise it rests on (optimistic via `readAt`/`reads`, or
// claim-protected via `claimRef`/`fenceToken`) — and holds no local row state,
// so it lives in the confirmation core (ADR 0016). Re-exported here so the
// existing `interfaces` import path keeps resolving.
// The `import type` is load-bearing, not redundant: `export type { X } from`
// re-exports without binding X in this module's scope, and `Pick<X, K>` on an
// unbound X silently yields all-required properties rather than a missing-name
// error at the Pick site.
export type { MutationOptions } from '@abloatai/transaction/client/resources/mutationOptions';
import type { MutationOptions } from '@abloatai/transaction/client/resources/mutationOptions';

/**
 * The subset of {@link MutationOptions} that travels with each write as it is
 * queued offline and sent on the wire. A single shared type keeps the public
 * parameters, the offline queue, and the wire format from diverging. `wait` and
 * `claim` are deliberately absent: both are resolved on the client before a write
 * is staged, so neither reaches this layer.
 */
export type WriteOptions = Pick<
  MutationOptions,
  'readAt' | 'reads' | 'idempotencyKey' | 'label' | 'fenceToken' | 'claimRef'
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
  /** Server-issued claim identity the operation is attributed to. */
  claimId?: string | null;
  readAt?: number | null;
  /**
   * The fencing token (Option B) carried on the wire for this op — the held
   * claim's token, validated against the entity's high-water at commit.
   */
  fenceToken?: number | null;
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
  commit(operations: MutationOperation[], options?: MutationOptions): Promise<MutationCommitResult>;

  /** Execute a create mutation for a specific model */
  executeCreate(
    modelName: string,
    id: string,
    input: Record<string, unknown>,
    clientMutationId?: string,
    options?: MutationOptions
  ): Promise<void>;

  /** Execute an update mutation for a specific model */
  executeUpdate(
    modelName: string,
    modelId: string,
    data: Record<string, unknown>,
    clientMutationId?: string,
    options?: MutationOptions
  ): Promise<MutationCommitResult | null>;

  /** Execute a delete mutation for a specific model */
  executeDelete(
    modelName: string,
    modelId: string,
    clientMutationId?: string,
    options?: MutationOptions
  ): Promise<void>;

  /** Execute an archive mutation for a specific model */
  executeArchive(
    modelName: string,
    modelId: string,
    clientMutationId?: string,
    options?: MutationOptions
  ): Promise<void>;

  /** Execute an unarchive mutation for a specific model */
  executeUnarchive(
    modelName: string,
    modelId: string,
    clientMutationId?: string,
    options?: MutationOptions
  ): Promise<void>;

  /** Upload an attachment (optional, not all consumers need this) */
  uploadAttachment?(id: string, input: Record<string, unknown>): Promise<{ url: string }>;

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
export interface RuntimeConfig {
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
   * For example: `{ Item: ['title', 'projectId'], Section: ['reportId', 'order'] }`.
   */
  essentialFields: Readonly<Record<string, readonly string[]>>;

  /**
   * A fallback map from class name to model name, used to resolve a model's name
   * when the usual lookup fails — for instance, when a bundler has minified the
   * class names. For example: `{ ItemModel: 'Item', ProjectModel: 'Project' }`.
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

  /**
   * Set only when the bound schema is a projection (`selectModels`/`omitModels`):
   * the content hash of the full source schema the subset was cut from. A subset
   * hashes differently from its full schema, so without this a projection-bound
   * client always reports drift against a server running the full schema. The
   * drift check treats the client as in-sync when the server's active hash
   * matches either `expectedSchemaHash` or this source hash. Advisory, like the
   * hash above.
   */
  expectedSourceSchemaHash?: string;

  /**
   * Per-model content hashes of the schema this client was built against,
   * keyed by schema key (`items` → hash of that model's serialized JSON). The
   * semantic layer of the drift check: on a whole-schema mismatch the client
   * compares only the models IT declares against the server's per-model
   * surface, so a purely additive server-side change (new models this build
   * never references) is silence, and real divergence names the exact models.
   * Advisory, like the hashes above.
   */
  expectedModelHashes?: Readonly<Record<string, string>>;
  /** Field shapes paired with expectedModelHashes so drift can name direction, not just a model. */
  expectedModelShapes?: Readonly<Record<string, Readonly<Record<string, { readonly type: string; readonly isOptional: boolean }>>>>;
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

// ── Deprecated aliases (the Sync* prefix family, renamed 2026-07-17) ────────
// The core's plumbing interfaces no longer stamp the consumer's identity.
// One alias each; removed in 0.36.0.

/** @deprecated Renamed to {@link Logger}. Removed in 0.36.0. */
export type SyncLogger = Logger;
/** @deprecated Renamed to {@link ObservabilityProvider}. Removed in 0.36.0. */
export type SyncObservabilityProvider = ObservabilityProvider;
/** @deprecated Renamed to {@link Analytics}. Removed in 0.36.0. */
export type SyncAnalytics = Analytics;
/** @deprecated Renamed to {@link RuntimeConfig}. Removed in 0.36.0. */
export type SyncEngineConfig = RuntimeConfig;
/** @deprecated Renamed to {@link BreadcrumbCategory}. Removed in 0.36.0. */
export type SyncBreadcrumbCategory = BreadcrumbCategory;
