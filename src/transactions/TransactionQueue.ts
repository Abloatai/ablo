/**
 * TransactionQueue - Production-ready transaction management
 *
 * Key features:
 * - Optimistic updates with rollback
 * - Conflict resolution strategies
 * - LINEAR-style microtask batching (transactions in same event loop share batchId)
 * - Proper dependency injection (no singleton)
 */

import { EventEmitter } from 'events';
import type { Database } from '../Database.js';
import { Model } from '../Model.js';
import { getContext } from '../context.js';
import { getActiveRegistry } from '../ModelRegistry.js';
import { MutationOperationType } from '../types/index.js';
import { handleMutationError } from './mutation-error-handler.js';
import { AbloError, AbloConnectionError } from '../errors.js';
import type { MutationOptions } from '../interfaces/index.js';

export interface UserContext {
  userId: string;
  organizationId: string;
  role?: string;
  teamIds?: string[];
}

/** Wire-format mutation payload (post-projection). */
type MutationInput = Record<string, unknown>;
type TransactionWriteOptions = Pick<MutationOptions, 'readAt' | 'onStale'>;

/**
 * Framework-internal keys added by `Model.toJSON()` that must never
 * reach the wire. The server treats each top-level key as a target
 * column, so shipping these would blow up the INSERT/UPDATE.
 */
const FRAMEWORK_KEYS = new Set(['__class', '__typename', 'clientId', 'syncStatus']);

/**
 * Project a Model's serialized data onto its schema-declared fields
 * and return a wire-safe commit payload. Two jobs:
 *
 *   1. Drop framework internals (`__class`, `__typename`, `clientId`,
 *      `syncStatus`) and anything not declared on the model's schema.
 *   2. JSON.stringify values typed as `field.json()` — TEXT columns
 *      storing JSON need explicit stringification; postgres.js won't
 *      auto-serialize for non-JSONB columns.
 *
 * For updates (`dropUndefined: true`), `undefined` values are also
 * stripped so they don't translate to `SET column = NULL` on the
 * server side.
 *
 * Fields are read from `ModelRegistry`, populated by
 * `registerModelsFromSchema` at SDK initialization. If the model
 * isn't registered with field metadata (edge case — e.g., tests or
 * manually registered models), projection falls back to identity and
 * the caller gets whatever the Model serialized.
 */
function projectCommitPayload(
  modelName: string,
  source: Record<string, unknown>,
  opts: { dropUndefined: boolean },
): MutationInput {
  const metadata = getActiveRegistry().getMetadata(modelName);
  const fields = metadata?.fields;
  const out: MutationInput = {};

  if (!fields) {
    // Unknown registration — strip framework keys and ship the rest.
    for (const [k, v] of Object.entries(source)) {
      if (FRAMEWORK_KEYS.has(k)) continue;
      if (opts.dropUndefined && v === undefined) continue;
      out[k] = v;
    }
    return out;
  }

  for (const [key, meta] of Object.entries(fields)) {
    if (!(key in source)) continue;
    const value = source[key];
    if (opts.dropUndefined && value === undefined) continue;
    // JSON-typed fields (`jsonb` on the server): ship as OBJECTS over
    // the wire, not pre-stringified strings. Previously we stringified
    // here, which round-tripped incorrectly:
    //
    //   1. Client stringifies `position: {x, y}` → `'{"x":...}'`
    //   2. Server writes to jsonb column (parses string → jsonb object, fine)
    //   3. Server's delta echoes `data: JSON.stringify(op.input)` where
    //      `op.input.position` is still the STRING from step 1
    //   4. Client merges delta → `model.position = "{...}"` (STRING)
    //   5. Next drag: `{ ...layer.position, x, y }` spreads the STRING
    //      char-by-char, producing corrupted char-indexed objects like
    //      `{"0":"{","1":"\"","2":"x",...,"x":null,"y":null,...}`
    //   6. That corrupt object lands in the next commit, stored in jsonb.
    //
    // Sending objects avoids the round-trip mismatch: the wire carries
    // the object through delta + commit unchanged, and `postgres-js`
    // serializes JS objects to jsonb correctly via its own
    // `json.serialize` (triggered by Postgres's ParameterDescription
    // response identifying the column as type 3802 / jsonb).
    out[key] = value;
  }
  return out;
}

export interface Transaction {
  id: string;
  type: 'create' | 'update' | 'delete' | 'archive' | 'unarchive';
  modelName: string;
  modelId: string;
  modelKey: string;
  data?: MutationInput;
  previousData?: MutationInput | null;
  context: UserContext;
  status: 'pending' | 'executing' | 'awaiting_delta' | 'completed' | 'failed' | 'rolled_back';
  createdAt: number;
  attempts: number;
  priority: 'normal' | 'high';
  priorityScore: number; // derived FK-aware priority used for sorting
  writeOptions?: TransactionWriteOptions;
  batchId?: string;
  /** LINEAR PATTERN: syncId threshold - transaction confirms when delta.id >= this value */
  syncIdNeededForCompletion?: number;
  /**
   * Resolves when the server has confirmed this transaction (delta arrived
   * or HTTP ack). Rejects with the originating error if the transaction is
   * permanently rolled back. Name matches the queue's existing `'confirmed'`
   * status vocabulary (`commits.create({wait:'confirmed'})`,
   * `waitForConfirmation`) — gives call sites a single `await` point for
   * "did my write land?", so failures surface at the source instead of
   * leaking via silent pool rollback. The rejection error is the same
   * `AbloError` recorded on the queue's `transaction:failed` event.
   */
  confirmation?: Promise<void>;
}

/**
 * A raw multi-op commit transaction queued via `ablo.commits.create()`.
 *
 * Distinct from the per-model `Transaction` above: operations are
 * pre-built by the caller and the envelope is atomic — no coalescing,
 * no FK reordering, no optimistic local apply. The lane shares the
 * same `mutationExecutor.commit()` underneath as the model-proxy
 * batch path, so reconnect-retry behavior is identical.
 */
interface CommitTransaction {
  id: string;
  kind: 'commit';
  operations: Array<{
    type: string;
    model: string;
    id: string;
    input?: Record<string, unknown>;
    transactionId?: string;
    readAt?: number | null;
    onStale?: 'reject' | 'force' | 'flag' | 'merge' | null;
  }>;
  causedByTaskId?: string | null;
  status: 'pending' | 'executing' | 'completed' | 'failed';
  createdAt: number;
  attempts: number;
  lastSyncId?: number;
  error?: Error;
}

const normalizeModelKey = (modelName: string): string =>
  modelName.replace('Model', '').toLowerCase();
const stripModelSuffix = (modelName: string): string => modelName.replace('Model', '');

/**
 * FK-ordered create priority.
 *
 * Reads `config.modelCreatePriority` out of the runtime SyncEngineContext —
 * this map is populated once at `createSyncEngine(...)` time by walking the
 * schema's `belongsTo` graph (see `computeFKDepthPriority` in
 * `client/createSyncEngine.ts`). The queue stays schema-agnostic: no model
 * names appear here, and consumer applications can override specific
 * priorities via `configOverrides.modelCreatePriority` without touching the
 * SDK.
 *
 * Non-create ops (update/delete/archive/unarchive) don't need FK ordering
 * because the row already exists, so they all share
 * `config.defaultNonCreatePriority`.
 */
const computePriorityScore = (type: Transaction['type'], modelName: string): number => {
  const { modelCreatePriority, defaultCreatePriority, defaultNonCreatePriority } =
    getContext().config;
  if (type !== 'create') return defaultNonCreatePriority;
  return modelCreatePriority.get(modelName) ?? defaultCreatePriority;
};

const TX_TYPE_TO_MUTATION_OP: Record<Transaction['type'], MutationOperationType> = {
  create: MutationOperationType.CREATE,
  update: MutationOperationType.UPDATE,
  delete: MutationOperationType.DELETE,
  archive: MutationOperationType.ARCHIVE,
  unarchive: MutationOperationType.UNARCHIVE,
};

function hasStaleWriteOptions(options?: TransactionWriteOptions): boolean {
  return (
    options?.readAt !== undefined ||
    options?.onStale !== undefined
  );
}

type StaleWriteOperationFields = {
  readAt?: number | null;
  onStale?: 'reject' | 'force' | 'flag' | 'merge' | null;
};

function applyStaleWriteOptions<T extends object>(
  op: T,
  transaction: Transaction,
): T & StaleWriteOperationFields {
  const operation = op as T & StaleWriteOperationFields;
  if (transaction.writeOptions?.readAt !== undefined) {
    operation.readAt = transaction.writeOptions.readAt;
  }
  if (transaction.writeOptions?.onStale !== undefined) {
    operation.onStale = transaction.writeOptions.onStale;
  }
  return operation;
}

/**
 * Structural shape we duck-type against for transport-layer errors.
 * Captures the union of GraphQL-style and HTTP-style error shapes the
 * mutation executor surfaces — kept narrow on purpose so we don't
 * pretend to know fields the runtime won't always supply.
 */
interface TransportError {
  message?: string;
  code?: string | number;
  extensions?: Record<string, unknown>;
  locations?: ReadonlyArray<unknown>;
  path?: ReadonlyArray<string | number>;
  response?: {
    status?: number;
    errors?: ReadonlyArray<{ extensions?: { code?: string }; message?: string }>;
  };
  // Some executors stash a wrapped server message under `error`.
  error?: string;
}

function asTransportError(value: unknown): TransportError {
  return (value && typeof value === 'object' ? value : {}) as TransportError;
}

function extractStatusCode(error: unknown): number | undefined {
  return asTransportError(error).response?.status;
}


interface ConflictResolution {
  strategy: 'last-write-wins' | 'merge' | 'reject' | 'custom';
  resolver?: (local: MutationInput | undefined, remote: MutationInput) => MutationInput;
}

