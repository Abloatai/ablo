/**
 * SyncClient - Mutation and offline queue manager
 *
 * Responsibilities:
 * - Handle model mutations (create, update, delete, archive)
 * - Manage offline mutation queue with persistence
 * - Send mutations to server via API client
 * - Handle conflict resolution for local changes
 */

import { ObjectPool, ModelScope } from './ObjectPool.js';
import { Model } from './Model.js';
import type { ModelData } from './BaseSyncedStore.js';
// ModelRegistry instance accessed via this.objectPool.registry
import { LoadStrategy } from './types/index.js';
import { getContext } from './context.js';
import { AbloAuthenticationError, AbloError, AbloValidationError } from './errors.js';
import { EventEmitter } from 'events';
import { NetworkMonitor } from './NetworkMonitor.js';
import { TransactionQueue } from './transactions/TransactionQueue.js';
import {
  OptimisticEchoTracker,
  type OptimisticEchoMetrics,
} from './transactions/OptimisticEchoTracker.js';
import type { Database } from './Database.js';
import type { WriteOptions } from './interfaces/index.js';

interface SyncObserver {
  onSync?: (event: SyncEvent) => void;
}

interface SyncEvent {
  type: 'create' | 'update' | 'delete' | 'archive' | 'rollback';
  modelType: string;
  model?: Model;
  modelId?: string;
  transactionType?: string; // Original transaction type that was rolled back
}

interface SyncState {
  connectionState: 'connected' | 'disconnected' | 'connecting';
  pendingMutations: number;
  lastSyncAt?: Date;
  error?: Error;
}

export interface RehydrationStats {
  added: number;
  updated: number;
  removed: number;
  skipped: number;
  healed: number;
  elapsedMs: number;
}

type EventHandler = () => void;


export class SyncClient extends EventEmitter {
  private objectPool: ObjectPool;
  private database: Database;
  private get mutationExecutor() { return getContext().mutationExecutor; }
  private networkMonitor: NetworkMonitor;
  private transactionQueue: TransactionQueue;
  private observers: Set<SyncObserver> = new Set();

  // Authentication context
  private userId: string | null = null;
  private organizationId: string | null = null;

  // Pending mutations queue
  private pendingMutations: Array<{
    type: 'create' | 'update' | 'delete' | 'archive';
    model: Model;
    timestamp: Date;
    capturedChanges?: Record<string, unknown>;
    writeOptions?: WriteOptions;
  }> = [];

  /**
   * Tracks transaction ids the client has optimistically applied but
   * the server has not yet confirmed. The receive path consults it
   * to recognize delta echoes of own mutations and suppress the
   * (otherwise-redundant) pool mutation — the IDB write still runs
   * because the delta is the authoritative version of the row.
   *
   * The receive-layer discriminator named in
   * `apps/sync-server/docs/OPTIMISTIC_RECONCILIATION.md`. Without
   * it, an optimistically-applied DELETE followed by a
   * server-confirming CREATE echo resurrects the row for the window
   * between the two confirmations (the chart-delete flicker).
   *
   * Bounded with FIFO eviction; observability via `getEchoMetrics()`.
   */
  private readonly echoTracker = new OptimisticEchoTracker();

  // Connection state
  private connectionState: 'connected' | 'disconnected' | 'connecting' = 'disconnected';
  private offlineSince?: Date;

  // Configuration
  private maxRetries: number = 3;
  private isDisposed: boolean = false;

  constructor(objectPool: ObjectPool, database: Database) {
    super();
    this.objectPool = objectPool;
    this.database = database;
    this.networkMonitor = new NetworkMonitor();

    // Initialize TransactionQueue with proper configuration
    this.transactionQueue = new TransactionQueue({
      maxBatchSize: 50, // Increased from 10 to reduce batch count for large operations
      // Lower delay for snappier dev UX; batching still happens via coalescing
      batchDelay: 150,
      maxRetries: 3,
      enableOptimistic: true,
      enablePersistence: true,
      conflictResolution: {
        strategy: 'last-write-wins',
      },
    });

    // Provide connection state to TransactionQueue - prevents rollbacks during disconnection
    this.transactionQueue.setConnectionChecker(() => this.connectionState === 'connected');

    // LINEAR PATTERN: Subscribe to rollback events to restore ObjectPool state
    // When a transaction fails (server rejects or timeout), we need to restore the model
    // Since we no longer write to IndexedDB optimistically, IndexedDB already has correct state
    this.setupTransactionRollbackHandling();

    // REPLICACHE PATTERN: Forward reconciliation requests from TransactionQueue
    // When delta confirmation times out, instead of rolling back we request the sync layer
    // to cycle the WebSocket connection, triggering a delta catch-up from the server
    this.setupReconciliationForwarding();

    // LINEAR PATTERN: Persist unconfirmed transactions to IndexedDB
    // When delta retries exhaust, cache in IDB so they survive tab close
    this.setupAwaitingTransactionPersistence();

    // Setup network monitoring
    this.setupNetworkMonitoring();
  }

  /**
   * Setup network monitoring handlers
   */
  private setupNetworkMonitoring(): void {
    this.networkMonitor.on('online', () => this.handleReconnection());
    this.networkMonitor.on('offline', () => this.handleDisconnection());
  }

  /**
   * Handle transaction rollback. Two distinct shapes flow through this
   * event:
   *
   *   1. **Server-rejected rollback** (`reason === 'permanent_error'`,
   *      `'max_retries_exhausted'`, `'conflict_server_wins'`) — the
   *      optimistic state is wrong, the row exists, restore previous
   *      state and notify the UI.
   *
   *   2. **Local-cancellation cleanup** (`reason === 'model_cancelled'`,
   *      `'cascade_parent_deleted'`) — the user deleted this model (or
   *      its parent), so a pending UPDATE on it gets cancelled. There's
   *      nothing to restore (the model is doomed) and no UI notification
   *      needed (the delete itself already triggered re-renders). Just
   *      discard the optimistic state silently.
   *
   * Treating both paths the same caused the deletion-flicker bug: every
   * cancelled update on a multi-layer chart fired a per-model observer
   * event and a `[SyncClient.rollback]` warn, producing N renders and N
   * spam log lines for one user-initiated delete.
   */
  private setupTransactionRollbackHandling(): void {
    this.transactionQueue.on(
      'optimistic:rollback',
      (event: {
        model: Model;
        previousState: unknown;
        transaction: { id: string; type: string; modelName: string; modelId: string };
        reason?: string;
        error?: Error;
      }) => {
        const { model, previousState, transaction, reason, error } = event;

        // Local cleanup path — discard quietly. The optimistic state was
        // applied to a model that's already disposed by the cascading
        // delete, and emitting per-model observer events here would
        // re-render N times for one user-initiated cascade.
        if (reason === 'model_cancelled' || reason === 'cascade_parent_deleted') {
          return;
        }

        // Surface the typed AbloError fields directly — `type`/`code`/
        // `httpStatus`/`requestId` are what tell us the rollback cause
        // (e.g. `AbloValidationError` with `code: 'schema_...'`,
        // `AbloServerError` with `httpStatus: 500`). Falling back to
        // generic message lets us still see unstructured errors.
        const abloErr = error instanceof AbloError ? error : undefined;
        getContext().logger.warn('[SyncClient.rollback]', {
          txType: transaction.type,
          modelName: transaction.modelName,
          modelId: transaction.modelId.slice(0, 12),
          reason: reason ?? 'unknown',
          errorType: abloErr?.type ?? error?.name,
          errorCode: abloErr?.code,
          httpStatus: abloErr?.httpStatus,
          requestId: abloErr?.requestId,
          message: error?.message,
        });
        getContext().observability.captureRollback({
          transactionType: transaction.type,
          modelName: transaction.modelName,
          modelId: transaction.modelId,
          reason: reason ?? 'unknown',
          error: error?.message,
          connectionState: this.connectionState,
        });

        try {
          if (transaction.type === 'create') {
            // CREATE rollback: remove the optimistically created entity
            this.objectPool.remove(transaction.modelId);
          } else if (
            transaction.type === 'delete' &&
            reason === 'permanent_error' &&
            error?.message?.includes('not found')
          ) {
            // DELETE "not found" rollback: the entity doesn't exist on the server.
            // Instead of restoring a ghost entity, remove it locally too.
            // Both sides agree: this entity should not exist.
            getContext().observability.breadcrumb(
              'DELETE rolled back with "not found" - removing ghost entity',
              'sync.conflict',
              'info',
              {
                modelId: transaction.modelId,
                modelName: transaction.modelName,
              }
            );
            this.objectPool.remove(transaction.modelId);
          } else if (model) {
            // For update/delete/archive: restore model (with previousState if available)
            // Guard: if the model was disposed (e.g. by a concurrent DELETE rollback or
            // cascade), don't re-add it — Object.assign cannot restore the private
            // isDisposed flag, so the model would be added in a broken state.
            if (model.disposed) {
              getContext().logger.warn('[SyncClient] Skipping rollback restore for disposed model', {
                modelId: transaction.modelId,
                modelName: transaction.modelName,
                reason,
              });
            } else {
              if (previousState) Object.assign(model, previousState);
              this.objectPool.add(model, ModelScope.live);
            }
          }

          this.notifyObservers({
            type: 'rollback',
            modelType: transaction.modelName,
            modelId: transaction.modelId,
            transactionType: transaction.type,
          });

          // Emit event so SyncedStore can clear pendingDeletes on delete rollback
          this.emit('sync:rollback', {
            modelId: transaction.modelId,
            modelName: transaction.modelName,
            transactionType: transaction.type,
            reason,
          });
        } catch (error) {
          getContext().observability.captureTransactionFailure({
            context: 'rollback-failed',
            transactionId: transaction.id,
            modelName: transaction.modelName,
            modelId: transaction.modelId,
            error: error instanceof Error ? error : new Error(String(error)),
          });
        }
      }
    );
  }

