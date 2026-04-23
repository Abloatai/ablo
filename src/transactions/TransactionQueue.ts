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
import type { Database } from '@ablo/sync-engine/core';
import { Model } from '@ablo/sync-engine';
import { getContext } from '../context';
import { getActiveRegistry } from '../ModelRegistry';
import { MutationOperationType } from '../types';
import { handleMutationError } from './mutation-error-handler';
import { AbloError } from '../errors';

export interface UserContext {
  userId: string;
  organizationId: string;
  role?: string;
  teamIds?: string[];
}

/** Wire-format mutation payload (post-projection). */
type MutationInput = Record<string, unknown>;

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
    if (meta.type === 'json' && value !== null && typeof value === 'object') {
      out[key] = JSON.stringify(value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

interface Transaction {
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
  batchId?: string;
  /** LINEAR PATTERN: syncId threshold - transaction confirms when delta.id >= this value */
  syncIdNeededForCompletion?: number;
}

/**
 * Priority map for FK-ordered model creation.
 * Lower numbers execute first to satisfy foreign key dependencies.
 */
const MODEL_CREATE_PRIORITY: ReadonlyMap<string, number> = new Map([
  ['Theme', 5], // Theme must be created before SlideDeck references it
  ['User', 10],
  ['Organization', 10],
  ['Team', 10],
  ['Project', 10],
  ['Task', 10],
  ['Chat', 10],
  ['SlideDeck', 10],
  ['Layout', 10],
  ['Spreadsheet', 10],
  ['Document', 10],
  ['Folder', 10],
  ['StatusGroup', 10],
  ['SlideLayout', 12],
  ['Message', 12], // Message depends on Chat (priority 10)
  ['Slide', 15],
  ['SpreadsheetSheet', 15], // SpreadsheetSheet depends on Spreadsheet (priority 10)
  ['SlideLayer', 20],
  ['SlideLayoutLayer', 20],
  ['MessagePart', 20], // MessagePart depends on Message (priority 12)
  ['SpreadsheetCell', 20], // SpreadsheetCell depends on SpreadsheetSheet (priority 15)
  ['File', 20],
  ['Invitation', 20],
  ['Role', 20],
  ['ProjectTeam', 30],
  ['TeamMember', 30],
  ['Assignment', 30],
  ['Subscription', 30],
  ['Favorite', 30],
  ['Comment', 30],
  ['Attachment', 30],
  ['Event', 30],
  ['Company', 10],
  ['Contact', 15], // Contact may reference Company (priority 10)
  ['ObjectLink', 30], // Links reference other entities
]);

const DEFAULT_NON_CREATE_PRIORITY = 50;
const DEFAULT_CREATE_PRIORITY = 40;

const BATCHABLE_MODELS = new Set([
  'task',
  'project',
  'comment',
  'statusgroup',
  'chat',
  'message',
  'messagepart',
  'attachment',
  'agent',
  'assignment',
  'folder',
  'file',
  'slidedeck',
  'layout',
  'slidelayout',
  'slide',
  'slidelayer',
  'slidelayoutlayer',
  'theme',
  'spreadsheet',
  'spreadsheetsheet',
  'spreadsheetcell',
  'document',
  'company',
  'contact',
  'objectlink',
  'dataroom',
]);

const DEDICATED_DELETE_MODELS = new Set([
  'task',
  'project',
  'activity',
  'comment',
  'assignment',
  'chat',
  'message',
  'messagepart',
  'statusgroup',
  'attachment',
  'team',
  'teammember',
  'invitation',
  'folder',
  'file',
  'slidelayoutlayer',
]);


const normalizeModelKey = (modelName: string): string =>
  modelName.replace('Model', '').toLowerCase();
const stripModelSuffix = (modelName: string): string => modelName.replace('Model', '');
const computePriorityScore = (type: Transaction['type'], modelName: string): number =>
  type !== 'create'
    ? DEFAULT_NON_CREATE_PRIORITY
    : (MODEL_CREATE_PRIORITY.get(modelName) ?? DEFAULT_CREATE_PRIORITY);

const TX_TYPE_TO_MUTATION_OP: Record<Transaction['type'], MutationOperationType> = {
  create: MutationOperationType.CREATE,
  update: MutationOperationType.UPDATE,
  delete: MutationOperationType.DELETE,
  archive: MutationOperationType.ARCHIVE,
  unarchive: MutationOperationType.UNARCHIVE,
};


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
  private get mutationExecutor() { return getContext().mutationExecutor; }

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

  constructor(config?: Partial<TransactionQueueConfig>) {
    super();

        if (config) {
      this.config = { ...this.config, ...config };
    }
  }

  /**
   * Set connection state checker - prevents rollbacks during disconnection.
   * When disconnected, timeouts re-schedule instead of rolling back.
   */
  setConnectionChecker(fn: () => boolean): void {
    this.isConnectedFn = fn;
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

    // 🔍 DEBUG: Log SlideDeck/Slide/SlideLayer/Theme commits
    const slideDeckTxns = this.createdTransactions.filter((t) => t.modelName === 'SlideDeck');
    const slideTxns = this.createdTransactions.filter((t) => t.modelName === 'Slide');
    const slideLayerTxns = this.createdTransactions.filter((t) => t.modelName === 'SlideLayer');
    const themeTxns = this.createdTransactions.filter((t) => t.modelName === 'Theme');
    if (
      slideDeckTxns.length > 0 ||
      slideTxns.length > 0 ||
      slideLayerTxns.length > 0 ||
      themeTxns.length > 0
    ) {
      console.log('[TransactionQueue.commitCreatedTransactions] Committing:', {
        totalCount: this.createdTransactions.length,
        slideDeckCount: slideDeckTxns.length,
        slideCount: slideTxns.length,
        slideLayerCount: slideLayerTxns.length,
        themeCount: themeTxns.length,
        batchIndex: currentBatchIndex,
        allTypes: this.createdTransactions.map(
          (t) => `${t.type}:${t.modelName}:${t.modelId.slice(0, 8)}`
        ),
      });
    }

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

  // Batch flush all pending transactions via batchAck (fast path on reconnect)
  async flushOfflineQueue(): Promise<void> {
    // Collect pending transactions in created order
    const pending = this.store.getByStatus('pending').sort((a, b) => a.createdAt - b.createdAt);
    if (pending.length === 0) return;

    // Build operations list
    const operations = pending.map((tx) => {
      this.ensureDerivedFields(tx);
      return {
        type: TX_TYPE_TO_MUTATION_OP[tx.type],
        model: tx.modelKey,
        id: tx.modelId,
        input: tx.type === 'create' || tx.type === 'update' ? tx.data || {} : undefined,
      };
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
      getContext().logger.debug('txn:batchAck', 0, {
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
  async create(model: Model, context: UserContext): Promise<Transaction> {
    const callId = `txn_queue_create_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
    // 🔧 FIXED: Use getModelName() instead of constructor.name (production-safe)
    const actualModelName = model.getModelName();

    // 🔍 DEBUG: Log SlideDeck/Slide/SlideLayer/Theme transactions entering TransactionQueue
    if (
      actualModelName === 'SlideDeck' ||
      actualModelName === 'Slide' ||
      actualModelName === 'SlideLayer' ||
      actualModelName === 'Theme'
    ) {
      console.log(`[TransactionQueue.create] ${actualModelName} CREATE transaction created:`, {
        modelId: model.id.slice(0, 8),
        callId,
      });
    }

    getContext().logger.debug('TransactionQueue.create() ENTRY', {
      callId,
      modelType: actualModelName,
      modelId: model.id,
    });

    const previousData = model.toJSON ? model.toJSON() : { ...model };
    const modelKey = normalizeModelKey(actualModelName);
    const priorityScore = this.computePriorityScore('create', actualModelName);

    const transaction: Transaction = {
      id: this.generateId(),
      type: 'create',
      modelName: actualModelName,
      modelId: model.id,
      modelKey,
      priorityScore,
      data: this.extractCreateData(model),
      previousData,
      context,
      status: 'pending',
      createdAt: Date.now(),
      attempts: 0,
      priority: 'normal',
    };

    getContext().logger.debug('TransactionQueue.create() transaction created', {
      callId,
      transactionId: transaction.id,
      modelId: model.id,
    });

    this.store.add(transaction);

    // Apply optimistic update
    if (this.config.enableOptimistic) {
      this.applyOptimisticCreate(model, transaction);
    }

    // LINEAR PATTERN: Stage transaction for microtask commit
    // All creates in same event loop will be batched together with same batchIndex
    getContext().logger.debug('TransactionQueue.create() staging transaction', {
      callId,
      transactionId: transaction.id,
    });
    this.stageTransaction(transaction);

    this.emit('transaction:created', transaction);
    getContext().logger.debug('TransactionQueue.create() EXIT', {
      callId,
      transactionId: transaction.id,
      modelId: model.id,
    });

    // Transaction staged for commit

    return transaction;
  }

  /**
   * Update operation with conflict detection
   * @param precomputedChanges - Optional pre-captured changes (avoids re-reading from model)
   */
  async update(
    model: Model,
    context: UserContext,
    precomputedChanges?: Record<string, unknown>
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
    };

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
  async delete(model: Model, context: UserContext): Promise<Transaction> {
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
    };

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
  async archive(model: Model, context: UserContext): Promise<Transaction> {
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
    };

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
      // If there is an in-flight update for this model, merge into post-flight buffer
      if (this.inFlightByModel.has(modelKey)) {
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
          t.modelName === transaction.modelName
      );
      if (pendingInQueue) {
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
   * Key optimization: Instead of making separate HTTP calls per operation type/model,
   * we collect ALL batchable operations and send them in a SINGLE batchAck call.
   * The Go backend's ExecuteBatchAck handles mixed types efficiently via pgx.Batch.
   *
   * This reduces N HTTP round-trips to 1, dramatically improving batch latency.
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

          // Build ALL operations for unified batchAck (SINGLE HTTP call)
          const batchOps: Array<{
            tx: Transaction;
            op: {
              type: MutationOperationType;
              model: string;
              id: string;
              input?: Record<string, unknown>;
            };
          }> = [];

          for (const tx of batch) {
            const op = {
              type: TX_TYPE_TO_MUTATION_OP[tx.type],
              model: tx.modelKey,
              id: tx.modelId,
              input: tx.type === 'create' || tx.type === 'update' ? tx.data || {} : undefined,
            };
            batchOps.push({ tx, op });
          }

          // Execute unified batchAck for ALL operations (SINGLE HTTP call)
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
                getContext().observability.captureBatchAckZeroSyncId({
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
              // cascaded failures (e.g. FK violation that rolls back a
              // multi-op transaction) are attributable to a specific cause
              // instead of each op showing as a generic permanent error.
              const abloErr = error instanceof AbloError ? error : undefined;
              getContext().logger.warn('[TransactionQueue] Batch commit rejected', {
                batchSize: batchOps.length,
                models: batchOps.map(({ op }) => `${op.type}:${op.model}`),
                errorType: abloErr?.type ?? (error as Error)?.name,
                errorCode: abloErr?.code,
                httpStatus: abloErr?.httpStatus,
                requestId: abloErr?.requestId,
                message: errorMessage,
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

  private groupTransactions(transactions: Transaction[]): Map<string, Transaction[]> {
    const groups = new Map<string, Transaction[]>();

    for (const tx of transactions) {
      const key = `${tx.type}:${tx.modelName}`;
      if (!groups.has(key)) {
        groups.set(key, []);
      }
      groups.get(key)!.push(tx);
    }

    // Sort groups by dependency order for creates to avoid foreign key violations
    // Relationship entities must be created after their parent entities
    const sortedGroups = new Map<string, Transaction[]>();
    const sortedEntries = Array.from(groups.entries()).sort(([keyA], [keyB]) => {
      return this.getModelPriority(keyA) - this.getModelPriority(keyB);
    });

    for (const [key, txs] of sortedEntries) {
      sortedGroups.set(key, txs);
    }

    return sortedGroups;
  }

  /**
   * Get priority for model operations. Lower numbers execute first.
   * This ensures dependencies are created before relationship entities.
   *
   * NOTE: Model names here are Prisma-style (e.g., "Slide", "SlideLayer")
   * NOT JavaScript class names (e.g., "SlideModel", "SlideLayerModel").
   * The getModelName() method strips the "Model" suffix.
   *
   * Uses static MODEL_CREATE_PRIORITY map for O(1) lookup instead of regex.
   */
  private getModelPriority(key: string): number {
    // Fast path: non-create operations don't need FK ordering
    const colonIdx = key.indexOf(':');
    const type = colonIdx > 0 ? key.slice(0, colonIdx) : key;
    if (type !== 'create') return DEFAULT_NON_CREATE_PRIORITY;

    // O(1) map lookup instead of multiple regex matches
    const modelName = colonIdx > 0 ? key.slice(colonIdx + 1) : '';
    return MODEL_CREATE_PRIORITY.get(modelName) ?? DEFAULT_CREATE_PRIORITY;
  }

  /**
   * Execute group of similar transactions
   */
  private async executeGroup(transactions: Transaction[]): Promise<void> {
    return getContext().observability.startSpanAsync(
      'sync.group',
      'sync.transaction.group',
      async () => {
        // Mark in-flight models
        for (const tx of transactions) {
          const key = `${tx.modelName}:${tx.modelId}`;
          if (tx.type === 'update') this.inFlightByModel.add(key);
        }
        const groupStart = typeof performance !== 'undefined' ? performance.now() : Date.now();
        // Update status
        for (const tx of transactions) {
          this.store.updateStatus(tx.id, 'executing');
        }

        try {
          // Execute based on type
          const type = transactions[0].type;

          switch (type) {
            case 'create':
              await this.executeBatchCreate(transactions);
              break;
            case 'update':
              await this.executeBatchUpdate(transactions);
              break;
            case 'delete':
              await this.executeBatchDelete(transactions);
              break;
            case 'archive':
              await this.executeBatchArchive(transactions);
              break;
            default:
              // Execute individually (e.g. unarchive)
              for (const tx of transactions) {
                await this.executeTransaction(tx);
              }
          }

          // Mark as completed
          for (const tx of transactions) {
            this.store.updateStatus(tx.id, 'completed');
            this.emit('transaction:completed', tx);
            this.emit(`transaction:completed:${tx.id}`, tx);

            // No temp ID tracking needed - IDs are permanent!

            // Remove optimistic update
            this.optimisticUpdates.delete(tx.id);
          }
          const groupEnd = typeof performance !== 'undefined' ? performance.now() : Date.now();
          getContext().logger.debug('txn:group', groupEnd - groupStart, {
            type: transactions[0].type,
            model: transactions[0].modelName,
            count: transactions.length,
          });
        } catch (error) {
          // Enhanced error logging to capture all possible error formats
          const errorInfo: any = {
            rawError: error, // Include the raw error object
            transactions: transactions.map((tx) => ({
              id: tx.id,
              type: tx.type,
              modelName: tx.modelName,
            })),
          };

          // Try to extract error message from various possible sources
          if (error instanceof Error) {
            errorInfo.message = error.message;
            errorInfo.name = error.name;
            errorInfo.stack =
              typeof error.stack === 'string' ? error.stack.split('\n').slice(0, 5) : undefined;
          } else if (error && typeof error === 'object') {
            // Handle GraphQL or other structured errors
            errorInfo.message = (error as any).message || (error as any).error || 'Unknown error';
            errorInfo.code = (error as any).code;
            errorInfo.extensions = (error as any).extensions;
            errorInfo.locations = (error as any).locations;
            errorInfo.path = (error as any).path;
          } else {
            errorInfo.message = String(error);
          }

          // Only log if we're online OR if it's not a network error
          const isOffline = !getContext().onlineStatus.isOnline();
          const isNetworkError =
            errorInfo.message?.includes('Failed to fetch') ||
            errorInfo.message?.includes('Network request failed') ||
            errorInfo.message?.includes('NetworkError');

          if (!isOffline || !isNetworkError) {
            getContext().observability.captureTransactionFailure({
              context: 'execute-group',
              error: error instanceof Error ? error : String(errorInfo.message ?? error),
              modelName: transactions[0]?.modelName,
              modelId: transactions[0]?.modelId,
              transactionId: transactions[0]?.id,
            });
          }

          // Handle failures
          for (const tx of transactions) {
            await this.handleFailure(tx, error as Error);
          }
        }

        // Handle post-execution merge for updates
        for (const tx of transactions) {
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
      },
      {
        groupSize: transactions.length,
        type: transactions[0]?.type,
        model: transactions[0]?.modelName,
      }
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

  // Legacy: mark a transaction as confirmed by clientMutationId (tx.id)
  // @deprecated Use onDeltaReceived for sync ID threshold-based confirmation
  confirmByClientMutationId(id: string): void {
    const tx = this.store.get(id);
    if (!tx) return;
    if (tx.status === 'completed') return;

    // Cancel the timeout since delta was received
    this.cancelDeltaConfirmationTimeout(id);

    this.store.updateStatus(id, 'completed');
    this.emit('transaction:completed', tx);
    this.emit(`transaction:completed:${id}`, tx);
    this.optimisticUpdates.delete(id);

    // Dev-friendly console + perf metric
    const elapsed = Date.now() - (tx.createdAt || Date.now());
    getContext().logger.debug('tx:confirm_echo', elapsed, {
      model: `${tx.modelName}:${tx.modelId}`,
      type: tx.type,
    });
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
    return !!this.store.get(id);
  }

  private isReorderPayload(data: MutationInput | undefined): boolean {
    if (!data || typeof data !== 'object') return false;
    return 'order' in data || 'orderKey' in data || 'position' in data;
  }

  private async executeBatchCreate(transactions: Transaction[]): Promise<void> {
    if (transactions.length === 0) return;
    const operations = transactions.map((tx) => ({
      type: MutationOperationType.CREATE,
      model: tx.modelKey,
      id: tx.modelId,
      input: tx.data,
    }));
    await this.mutationExecutor.commit(operations);
  }

  private async executeBatchUpdate(transactions: Transaction[]): Promise<void> {
    if (transactions.length === 0) return;
    const operations = transactions.map((tx) => ({
      type: MutationOperationType.UPDATE,
      model: tx.modelKey,
      id: tx.modelId,
      input: tx.data,
    }));
    await this.mutationExecutor.commit(operations);
  }

  private async executeBatchDelete(transactions: Transaction[]): Promise<void> {
    if (transactions.length === 0) return;
    const operations = transactions.map((tx) => {
      // Subscription delete needs entityType/entityId in input for the server
      const input = tx.modelName === 'Subscription' && tx.previousData
        ? { entityType: (tx.previousData as Record<string, unknown>).entityType, entityId: (tx.previousData as Record<string, unknown>).entityId }
        : undefined;
      return { type: MutationOperationType.DELETE, model: tx.modelKey, id: tx.modelId, input };
    });
    await this.mutationExecutor.commit(operations);
  }

  private async executeBatchArchive(transactions: Transaction[]): Promise<void> {
    if (transactions.length === 0) return;
    const operations = transactions.map((tx) => ({
      type: MutationOperationType.ARCHIVE,
      model: stripModelSuffix(tx.modelName).toLowerCase(),
      id: tx.modelId,
      input: undefined,
    }));
    await this.mutationExecutor.commit(operations);
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
    const status: number | undefined = (error as any)?.response?.status;

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
    const responseErrors = (error as any)?.response?.errors;
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
      // console (not just via Sentry). Include typed AbloError fields
      // (`type`/`code`/`httpStatus`) so the cause is attributable:
      // distinguishes FK-violation (AbloValidationError) from auth
      // expiry (AbloAuthenticationError), etc.
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
      // Optional backoff for retryable server responses (e.g., 429/503)
      try {
        const status: number | undefined = (error as any)?.response?.status;
        if (status === 429 || status === 503) {
          const base =
            (typeof process !== 'undefined' && (process.env as any)?.NEXT_PUBLIC_TXQ_RETRY_BASE_MS
              ? Math.max(1, parseInt((process.env as any).NEXT_PUBLIC_TXQ_RETRY_BASE_MS, 10) || 0)
              : 200) || 200;
          const cap =
            (typeof process !== 'undefined' &&
            (process.env as any)?.NEXT_PUBLIC_TXQ_RETRY_MAX_DELAY_MS
              ? Math.max(
                  100,
                  parseInt((process.env as any).NEXT_PUBLIC_TXQ_RETRY_MAX_DELAY_MS, 10) || 0
                )
              : 1500) || 1500;
          const delay = Math.min(cap, Math.floor(base * Math.pow(2, transaction.attempts - 1)));
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
   * Execute individual transaction via unified batchAck endpoint
   */
  private async executeTransaction(transaction: Transaction): Promise<void> {
    const { type, modelName, modelId, data } = transaction;
    const schemaName = stripModelSuffix(modelName);
    const mutationType = TX_TYPE_TO_MUTATION_OP[type];
    const model = normalizeModelKey(modelName);
    const input = (type === 'create' || type === 'update') ? data : undefined;

    try {
      await this.mutationExecutor.commit([{ type: mutationType, model, id: modelId, input }]);
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

  // Derive previous values for changed fields to support accurate rollback
  private extractPreviousData(model: Model, updateInput?: any): any {
    const modelName =
      typeof model?.getModelName === 'function' ? model.getModelName() : model?.constructor?.name;
    const prev: any = { id: model?.id };

    // If model tracks modifiedProperties (base Model), use those old values
    if (model && model.modifiedProperties instanceof Map && model.modifiedProperties.size > 0) {
      for (const [key, change] of model.modifiedProperties as Map<string, { old: any; new: any }>) {
        // Only include keys that are part of this update if provided
        if (updateInput && !(key in updateInput)) continue;
        prev[key] = (change as any).old;
      }
    }

    // Special handling for Slide which uses internal _localChanges instead of modifiedProperties
    if (modelName === 'Slide' && model && (model as any)._data) {
      const raw = (model as any)._data;
      const keys = updateInput
        ? Object.keys(updateInput)
        : ['title', 'layoutId', 'layers', 'settings', 'order', 'notes'];
      for (const k of keys) {
        if (k in raw) {
          prev[k] = (raw as any)[k];
        }
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