interface TransactionQueueConfig {
  maxBatchSize: number;
  batchDelay: number;
  maxRetries: number;
  conflictResolution: ConflictResolution;
  enablePersistence: boolean;
  enableOptimistic: boolean;
  // Backpressure control (Linear pattern) - prevents overwhelming server
  maxExecutingTransactions: number;
  // Delta confirmation timeout in ms - how long to wait for WebSocket delta before rollback
  // Default: 30000 (30s). Set higher for slow networks.
  deltaConfirmationTimeout: number;
  /**
   * Exponential backoff for retryable server responses (HTTP 429/503).
   * `baseMs` is the first retry delay; each subsequent attempt doubles
   * up to `capMs`. Final delay = min(capMs, baseMs * 2^(attempt-1)) +
   * up to 100ms of jitter. Defaults: 200ms / 1500ms.
   */
  retryBackoff: {
    baseMs: number;
    capMs: number;
  };
  /**
   * Grace window in ms before in-flight commit-lane transactions are
   * failed with `AbloConnectionError` after the WebSocket transitions
   * to `'disconnected'`. Brief disconnects (deploy rotations, mobile
   * jitter) are absorbed transparently; only persistent disconnects
   * surface as failures. Aligned with the 30s convention from the
   * WebSocket reconnection guidance (websocket.org). Set lower for
   * human-interactive consumers (e.g. 10s for chat) or higher for
   * batch workers (e.g. 60s for agent-worker).
   *
   * Without this deadline, `commits.create({wait:'confirmed'})` waits
   * forever when the WS dies mid-flight — see the 2026-05-15 wedge.
   */
  commitOfflineGraceMs: number;
}

class TransactionStore {
  private transactions = new Map<string, Transaction>();
  private byStatus = new Map<string, Set<string>>();

  add(transaction: Transaction): void {
    this.transactions.set(transaction.id, transaction);

    if (!this.byStatus.has(transaction.status)) {
      this.byStatus.set(transaction.status, new Set());
    }
    this.byStatus.get(transaction.status)!.add(transaction.id);
  }

  get(id: string): Transaction | undefined {
    return this.transactions.get(id);
  }

  updateStatus(id: string, newStatus: Transaction['status']): void {
    const tx = this.transactions.get(id);
    if (!tx) return;

    this.byStatus.get(tx.status)?.delete(id);
    tx.status = newStatus;

    if (!this.byStatus.has(newStatus)) {
      this.byStatus.set(newStatus, new Set());
    }
    this.byStatus.get(newStatus)!.add(id);
  }

  getByStatus(status: Transaction['status']): Transaction[] {
    const ids = this.byStatus.get(status) || new Set();
    return Array.from(ids)
      .map((id) => this.transactions.get(id)!)
      .filter(Boolean);
  }

  remove(id: string): void {
    const tx = this.transactions.get(id);
    if (!tx) return;

    this.transactions.delete(id);
    this.byStatus.get(tx.status)?.delete(id);
  }

  clear(): void {
    this.transactions.clear();
    this.byStatus.clear();
  }

  getAll(): Transaction[] {
    return Array.from(this.transactions.values());
  }
}

export class TransactionQueue extends EventEmitter {
  private store = new TransactionStore();
  // Per-instance executor binding. Set by `setMutationExecutor(...)` from the
  // owning Ablo right after construction. Falls back to `getContext()` only
  // when unset (preserves legacy tests / SDK consumers that haven't migrated).
  //
  // Why this exists: `initSyncEngine()` writes a *module-level* singleton.
  // Constructing a second Ablo (e.g. worker + per-job peer in agent-worker)
  // overwrites the first instance's executor. Without an instance binding,
  // queue commits on Ablo A would dispatch through Ablo B's executor closure,
  // which captures B's `storeHolder.store` — and once B disposes its store,
  // that closure returns `null` for `getWs()` and every commit on A throws
  // `ws_not_ready` forever (queue classifies it as transient → retry loop).
  private _mutationExecutor: import('../interfaces/index.js').MutationExecutor | null = null;
  private get mutationExecutor() {
    return this._mutationExecutor ?? getContext().mutationExecutor;
  }

  private executionQueue: Transaction[] = [];
  private isProcessing = false;
  private processTimer?: NodeJS.Timeout;
  private processScheduled = false;

  // LINEAR PATTERN: Staging area for transactions created in same event loop tick
  // All transactions go here first, then get committed together via microtask
  private createdTransactions: Transaction[] = [];
  private commitScheduled = false;

  // Per-model in-flight tracking and merge buffer
  private inFlightByModel = new Set<string>();
  private pendingMergeByModel = new Map<string, any>();

  // Commit lane: pre-built atomic multi-op envelopes from `ablo.commits.create()`.
  // Drained serially (one envelope at a time) since each is atomic; no
  // coalescing with model-proxy transactions.
  private commitLane: CommitTransaction[] = [];
  private commitStore = new Map<string, CommitTransaction>();
  private commitProcessing = false;

  private computePriorityScore(type: Transaction['type'], modelName: string): number {
    return computePriorityScore(type, modelName);
  }

  private ensureDerivedFields(transaction: Transaction): void {
    if (!transaction.modelKey) {
      transaction.modelKey = normalizeModelKey(transaction.modelName);
    }
    if (transaction.priorityScore === undefined) {
      transaction.priorityScore = this.computePriorityScore(
        transaction.type,
        transaction.modelName
      );
    }
  }

  // Merge two GraphQL update payloads with special handling for metadata fields
  private mergeUpdateData(
    left: MutationInput | undefined,
    right: MutationInput | undefined,
    _modelName?: string
  ): MutationInput {
    const out: MutationInput = { ...(left || {}) };
    const src = right || {};

    for (const key of Object.keys(src)) {
      // Special case: metadata payloads may be JSON strings; merge objects instead of clobbering
      if (key === 'metadata') {
        const l = out.metadata;
        const r = src.metadata;

        // If both sides undefined/null, continue
        if (l == null && r == null) {
          continue;
        }

        // Normalize to objects
        const toObj = (v: unknown): Record<string, unknown> => {
          if (v == null) return {};
          if (typeof v === 'string') {
            try {
              return JSON.parse(v);
            } catch {
              return {};
            }
          }
          if (typeof v === 'object') return v as Record<string, unknown>;
          return {};
        };

        const lobj = toObj(l);
        const robj = toObj(r);
        const merged = { ...lobj, ...robj };
        // Re-stringify to match schema input type
        try {
          out.metadata = JSON.stringify(merged);
        } catch {
          // Fallback to right-hand side if stringify fails
          out.metadata = typeof r === 'string' ? r : JSON.stringify(robj || {});
        }
        continue;
      }

      // Default: shallow overwrite with right-hand value
      out[key] = src[key];
    }

    return out;
  }

  // Configuration - tuned for LINEAR-style batching
  // Higher batch size and delay allows more operations to coalesce into single HTTP call
  private config: TransactionQueueConfig = {
    maxBatchSize: 50, // Increased from 10 - matches Linear's batch size
    batchDelay: 150, // Increased from 50ms - more time to coalesce rapid operations
    maxRetries: 3,
    conflictResolution: {
      strategy: 'last-write-wins',
    },
    enablePersistence: true,
    enableOptimistic: true,
    // Backpressure: don't schedule more batches if too many transactions are executing
    maxExecutingTransactions: 100,
    // Delta confirmation initial timeout - first retry fires at 30s
    // On timeout: retries with exponential backoff (30s → 60s → 120s) instead of rolling back
    deltaConfirmationTimeout: 30000,
    retryBackoff: { baseMs: 200, capMs: 1500 },
    commitOfflineGraceMs: 30_000,
  };

  // Track executing transactions for backpressure
  private executingCount = 0;

  // Optimistic update tracking
  private optimisticUpdates = new Map<
    string,
    {
      model: Model;
      previousState: MutationInput | null | undefined;
      transaction: Transaction;
    }
  >();

  // LINEAR PATTERN: Track delta confirmation timeouts for awaiting_delta transactions
  // Following Replicache/PowerSync pattern: retry with backoff instead of rolling back
  private deltaConfirmationTimeouts = new Map<string, ReturnType<typeof setTimeout>>();

  // Track retry attempts per transaction for exponential backoff
  private deltaConfirmationRetries = new Map<string, number>();

  // Connection state check - set by SyncClient to prevent rollbacks during disconnection
  private isConnectedFn: () => boolean = () => true;

  // Grace timer that, when fired, fails any commit-lane transaction
  // still awaiting an ack. Started on `setConnectionState('disconnected')`,
  // cleared on `'connected'`. The reconnect-retry behavior of the queue
  // is preserved for brief blips; this only catches persistent disconnects.
  private commitOfflineGraceTimer: ReturnType<typeof setTimeout> | null = null;

  // Track the highest syncId received from WebSocket deltas
  // Used to immediately confirm transactions when HTTP response arrives AFTER the delta
  // (fixes race condition where WebSocket delta arrives before HTTP response)
  private lastSeenSyncId: number = 0;

  // Delta confirmation retry config (Replicache-style exponential backoff)
  // Max retries before requesting full reconciliation
  private static readonly DELTA_MAX_RETRIES = 5;
  // Initial timeout (first attempt)
  private static readonly DELTA_INITIAL_TIMEOUT_MS = 30_000;
  // Max timeout cap (like Replicache's maxDelayMs of 60s)
  private static readonly DELTA_MAX_TIMEOUT_MS = 120_000;

  // Batch management
  private batchIndex = 0;

  /**
   * Resolvers for per-transaction `confirmation` promises. Populated in
   * `attachConfirmation` at staging time, consumed by the constructor-time
   * listeners on `transaction:completed` / `transaction:failed`. Kept off
   * the Transaction row so the store's iteration order stays plain-data
   * and serialization-friendly.
   */
  private confirmationResolvers = new Map<
    string,
    { resolve: () => void; reject: (err: Error) => void }
  >();

  constructor(config?: Partial<TransactionQueueConfig>) {
    super();

        if (config) {
      this.config = { ...this.config, ...config };
    }

    // Centralized fan-in for `tx.confirmation`. Completion/failure are
    // emitted from ~10 sites (delta confirm, immediate confirm, batch
    // success, permanent error, max_retries_exhausted, …). Subscribing
    // once here keeps every emit site intact and guarantees the call-site
    // promise always settles, regardless of which path produced the
    // terminal state.
    this.on('transaction:completed', (tx: Transaction) => {
      const r = this.confirmationResolvers.get(tx.id);
      if (r) {
        this.confirmationResolvers.delete(tx.id);
        r.resolve();
      }
    });
    this.on(
      'transaction:failed',
      ({ transaction, error }: { transaction: Transaction; error: Error }) => {
        const r = this.confirmationResolvers.get(transaction.id);
        if (r) {
          this.confirmationResolvers.delete(transaction.id);
          r.reject(error);
        }
      }
    );
  }