  /**
   * Forward reconciliation requests from TransactionQueue to the sync layer.
   * When delta confirmation times out, TransactionQueue emits 'reconciliation:needed'
   * instead of rolling back — following the Replicache/PowerSync pattern of never
   * destroying optimistic state that the server may have committed.
   */
  private setupReconciliationForwarding(): void {
    this.transactionQueue.on(
      'reconciliation:needed',
      (event: {
        reason: string;
        txId: string;
        model: string;
        modelId: string;
        syncIdNeeded?: number;
        lastSeenSyncId: number;
        retryCount: number;
      }) => {
        getContext().observability.captureReconciliation({
          reason: event.reason,
          model: event.model,
          modelId: event.modelId,
          syncIdNeeded: event.syncIdNeeded,
          lastSeenSyncId: event.lastSeenSyncId,
          retryCount: event.retryCount,
          connectionState: this.connectionState,
        });

        // Forward to SyncedStore via event — it has access to the WebSocket
        this.emit('reconciliation:needed', event);
      }
    );
  }

  /**
   * LINEAR PATTERN: Persist unconfirmed transactions to IndexedDB.
   * When delta confirmation retries exhaust, the transaction data is cached in IDB
   * so it survives tab close. On next session, WebSocket reconnect + delta catch-up
   * will deliver the missing deltas and naturally confirm the transaction.
   */
  private setupAwaitingTransactionPersistence(): void {
    this.transactionQueue.on(
      'transaction:persist_awaiting',
      async (event: {
        txId: string;
        model: string;
        modelId: string;
        operationType: string;
        syncIdNeeded?: number;
      }) => {
        if (!this.database) return;

        try {
          await this.database.saveTransaction({
            id: `awaiting_${event.txId}`,
            type: 'awaiting_delta',
            timestamp: Date.now(),
            awaitingDelta: {
              syncIdNeeded: event.syncIdNeeded ?? 0,
              modelName: event.model,
              modelId: event.modelId,
              operationType: event.operationType,
            },
          });

          getContext().observability.breadcrumb(
            'Persisted unconfirmed transaction to IDB',
            'sync.transaction',
            'info',
            {
              txId: event.txId,
              model: event.model,
              modelId: event.modelId,
            }
          );
        } catch (error) {
          getContext().observability.captureTransactionFailure({
            context: 'persist-awaiting-transaction',
            modelName: event.model,
            modelId: event.modelId,
            error: error instanceof Error ? error : new Error(String(error)),
          });
        }
      }
    );

    // Clean up persisted awaiting transactions when they're finally confirmed
    this.transactionQueue.on(
      'transaction:completed',
      async (tx: { id: string; modelName: string; modelId: string }) => {
        if (!this.database) return;
        try {
          await this.database.removeTransaction(`awaiting_${tx.id}`);
        } catch {
          // Ignore — might not have been persisted
        }
      }
    );

    // Echo detection bridge. When the queue stages a transaction, the
    // client has already optimistically applied the change to the
    // pool — record the tx id so the matching server delta echo gets
    // recognized in `applyDeltaBatchToPool`. The set is drained when
    // the echo lands; if a transaction is rolled back before the
    // server processes it, we drain on rollback too so a stale id
    // doesn't permanently silence a foreign delta sharing the same id
    // (vanishingly unlikely for UUIDs, but cheap insurance).
    this.transactionQueue.on(
      'transaction:created',
      (tx: { id: string }) => this.echoTracker.markPending(tx.id),
    );
    this.transactionQueue.on(
      'optimistic:rollback',
      (event: { transaction: { id: string } }) => {
        this.echoTracker.drainOnRollback(event.transaction.id);
      },
    );
  }

  /**
   * Initialize sync client with authentication
   */
  async initialize(userId: string, organizationId: string): Promise<void> {
    this.userId = userId;
    this.organizationId = organizationId;

    getContext().observability.setContext(userId, organizationId);

    // Restore queued mutations from previous session
    await this.restoreMutationQueue();

    // Check network status via the DI'd OnlineStatusProvider (see interfaces.ts:192).
    // In the browser this is wired to the service worker's connectivity signal via
    // abloOnlineStatus in ablo-sync-adapters.ts; in Node it returns true (assume
    // online) via the browserOnlineStatus fallback. NetworkMonitor still drives
    // event-based online/offline transitions below; this read is just the initial
    // status snapshot at registerUser() time.
    if (getContext().onlineStatus.isOnline()) {
      this.setConnectionState('connected');
    } else {
      // Offline - start in offline mode
      this.setConnectionState('disconnected');
      this.offlineSince = new Date();
      this.emit('sync:offline');
    }
  }

  /**
   * The organization this client writes under (set by `initialize`).
   * Read by the model proxy so `create()` defaults `organizationId` the
   * same way the mutator path does — `null` until identity is wired.
   */
  getOrganizationId(): string | null {
    return this.organizationId;
  }

  /**
   * Self-healing helper for individual model records.
   *
   * Two registry-driven repair passes run on every row hydrated from
   * IDB or merged from a delta:
   *
   * 1. **Auto-fill** — for each `autoFill` rule the consumer's schema
   *    declares on this model, copy the corresponding identity value
   *    (`organizationId` / `userId`) onto the row when it's missing.
   *    Repairs rows from a past version that didn't write the field.
   *
   * 2. **Required-field gate** — if the row is missing any field listed
   *    in the model's `requiredFields`, return `null` so the caller
   *    skips this record. Used for FK columns whose absence renders the
   *    row unrecoverable (e.g. a SlideLayer with no slideId).
   *
   * The engine itself is product-neutral: model identity (which fields
   * to back-fill, which absences are fatal) lives entirely in the
   * consumer schema.
   */
  healModelRecord(
    modelType: string,
    data: Record<string, unknown>
  ): { data: Record<string, unknown>; healed: boolean } | null {
    const meta = this.objectPool.registry.getMetadata(modelType);
    if (!meta) return { data, healed: false };

    const idPrefix = (data.id as string)?.slice(0, 8) ?? 'unknown';
    let result = data;
    let healed = false;

    if (meta.autoFill) {
      for (const rule of meta.autoFill) {
        if (result[rule.field]) continue;
        const replacement =
          rule.from === 'organizationId' ? this.organizationId : this.userId;
        if (!replacement) continue;
        getContext().observability.captureSelfHealing({
          modelName: modelType,
          modelId: idPrefix,
          field: rule.field,
          action: `added missing ${rule.field}`,
        });
        result = { ...result, [rule.field]: replacement };
        healed = true;
      }
    }

    if (meta.requiredFields) {
      for (const field of meta.requiredFields) {
        if (result[field]) continue;
        getContext().observability.captureSelfHealing({
          modelName: modelType,
          modelId: idPrefix,
          field,
          action: `skipped corrupted ${modelType} - missing ${field}`,
        });
        return null;
      }
    }

    return { data: result, healed };
  }

  /**
   * Hydrate ObjectPool with data from Database
   * Called after bootstrap is complete
   */
  async hydrateFromDatabase(): Promise<void> {
    if (!this.database) {
      throw new AbloValidationError('Database not available for hydration', {
        code: 'sync_client_db_missing',
      });
    }

    // Get model types that should be hydrated on startup (skip lazy per LSE)
    const modelTypes = this.objectPool.registry.getRegisteredModelNames().filter((name) => {
      const meta = this.objectPool.registry.getMetadata(name);
      return (
        meta?.loadStrategy === LoadStrategy.instant || meta?.loadStrategy === LoadStrategy.partial
      );
    });

    const totalStart = typeof performance !== 'undefined' ? performance.now() : Date.now();

    // Phase 1: Fetch all data from IndexedDB and create model instances (async I/O).
    // We collect all models across ALL types before touching MobX, so that Phase 2
    // can add them in a single addBatch() call → ONE MobX action → ONE re-render.
    const allModelsToAdd: Model[] = [];
    const perTypePerfLogs: Array<{
      type: string;
      fetched: number;
      added: number;
      fetchMs: string;
      createMs: string;
    }> = [];

    for (const modelType of modelTypes) {
      const typeStart = typeof performance !== 'undefined' ? performance.now() : Date.now();
      try {
        // Get raw data from Database (via StoreManager)
        const rawData = await this.database.hydrateModels(modelType);
        const afterFetch = typeof performance !== 'undefined' ? performance.now() : Date.now();

        // Create models in batch first, collect for deferred addBatch
        const modelsForType: Model[] = [];
        const recordsToHeal: Array<{ id: string; data: Record<string, unknown> }> = [];

        for (const data of rawData) {
          let withType =
            data && typeof data === 'object' && !data.__typename
              ? { __typename: modelType, ...data }
              : data;

          // Self-healing: Fix corrupted IndexedDB records missing essential fields
          const healResult = this.healModelRecord(modelType, withType as Record<string, unknown>);
          if (healResult === null) {
            continue; // Record is corrupted beyond repair — skip
          }
          withType = healResult.data;
          if (healResult.healed) {
            recordsToHeal.push({ id: healResult.data.id as string, data: healResult.data });
          }

          const model = this.objectPool.createFromData(withType);

          if (model) {
            modelsForType.push(model);
          }
        }

        // Collect models for the single batched addBatch call in Phase 2
        allModelsToAdd.push(...modelsForType);

        // Persist healed records back to IndexedDB (fire-and-forget, non-blocking)
        if (recordsToHeal.length > 0 && this.database) {
          getContext().logger.info(
            `[SyncClient.hydrate] Persisting ${recordsToHeal.length} healed ${modelType} records to IndexedDB`
          );
          // Use fire-and-forget to not block hydration
          Promise.resolve().then(async () => {
            try {
              for (const { id, data } of recordsToHeal) {
                await this.database!.putRecord(modelType, id, data);
              }
              getContext().logger.info(
                `[SyncClient.hydrate] Successfully healed ${recordsToHeal.length} ${modelType} records`
              );
            } catch (err) {
              getContext().observability.captureTransactionFailure({
                context: 'persist-healed-records',
                modelName: modelType,
                error: err instanceof Error ? err : new Error(String(err)),
              });
            }
          });
        }

        const typeEnd = typeof performance !== 'undefined' ? performance.now() : Date.now();

        // Dev-only hydration summary
        if (modelType === 'InboxItem' && process.env.NODE_ENV !== 'production') {
          getContext().logger.debug('[SyncClient] InboxItem hydration summary', {
            fetched: rawData.length,
            added: modelsForType.length,
          });
        }

        perTypePerfLogs.push({
          type: modelType,
          fetched: rawData.length,
          added: modelsForType.length,
          fetchMs: (afterFetch - typeStart).toFixed(2),
          createMs: (typeEnd - afterFetch).toFixed(2),
        });
      } catch (error) {
        getContext().observability.captureBootstrapFailure(error, { type: `hydrate-${modelType}` });
      }
    }

    // Phase 2: Single MobX action — add ALL models across all types at once.
    const addStart = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const totalAdded = this.objectPool.addBatch(allModelsToAdd, ModelScope.live);
    const addEnd = typeof performance !== 'undefined' ? performance.now() : Date.now();

    // Log per-type perf after the batched add (so logs still show per-type breakdown)
    for (const entry of perTypePerfLogs) {
      getContext().logger.debug('hydrate:type', parseFloat(entry.fetchMs) + parseFloat(entry.createMs), {
        type: entry.type,
        fetched: entry.fetched,
        added: entry.added,
        fetchMs: entry.fetchMs,
        createMs: entry.createMs,
      });
    }

    const totalEnd = typeof performance !== 'undefined' ? performance.now() : Date.now();
    getContext().logger.debug('hydrate:total', totalEnd - totalStart, {
      totalModels: totalAdded,
      addBatchMs: (addEnd - addStart).toFixed(2),
    });

    // One-line startup summary: types pre-seeded and items per type
    try {
      const preseededTypes = this.objectPool.registry.getRegisteredModelNames();
      const stats = this.objectPool.getStats();
      getContext().logger.info('startup_summary', {
        typesPreseeded: preseededTypes.length,
        poolSize: stats.size,
        typeCounts: stats.typeCounts,
      });
    } catch {}
  }

  /**
   * Re-hydrate ObjectPool from IndexedDB when the pool already has data.
   *
   * Unlike hydrateFromDatabase() (which uses addBatch and skips existing IDs),
   * this method properly:
   *   1. Upserts models — updates existing models in-place, adds new ones
   *   2. Removes ghosts — deletes models from the pool that no longer exist in IndexedDB
   *
   * Used by background bootstrap, network recovery, and server-triggered re-bootstrap.
   */
  async rehydrateFromDatabase(): Promise<RehydrationStats> {
    if (!this.database) {
      throw new AbloValidationError('Database not available for rehydration', {
        code: 'sync_client_db_missing',
      });
    }

    const totalStart = typeof performance !== 'undefined' ? performance.now() : Date.now();

    // Model types to rehydrate (same filter as hydrateFromDatabase)
    const modelTypes = this.objectPool.registry.getRegisteredModelNames().filter((name) => {
      const meta = this.objectPool.registry.getMetadata(name);
      return (
        meta?.loadStrategy === LoadStrategy.instant || meta?.loadStrategy === LoadStrategy.partial
      );
    });

    // ── Phase 1: Read from IndexedDB & create model instances (async I/O) ──
    const allModels: Model[] = [];
    const idbIdsByType = new Map<string, Set<string>>();
    let healedCount = 0;
    let skippedCount = 0;

    for (const modelType of modelTypes) {
      try {
        const rawData = await this.database.hydrateModels(modelType);
        const idsForType = new Set<string>();
        idbIdsByType.set(modelType, idsForType);

        for (const data of rawData) {
          let withType =
            data && typeof data === 'object' && !data.__typename
              ? { __typename: modelType, ...data }
              : data;

          // Self-healing
          const healResult = this.healModelRecord(modelType, withType as Record<string, unknown>);
          if (healResult === null) {
            skippedCount++;
            continue;
          }
          withType = healResult.data;
          if (healResult.healed) {
            healedCount++;
            // Persist heal back to IndexedDB (fire-and-forget)
            if (this.database) {
              const id = healResult.data.id as string;
              const healedData = healResult.data;
              Promise.resolve().then(async () => {
                try {
                  await this.database!.putRecord(modelType, id, healedData);
                } catch {
                  // Non-critical — will heal again next time
                }
              });
            }
          }

          // Register ID before createFromData — prevents ghost removal
          // if createFromData fails for a record that exists in IDB
          const recordId = (withType as Record<string, unknown>).id as string | undefined;
          if (recordId) {
            idsForType.add(recordId);
          }

          try {
            const model = this.objectPool.createFromData(withType);
            if (model) {
              allModels.push(model);
            }
          } catch (error) {
            getContext().observability.breadcrumb(
              'Model creation failed during rehydration',
              'sync.bootstrap',
              'warning',
              {
                modelType,
                modelId: recordId?.slice(0, 8) ?? 'unknown',
                error: error instanceof Error ? error.message : String(error),
              }
            );
            skippedCount++;
          }
        }
      } catch (error) {
        getContext().observability.captureBootstrapFailure(error, { type: `rehydrate-${modelType}` });
      }
    }

    // ── Phase 2: Upsert batch (single MobX action) ──
    // createFromData already calls updateFromData() on existing models,
    // so existing models are up-to-date. Upsert adds the new ones and
    // updates scope for any that changed.
    const beforeSize = this.objectPool.size;
    this.objectPool.upsertBatch(allModels, ModelScope.live);
    const addedCount = this.objectPool.size - beforeSize;
    const updatedCount = allModels.length - addedCount;

    // ── Phase 3: Reconcile ghost deletions (single MobX action) ──
    // Only reconcile types that were rehydrated — never touch lazy-loaded types.
    const ghostIds: string[] = [];

    for (const modelType of modelTypes) {
      const idbIds = idbIdsByType.get(modelType);
      if (!idbIds) continue; // Type had an error during fetch — don't reconcile

      const poolIds = this.objectPool.getIdsByModelType(modelType);
      if (!poolIds) continue;

      for (const poolId of poolIds) {
        if (!idbIds.has(poolId)) {
          ghostIds.push(poolId);
        }
      }
    }

    const removedCount = this.objectPool.removeBatch(ghostIds);

    // ── Phase 4: Stats & logging ──
    const totalEnd = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const elapsedMs = Math.round(totalEnd - totalStart);

    const stats: RehydrationStats = {
      added: addedCount,
      updated: updatedCount,
      removed: removedCount,
      skipped: skippedCount,
      healed: healedCount,
      elapsedMs,
    };

    getContext().logger.info('[SyncClient.rehydrate] Complete', {
      ...stats,
      poolSize: this.objectPool.size,
      ghostIds: ghostIds.length > 0 ? ghostIds.slice(0, 5).map((id) => id.slice(0, 8)) : [],
    });

    getContext().observability.breadcrumb('Rehydration complete', 'sync.bootstrap', 'info', {
      added: stats.added,
      updated: stats.updated,
      removed: stats.removed,
      elapsedMs: stats.elapsedMs,
    });

    return stats;
  }