  /**
   * Look up the in-flight `confirmation` promise for a (model, id) pair.
   * Returns the promise from the most-recent live transaction matching
   * the given model+id, or `Promise.resolve()` if none is open (which
   * means either "already confirmed" or "never staged" — both safe
   * outcomes for the routing-helper grace-window use case).
   *
   * Looks across `pending`, `executing`, and `awaiting_delta` — these
   * are the three non-terminal statuses where rollback is still
   * possible. Skips `completed` (already settled) and `failed` /
   * `rolled_back` (already rejected; the call site missed the
   * `confirmation` window and should rely on `onMutationFailure` toast
   * instead).
   *
   * Distinct from `tx.confirmation` on a known transaction — used by
   * call sites that hold a Model reference (returned by
   * `ablo.<model>.create()`) but never see the underlying transaction.
   */
  confirmationFor(modelName: string, modelId: string): Promise<void> {
    const candidates = [
      ...this.store.getByStatus('pending'),
      ...this.store.getByStatus('executing'),
      ...this.store.getByStatus('awaiting_delta'),
    ].filter(
      (tx) => tx.modelName === modelName && tx.modelId === modelId,
    );
    if (candidates.length === 0) return Promise.resolve();
    const latest = candidates.sort((a, b) => b.createdAt - a.createdAt)[0];
    return latest.confirmation ?? Promise.resolve();
  }

  /**
   * Attach a hot `confirmation` promise to a freshly created transaction.
   * Must be called BEFORE the transaction is staged so the call site can
   * `await tx.confirmation` synchronously after the create/update/delete
   * call returns. Idempotent: returns early if the tx already has one.
   *
   * The unhandled-rejection trap is mandatory — most call sites won't
   * `await confirmation`, and Node/browser would otherwise crash on the
   * rejection. Consumers who *do* want failure visibility just attach a
   * `.then`/`.catch` and the trap becomes a no-op.
   */
  private attachConfirmation(tx: Transaction): void {
    if (tx.confirmation) return;
    tx.confirmation = new Promise<void>((resolve, reject) => {
      this.confirmationResolvers.set(tx.id, { resolve, reject });
    });
    tx.confirmation.catch(() => {
      // Swallow unhandled rejections — explicit consumers attach their own
      // handler; silent failure is the leak we're already fixing elsewhere.
    });
  }

  /**
   * Set connection state checker - prevents rollbacks during disconnection.
   * When disconnected, timeouts re-schedule instead of rolling back.
   */
  setConnectionChecker(fn: () => boolean): void {
    this.isConnectedFn = fn;
  }

  /**
   * Drive the offline-grace timer for in-flight commit-lane transactions.
   *
   * On `'disconnected'`: start a one-shot timer of
   * `config.commitOfflineGraceMs`. If the timer fires (disconnect
   * persisted past grace), iterate every commit-lane transaction with
   * `status ∈ {'pending', 'executing'}` and emit
   * `transaction:failed:${id}` with an `AbloConnectionError`. That
   * lets `waitForCommitReceipt` reject in seconds instead of hanging
   * forever — which is what wedged the 2026-05-15 subagent run.
   *
   * On `'connected'`: clear any pending grace timer. Brief blips are
   * absorbed transparently; the existing reconnect-retry path in
   * `processCommitLane` / `flushOfflineQueue` handles the resumption.
   *
   * Called from SyncClient's `setConnectionState` after the
   * `'connection:disconnected'` / `'connection:established'` events.
   */
  setConnectionState(state: 'connected' | 'disconnected'): void {
    if (state === 'connected') {
      if (this.commitOfflineGraceTimer !== null) {
        clearTimeout(this.commitOfflineGraceTimer);
        this.commitOfflineGraceTimer = null;
      }
      return;
    }
    // state === 'disconnected'
    if (this.commitOfflineGraceTimer !== null) return; // already armed
    const graceMs = this.config.commitOfflineGraceMs;
    this.commitOfflineGraceTimer = setTimeout(() => {
      this.commitOfflineGraceTimer = null;
      this.failInFlightCommitsOnOffline(graceMs);
    }, graceMs);
  }

  private failInFlightCommitsOnOffline(graceMs: number): void {
    const inFlight: string[] = [];
    for (const [id, tx] of this.commitStore.entries()) {
      if (tx.status === 'pending' || tx.status === 'executing') {
        inFlight.push(id);
      }
    }
    if (inFlight.length === 0) return;
    getContext().logger.warn(
      `[TransactionQueue] WS disconnected > ${graceMs}ms; failing ${inFlight.length} in-flight commit(s) with AbloConnectionError`,
      { inFlightIds: inFlight.map((id) => id.slice(0, 8)) },
    );
    for (const id of inFlight) {
      const tx = this.commitStore.get(id);
      if (!tx) continue;
      const err = new AbloConnectionError(
        `commit ack abandoned after ${graceMs}ms offline`,
        { code: 'commit_offline_grace_expired' },
      );
      tx.status = 'failed';
      tx.error = err;
      this.emit(`transaction:failed:${id}`, { error: err });
    }
  }

  /**
   * Bind the executor for this queue instance. Called by the owning Ablo
   * right after `BaseSyncedStore` is constructed so the executor's
   * `storeHolder.store` closure resolves to *this* Ablo's WS — not whichever
   * Ablo most recently called `initSyncEngine()`.
   */
  setMutationExecutor(executor: import('../interfaces/index.js').MutationExecutor): void {
    this._mutationExecutor = executor;
  }

  // ============================================================================
  // LINEAR PATTERN: Microtask-based Transaction Staging
  // ============================================================================
  //
  // All transactions first go to `createdTransactions` staging area.
  // A microtask commits them all together with the same batchIndex.
  // This ensures that bulk operations (like importing 100 layers) are batched efficiently.
  //
  // Flow:
  // 1. create()/update()/delete() calls stageTransaction()
  // 2. stageTransaction() adds to createdTransactions and schedules microtask
  // 3. Microtask runs commitCreatedTransactions() after current sync code completes
  // 4. All staged transactions get same batchIndex and move to executionQueue
  // ============================================================================

  /**
   * Stage a transaction for commit (Linear pattern)
   * Transactions staged in the same event loop tick will be committed together
   */
  private stageTransaction(transaction: Transaction): void {
    this.createdTransactions.push(transaction);
    this.scheduleCommit();
  }

  /**
   * Schedule commit of staged transactions via microtask
   * This ensures all synchronous transaction creates are batched together
   */
  private scheduleCommit(): void {
    if (this.commitScheduled) return;
    this.commitScheduled = true;

    // Use queueMicrotask to run after current sync code completes
    // All transactions created in same event loop will be committed together
    const schedule =
      typeof queueMicrotask === 'function'
        ? queueMicrotask
        : (cb: () => void) => Promise.resolve().then(cb);

    schedule(() => {
      this.commitCreatedTransactions();
    });
  }

  /**
   * Commit all staged transactions to the execution queue (Linear pattern)
   * All transactions get the same batchIndex for efficient batching
   */
  private commitCreatedTransactions(): void {
    this.commitScheduled = false;

    if (this.createdTransactions.length === 0) return;

    // Increment batch index - all transactions in this commit share it
    this.batchIndex++;
    const currentBatchIndex = this.batchIndex;

    // Log batch commit for performance monitoring
    getContext().logger.debug('[TransactionQueue] commitCreatedTransactions', {
      count: this.createdTransactions.length,
      batchIndex: currentBatchIndex,
      types: this.createdTransactions.map((t) => `${t.type}:${t.modelName}`),
    });

    // Move all staged transactions to execution queue
    const staged = this.createdTransactions;
    this.createdTransactions = [];

    for (const transaction of staged) {
      // Assign batch ID based on current batch index
      transaction.batchId = `batch_${currentBatchIndex}`;
      this.enqueue(transaction);
    }
  }

  // Batch flush all pending transactions via commit (fast path on reconnect)
  async flushOfflineQueue(): Promise<void> {
    // Kick the commit lane too — pending atomic envelopes from
    // `commits.create()` were left at the head of the lane while the WS
    // was down. Fire-and-forget; processCommitLane self-serializes.
    void this.processCommitLane();

    // Collect pending transactions in created order
    const pending = this.store.getByStatus('pending').sort((a, b) => a.createdAt - b.createdAt);
    if (pending.length === 0) return;

    // Build operations list
    const operations = pending.map((tx) => {
      this.ensureDerivedFields(tx);
      return applyStaleWriteOptions({
        type: TX_TYPE_TO_MUTATION_OP[tx.type],
        model: tx.modelKey,
        id: tx.modelId,
        input: tx.type === 'create' || tx.type === 'update' ? tx.data || {} : undefined,
      }, tx);
    });

    try {
      const res: any = await this.mutationExecutor.commit(operations);
      // Mark all as completed
      for (const tx of pending) {
        this.store.updateStatus(tx.id, 'completed');
        this.emit('transaction:completed', tx);
        this.emit(`transaction:completed:${tx.id}`, tx);
        this.optimisticUpdates.delete(tx.id);
      }
      // Simple perf note
      getContext().logger.debug('txn:commit', 0, {
        count: pending.length,
        lastSyncId: res?.lastSyncId,
      });
    } catch (err) {
      // If batch fails, fall back to normal processing
      // Only log if we're online (if we're offline, this is expected)
      const isOffline = !getContext().onlineStatus.isOnline();
      const isNetworkError =
        err instanceof Error &&
        (err.message.includes('Failed to fetch') ||
          err.message.includes('Network request failed') ||
          err.message.includes('NetworkError'));

      if (!isOffline || !isNetworkError) {
        getContext().observability.breadcrumb('Batch flush fallback failed', 'sync.transaction', 'warning', {
          error: err instanceof Error ? err.message : String(err),
        });
      }

      // Enqueue pending ones to executionQueue
      for (const tx of pending) {
        this.enqueue(tx);
      }
    }
  }