  /**
   * Mutate model optimistically and queue for server sync.
   * IndexedDB is only updated when server confirms via delta packet.
   *
   * CRITICAL: Changes are captured BEFORE poolAction to prevent data loss.
   * The captured changes are frozen and passed to queueMutation.
   *
   * @see src/sync-engine/types/TrackableModel.ts for change capture pattern
   */
  private mutate(
    type: 'create' | 'update' | 'delete' | 'archive',
    model: Model,
    poolAction: () => void,
    writeOptions?: WriteOptions,
  ): void {
    // CRITICAL FIX: Capture changes BEFORE pool action
    // Pool operations (especially upsert) can clear _local changes
    // By capturing first, we ensure changes are never lost
    const capturedChanges =
      type === 'update' || type === 'create' ? this.captureModelChanges(model) : undefined;

    poolAction();
    this.queueMutation({ type, model, timestamp: new Date(), capturedChanges, writeOptions });
    this.notifyObservers({
      type,
      modelType: model.getModelName(),
      model: type !== 'delete' ? model : undefined,
      modelId: model.id,
    });

    // QueryProcessor uses `models:changed` to invalidate caches. Coalesce
    // to one event per microtask: a paste of 100 layers should re-run
    // affected queries ONCE, not 100×.
    this.markModelChanged(model.getModelName());
  }

  private pendingChangedTypes: Set<string> | null = null;

  private markModelChanged(modelType: string): void {
    if (!this.pendingChangedTypes) {
      this.pendingChangedTypes = new Set();
      const schedule =
        typeof queueMicrotask === 'function'
          ? queueMicrotask
          : (cb: () => void) => Promise.resolve().then(cb);
      schedule(() => {
        const types = this.pendingChangedTypes;
        this.pendingChangedTypes = null;
        if (types && types.size > 0) this.emit('models:changed', types);
      });
    }
    this.pendingChangedTypes.add(modelType);
  }

  /**
   * Capture model changes immutably BEFORE any pool operations
   * This prevents the fragile pattern of reading changes after state modification
   */
  private captureModelChanges(model: Model): Record<string, unknown> | undefined {
    if (typeof model.getChanges !== 'function') return undefined;
    const changes = model.getChanges();
    // Return a frozen copy to prevent accidental modification
    return Object.keys(changes).length > 0 ? Object.freeze({ ...changes }) : undefined;
  }

  /** Add new model (CREATE) - works offline */
  add(model: Model, options?: WriteOptions): void {
    this.mutate('create', model, () => this.objectPool.add(model, ModelScope.live), options);
  }

  /** Update existing model (UPDATE) - works offline */
  update(model: Model, options?: WriteOptions): void {
    this.mutate('update', model, () => this.objectPool.upsert(model, ModelScope.live), options);
  }

  /**
   * Update existing model with pre-computed changes.
   * Used by saveManyOptimized when incoming models have empty change-tracking
   * (e.g. freshly constructed SpreadsheetCellModels from decomposeSpreadsheetDocument).
   */
  updateWithChanges(model: Model, changes?: Record<string, unknown>): void {
    getContext().logger.debug(`SyncClient.updateWithChanges`, {
      modelId: model.id,
      modelType: model.getModelName(),
    });

    // Use pre-computed changes if provided, otherwise fall back to model.getChanges()
    const capturedChanges =
      changes && Object.keys(changes).length > 0
        ? Object.freeze({ ...changes })
        : this.captureModelChanges(model);

    this.objectPool.upsert(model, ModelScope.live);
    this.queueMutation({ type: 'update', model, timestamp: new Date(), capturedChanges });
    this.notifyObservers({
      type: 'update',
      modelType: model.getModelName(),
      model,
      modelId: model.id,
    });
  }

  /** Expose the GraphQL client for atomic mutations (e.g., createSlideWithLayers).
   *  Used by SyncedStore for operations that bypass the transaction queue
   *  but still need optimistic pool updates at the sync layer. */
  get gql() {
    return this.mutationExecutor;
  }

  /** Delete model (DELETE) - works offline */
  delete(model: Model, options?: WriteOptions): void {
    // Clear pending mutations first to prevent "not found" errors on fast delete
    this.clearPendingMutationsForModel(model.id);
    this.mutate('delete', model, () => this.objectPool.remove(model.id), options);
  }

  /**
   * Clear all pending mutations for a specific model
   * Called before deletion to prevent "layer not found" errors on the server
   */
  private clearPendingMutationsForModel(modelId: string): void {
    const beforeCount = this.pendingMutations.length;
    this.pendingMutations = this.pendingMutations.filter((m) => m.model.id !== modelId);
    const afterCount = this.pendingMutations.length;

    if (beforeCount !== afterCount) {
      getContext().logger.debug('[SyncClient.clearPendingMutationsForModel] Cleared pending mutations', {
        modelId,
        clearedCount: beforeCount - afterCount,
        remainingCount: afterCount,
      });

      // Persist updated queue immediately
      void this.persistMutationQueue();
    }
  }

  /**
   * Upload file and create attachment (UPLOAD operation)
   * Uses Linear-style pattern with immediate URL generation
   */
  async uploadFile(
    file: File,
    options: {
      id: string;
      attachableType: string;
      attachableId: string;
      metadata?: Record<string, unknown>;
    }
  ): Promise<Model | null> {
    if (!this.userId || !this.organizationId) {
      throw new AbloAuthenticationError('Authentication required for file uploads', {
        code: 'file_upload_auth_required',
      });
    }

    try {
      // Use TransactionQueue to handle the upload mutation
      const result = await this.transactionQueue.uploadAttachment(
        file,
        {
          id: options.id,
          attachableType: options.attachableType,
          attachableId: options.attachableId,
          metadata: options.metadata,
        },
        {
          userId: this.userId,
          organizationId: this.organizationId,
        }
      );

      if (result) {
        // Create model from response using ModelRegistry (generic — no concrete class import)
        const model = this.objectPool.createFromData({
          id: options.id,
          ...result,
        });

        if (model) {
          this.objectPool.add(model, ModelScope.live);
          this.notifyObservers({
            type: 'create',
            modelType: model.getModelName(),
            model,
          });
          return model;
        }
      }

      return null;
    } catch (error) {
      getContext().observability.captureTransactionFailure({
        context: 'file-upload',
        error: error instanceof Error ? error : new Error(String(error)),
      });
      throw error;
    }
  }