  /**
   * Create operation with optimistic update
   */
  async create(
    model: Model,
    context: UserContext,
    writeOptions?: TransactionWriteOptions,
  ): Promise<Transaction> {
    const actualModelName = model.getModelName();

    const transaction: Transaction = {
      id: this.generateId(),
      type: 'create',
      modelName: actualModelName,
      modelId: model.id,
      modelKey: normalizeModelKey(actualModelName),
      priorityScore: this.computePriorityScore('create', actualModelName),
      data: this.extractCreateData(model),
      // CREATE rollback removes the row — there is no prior state to
      // restore, so allocating a `toJSON()` snapshot here was waste.
      previousData: null,
      context,
      status: 'pending',
      createdAt: Date.now(),
      attempts: 0,
      priority: 'normal',
      writeOptions,
    };

    this.attachConfirmation(transaction);
    this.store.add(transaction);

    if (this.config.enableOptimistic) {
      this.applyOptimisticCreate(model, transaction);
    }

    // Microtask coalescer (`scheduleCommit`) collapses all creates in
    // this tick into one wire commit with one `batchIndex` — see
    // `commitCreatedTransactions`. No batch API needed at the call site.
    this.stageTransaction(transaction);
    this.emit('transaction:created', transaction);
    return transaction;
  }

  /**
   * Update operation with conflict detection
   * @param precomputedChanges - Optional pre-captured changes (avoids re-reading from model)
   */
  async update(
    model: Model,
    context: UserContext,
    precomputedChanges?: Record<string, unknown>,
    writeOptions?: TransactionWriteOptions,
  ): Promise<Transaction> {
    const actualModelName = model.getModelName();

    // Use pre-computed changes if provided, otherwise extract from model
    const updateInput = precomputedChanges
      ? this.mapChangesToInput(actualModelName, precomputedChanges)
      : this.extractUpdateData(model);
    const previousData = this.extractPreviousData(model, updateInput);
    const modelKey = normalizeModelKey(actualModelName);
    const priorityScore = this.computePriorityScore('update', actualModelName);

    const transaction: Transaction = {
      id: this.generateId(),
      type: 'update',
      modelName: actualModelName,
      modelId: model.id,
      modelKey,
      priorityScore,
      data: updateInput,
      previousData,
      context,
      status: 'pending',
      createdAt: Date.now(),
      attempts: 0,
      priority: this.isReorderPayload(updateInput) ? 'high' : 'normal',
      writeOptions,
    };

    this.attachConfirmation(transaction);
    this.store.add(transaction);

    // Apply optimistic update
    if (this.config.enableOptimistic) {
      this.applyOptimisticUpdate(model, transaction);
    }

    // LINEAR PATTERN: Stage transaction for microtask commit
    // Multiple updates in same event loop will be batched together
    // enqueue() will still apply its coalescing logic for same-entity updates
    this.stageTransaction(transaction);

    this.emit('transaction:created', transaction);
    return transaction;
  }

  /**
   * Delete operation with cascade handling
   */
  async delete(
    model: Model,
    context: UserContext,
    writeOptions?: TransactionWriteOptions,
  ): Promise<Transaction> {
    // 🔧 FIXED: Use getModelName() instead of constructor.name (production-safe)
    const actualModelName = model.getModelName();

    // Skip Activity delete transactions - activities are permanent audit records
    if (actualModelName === 'Activity') {
      getContext().logger.debug(
        'TransactionQueue.delete() skipping Activity deletion - permanent audit records',
        { modelId: model.id }
      );
      const modelKey = normalizeModelKey(actualModelName);
      const priorityScore = this.computePriorityScore('delete', actualModelName);

      const mockTransaction: Transaction = {
        id: this.generateId(),
        type: 'delete',
        modelName: actualModelName,
        modelId: model.id,
        modelKey,
        priorityScore,
        previousData: model.toJSON ? model.toJSON() : { ...model },
        context,
        status: 'completed',
        createdAt: Date.now(),
        attempts: 0,
        priority: 'high',
        writeOptions,
        // Activity deletes complete synchronously (audit-record skip path).
        // Pre-resolved so consumers can still `await tx.confirmation` uniformly.
        confirmation: Promise.resolve(),
      };

      // Apply optimistic delete for UI feedback
      if (this.config.enableOptimistic) {
        this.applyOptimisticDelete(model, mockTransaction);
      }

      this.emit('transaction:created', mockTransaction);
      this.emit('transaction:completed', mockTransaction);
      return mockTransaction;
    }

    const modelKey = normalizeModelKey(actualModelName);
    const priorityScore = this.computePriorityScore('delete', actualModelName);

    const transaction: Transaction = {
      id: this.generateId(),
      type: 'delete',
      modelName: actualModelName,
      modelId: model.id,
      modelKey,
      priorityScore,
      previousData: model.toJSON ? model.toJSON() : { ...model },
      context,
      status: 'pending',
      createdAt: Date.now(),
      attempts: 0,
      priority: 'high', // Deletes are high priority
      writeOptions,
    };

    this.attachConfirmation(transaction);
    this.store.add(transaction);

    // Cancel any pending/in-flight updates for this model to prevent "no rows" errors
    // when the delete executes before the update (race condition fix)
    this.cancelTransactionsForModel(model.id, 'update');
    this.pendingMergeByModel.delete(`${actualModelName}:${model.id}`);
    this.inFlightByModel.delete(`${actualModelName}:${model.id}`);

    // Apply optimistic delete
    if (this.config.enableOptimistic) {
      this.applyOptimisticDelete(model, transaction);
    }

    // LINEAR PATTERN: Stage transaction for microtask commit
    // All deletes in same event loop will be batched together
    this.stageTransaction(transaction);

    this.emit('transaction:created', transaction);
    return transaction;
  }

  /**
   * Upload attachment — delegates to attachment-uploader.ts
   */
  async uploadAttachment(
    _file: File,
    options: { id: string; [key: string]: unknown },
    _context: UserContext
  ): Promise<{ url: string } | null> {
    return this.mutationExecutor.uploadAttachment?.(options.id, options) ?? null;
  }

  /**
   * Batch upload attachments — delegates to MutationExecutor
   */
  async batchUploadAttachments(
    _files: File[],
    items: Array<{ id: string; [key: string]: unknown }>,
    _context: UserContext
  ): Promise<Array<{ id: string; url: string }>> {
    return this.mutationExecutor.batchUploadAttachments?.(items.map(i => ({ id: i.id, input: i }))) ?? [];
  }

  /**
   * Archive operation
   */
  async archive(
    model: Model,
    context: UserContext,
    writeOptions?: TransactionWriteOptions,
  ): Promise<Transaction> {
    // 🔧 FIXED: Use getModelName() instead of constructor.name (production-safe)
    const actualModelName = model.getModelName();
    const modelKey = normalizeModelKey(actualModelName);
    const priorityScore = this.computePriorityScore('archive', actualModelName);

    const transaction: Transaction = {
      id: this.generateId(),
      type: 'archive',
      modelName: actualModelName,
      modelId: model.id,
      modelKey,
      priorityScore,
      previousData: model.toJSON ? model.toJSON() : { ...model },
      context,
      status: 'pending',
      createdAt: Date.now(),
      attempts: 0,
      priority: 'normal',
      writeOptions,
    };

    this.attachConfirmation(transaction);
    this.store.add(transaction);

    // LINEAR PATTERN: Stage transaction for microtask commit
    this.stageTransaction(transaction);

    this.emit('transaction:created', transaction);
    return transaction;
  }

  /**
   * Unarchive operation
   */
  async unarchive(model: Model, context: UserContext): Promise<Transaction> {
    // 🔧 FIXED: Use getModelName() instead of constructor.name (production-safe)
    const actualModelName = model.getModelName();
    const modelKey = normalizeModelKey(actualModelName);
    const priorityScore = this.computePriorityScore('unarchive', actualModelName);

    const transaction: Transaction = {
      id: this.generateId(),
      type: 'unarchive',
      modelName: actualModelName,
      modelId: model.id,
      modelKey,
      priorityScore,
      previousData: model.toJSON ? model.toJSON() : { ...model },
      context,
      status: 'pending',
      createdAt: Date.now(),
      attempts: 0,
      priority: 'normal',
    };

    this.attachConfirmation(transaction);
    this.store.add(transaction);

    // LINEAR PATTERN: Stage transaction for microtask commit
    this.stageTransaction(transaction);

    this.emit('transaction:created', transaction);
    return transaction;
  }

  /**
   * Enqueue transaction for execution
   */
  private enqueue(transaction: Transaction): void {
    this.ensureDerivedFields(transaction);
    const modelKey = `${transaction.modelName}:${transaction.modelId}`;

    // LINEAR PATTERN: Simplified coalescing for updates
    // Staging already batches all transactions in same event loop tick
    // We only need to handle: (1) in-flight merging, (2) same-entity merging
    if (transaction.type === 'update') {
      const preserveWatermark = hasStaleWriteOptions(transaction.writeOptions);
      // If there is an in-flight update for this model, merge into post-flight buffer
      if (!preserveWatermark && this.inFlightByModel.has(modelKey)) {
        const prev = this.pendingMergeByModel.get(modelKey) || {};
        const merged = this.mergeUpdateData(prev, transaction.data || {}, transaction.modelName);
        this.pendingMergeByModel.set(modelKey, merged);
        this.store.remove(transaction.id);
        return;
      }

      // If there's a pending update for same model in execution queue, merge into it
      const pendingInQueue = this.executionQueue.find(
        (t) =>
          t.id !== transaction.id &&
          t.type === 'update' &&
          t.modelId === transaction.modelId &&
          t.modelName === transaction.modelName &&
          !hasStaleWriteOptions(t.writeOptions)
      );
      if (!preserveWatermark && pendingInQueue) {
        pendingInQueue.data = this.mergeUpdateData(
          pendingInQueue.data || {},
          transaction.data || {},
          transaction.modelName
        );
        this.store.remove(transaction.id);
        return;
      }
    }

    // Add to execution queue based on priority
    if (transaction.priority === 'high') {
      this.executionQueue.unshift(transaction);
    } else {
      this.executionQueue.push(transaction);
    }

    this.scheduleProcessing(transaction.priority === 'high');
  }

  private scheduleProcessing(immediate = false): void {
    if (this.processScheduled) return;

    // BACKPRESSURE: Don't schedule if too many transactions are already executing
    // This prevents overwhelming the server with concurrent requests (Linear pattern)
    if (this.executingCount >= this.config.maxExecutingTransactions) {
      getContext().logger.debug('[TransactionQueue] Backpressure: delaying batch, too many executing', {
        executingCount: this.executingCount,
        max: this.config.maxExecutingTransactions,
      });
      return;
    }

    this.processScheduled = true;

    if (immediate || (this.config.batchDelay ?? 0) <= 0) {
      const schedule =
        typeof queueMicrotask === 'function'
          ? queueMicrotask
          : (cb: () => void) => Promise.resolve().then(cb);
      schedule(() => {
        this.processScheduled = false;
        void this.processBatch();
      });
      return;
    }

    const delay = Math.max(0, this.config.batchDelay);
    this.processTimer = setTimeout(() => {
      this.processTimer = undefined;
      this.processScheduled = false;
      void this.processBatch();
    }, delay);
  }

  /**
   * Process batch of transactions using LINEAR-style unified batch execution.
   *
   * Key optimization: Instead of making separate calls per operation type/model,
   * we collect ALL batchable operations and send them in a SINGLE commit call.
   * The sync-server handles mixed types atomically inside one transaction.
   *
   * This reduces N round-trips to 1, dramatically improving batch latency.
   */
  private async processBatch(): Promise<void> {
    const batchStart = typeof performance !== 'undefined' ? performance.now() : Date.now();

    if (this.isProcessing || this.executionQueue.length === 0) {
      return;
    }

    this.isProcessing = true;

    // Declare batch outside try so it's accessible in finally for backpressure tracking
    let batch: Transaction[] = [];

    await getContext().observability.startSpanAsync(
      'sync.batch',
      'sync.transaction.batch',
      async () => {
        try {
          // Sort executionQueue by FK priority before batch selection
          // This ensures parent entities (Layout, SlideLayout) are always processed
          // before their children (SlideLayoutLayer) across batch boundaries
          this.executionQueue.sort((a, b) => {
            // Ensure derived fields exist (covers restored/persisted transactions)
            this.ensureDerivedFields(a);
            this.ensureDerivedFields(b);
            return a.priorityScore - b.priorityScore;
          });

          // Get batch (now guaranteed to have parent entities before children)
          batch = this.executionQueue.splice(0, this.config.maxBatchSize);

          // Track executing count for backpressure
          this.executingCount += batch.length;

          // Mark all as executing
          for (const tx of batch) {
            const key = `${tx.modelName}:${tx.modelId}`;
            if (tx.type === 'update') this.inFlightByModel.add(key);
            this.store.updateStatus(tx.id, 'executing');
          }

          // Build ALL operations for unified commit (SINGLE WS round-trip)
          const batchOps: Array<{
            tx: Transaction;
            op: {
              type: MutationOperationType;
              model: string;
              id: string;
              input?: Record<string, unknown>;
              transactionId: string;
              readAt?: number | null;
              onStale?: 'reject' | 'force' | 'flag' | 'merge' | null;
            };
          }> = [];

          for (const tx of batch) {
            // Per-op `transactionId` carries the local tx UUID through
            // the wire so the server can stamp it on the resulting
            // sync delta. The receive path (`SyncClient.applyDeltaBatchToPool`)
            // matches it via `OptimisticEchoTracker.consumeEcho` to suppress
            // double-applying optimistic mutations. Distinct from the
            // batch-level idempotency key in mutation_log.
            const op = applyStaleWriteOptions({
              type: TX_TYPE_TO_MUTATION_OP[tx.type],
              model: tx.modelKey,
              id: tx.modelId,
              input: tx.type === 'create' || tx.type === 'update' ? tx.data || {} : undefined,
              transactionId: tx.id,
            }, tx);
            batchOps.push({ tx, op });
          }

          // Execute unified commit for ALL operations (SINGLE WS round-trip)
          if (batchOps.length > 0) {
            const operations = batchOps.map(({ op }) => op);

            try {
              // LINEAR PATTERN: Capture lastSyncId from server response for threshold-based confirmation
              //
              // Idempotency note: the default HTTP executor derives a
              // stable `Idempotency-Key` from the operations array
              // itself (sorted sha256), so retries of the SAME batch
              // hit the server's `mutation_log` replay path without
              // requiring us to thread a key through the microtask
              // boundary here. Keeping this path await-free preserves
              // the coalescing test's tight bound on batch count.
              const result = await this.mutationExecutor.commit(operations);
              const lastSyncId: number = result?.lastSyncId ?? 0;

              // Detect server bug: lastSyncId 0 means mutation succeeded but no sync delta was emitted
              if (lastSyncId === 0) {
                getContext().observability.captureCommitZeroSyncId({
                  operationCount: operations.length,
                  operations: operations.map(
                    (op) => `${op.type}:${op.model}:${op.id?.slice(0, 8) ?? '?'}`
                  ),
                });
              }

              // LINEAR PATTERN: Mark as awaiting_delta with syncId threshold
              // Transactions will be confirmed when any delta with id >= lastSyncId arrives
              for (const { tx } of batchOps) {
                tx.syncIdNeededForCompletion = lastSyncId;

                // Safety net: when lastSyncId is 0, DELETE transactions should be confirmed
                // immediately. DELETEs are idempotent — if no delta was emitted, the entity
                // is already gone and the intent was achieved. Parking DELETEs in awaiting_delta
                // with threshold 0 causes 30s reconciliation delays.
                if (lastSyncId === 0 && tx.type === 'delete') {
                  this.store.updateStatus(tx.id, 'completed');
                  this.emit('transaction:completed', tx);
                  this.emit(`transaction:completed:${tx.id}`, tx);
                  this.optimisticUpdates.delete(tx.id);
                  getContext().logger.debug('tx:confirm_delete_zero_syncid', {
                    txId: tx.id.slice(0, 8),
                    model: tx.modelName,
                    reason: 'delete_idempotent_no_delta',
                  });
                  continue;
                }

                // FIX: Check if delta already arrived before HTTP response (race condition)
                // WebSocket can be faster than HTTP, so the delta might already be here
                // Guard: only do immediate confirm if lastSyncId > 0 (valid server response)
                if (lastSyncId > 0 && this.lastSeenSyncId >= lastSyncId) {
                  // Delta already arrived! Confirm immediately without timeout
                  this.store.updateStatus(tx.id, 'completed');
                  this.emit('transaction:completed', tx);
                  this.emit(`transaction:completed:${tx.id}`, tx);
                  this.optimisticUpdates.delete(tx.id);
                  getContext().logger.debug('tx:confirm_immediate', {
                    txId: tx.id.slice(0, 8),
                    model: tx.modelName,
                    neededSyncId: lastSyncId,
                    lastSeenSyncId: this.lastSeenSyncId,
                    reason: 'delta_arrived_before_http',
                  });
                } else {
                  // Delta hasn't arrived yet, wait for it
                  this.store.updateStatus(tx.id, 'awaiting_delta');
                  getContext().logger.debug('tx:awaiting_delta', {
                    txId: tx.id.slice(0, 8),
                    model: tx.modelName,
                    neededSyncId: lastSyncId,
                    lastSeenSyncId: this.lastSeenSyncId,
                    gap: lastSyncId - this.lastSeenSyncId,
                  });

                  // Schedule timeout-based rollback for unconfirmed transactions
                  this.scheduleDeltaConfirmationTimeout(tx, this.config.deltaConfirmationTimeout);
                }
              }
            } catch (error) {
              const errorMessage = (error as Error).message || '';
              // Surface the raw server rejection for the whole batch so
              // cascaded failures (e.g. Layout FK violation that rolls
              // back a 6-op transaction) are attributable to a specific
              // cause instead of each op showing as a generic permanent
              // error downstream.
              const abloErr = error instanceof AbloError ? error : undefined;
              // SyncWebSocket attaches a `diagnostics` snapshot to its
              // "not connected" / "closed while in flight" rejections.
              // Surface it here so the warn line attributes the drop to
              // a specific cause (handshake reject, heartbeat zombie,
              // session expiry, …) instead of just "AbloConnectionError".
              const readDiagnostics = (e: unknown): unknown => {
                let cur: unknown = e;
                // Walk up to 3 wrap layers (current err → its cause → its
                // cause's cause) so diagnostics survive AbloConnectionError
                // wrapping in Ablo.commit() and any future wrappers.
                for (let i = 0; i < 3 && cur && typeof cur === 'object'; i++) {
                  if ('diagnostics' in cur && (cur as { diagnostics?: unknown }).diagnostics) {
                    return (cur as { diagnostics: unknown }).diagnostics;
                  }
                  cur = (cur as { cause?: unknown }).cause;
                }
                return undefined;
              };
              const diagnostics = readDiagnostics(error);
              getContext().logger.warn('[TransactionQueue] Batch commit rejected', {
                batchSize: batchOps.length,
                models: batchOps.map(({ op }) => `${op.type}:${op.model}`),
                errorType: abloErr?.type ?? (error as Error)?.name,
                errorCode: abloErr?.code,
                httpStatus: abloErr?.httpStatus,
                requestId: abloErr?.requestId,
                message: errorMessage,
                diagnostics,
              });

              // LINEAR PATTERN: Handle "no rows in result set" gracefully
              // This error means the entity was already deleted - for UPDATE/DELETE ops, this is success
              // The intent was achieved (the data doesn't exist), so treat as completed
              if (errorMessage.includes('no rows in result set')) {
                getContext().logger.info('[TransactionQueue] Graceful handling: entity already deleted', {
                  batchSize: batchOps.length,
                });

                for (const { tx, op } of batchOps) {
                  if (op.type === 'UPDATE' || op.type === 'DELETE') {
                    // Entity gone = intent achieved, mark as completed
                    this.store.updateStatus(tx.id, 'completed');
                    this.emit('transaction:completed', tx);

                    getContext().logger.debug('[TransactionQueue] Orphaned transaction treated as success', {
                      txId: tx.id.slice(0, 12),
                      model: tx.modelName,
                      type: op.type,
                    });
                  } else {
                    // CREATE operations on non-existent parent are real failures
                    await this.handleFailure(tx, error as Error);
                  }
                }
              } else {
                // Handle other batch failures - mark all as failed
                for (const { tx } of batchOps) {
                  await this.handleFailure(tx, error as Error);
                }
              }
            }
          }

          // Handle post-execution merge for updates
          for (const tx of batch) {
            const key = `${tx.modelName}:${tx.modelId}`;
            if (tx.type === 'update') {
              this.inFlightByModel.delete(key);
              const pending = this.pendingMergeByModel.get(key);
              if (pending && Object.keys(pending).length > 0) {
                // Create a single merged follow-up transaction
                const followUp: Transaction = {
                  id: this.generateId(),
                  type: 'update',
                  modelName: tx.modelName,
                  modelId: tx.modelId,
                  modelKey: tx.modelKey ?? normalizeModelKey(tx.modelName),
                  data: pending,
                  previousData: undefined,
                  context: tx.context,
                  status: 'pending',
                  createdAt: Date.now(),
                  attempts: 0,
                  priority: 'normal',
                  priorityScore: this.computePriorityScore('update', tx.modelName),
                };
                this.pendingMergeByModel.delete(key);
                this.store.add(followUp);
                this.enqueue(followUp);
              }
            }
          }
        } finally {
          this.isProcessing = false;

          // Decrement executing count for backpressure tracking
          this.executingCount -= batch.length;

          // Process next batch if needed
          if (this.executionQueue.length > 0) {
            this.scheduleProcessing(true);
          }

          const batchEnd = typeof performance !== 'undefined' ? performance.now() : Date.now();
          getContext().logger.debug('txn:batch', batchEnd - batchStart, {
            maxBatchSize: this.config.maxBatchSize,
            remaining: this.executionQueue.length,
            executingCount: this.executingCount,
          });
        }
      },
      { batchSize: this.executionQueue.length + (batch?.length ?? 0) }
    );
  }