  /**
   * Batch upload files — single GraphQL call + parallel S3 PUTs.
   *
   * Returns the raw `Model[]` built by the object pool (typename is
   * determined by the payload the server returns — currently always
   * `Attachment`). The SDK has no knowledge of app-specific model classes,
   * so it cannot honestly claim a narrower return type; consumers that
   * need an `Attachment[]` project through their own typed accessor
   * (e.g. `store.query.attachments.findMany({ where: { id: IN ids } })`)
   * after the upload resolves.
   */
  async batchUploadFiles(
    files: File[],
    options: {
      ids: string[];
      attachableType: string;
      attachableId: string;
      metadata?: Record<string, unknown>;
    }
  ): Promise<Model[]> {
    if (!this.userId || !this.organizationId) {
      throw new AbloAuthenticationError('Authentication required for file uploads', {
        code: 'file_upload_auth_required',
      });
    }

    const items = options.ids.map((id) => ({
      id,
      attachableType: options.attachableType,
      attachableId: options.attachableId,
      metadata: options.metadata,
    }));

    const results = await this.transactionQueue.batchUploadAttachments(files, items, {
      userId: this.userId,
      organizationId: this.organizationId,
    });

    const models: Model[] = [];
    for (const result of results) {
      const model = this.objectPool.createFromData({ ...result });
      if (model) {
        this.objectPool.add(model, ModelScope.live);
        this.notifyObservers({
          type: 'create',
          modelType: model.getModelName(),
          model,
        });
        models.push(model);
      }
    }

    return models;
  }

  /** Archive model (ARCHIVE) - works offline */
  archive(model: Model): void {
    this.mutate('archive', model, () => this.objectPool.updateScope(model.id, ModelScope.archived));
  }

  /**
   * Append a mutation and schedule its sync work.
   *
   * IDB persistence and the server push are deferred to a microtask so N
   * pushes inside the same tick collapse into ONE IDB serialization + ONE
   * process call. Without the deferral, queueing 100 mutations (paste,
   * PPTX import, AI sandbox layer creation) reserializes the entire
   * growing queue 100× — O(N²) `model.toJSON()`.
   *
   * @param mutation.capturedChanges - Pre-captured changes (frozen), used
   *   to avoid re-reading changes after pool ops that might clear them.
   */
  private queueMutation(mutation: {
    type: 'create' | 'update' | 'delete' | 'archive';
    model: Model;
    timestamp: Date;
    capturedChanges?: Record<string, unknown>;
    writeOptions?: WriteOptions;
  }): void {
    this.pendingMutations.push(mutation);
    this.scheduleSync();
  }

  private syncScheduled = false;

  private scheduleSync(): void {
    if (this.syncScheduled) return;
    this.syncScheduled = true;
    const schedule =
      typeof queueMicrotask === 'function'
        ? queueMicrotask
        : (cb: () => void) => Promise.resolve().then(cb);
    schedule(() => {
      this.syncScheduled = false;
      void this.persistMutationQueue();
      if (getContext().onlineStatus.isOnline()) {
        this.processPendingMutations().catch((err) => {
          getContext().observability.breadcrumb(
            'Background sync failed',
            'sync.transaction',
            'warning',
            { error: err instanceof Error ? err.message : String(err) },
          );
        });
      }
    });
  }

  /**
   * Persist mutation queue to IndexedDB
   */
  private async persistMutationQueue(): Promise<void> {
    if (!this.database || !this.userId) return;

    try {
      const serializedMutations = this.pendingMutations.map((m) => ({
        type: m.type,
        modelData: m.model.toJSON ? m.model.toJSON() : { ...m.model },
        modelName: m.model.getModelName(),
        timestamp: m.timestamp.toISOString(),
        writeOptions: m.writeOptions,
      }));

      await this.database.saveTransaction({
        id: 'mutation-queue',
        type: 'queue',
        mutations: serializedMutations,
        timestamp: Date.now(),
      });
    } catch (error) {}
  }

  /**
   * Restore mutation queue from IndexedDB
   */
  private async restoreMutationQueue(): Promise<void> {
    if (!this.database || !this.userId) return;

    try {
      const stored = await this.database.getPersistedTransactions();
      const queue = stored.find((t) => t.id === 'mutation-queue');

      if (queue?.mutations) {
        for (const mutation of queue.mutations) {
          const model = this.objectPool.createFromData(mutation.modelData);
          if (model) {
            this.pendingMutations.push({
              type: mutation.type,
              model,
              timestamp: new Date(mutation.timestamp),
              writeOptions: mutation.writeOptions,
            });
          }
        }
      }
    } catch (error) {}
  }

  /**
   * Process pending mutations - can be called by SyncedStore when online
   *
   * Best Practice: Only sync models that still exist locally (local-first principle)
   * - If a model was deleted locally → skip any pending updates/creates for it
   * - This prevents "layer not found" errors from fast copy-paste-delete workflows
   */
  async processPendingMutations(): Promise<void> {
    if (this.pendingMutations.length === 0) return;
    // Identity guard. The early returns here used to be silent — the bug
    // pattern was "every mutation from a logged-in user evaporates" when
    // `SyncClient.initialize()` wasn't called (e.g., missing wiring in
    // the consumer's `BaseSyncedStore.initialize` generator). Warn so
    // this class of misconfiguration surfaces in dev instead of
    // manifesting as "my drag doesn't save."
    if (!this.userId || !this.organizationId) {
      getContext().logger.warn(
        '[sync] mutations dropped — SyncClient has no identity. ' +
          'Did the store call `syncClient.initialize(userId, orgId)`?',
        {
          pending: this.pendingMutations.length,
          userId: this.userId,
          organizationId: this.organizationId,
        },
      );
      return;
    }
    if (!getContext().onlineStatus.isOnline()) return; // Skip if offline
    if (this.isDisposed) return; // Skip if disposed

    const mutations = this.pendingMutations;
    this.pendingMutations = [];

    // Clear persisted queue before processing
    await this.persistMutationQueue();

    // LINEAR PATTERN: Stage all mutations synchronously in same event loop tick
    // TransactionQueue's microtask will batch and send them together
    for (const mutation of mutations) {
      // Skip mutations for deleted models (prevents "not found" errors)
      if (mutation.type !== 'delete' && !this.objectPool.get(mutation.model.id)) {
        continue;
      }
      // Stage synchronously - TransactionQueue handles batching, retry, and errors
      this.stageMutation(mutation);
    }
  }

  /**
   * Stage mutation to TransactionQueue - mutations in same tick are batched via microtask
   *
   * @param mutation.capturedChanges - Pre-captured changes to use instead of re-reading from model
   */
  private stageMutation(mutation: {
    type: 'create' | 'update' | 'delete' | 'archive';
    model: Model;
    timestamp: Date;
    capturedChanges?: Record<string, unknown>;
    writeOptions?: WriteOptions;
  }): void {
    if (!this.userId || !this.organizationId) return;

    const ctx = { userId: this.userId, organizationId: this.organizationId };

    if (mutation.type === 'update') {
      this.transactionQueue.update(
        mutation.model,
        ctx,
        mutation.capturedChanges,
        mutation.writeOptions,
      );
    } else {
      const handler = this.transactionQueue[mutation.type].bind(this.transactionQueue);
      handler(mutation.model, ctx, mutation.writeOptions);
    }
  }

  /**
   * Resolve conflicts between local and server data
   * Used when processing deltas from WebSocket
   *
   * CRITICAL: Always respects certain server states (deletes, deactivations)
   * even when there are local changes, to maintain data consistency.
   */
  resolveConflicts(localModel: Model, serverData: any): Model {
    const hasLocalChanges = localModel.hasChanges;
    // Safely get timestamp, handling both Date objects and strings
    const localUpdatedAt = localModel.updatedAt
      ? localModel.updatedAt instanceof Date
        ? localModel.updatedAt.getTime()
        : new Date(localModel.updatedAt).getTime()
      : 0;
    const serverUpdatedAt = serverData?.updatedAt ? new Date(serverData.updatedAt).getTime() : 0;

    getContext().logger.debug('Conflict resolution', {
      modelId: localModel.id,
      modelType: localModel.getModelName(),
      hasLocalChanges,
      localUpdatedAt: localModel.updatedAt?.toString(),
      serverUpdatedAt: serverData.updatedAt,
      localChanges: localModel.getChanges(),
      serverState: this.extractCriticalState(serverData),
    });

    // PRIORITY 1: Check for critical server states that must be respected
    // These states override any local changes to maintain data consistency
    const criticalServerStates = this.extractCriticalState(serverData);
    const shouldForceAcceptServer = this.hasCriticalStateChange(criticalServerStates);

    if (shouldForceAcceptServer) {
      getContext().logger.debug('Accepting server update - critical state change detected', {
        modelId: localModel.id,
        criticalStates: criticalServerStates,
      });

      // Force accept server state for critical changes
      localModel.updateFromData(serverData);
      localModel.clearChanges();
      localModel.markAsSynced();
      return localModel;
    }

    // Local-first: if we have local dirty fields, merge by field.
    // Keep locally changed fields; apply server for the rest.
    if (hasLocalChanges) {
      const localChanges = localModel.getChanges();
      getContext().logger.debug('Merging server update with local dirty fields', {
        modelId: localModel.id,
        keptFields: Object.keys(localChanges || {}),
      });

      // Merge: server baseline + local dirty fields win
      const merged: ModelData = { ...serverData, ...(localChanges || {}) };

      // Preserve the most recent updatedAt without clearing dirty flags
      if (serverData?.updatedAt || localModel.updatedAt) {
        const mergedUpdatedAt = new Date(Math.max(localUpdatedAt, serverUpdatedAt));
        // updateFromData accepts Date or ISO string for dates
        merged.updatedAt = mergedUpdatedAt;
      }

      localModel.updateFromData(merged);
      // Intentionally DO NOT clearChanges here; pending tx will confirm and clear
      return localModel;
    }

    // No local changes: fall back to LWW to converge
    // Accept server regardless of timestamp equality to stay in sync
    const acceptReason = serverUpdatedAt > localUpdatedAt ? 'server is newer' : 'no local changes';
    getContext().logger.debug(`Accepting server update - ${acceptReason}`);
    localModel.updateFromData(serverData);
    localModel.clearChanges();
    localModel.markAsSynced();
    return localModel;
  }

  /**
   * Extract critical state fields from server data
   * These are states that must always be respected, even with local changes
   */
  private extractCriticalState(serverData: any): Record<string, any> {
    const critical: Record<string, any> = {};

    if (!serverData || typeof serverData !== 'object') {
      return critical;
    }

    // Deletion/archival states - always critical
    if (serverData.deletedAt !== undefined) {
      critical.deletedAt = serverData.deletedAt;
    }
    if (serverData.archivedAt !== undefined) {
      critical.archivedAt = serverData.archivedAt;
    }

    // Deactivation states - critical for assignments and similar entities
    if (serverData.isActive !== undefined && serverData.isActive === false) {
      critical.isActive = false;
    }
    if (serverData.unassignedAt !== undefined) {
      critical.unassignedAt = serverData.unassignedAt;
    }

    return critical;
  }

  /**
   * Check if critical state changes exist that require forcing server state
   */
  private hasCriticalStateChange(criticalStates: Record<string, any>): boolean {
    // Any critical state present means we should force accept server
    return (
      Object.keys(criticalStates).length > 0 &&
      Object.values(criticalStates).some((v) => v !== null && v !== undefined)
    );
  }

  /**
   * Handle network reconnection
   */
  private async handleReconnection(): Promise<void> {
    getContext().observability.breadcrumb('Network reconnected', 'sync.offline');
    this.emit('sync:reconnecting');

    try {
      // Prefer a single batch flush for pending mutations (fast path)
      try {
        await this.transactionQueue.flushOfflineQueue();
      } catch {}
      // Process all queued mutations
      await this.processPendingMutations();

      this.setConnectionState('connected');
      this.emit('sync:reconnected');

      // Clear offline timestamp
      this.offlineSince = undefined;
    } catch (error) {
      getContext().observability.captureTransactionFailure({
        context: 'reconnection-sync',
        error: error instanceof Error ? error : new Error(String(error)),
      });
      this.emit('sync:error', error);
    }
  }

  /**
   * Handle network disconnection
   */
  private async handleDisconnection(): Promise<void> {
    getContext().observability.breadcrumb('Network disconnected', 'sync.offline');
    this.setConnectionState('disconnected');
    this.offlineSince = new Date();
    this.emit('sync:offline');
  }

  /**
   * Get current sync state
   */
  getState(): SyncState {
    return {
      connectionState: this.connectionState,
      pendingMutations: this.pendingMutations.length,
      lastSyncAt: new Date(),
      error: undefined,
    };
  }

  /**
   * Set connection state
   */
  private setConnectionState(state: 'connected' | 'disconnected' | 'connecting'): void {
    const oldState = this.connectionState;
    this.connectionState = state;

    if (oldState !== state) {
      getContext().observability.setConnectionState(state);
      getContext().observability.breadcrumb(`Connection: ${oldState} → ${state}`, 'sync.websocket');
      if (state === 'connected') {
        this.emit('connection:established');
        this.transactionQueue.setConnectionState('connected');
      } else if (state === 'disconnected') {
        this.emit('connection:disconnected');
        this.transactionQueue.setConnectionState('disconnected');
      }
    }
  }

  /**
   * Subscribe to events with disposer pattern
   */
  subscribe(event: string, handler: (data?: unknown) => void): () => void {
    super.on(event, handler);

    // Return disposer function
    return () => {
      this.off(event, handler);
    };
  }

  /**
   * Add observer for sync events
   */
  addObserver(observer: SyncObserver): void {
    this.observers.add(observer);
  }

  /**
   * Remove observer
   */
  removeObserver(observer: SyncObserver): void {
    this.observers.delete(observer);
  }