  /**
   * LINEAR PATTERN: Confirm all awaiting transactions when delta with syncId >= threshold arrives.
   * This replaces clientMutationId echoing - transactions are confirmed by sync ID threshold.
   * @param syncId - The sync ID of the received delta
   */
  onDeltaReceived(syncId: number): void {
    const prevLastSeen = this.lastSeenSyncId;

    // Track highest syncId seen (fixes race: delta arrives before HTTP response)
    if (syncId > this.lastSeenSyncId) {
      this.lastSeenSyncId = syncId;
      getContext().logger.debug('tx:highwater_update', {
        prev: prevLastSeen,
        new: syncId,
        delta: syncId - prevLastSeen,
      });
    }

    const awaitingTxs = this.store.getByStatus('awaiting_delta');
    const executingTxs = this.store.getByStatus('executing');

    // Debug: Show state when delta arrives
    if (awaitingTxs.length > 0 || executingTxs.length > 0) {
      getContext().logger.debug('tx:delta_received', {
        syncId,
        lastSeenSyncId: this.lastSeenSyncId,
        awaitingCount: awaitingTxs.length,
        executingCount: executingTxs.length,
        awaitingThresholds: awaitingTxs.map((tx) => ({
          txId: tx.id.slice(0, 8),
          model: tx.modelName,
          needed: tx.syncIdNeededForCompletion,
          willConfirm:
            tx.syncIdNeededForCompletion !== undefined && syncId >= tx.syncIdNeededForCompletion,
        })),
      });
    }

    // Fast path: no awaiting transactions
    if (awaitingTxs.length === 0) return;

    let confirmedCount = 0;

    for (const tx of awaitingTxs) {
      // Confirm if this delta's ID meets or exceeds the threshold
      if (tx.syncIdNeededForCompletion !== undefined && syncId >= tx.syncIdNeededForCompletion) {
        this.cancelDeltaConfirmationTimeout(tx.id);
        this.store.updateStatus(tx.id, 'completed');
        this.emit('transaction:completed', tx);
        this.emit(`transaction:completed:${tx.id}`, tx);
        this.optimisticUpdates.delete(tx.id);
        confirmedCount++;

        getContext().logger.debug('tx:confirm_via_delta', {
          txId: tx.id.slice(0, 8),
          model: tx.modelName,
          neededSyncId: tx.syncIdNeededForCompletion,
          receivedSyncId: syncId,
        });
      }
    }

    // Log batch summary only if we confirmed something
    if (confirmedCount > 0) {
      // Use warn for staging visibility when transactions confirm
      getContext().observability.breadcrumb('Transactions confirmed via delta', 'sync.transaction', 'info', {
        count: confirmedCount,
        syncId,
        remainingAwaiting: awaitingTxs.length - confirmedCount,
      });
    }
  }

  // REPLICACHE/POWERSYNC PATTERN: Schedule delta confirmation with retry + reconciliation
  // Instead of rolling back on timeout (which destroys confirmed server state),
  // retry with exponential backoff and request reconciliation to catch up on missed deltas.
  // Only rollback on explicit server rejection, never on timeout.
  private scheduleDeltaConfirmationTimeout(tx: Transaction, timeoutMs: number): void {
    // Cancel any existing timeout for this transaction
    this.cancelDeltaConfirmationTimeout(tx.id);

    const timeoutHandle = setTimeout(async () => {
      const currentTx = this.store.get(tx.id);
      if (!currentTx || currentTx.status !== 'awaiting_delta') {
        this.deltaConfirmationRetries.delete(tx.id);
        return; // Already confirmed or failed
      }

      // If disconnected, re-schedule with same timeout (no backoff while offline)
      if (!this.isConnectedFn()) {
        getContext().logger.warn('[TransactionQueue] Timeout fired while disconnected - re-scheduling', {
          txId: tx.id.slice(0, 8),
          model: tx.modelName,
        });
        this.deltaConfirmationTimeouts.delete(tx.id);
        this.scheduleDeltaConfirmationTimeout(tx, timeoutMs);
        return;
      }

      const retryCount = this.deltaConfirmationRetries.get(tx.id) ?? 0;
      const diagnosis =
        this.lastSeenSyncId === 0
          ? 'No deltas received - delta pipeline may be broken'
          : currentTx.syncIdNeededForCompletion &&
              this.lastSeenSyncId < currentTx.syncIdNeededForCompletion
            ? 'Delta not yet received - may be lost or delayed'
            : 'Delta should have confirmed - possible race condition';

      getContext().observability.captureReconciliation({
        reason: 'delta_timeout',
        model: tx.modelName,
        modelId: tx.modelId,
        syncIdNeeded: currentTx.syncIdNeededForCompletion,
        lastSeenSyncId: this.lastSeenSyncId,
        retryCount,
        connectionState: this.isConnectedFn() ? 'connected' : 'disconnected',
      });

      if (retryCount < TransactionQueue.DELTA_MAX_RETRIES) {
        // RETRY: Request reconciliation and re-schedule with exponential backoff
        // The server already committed this mutation — we just need the delta to arrive
        this.deltaConfirmationRetries.set(tx.id, retryCount + 1);
        this.deltaConfirmationTimeouts.delete(tx.id);

        // Exponential backoff: 30s → 60s → 120s → 120s → 120s (capped)
        const nextTimeout = Math.min(timeoutMs * 2, TransactionQueue.DELTA_MAX_TIMEOUT_MS);

        // Emit reconciliation request so SyncedStore can cycle the WebSocket
        // to trigger delta catch-up from the server
        this.emit('reconciliation:needed', {
          reason: 'delta_confirmation_timeout',
          txId: tx.id,
          model: tx.modelName,
          modelId: tx.modelId,
          syncIdNeeded: currentTx.syncIdNeededForCompletion,
          lastSeenSyncId: this.lastSeenSyncId,
          retryCount: retryCount + 1,
        });

        getContext().logger.warn('[TransactionQueue] Re-scheduling with backoff', {
          txId: tx.id.slice(0, 8),
          model: tx.modelName,
          nextTimeoutMs: nextTimeout,
          retry: retryCount + 1,
        });

        this.scheduleDeltaConfirmationTimeout(tx, nextTimeout);
      } else {
        // LINEAR PATTERN: Retries exhausted — persist to IndexedDB instead of rolling back.
        // The transaction succeeded on the server (HTTP 200), so the data exists server-side.
        // Persist the awaiting state so it survives tab close. On next session, the WebSocket
        // reconnect + delta catch-up will naturally confirm it (like Linear's IndexedDB caching).
        this.deltaConfirmationRetries.delete(tx.id);
        this.deltaConfirmationTimeouts.delete(tx.id);

        getContext().observability.captureDeltaRetryExhausted({
          txId: tx.id,
          model: tx.modelName,
          modelId: tx.modelId,
          retryCount: TransactionQueue.DELTA_MAX_RETRIES,
          syncIdNeeded: currentTx.syncIdNeededForCompletion,
        });

        // Emit persist event — SyncClient handles the IDB write
        this.emit('transaction:persist_awaiting', {
          txId: tx.id,
          model: tx.modelName,
          modelId: tx.modelId,
          operationType: tx.type,
          syncIdNeeded: currentTx.syncIdNeededForCompletion,
        });

        // Also request one final reconciliation cycle
        this.emit('reconciliation:needed', {
          reason: 'delta_retries_exhausted',
          txId: tx.id,
          model: tx.modelName,
          modelId: tx.modelId,
          syncIdNeeded: currentTx.syncIdNeededForCompletion,
          lastSeenSyncId: this.lastSeenSyncId,
          retryCount: TransactionQueue.DELTA_MAX_RETRIES,
        });
      }
    }, timeoutMs);

    this.deltaConfirmationTimeouts.set(tx.id, timeoutHandle);
  }