  /**
   * Notify all observers
   */
  private notifyObservers(event: SyncEvent): void {
    for (const observer of this.observers) {
      if (observer.onSync) {
        try {
          observer.onSync(event);
        } catch (error) {
          getContext().observability.breadcrumb('Observer error', 'sync.transaction', 'error', {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
  }

  /**
   * Disconnect from sync
   */
  disconnect(): void {
    this.setConnectionState('disconnected');
  }

  /**
   * Mark the sync client as connected
   * Called when WebSocket successfully connects (can happen independently of browser online/offline)
   */
  markConnected(): void {
    this.setConnectionState('connected');
  }

  /**
   * Dispose and cleanup
   */
  dispose(): void {
    this.isDisposed = true;
    this.disconnect();
    this.networkMonitor.dispose();
    this.observers.clear();
    this.pendingMutations = [];
    this.removeAllListeners();
  }

  /**
   * LINEAR PATTERN: Notify TransactionQueue of incoming delta for sync ID threshold confirmation.
   * Transactions are confirmed when any delta with id >= their lastSyncId threshold arrives.
   * @param syncId - The sync ID of the received delta
   */
  onDeltaReceived(syncId: number): void {
    try {
      this.transactionQueue.onDeltaReceived(syncId);
    } catch (e) {
      getContext().observability.breadcrumb(
        'Failed to notify delta received',
        'sync.transaction',
        'warning',
        {
          syncId,
        }
      );
    }
  }

  /**
   * LINEAR PATTERN: Cancel transactions for orphaned child entities
   *
   * Called by SyncedStore when a DELETE delta arrives for a parent entity.
   * Cancels pending transactions for children that reference the deleted parent.
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
    return this.transactionQueue.cancelTransactionsByForeignKey(
      childModelName,
      foreignKey,
      parentId
    );
  }

  /**
   * Wait for a transaction to be confirmed via delta echo (Linear pattern)
   * Delegates to TransactionQueue which already handles timeouts
   */
  waitForDeltaConfirmation(transactionId: string): Promise<void> {
    return this.transactionQueue.waitForConfirmation(transactionId);
  }

  /**
   * Force sync now - process pending mutations
   */
  async syncNow(): Promise<void> {
    await this.processPendingMutations();
  }

  /**
   * Get sync statistics. Return type is inferred from the literal so
   * the call site sees the actual shape — `connectionState` narrowed
   * to its three states, `objectPoolStats` typed by `ObjectPool.getStats`.
   */
  getSyncStats(): {
    connectionState: 'connected' | 'disconnected' | 'connecting';
    pendingMutations: number;
    objectPoolStats: ReturnType<ObjectPool['getStats']>;
  } {
    return {
      connectionState: this.connectionState,
      pendingMutations: this.pendingMutations.length,
      objectPoolStats: this.objectPool.getStats(),
    };
  }

  /**
   * Get pending transaction count from TransactionQueue
   * Used by SyncedStore to compute hasUnsyncedChanges
   */
  getPendingTransactionCount(): number {
    const stats = this.transactionQueue.getStats();
    // Include pending and executing as "unsynced"
    // awaiting_delta transactions are included in 'executing' until confirmed
    // Completed and failed are "synced" (either done or gave up)
    return stats.pending + stats.executing;
  }

  /**
   * Subscribe to transaction events for sync status tracking
   * Returns unsubscribe function
   */
  onTransactionEvent(event: 'created' | 'completed' | 'failed', callback: () => void): () => void {
    const eventName = `transaction:${event}`;
    this.transactionQueue.on(eventName, callback);
    return () => this.transactionQueue.off(eventName, callback);
  }

  /**
   * Subscribe to mutation failures with the full payload. Mirrors the
   * underlying TransactionQueue 'transaction:failed' shape so consumers
   * can render typed UI (toast keyed by `AbloError.type`, route-level
   * "this entity reverted" boundaries, telemetry).
   *
   * Distinct from `onTransactionEvent('failed', cb)`, which exists only
   * for the legacy parameterless `pendingChanges` counter and intentionally
   * drops the payload. The two coexist — keep the counter callback fast
   * and the typed listener for user-visible surfaces.
   */
  onMutationFailure(
    listener: (payload: {
      transaction: import('./transactions/TransactionQueue.js').Transaction;
      error: Error;
      permanent?: boolean;
    }) => void,
  ): () => void {
    this.transactionQueue.on('transaction:failed', listener);
    return () => this.transactionQueue.off('transaction:failed', listener);
  }

  /**
   * Subscribe to LOCAL transaction creation with the full {@link Transaction}
   * payload (`type`, `modelName`, `modelId`, `data`, `previousData`). This is
   * the feed `BaseSyncedStore.subscribeLocalMutations` taps for undo recording.
   *
   * MUST subscribe to the TransactionQueue's emitter directly — that is the
   * ONLY emitter that fires `transaction:created`. SyncClient's own emitter
   * (reached via `subscribe()`) never re-broadcasts it, so routing undo through
   * `subscribe('transaction:created')` silently records nothing. Mirrors
   * `onMutationFailure`, which taps the queue for the same reason.
   */
  onLocalTransaction(
    listener: (tx: import('./transactions/TransactionQueue.js').Transaction) => void,
  ): () => void {
    this.transactionQueue.on('transaction:created', listener);
    // Commit-lane writes (`ablo.commits.create` — the agent/atomic door) ride
    // their own `commit:created` event: they have no optimistic pool apply,
    // so they must not feed the echo tracker's `transaction:created` path.
    // Enrich each operation with previous state captured from the pool HERE
    // (the queue is pool-free) and hand the synthesized transaction to the
    // same listener, so undo observes every write door — one stream.
    const onCommitCreated = (payload: {
      clientTxId: string;
      operations: ReadonlyArray<{
        type: string;
        model: string;
        id: string;
        input?: Record<string, unknown>;
      }>;
    }): void => {
      const TYPE_BY_WIRE: Record<
        string,
        import('./transactions/TransactionQueue.js').Transaction['type']
      > = {
        CREATE: 'create',
        UPDATE: 'update',
        DELETE: 'delete',
        ARCHIVE: 'archive',
        UNARCHIVE: 'unarchive',
      };
      payload.operations.forEach((op, index) => {
        const type = TYPE_BY_WIRE[op.type];
        if (!type || !op.id) return;
        const resident = this.objectPool.get(op.id);
        const snapshot =
          type === 'create' ? undefined : (resident?.toJSON() as Record<string, unknown> | undefined);
        // A DELETE of a row the local graph never saw is not invertible —
        // recording it would make undo "restore" an empty husk. Skip it.
        if (type === 'delete' && !snapshot) return;
        // UPDATE inverse must only revert the fields this op actually wrote;
        // handing undo the FULL row would clobber concurrent edits to
        // unrelated fields on revert.
        const previousData =
          type === 'update' && snapshot && op.input
            ? Object.fromEntries(
                Object.keys(op.input).map((key) => [key, snapshot[key]]),
              )
            : snapshot ?? null;
        listener({
          id: `${payload.clientTxId}_op${index}`,
          type,
          modelName: op.model,
          modelId: op.id,
          modelKey: op.model,
          data: op.input ?? undefined,
          previousData,
          context: {
            userId: this.userId ?? '',
            organizationId: this.organizationId ?? '',
          },
          status: 'pending',
          createdAt: Date.now(),
          attempts: 0,
          priority: 'normal',
          priorityScore: 0,
        });
      });
    };
    this.transactionQueue.on('commit:created', onCommitCreated);
    return () => {
      this.transactionQueue.off('transaction:created', listener);
      this.transactionQueue.off('commit:created', onCommitCreated);
    };
  }

  /**
   * Wait for the latest in-flight transaction for (modelName, modelId)
   * to be confirmed by the server, or reject if it's rolled back.
   * Resolves immediately when no transaction is in flight — see
   * `TransactionQueue.confirmationFor` for the lookup contract.
   *
   * Distinct from `waitForDeltaConfirmation(transactionId)` which keys
   * off a known tx id; this variant is for call sites that hold a
   * Model reference but never see the underlying transaction.
   */
  waitForConfirmation(modelName: string, modelId: string): Promise<void> {
    return this.transactionQueue.confirmationFor(modelName, modelId);
  }

  /**
   * Get detailed debug info for the sync debug page
   */
  getDebugInfo() {
    return {
      connectionState: this.connectionState,
      pendingMutationsCount: this.pendingMutations.length,
      transactionQueue: this.transactionQueue.getDebugInfo(),
    };
  }

  // --- Best-practice assignment ops ---
  async unassignEntity(entityType: string, entityId: string): Promise<void> {
    // Call server-side unassign to avoid per-id races
    await this.mutationExecutor.executeDelete('Assignment', entityId);
  }

  async reassignEntity(
    entityType: string,
    entityId: string,
    assigneeType: string,
    assigneeId: string,
    id?: string
  ): Promise<void> {
    await this.mutationExecutor.executeCreate('Assignment', id || '', {
      entityType,
      entityId,
      assigneeType,
      assigneeId,
    });
  }

  // ── Delta + Bootstrap application (owns ObjectPool writes) ──────────────

  /**
   * Apply a batch of delta results from Database to the ObjectPool.
   * Owns: model creation, upsert, remove, archive, conflict resolution.
   * Returns: nothing — ObjectPool is updated in place.
   */
  /**
   * Mark a local transaction as optimistically applied. The matching
   * server delta (when it arrives with the same `transactionId`) will
   * be recognized as an echo and skip the pool mutation. Called
   * automatically by `TransactionQueue` when a transaction is staged;
   * exposed publicly so tests can drive the API directly.
   */
  markTransactionPending(transactionId: string): void {
    this.echoTracker.markPending(transactionId);
  }

  /**
   * Read echo-detection counters: hits, rollbacks, evictions, and the
   * current pending-set size. Surfaced for production observability
   * — a sustained `evictions > 0` rate or `rollbacks` spike is a
   * health signal worth alerting on.
   */
  getEchoMetrics(): Readonly<OptimisticEchoMetrics> {
    return this.echoTracker.getMetrics();
  }

  /**
   * Package-internal accessor for the TransactionQueue. Used by
   * `Ablo.commits.create()` to route raw multi-op envelopes through the
   * same retry-on-reconnect lane as the Model proxy path, and by tests
   * to exercise the queue ↔ markTransactionPending wiring on the real
   * instance the SyncClient subscribes to. NOT re-exported to SDK
   * consumers — `Ablo` itself is the public surface.
   */
  getTransactionQueue(): TransactionQueue {
    return this.transactionQueue;
  }

  applyDeltaBatchToPool(
    dbResults: Array<{
      action: string;
      modelName: string;
      modelId: string;
      data?: Record<string, unknown> | null;
      /**
       * Server-stamped transaction id, echoing the client's commit op
       * id. Used by echo detection to recognize "this is the
       * confirmation of a mutation I've already applied locally."
       * Optional because system-emitted deltas (sync_group changes,
       * schema-derived deltas, etc.) don't have a client transaction.
       */
      transactionId?: string;
    }>,
    enrichRelations: (modelName: string, data: Record<string, unknown>) => Record<string, unknown>,
  ): void {
    const modelsToAdd: Model[] = [];
    const modelsToUpsert: Model[] = [];
    const idsToRemove: string[] = [];
    const idsToArchive: string[] = [];

    // Pre-pass: collect every id slated for `remove` in this batch. The
    // chart-delete flicker came from this exact pattern: a peer (or the
    // user themself) deletes a chart with N layers; the commit produces
    // BOTH residual `update` deltas (from the optimistic edits that
    // happened just before the delete) AND `remove` deltas. The
    // `update` branch below would `createFromData` the row back into
    // the pool when `existing` was already gone (optimistic remove
    // happened), and the next loop iteration's `remove` would strip
    // it again — net effect: pool transitions live → gone → live →
    // gone in one tick, which the renderer catches mid-frame as a
    // flicker. Filter ops on doomed ids before they touch the pool.
    const idsBeingRemoved = new Set<string>();
    for (const r of dbResults) {
      if (r.action === 'remove') idsBeingRemoved.add(r.modelId);
    }

    for (const result of dbResults) {
      const { modelName, modelId, action, transactionId } = result;

      // ECHO DETECTION. If this delta carries a transaction id that
      // matches one we've optimistically applied locally, the pool
      // already reflects this mutation — skip the pool op. The
      // upstream IDB write (in `Database.processDeltaBatch`) still
      // runs; only the in-memory pool mutation is suppressed. This is
      // the architectural fix for the chart-delete flicker: a
      // server-confirmed CREATE arriving AFTER the user has
      // optimistically deleted the row would otherwise re-add the row
      // for the ~2s window before the matching DELETE confirmation
      // lands. See `OPTIMISTIC_RECONCILIATION.md` for the framing.
      if (this.echoTracker.consumeEcho(transactionId)) {
        continue;
      }

      // If a later op in this batch will remove this id, skip earlier
      // add/update ops on it. Server FK ordering can produce
      // U(layer)+D(layer) when an optimistic edit and a delete both
      // commit in the same window; only the final state matters.
      if ((action === 'add' || action === 'update') && idsBeingRemoved.has(modelId)) {
        continue;
      }

      switch (action) {
        case 'add': {
          const existing = this.objectPool.get(modelId);
          if (existing) {
            existing.markAsSynced();
          } else if (result.data) {
            const data = enrichRelations(modelName, { ...result.data, __typename: modelName });
            const model = this.objectPool.createFromData(data);
            if (model) modelsToAdd.push(model);
          }
          break;
        }
        case 'update': {
          const existing = this.objectPool.get(modelId);
          if (existing && !existing.disposed && result.data) {
            enrichRelations(modelName, result.data);
            const resolved = this.resolveConflicts(existing, result.data);
            modelsToUpsert.push(resolved);
          }
          // Resurrection drop: if `existing` is gone (optimistic delete
          // discarded it; the matching D delta is in-flight) we used
          // to call `createFromData` here, which reintroduced the row
          // for a frame before the D delta stripped it again — the
          // chart-delete flicker. Trust the local state. If the server
          // still considers the row alive, a subsequent bootstrap or
          // resync will reconcile.
          break;
        }
        case 'remove':
          idsToRemove.push(modelId);
          break;
        case 'archive':
          idsToArchive.push(modelId);
          break;
        case 'verify':
          // `verify` is `Database.processDeltaBatch`'s signal for a delta
          // whose IDB store transaction FAILED. Pool isn't updated for
          // this delta — by design, since the persisted view doesn't
          // reflect it either — and the persistence-gated cursor in
          // `BaseSyncedStore.flushPendingDeltas` will NOT ack past it,
          // so the next 30s catch-up poll (or reconnect handshake) will
          // re-fetch and re-apply. Logged here so silent IDB failures
          // are observable instead of disappearing into a default switch
          // fall-through.
          getContext().logger.warn('[SyncClient.applyDeltaBatchToPool] skipping pool op for unpersisted delta', {
            modelName,
            modelId: modelId.slice(0, 12),
          });
          break;
      }
    }

    // Batch ObjectPool mutations — minimal MobX actions
    if (modelsToAdd.length > 0) this.objectPool.addBatch(modelsToAdd, ModelScope.live);
    if (modelsToUpsert.length > 0) this.objectPool.upsertBatch(modelsToUpsert, ModelScope.live);
    if (idsToRemove.length > 0) this.objectPool.removeBatch(idsToRemove);
    for (const id of idsToArchive) this.objectPool.updateScope(id, ModelScope.archived);

    // Emit changed model types so QueryProcessor can auto-invalidate
    const changedTypes = new Set(dbResults.map(r => r.modelName));
    if (changedTypes.size > 0) this.emit('models:changed', changedTypes);
  }

  /**
   * Apply bootstrap data to the ObjectPool with ghost removal.
   * Owns: model creation, batch upsert, ghost detection + removal.
   */
  applyBootstrapDataToPool(
    bootstrapData: { models?: Record<string, unknown[]>; failedModels?: string[] },
    protectedIds?: ReadonlySet<string>,
  ): { added: number; updated: number; removed: number; skipped: number; healed: number } {
    if (!bootstrapData.models) {
      return { added: 0, updated: 0, removed: 0, skipped: 0, healed: 0 };
    }

    const allModels: Model[] = [];
    const serverIdsByType = new Map<string, Set<string>>();
    let healedCount = 0;
    let skippedCount = 0;

    const failedTypes = new Set(bootstrapData.failedModels ?? []);

    for (const [modelType, records] of Object.entries(bootstrapData.models)) {
      if (failedTypes.has(modelType)) continue;

      const idsForType = new Set<string>();
      serverIdsByType.set(modelType, idsForType);

      if (!Array.isArray(records) || records.length === 0) continue;

      for (const rawRecord of records) {
        if (!rawRecord || typeof rawRecord !== 'object') { skippedCount++; continue; }

        let data = rawRecord as Record<string, unknown>;
        if (!data.__typename) data = { __typename: modelType, ...data };

        const healResult = this.healModelRecord(modelType, data);
        if (healResult === null) { skippedCount++; continue; }
        data = healResult.data;
        if (healResult.healed) healedCount++;

        const recordId = data.id as string | undefined;
        if (recordId) idsForType.add(recordId);

        try {
          const model = this.objectPool.createFromData(data);
          if (model) allModels.push(model);
        } catch {
          skippedCount++;
        }
      }
    }

    // Batch upsert
    const beforeSize = this.objectPool.size;
    this.objectPool.upsertBatch(allModels, ModelScope.live);
    const addedCount = this.objectPool.size - beforeSize;
    const updatedCount = allModels.length - addedCount;

    // Ghost removal — remove pool entities not in server snapshot
    const ghostIds: string[] = [];
    for (const [modelType, serverIds] of serverIdsByType) {
      const poolIds = this.objectPool.getIdsByModelType(modelType);
      if (!poolIds) continue;
      for (const poolId of poolIds) {
        if (!serverIds.has(poolId) && !protectedIds?.has(poolId)) ghostIds.push(poolId);
      }
    }
    const removedCount = this.objectPool.removeBatch(ghostIds);

    // Emit changed model types so QueryProcessor can auto-invalidate
    const changedTypes = new Set(Object.keys(bootstrapData.models));
    if (changedTypes.size > 0) this.emit('models:changed', changedTypes);

    return { added: addedCount, updated: updatedCount, removed: removedCount, skipped: skippedCount, healed: healedCount };
  }
}