  // Cancel a pending delta confirmation timeout and clean up retry tracking
  private cancelDeltaConfirmationTimeout(id: string): void {
    const timeoutHandle = this.deltaConfirmationTimeouts.get(id);
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
      this.deltaConfirmationTimeouts.delete(id);
    }
    this.deltaConfirmationRetries.delete(id);
  }

  /**
   * Wait for a transaction to be confirmed via delta echo (Linear pattern)
   * Reuses existing timeout mechanism from scheduleDeltaConfirmationTimeout
   */
  waitForConfirmation(transactionId: string): Promise<void> {
    return new Promise((resolve, reject) => {
      // Check if already completed
      const tx = this.store.get(transactionId);
      if (tx?.status === 'completed') {
        resolve();
        return;
      }

      const onCompleted = () => {
        cleanup();
        resolve();
      };

      const onFailed = ({ error }: { error: Error }) => {
        cleanup();
        reject(error);
      };

      const cleanup = () => {
        this.off(`transaction:completed:${transactionId}`, onCompleted);
        this.off(`transaction:failed:${transactionId}`, onFailed);
      };

      // Listen to existing events (timeout already handled by scheduleDeltaConfirmationTimeout)
      this.on(`transaction:completed:${transactionId}`, onCompleted);
      this.on(`transaction:failed:${transactionId}`, onFailed);
    });
  }

  // Public: check if a clientMutationId exists in this queue (helps identify self-echo deltas)
  hasClientMutationId(id: string): boolean {
    return !!this.store.get(id) || this.commitStore.has(id);
  }

  /**
   * Enqueue a raw multi-op atomic commit envelope (the `ablo.commits.create`
   * path). Operations are pre-built by the caller; the queue's job is
   * retry-on-reconnect + idempotent dedup, NOT optimistic apply or FK
   * ordering. Same idempotency key (clientTxId) is dropped on the floor
   * if already in flight — server-side `mutation_log` handles cross-session
   * dedup; this guard handles same-session double-enqueue.
   */
  enqueueCommit(
    clientTxId: string,
    operations: CommitTransaction['operations'],
    options: { causedByTaskId?: string | null } = {},
  ): void {
    if (this.commitStore.has(clientTxId)) return;
    const tx: CommitTransaction = {
      id: clientTxId,
      kind: 'commit',
      operations: [...operations],
      causedByTaskId: options.causedByTaskId ?? null,
      status: 'pending',
      createdAt: Date.now(),
      attempts: 0,
    };
    this.commitStore.set(clientTxId, tx);
    this.commitLane.push(tx);
    void this.processCommitLane();
  }

  /**
   * Drain pending commit-lane envelopes serially. Transient failures
   * (network, ws_not_ready) leave the head-of-queue tx in `pending` and
   * break — reconnect handler re-kicks via `flushOfflineQueue`.
   * Permanent failures emit `transaction:failed:<id>` and drop the tx.
   */
  private async processCommitLane(): Promise<void> {
    if (this.commitProcessing) return;
    this.commitProcessing = true;
    try {
      while (this.commitLane.length > 0) {
        const tx = this.commitLane[0];
        if (tx.status !== 'pending') {
          this.commitLane.shift();
          continue;
        }
        tx.status = 'executing';
        tx.attempts += 1;
        try {
          const result = await this.mutationExecutor.commit(tx.operations, {
            idempotencyKey: tx.id,
            causedByTaskId: tx.causedByTaskId ?? undefined,
          });
          tx.lastSyncId = result?.lastSyncId ?? 0;
          tx.status = 'completed';
          this.commitLane.shift();
          this.emit('transaction:completed', tx);
          this.emit(`transaction:completed:${tx.id}`, tx);
        } catch (err) {
          const error = err instanceof Error ? err : new Error(String(err));
          if (!this.isPermanentError(error)) {
            // Transient — leave at head, retry on next kick (reconnect or
            // next enqueueCommit). Don't tight-loop while WS is down.
            tx.status = 'pending';
            getContext().logger.debug('[TransactionQueue] commit lane transient', {
              txId: tx.id.slice(0, 12),
              attempts: tx.attempts,
              message: error.message,
            });
            break;
          }
          tx.status = 'failed';
          tx.error = error;
          this.commitLane.shift();
          getContext().logger.warn('[TransactionQueue] commit lane permanent error', {
            txId: tx.id.slice(0, 12),
            attempts: tx.attempts,
            message: error.message,
          });
          this.emit('transaction:failed', { transaction: tx, error, permanent: true });
          this.emit(`transaction:failed:${tx.id}`, { error });
        }
      }
    } finally {
      this.commitProcessing = false;
    }
  }

  /**
   * Promise-based confirmation for a commit-lane transaction. Resolves
   * with the server-side `lastSyncId` once `mutation_result` lands;
   * rejects on permanent failure. Backs the `wait: 'confirmed'` semantics
   * of `ablo.commits.create()`.
   */
  waitForCommitReceipt(clientTxId: string): Promise<{ lastSyncId: number }> {
    return new Promise((resolve, reject) => {
      const existing = this.commitStore.get(clientTxId);
      if (existing?.status === 'completed') {
        resolve({ lastSyncId: existing.lastSyncId ?? 0 });
        return;
      }
      if (existing?.status === 'failed' && existing.error) {
        reject(existing.error);
        return;
      }
      const onCompleted = (tx: CommitTransaction) => {
        cleanup();
        resolve({ lastSyncId: tx.lastSyncId ?? 0 });
      };
      const onFailed = ({ error }: { error: Error }) => {
        cleanup();
        reject(error);
      };
      const cleanup = () => {
        this.off(`transaction:completed:${clientTxId}`, onCompleted);
        this.off(`transaction:failed:${clientTxId}`, onFailed);
      };
      this.on(`transaction:completed:${clientTxId}`, onCompleted);
      this.on(`transaction:failed:${clientTxId}`, onFailed);
    });
  }

  private isReorderPayload(data: MutationInput | undefined): boolean {
    if (!data || typeof data !== 'object') return false;
    return 'order' in data || 'orderKey' in data || 'position' in data;
  }

  /**
   * Determine if an error is transient (retryable) vs permanent (non-retryable).
   *
   * IMPORTANT: Uses a BLOCKLIST approach for safety - only retry on known transient errors.
   * Any unknown error type defaults to permanent (don't retry) to prevent infinite loops.
   *
   * Transient errors (will retry):
   * - Network failures, connection errors, timeouts
   * - Server errors (5xx status codes)
   * - Rate limiting (429)
   *
   * Permanent errors (won't retry - includes but not limited to):
   * - Validation errors, constraint violations
   * - Not found, unauthorized, forbidden
   * - Any other business logic error from the server
   */
  private isPermanentError(error: Error): boolean {
    // Typed connection error (e.g. ws_not_ready, transport timeout) is
    // always transient — the message text varies ("SyncWebSocket not
    // connected", "commit timed out after ...") and string-matching them
    // is brittle. Class identity is the right signal.
    if (error instanceof AbloConnectionError) {
      return false;
    }

    const message = error?.message?.toLowerCase() || '';

    // Network/connection errors are transient - retry these
    const isNetworkError =
      message.includes('failed to fetch') ||
      message.includes('network error') ||
      message.includes('networkerror') ||
      message.includes('connection refused') ||
      message.includes('connection reset') ||
      message.includes('timeout') ||
      message.includes('econnrefused') ||
      message.includes('econnreset') ||
      message.includes('etimedout') ||
      message.includes('socket hang up');

    if (isNetworkError) {
      return false; // Transient - retry
    }

    // Check HTTP status codes
    const status = extractStatusCode(error);

    // 5xx server errors and 429 rate limiting are transient - retry
    if (status !== undefined) {
      if (status >= 500 || status === 429) {
        return false; // Transient - retry
      }
      // Any other status code (4xx except 429) is permanent
      return true;
    }

    // GraphQL errors with HTTP 200 but error payload are permanent
    // These are validation/business logic errors that won't change on retry
    const responseErrors = asTransportError(error).response?.errors;
    if (Array.isArray(responseErrors) && responseErrors.length > 0) {
      return true; // Permanent - don't retry
    }

    // Default: treat unknown errors as permanent to prevent infinite loops
    // This is the safe default - better to fail fast than retry forever
    return true;
  }

  /**
   * Handle transaction failure
   */
  private async handleFailure(transaction: Transaction, error: Error): Promise<void> {
    transaction.attempts++;

    // Check if this is a permanent error that should NOT be retried
    if (this.isPermanentError(error)) {
      // Elevated to warn — permanent errors mean user writes were rejected
      // by the server, so the user should be able to see WHY in the
      // console (not just via Sentry). Include the typed AbloError fields
      // so the cause is visible: `type`/`code`/`httpStatus` are what
      // distinguish e.g. FK-violation (AbloValidationError) from auth
      // expiry (AbloAuthenticationError).
      try {
        const abloErr = error instanceof AbloError ? error : undefined;
        getContext().logger.warn('[TransactionQueue] Permanent error - rolling back', {
          txId: transaction.id.slice(0, 8),
          type: transaction.type,
          model: transaction.modelName,
          modelId: transaction.modelId.slice(0, 12),
          errorType: abloErr?.type ?? error?.name,
          errorCode: abloErr?.code,
          httpStatus: abloErr?.httpStatus,
          requestId: abloErr?.requestId,
          message: error?.message,
          inputKeys: transaction.data ? Object.keys(transaction.data) : undefined,
        });
      } catch {}

      // Mark as failed immediately and rollback
      this.store.updateStatus(transaction.id, 'failed');

      if (this.config.enableOptimistic) {
        await this.rollbackOptimistic(transaction, 'permanent_error', error);
      }

      this.emit('transaction:failed', { transaction, error, permanent: true });
      return;
    }

    if (transaction.attempts < this.config.maxRetries) {
      // Backoff for retryable server responses (HTTP 429/503).
      // Exponential with jitter, capped — tunable via
      // `TransactionQueueConfig.retryBackoff`.
      try {
        const status = extractStatusCode(error);
        if (status === 429 || status === 503) {
          const { baseMs, capMs } = this.config.retryBackoff;
          const delay = Math.min(
            capMs,
            Math.floor(baseMs * Math.pow(2, transaction.attempts - 1)),
          );
          const jitter = Math.floor(Math.random() * 100);
          await new Promise((r) => setTimeout(r, delay + jitter));
        }
      } catch {}

      // Retry
      this.store.updateStatus(transaction.id, 'pending');
      this.enqueue(transaction);
    } else {
      // Mark as failed and rollback
      this.store.updateStatus(transaction.id, 'failed');

      if (this.config.enableOptimistic) {
        await this.rollbackOptimistic(transaction, 'max_retries_exhausted', error);
      }

      this.emit('transaction:failed', { transaction, error });
    }
  }

  /**
   * Conflict resolution
   */
  async handleConflict(transaction: Transaction, serverData: MutationInput): Promise<void> {
    const { strategy, resolver } = this.config.conflictResolution;

    switch (strategy) {
      case 'last-write-wins':
        // Server wins, cancel transaction
        this.store.updateStatus(transaction.id, 'rolled_back');
        await this.rollbackOptimistic(transaction, 'conflict_server_wins');
        break;

      case 'merge':
        // Merge changes
        const merged = this.mergeData(transaction.data, serverData);
        transaction.data = merged;
        this.enqueue(transaction);
        break;

      case 'reject':
        // Client wins, re-execute
        this.enqueue(transaction);
        break;

      case 'custom':
        if (resolver) {
          const resolved = resolver(transaction.data, serverData);
          transaction.data = resolved;
          this.enqueue(transaction);
        }
        break;
    }
  }

  /**
   * Optimistic updates
   */
  private applyOptimisticCreate(model: Model, transaction: Transaction): void {
    this.optimisticUpdates.set(transaction.id, {
      model,
      previousState: null,
      transaction,
    });

    this.emit('optimistic:create', { model, transaction });
  }

  private applyOptimisticUpdate(model: Model, transaction: Transaction): void {
    this.optimisticUpdates.set(transaction.id, {
      model,
      previousState: transaction.previousData,
      transaction,
    });

    this.emit('optimistic:update', { model, transaction });
  }

  private applyOptimisticDelete(model: Model, transaction: Transaction): void {
    this.optimisticUpdates.set(transaction.id, {
      model,
      previousState: transaction.previousData,
      transaction,
    });

    this.emit('optimistic:delete', { model, transaction });
  }

  private async rollbackOptimistic(
    transaction: Transaction,
    reason?: string,
    error?: Error
  ): Promise<void> {
    const optimistic = this.optimisticUpdates.get(transaction.id);
    if (!optimistic) return;

    this.emit('optimistic:rollback', {
      model: optimistic.model,
      previousState: optimistic.previousState,
      transaction,
      reason: reason ?? 'unknown',
      error,
    });

    this.optimisticUpdates.delete(transaction.id);
  }

  /**
   * Execute individual transaction via the unified commit path
   */
  private async executeTransaction(transaction: Transaction): Promise<void> {
    const { type, modelName, modelId, data } = transaction;
    const schemaName = stripModelSuffix(modelName);
    const mutationType = TX_TYPE_TO_MUTATION_OP[type];
    const model = normalizeModelKey(modelName);
    const input = (type === 'create' || type === 'update') ? data : undefined;

    try {
      await this.mutationExecutor.commit([
        applyStaleWriteOptions({ type: mutationType, model, id: modelId, input }, transaction),
      ]);
    } catch (error) {
      handleMutationError(error, `${type}-mutation`, schemaName, modelId);
    }
  }

  /**
   * Persistence
   */
  async loadPersistedTransactions(database: Database): Promise<void> {
    if (!this.config.enablePersistence) return;

    try {
      const persisted = await database.getPersistedTransactions();

      for (const data of persisted) {
        const transaction = this.deserializeTransaction(data);
        this.store.add(transaction);
        this.enqueue(transaction);
      }
    } catch (error) {
      getContext().observability.captureTransactionFailure({
        context: 'load-persisted-transactions',
        error: error instanceof Error ? error : String(error),
      });
    }
  }

  private deserializeTransaction(data: any): Transaction {
    return { ...data, status: 'pending' };
  }

  /**
   * Cancel transactions for a specific model
   */
  cancelTransactionsForModel(modelId: string, transactionType?: string): Transaction[] {
    const cancelledTransactions: Transaction[] = [];

    const allTransactions = [
      ...this.store.getByStatus('pending'),
      ...this.store.getByStatus('executing'),
    ];

    for (const transaction of allTransactions) {
      if (transaction.modelId === modelId) {
        if (!transactionType || transaction.type === transactionType) {
          cancelledTransactions.push(transaction);
          this.store.updateStatus(transaction.id, 'rolled_back');
          this.rollbackOptimistic(transaction, 'model_cancelled');
        }
      }
    }

    return cancelledTransactions;
  }

  /**
   * LINEAR PATTERN: Cancel transactions for child entities by foreign key
   *
   * Used by SyncedStore for cascade cancellation when a parent is deleted.
   * This keeps FK relationship knowledge in ModelRegistry/SyncedStore,
   * while TransactionQueue just handles the cancellation mechanics.
   *
   * @param childModelName - The child model type (e.g., 'SlideLayer')
   * @param foreignKey - The FK property name (e.g., 'slideId')
   * @param parentId - The deleted parent's ID
   * @returns Number of transactions cancelled
   */
  cancelTransactionsByForeignKey(
    childModelName: string,
    foreignKey: string,
    parentId: string
  ): number {
    let cancelled = 0;

    const allTransactions = [
      ...this.store.getByStatus('pending'),
      ...this.store.getByStatus('executing'),
      ...this.store.getByStatus('awaiting_delta'),
    ];

    for (const transaction of allTransactions) {
      if (transaction.modelName === childModelName) {
        // Check if this transaction's data contains the parent FK
        const fkValue = transaction.data?.[foreignKey];
        if (fkValue === parentId) {
          this.store.updateStatus(transaction.id, 'rolled_back');
          this.rollbackOptimistic(transaction, 'cascade_parent_deleted');
          cancelled++;

          getContext().logger.debug('[TransactionQueue] Cascade cancelled orphaned transaction', {
            txId: transaction.id.slice(0, 12),
            model: childModelName,
            foreignKey,
            parentId: parentId.slice(0, 12),
          });
        }
      }
    }

    return cancelled;
  }

  /**
   * Get count of outstanding transactions
   */
  getOutstandingTransactionCount(): number {
    return this.store.getByStatus('pending').length + this.store.getByStatus('executing').length;
  }

  /**
   * Utilities
   */
  private generateId(): string {
    return `tx_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
  }

  private mergeData(
    local: MutationInput | undefined,
    remote: MutationInput | undefined
  ): MutationInput {
    return { ...(remote || {}), ...(local || {}) };
  }

  private extractCreateData(model: Model): MutationInput {
    return projectCommitPayload(model.getModelName(), model.toJSON(), { dropUndefined: false });
  }

  private mapChangesToInput(modelName: string, changes: Record<string, unknown>): MutationInput {
    return projectCommitPayload(modelName, changes, { dropUndefined: true });
  }

  private extractUpdateData(model: Model): MutationInput {
    return projectCommitPayload(model.getModelName(), model.getChanges(), { dropUndefined: true });
  }

  private buildUpdateInput(modelName: string, changes: Record<string, unknown>): MutationInput {
    return projectCommitPayload(modelName, changes, { dropUndefined: true });
  }

  // Derive previous values for changed fields to support accurate rollback.
  //
  // The previous Slide-specific branch reaching into `_data` was removed:
  // the field name in the comment (`_localChanges`) didn't match the
  // code (`_data`), no `Slide` class still defines either field, and
  // hardcoded model-name checks don't belong in a generic queue. If a
  // model ever needs to surface previous-state outside `modifiedProperties`,
  // expose a typed `getPreviousData()` accessor on Model and call that.
  private extractPreviousData(model: Model, updateInput?: MutationInput): MutationInput {
    const prev: MutationInput = { id: model.id };

    if (model.modifiedProperties instanceof Map && model.modifiedProperties.size > 0) {
      for (const [key, change] of model.modifiedProperties) {
        // Only include keys that are part of this update if provided
        if (updateInput && !(key in updateInput)) continue;
        prev[key] = change.old;
      }
    }

    return prev;
  }

  /**
   * Public API
   */
  getStats() {
    return {
      pending: this.store.getByStatus('pending').length,
      executing: this.store.getByStatus('executing').length,
      completed: this.store.getByStatus('completed').length,
      failed: this.store.getByStatus('failed').length,
      optimistic: this.optimisticUpdates.size,
      totalTransactions: this.store.getAll().length,
      batchIndex: this.batchIndex,
      config: { ...this.config },
    };
  }

  /**
   * Get detailed debug info for the sync debug page
   * Exposes internal state that helps diagnose delta confirmation issues
   */
  getDebugInfo() {
    const awaitingDelta = this.store.getByStatus('awaiting_delta');
    return {
      lastSeenSyncId: this.lastSeenSyncId,
      awaitingDeltaCount: awaitingDelta.length,
      awaitingDeltaTransactions: awaitingDelta.map((tx) => ({
        id: tx.id.slice(0, 8),
        type: tx.type,
        modelName: tx.modelName,
        modelId: tx.modelId.slice(0, 8),
        syncIdNeeded: tx.syncIdNeededForCompletion,
        createdAt: tx.createdAt,
        age: Date.now() - tx.createdAt,
      })),
      pendingTransactions: this.store.getByStatus('pending').map((tx) => ({
        id: tx.id.slice(0, 8),
        type: tx.type,
        modelName: tx.modelName,
        modelId: tx.modelId.slice(0, 8),
      })),
      executingTransactions: this.store.getByStatus('executing').map((tx) => ({
        id: tx.id.slice(0, 8),
        type: tx.type,
        modelName: tx.modelName,
        modelId: tx.modelId.slice(0, 8),
      })),
    };
  }

  /**
   * Set configuration
   */
  setConfig(config: Partial<TransactionQueueConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * Handle incoming sync delta - simplified for permanent IDs
   */
  handleSyncDelta(delta: { id: string; modelName: string; action: string; data: any }): boolean {
    // With permanent IDs, no reconciliation needed!
    // Just emit the delta for ObjectPool to handle directly
    this.emit('sync:delta', {
      id: delta.id,
      modelName: delta.modelName,
      action: delta.action,
      data: delta.data,
    });

    return true;
  }

  /**
   * Cleanup and dispose resources
   */
  dispose(): void {
    // Cancel all active optimistic updates
    for (const [, optimistic] of this.optimisticUpdates) {
      this.emit('optimistic:rollback', {
        model: optimistic.model,
        previousState: optimistic.previousState,
        transaction: optimistic.transaction,
        reason: 'dispose',
      });
    }

    // Clear processing
    if (this.processTimer) {
      clearTimeout(this.processTimer);
    }

    // Clear store
    this.store.clear();
    this.optimisticUpdates.clear();
    this.executionQueue = [];

    // Clear event listeners
    this.removeAllListeners();

    // Reset state
    this.isProcessing = false;
    this.batchIndex = 0;
  }
}
