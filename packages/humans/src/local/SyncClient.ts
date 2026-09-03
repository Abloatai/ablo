/**
 * Applies model mutations and manages the offline write queue. The
 * SyncClient turns local create, update, delete, and archive calls into
 * optimistic changes, holds them while the client is offline, sends them to
 * the server when connectivity returns, and resolves conflicts when the
 * server's version of a row disagrees with the local one. It sits between the
 * reactive object pool and the {@link MutationQueue} that delivers writes
 * over the network.
 */

import { runInAction } from 'mobx';
import { InstanceCache, ModelScope } from './InstanceCache.js';
import { Model } from './Model.js';
import type { ModelData } from '@abloatai/transaction/types/modelData';
import type { AppliedChange } from '../plugin.js';
import { deepEqual, snapshotJsonValue } from '@abloatai/transaction/utils/json';
// ModelRegistry instance accessed via this.objectPool.registry
import { LoadStrategy } from '@abloatai/transaction/types';
import { globalRuntime } from './context.js';
import type { RuntimeContext } from './RuntimeContext.js';
import { AbloError, AbloValidationError } from '@abloatai/transaction/errors';
import { EventEmitter } from 'events';
import { NetworkMonitor } from './NetworkMonitor.js';
import {
  MutationQueue,
  type QueuedMutation,
} from './transactions/mutations/MutationQueue.js';
import {
  observeCommitLatency,
  type CommitLatencySample,
} from './transactions/mutations/commitLatency.js';
import {
  UnconfirmedWrites,
  type UnconfirmedWritesMetrics,
} from './transactions/mutations/UnconfirmedWrites.js';
import type { DurableWriteStore } from './transactions/mutations/durableWriteStore.js';
import type { Database } from './Database.js';
import type { MutationPersistencePort } from './mutationPersistence.js';
import type { WriteOptions } from './interfaces/index.js';
import { LogPosition } from './logPosition.js';
import { createLocalMutationPort } from './transactions/localMutation.js';
import { createReconnectDrain } from './transactions/reconnectDrain.js';
import { DatabaseCommitOutboxStore } from './transactions/databaseCommitOutbox.js';
import {
  toEpochMs,
  type CompletedTransaction,
  type EventHandler,
  type RehydrationStats,
  type SyncEvent,
  type SyncObserver,
  type SyncState,
} from './syncClientTypes.js';
import type { BootstrapSnapshot } from './syncClientTypes.js';
import {
  batchUploadFiles,
  uploadFile,
  type BatchFileUploadOptions,
  type FileUploadContext,
  type FileUploadOptions,
} from './fileUploads.js';

export type { BootstrapSnapshot, RehydrationStats } from './syncClientTypes.js';
const ignoreSeparatelyObservedMutationFailure = (): undefined => undefined;
export class SyncClient extends EventEmitter {
  private objectPool: InstanceCache;
  private database: Database;
  private readonly mutationPersistence: MutationPersistencePort;
  private readonly reconnectDrain = createReconnectDrain();
  private get mutationExecutor() { return this.runtime.mutationExecutor; }
  private networkMonitor: NetworkMonitor;
  /**
   * @internal — test seam, stripped from the published declarations by
   * `stripInternal`. Unit suites deliver queue lifecycle events directly.
   */
  readonly mutationQueue: MutationQueue;
  private observers = new Set<SyncObserver>();

  // Authentication context
  private userId: string | null = null;
  private organizationId: string | null = null;

  // The MutationQueue is the sole owner of queued transaction state.
  private pendingStages = new Set<Promise<void>>();
  private readonly commitOutboxNamespace: string;

  /** Compatibility view for diagnostics; transaction state lives in the queue. */
  private get pendingMutations() {
    const transactions = [...this.mutationQueue.getOutstandingTransactions()];
    const deferredCount = this.mutationQueue.getOutstandingTransactionCount() - transactions.length;
    return deferredCount > 0
      ? [...transactions, ...Array.from({ length: deferredCount })]
      : transactions;
  }

  /**
   * Tracks the ids of transactions the client has applied optimistically but
   * the server has not yet confirmed. When a delta arrives, the receive path
   * consults this set to recognize the echo of the client's own mutation and
   * skip the now-redundant pool update; the IndexedDB write still runs,
   * because the delta is the authoritative version of the row. Without this
   * discriminator, an optimistically applied delete followed by a
   * server-confirmed create echo would resurrect the row for the window
   * between the two confirmations.
   *
   * The set is bounded with first-in-first-out eviction, and
   * {@link SyncClient.getEchoMetrics} exposes its counters.
   */
  private readonly echoTracker = new UnconfirmedWrites();

  // Connection state
  private connectionState: 'connected' | 'disconnected' | 'connecting' = 'disconnected';

  // Configuration
  private isDisposed = false;

  /**
   * The client's position in the global delta order, held as the single
   * canonical {@link LogPosition} instance. The store advances `applied` and
   * `persisted` as deltas land, the queue advances `acked` on commit
   * responses, and snapshots and claims read `readFloor`.
   */
  readonly position = new LogPosition();

  constructor(
    objectPool: InstanceCache,
    database: Database,
    commitOutbox: DurableWriteStore = new DatabaseCommitOutboxStore(database),
    commitOutboxNamespace = 'default',
    private readonly runtime: RuntimeContext = globalRuntime,
  ) {
    super();
    this.objectPool = objectPool;
    this.database = database;
    this.mutationPersistence = {
      saveTransaction: (transaction) => database.saveTransaction(
        snapshotJsonValue(
          transaction,
          '$.pendingMutation',
        ) as Parameters<Database['saveTransaction']>[0],
      ),
      removeTransaction: (id) => database.removeTransaction(id),
      getPersistedTransactions: () => database.getPersistedTransactions(),
    };
    this.commitOutboxNamespace = commitOutboxNamespace;
    this.networkMonitor = new NetworkMonitor(this.runtime);

    // Initialize MutationQueue with proper configuration
    const localMutationPort = createLocalMutationPort((event, payload) => {
      this.mutationQueue.emit(event, payload);
    });
    this.mutationQueue = new MutationQueue({
      position: this.position,
      runtime: this.runtime,
      localMutationPort,
      maxBatchSize: 50, // Larger batches keep the batch count low for bulk operations
      // A short delay keeps writes responsive; coalescing still groups them
      batchDelay: 150,
      maxRetries: 3,
      enableOptimistic: true,
      enablePersistence: true,
      conflictResolution: {
        strategy: 'last-write-wins',
      },
    });
    this.mutationQueue.setPersistence(this.mutationPersistence);
    this.mutationQueue.setCommitOutbox(commitOutbox);

    // Provide connection state to MutationQueue - prevents rollbacks during disconnection
    this.mutationQueue.setConnectionChecker(() => this.connectionState === 'connected');

    // Restore object-pool state when a transaction is rolled back. If the
    // server rejects a write or it times out, the model's previous state is
    // put back. Because writes are no longer applied to IndexedDB
    // optimistically, that store already holds the correct state.
    this.setupTransactionRollbackHandling();

    // Forward reconciliation requests from the transaction queue. When delta
    // confirmation times out, the client cycles the WebSocket connection to
    // trigger a catch-up from the server rather than rolling the write back.
    this.setupReconciliationForwarding();

    // Persist unconfirmed transactions to IndexedDB. When delta retries are
    // exhausted, the write is cached so it survives a tab close.
    this.setupAwaitingTransactionPersistence();

    // Setup network monitoring
    this.setupNetworkMonitoring();
  }

  /**
   * Setup network monitoring handlers
   */
  private setupNetworkMonitoring(): void {
    // Both handlers emit to external listeners (which can throw) before/around
    // their own try/catch — route rejections into observability rather than
    // losing a failed reconnect flush silently.
    this.networkMonitor.on('online', () => {
      void this.handleReconnection().catch((error: unknown) => {
        this.runtime.observability.captureMutationFailure({
          context: 'network-online-reconnection',
          error: error instanceof Error ? error : new Error(String(error)),
        });
      });
    });
    this.networkMonitor.on('offline', () => {
      void this.handleDisconnection().catch((error: unknown) => {
        this.runtime.observability.captureMutationFailure({
          context: 'network-offline-handler',
          error: error instanceof Error ? error : new Error(String(error)),
        });
      });
    });
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
   * cancelled update on a multi-child record fired a per-model observer
   * event and a `[SyncClient.rollback]` warn, producing N renders and N
   * spam log lines for one user-initiated delete.
   */
  private setupTransactionRollbackHandling(): void {
    this.mutationQueue.on(
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
        // Mechanic-level breadcrumb only. The authoritative, user-facing
        // reason is logged once at `warn` by `MutationQueue.handleFailure`
        // (`Permanent error - rolling back`). Logging the same typed cause
        // again here at `warn` is what produced three identical dumps per
        // rejected write — keep it at `debug` so the rollback mechanics are
        // available when debugging but don't double the console noise.
        const abloErr = error instanceof AbloError ? error : undefined;
        this.runtime.logger.debug('[SyncClient.rollback]', {
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
        this.runtime.observability.captureRollback({
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
            this.runtime.observability.breadcrumb(
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
              // Follow-on of an already-logged permanent error, not its own
              // problem: the tx that failed has already surfaced the cause in
              // MutationQueue. Restoring a disposed model is a no-op by
              // design (can't revive the private isDisposed flag), so keep this
              // at `debug` instead of emitting a second `warn` that reads as a
              // distinct failure in the console.
              this.runtime.logger.debug('[SyncClient] Rollback skipped restore (model already disposed)', {
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
          this.runtime.observability.captureMutationFailure({
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
   * Forward reconciliation requests from the {@link MutationQueue} to the
   * sync layer. When delta confirmation times out, the queue emits
   * `reconciliation:needed` instead of rolling back, so optimistic state the
   * server may already have committed is never destroyed.
   */
  private setupReconciliationForwarding(): void {
    this.mutationQueue.on(
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
        this.runtime.observability.captureReconciliation({
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
   * Persist unconfirmed transactions to IndexedDB. When delta-confirmation
   * retries are exhausted, the transaction is cached so it survives a tab
   * close. On the next session, a WebSocket reconnect and delta catch-up
   * deliver the missing deltas and confirm the transaction.
   */
  private setupAwaitingTransactionPersistence(): void {
    this.mutationQueue.on(
      'transaction:persist_awaiting',
      (event: {
        txId: string;
        model: string;
        modelId: string;
        operationType: string;
        syncIdNeeded?: number;
      }) => {
        // void is safe: the handler's body is fully try/catch'd.
        void this.persistAwaitingTransaction(event);
      }
    );

    // Clean up persisted awaiting transactions when they're finally confirmed,
    // and record the confirmed position on every row the transaction wrote.
    // The acknowledgement is the earliest proof of where this client's own
    // write landed in the log — earlier than its delta echo, which the pool
    // suppresses on apply — so a snapshot read before the write cannot regress
    // the row in the window between the two.
    this.mutationQueue.on(
      'transaction:completed',
      (tx: CompletedTransaction) => {
        // void is safe: the handler's body is fully try/catch'd.
        void this.removeAwaitingTransaction(tx.id);
        this.noteOwnWritePositions(tx);
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
    this.mutationQueue.on(
      'transaction:created',
      (tx: { id: string; localOnly?: boolean }) => {
        if (!tx.localOnly) this.echoTracker.markPending(tx.id);
      },
    );
    this.mutationQueue.on(
      'optimistic:rollback',
      (event: { transaction: { id: string } }) => {
        this.echoTracker.drainOnRollback(event.transaction.id);
      },
    );
  }

  /**
   * Advance the pooled rows a completed transaction wrote to the log position
   * its acknowledgement named. A model mutation names one row; an explicit
   * commit names one per operation. Rows no longer pooled have nothing to
   * advance — a fresh instance starts without evidence.
   */
  private noteOwnWritePositions(tx: CompletedTransaction): void {
    const position = tx.lastSyncId ?? tx.syncIdNeededForCompletion;
    if (position === undefined) return;
    const rowIds =
      tx.operations !== undefined ? tx.operations.map((op) => op.id) : [tx.modelId];
    for (const rowId of rowIds) {
      const row = this.objectPool.peek(rowId);
      if (row) this.objectPool.watermarks.advance(row, position);
    }
  }

  /** Persist an unconfirmed transaction to IndexedDB (never rejects — failures are captured). */
  private async persistAwaitingTransaction(event: {
    txId: string;
    model: string;
    modelId: string;
    operationType: string;
    syncIdNeeded?: number;
  }): Promise<void> {
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

      this.runtime.observability.breadcrumb(
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
      this.runtime.observability.captureMutationFailure({
        context: 'persist-awaiting-transaction',
        modelName: event.model,
        modelId: event.modelId,
        error: error instanceof Error ? error : new Error(String(error)),
      });
    }
  }

  /** Drop the persisted awaiting-row once confirmed (never rejects). */
  private async removeAwaitingTransaction(txId: string): Promise<void> {
    if (!this.database) return;
    try {
      await this.database.removeTransaction(`awaiting_${txId}`);
    } catch {
      // Ignore — might not have been persisted
    }
  }

  /**
   * Initialize sync client with authentication
   */
  async initialize(userId: string, organizationId: string): Promise<void> {
    this.userId = userId;
    this.organizationId = organizationId;

    this.runtime.observability.setContext(userId, organizationId);

    await this.mutationQueue.setCommitOutboxScope({
      organizationId,
      participantId: userId,
      namespace: this.commitOutboxNamespace,
    });

    // Restore exact, already-sealed requests first. The returned source ids
    // suppress any legacy queue entry left behind by an older non-atomic
    // handoff.
    const sealedMutationIds = await this.mutationQueue.restoreDurableCommits();
    await this.mutationQueue.loadPersistedTransactions(this.mutationPersistence, sealedMutationIds);

    // Read the initial network status from the injected OnlineStatusProvider.
    // In the browser this reflects the host's connectivity signal; in Node it
    // reports online by default. NetworkMonitor drives the ongoing
    // online/offline transitions below — this read is only the initial
    // snapshot taken when identity is set.
    if (this.runtime.onlineStatus.isOnline()) {
      this.setConnectionState('connected');
    } else {
      // Offline - start in offline mode
      this.setConnectionState('disconnected');
      this.emit('sync:offline');
    }
    if (this.mutationQueue.getOutstandingTransactionCount() > 0) {
      this.scheduleSync();
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
   * IndexedDB or merged from a delta:
   *
   * 1. **Auto-fill** — for each `autoFill` rule the consumer's schema
   *    declares on this model, copy the corresponding identity value
   *    (`organizationId` / `userId`) onto the row when it's missing.
   *    Repairs rows from a past version that didn't write the field.
   *
   * 2. **Required-field gate** — if the row is missing any field listed
   *    in the model's `requiredFields`, return `null` so the caller
   *    skips this record. Used for FK columns whose absence renders the
   *    row unrecoverable (e.g. a Block with no sectionId).
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
        this.runtime.observability.captureSelfHealing({
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
        this.runtime.observability.captureSelfHealing({
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
   * Hydrate InstanceCache with data from Database
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
      return meta?.loadStrategy === LoadStrategy.instant;
    });

    const totalStart = typeof performance !== 'undefined' ? performance.now() : Date.now();

    // Phase 1: Fetch all data from IndexedDB and create model instances (async I/O).
    // We collect all models across ALL types before touching MobX, so that Phase 2
    // can add them in a single addBatch() call → ONE MobX action → ONE re-render.
    const allModelsToAdd: Model[] = [];
    const perTypePerfLogs: {
      type: string;
      fetched: number;
      added: number;
      fetchMs: string;
      createMs: string;
    }[] = [];

    for (const modelType of modelTypes) {
      const typeStart = typeof performance !== 'undefined' ? performance.now() : Date.now();
      try {
        // Get raw data from Database (via StoreManager)
        const rawData = await this.database.hydrateModels(modelType);
        const afterFetch = typeof performance !== 'undefined' ? performance.now() : Date.now();

        // Create models in batch first, collect for deferred addBatch
        const modelsForType: Model[] = [];
        const recordsToHeal: { id: string; data: Record<string, unknown> }[] = [];

        for (const data of rawData) {
          let withType =
            data && typeof data === 'object' && !data.__typename
              ? { __typename: modelType, ...data }
              : data;

          // Self-healing: Fix corrupted IndexedDB records missing essential fields
          const healResult = this.healModelRecord(modelType, withType);
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
          this.runtime.logger.info(
            `[SyncClient.hydrate] Persisting ${recordsToHeal.length} healed ${modelType} records to IndexedDB`
          );
          // Use fire-and-forget to not block hydration.
          // void is safe: the handler's body is fully try/catch'd.
          void Promise.resolve().then(async () => {
            try {
              for (const { id, data } of recordsToHeal) {
                await this.database.putRecord(modelType, id, data);
              }
              this.runtime.logger.info(
                `[SyncClient.hydrate] Successfully healed ${recordsToHeal.length} ${modelType} records`
              );
            } catch (err) {
              this.runtime.observability.captureMutationFailure({
                context: 'persist-healed-records',
                modelName: modelType,
                error: err instanceof Error ? err : new Error(String(err)),
              });
            }
          });
        }

        const typeEnd = typeof performance !== 'undefined' ? performance.now() : Date.now();

        perTypePerfLogs.push({
          type: modelType,
          fetched: rawData.length,
          added: modelsForType.length,
          fetchMs: (afterFetch - typeStart).toFixed(2),
          createMs: (typeEnd - afterFetch).toFixed(2),
        });
      } catch (error) {
        this.runtime.observability.captureBootstrapFailure(error, { type: `hydrate-${modelType}` });
      }
    }

    // Phase 2: Single MobX action — add ALL models across all types at once.
    const addStart = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const totalAdded = this.objectPool.addBatch(allModelsToAdd, ModelScope.live);
    const addEnd = typeof performance !== 'undefined' ? performance.now() : Date.now();

    // Log per-type perf after the batched add (so logs still show per-type breakdown)
    for (const entry of perTypePerfLogs) {
      this.runtime.logger.debug('hydrate:type', parseFloat(entry.fetchMs) + parseFloat(entry.createMs), {
        type: entry.type,
        fetched: entry.fetched,
        added: entry.added,
        fetchMs: entry.fetchMs,
        createMs: entry.createMs,
      });
    }

    const totalEnd = typeof performance !== 'undefined' ? performance.now() : Date.now();
    this.runtime.logger.debug('hydrate:total', totalEnd - totalStart, {
      totalModels: totalAdded,
      addBatchMs: (addEnd - addStart).toFixed(2),
    });

    // One-line startup summary: types pre-seeded and items per type
    try {
      const preseededTypes = this.objectPool.registry.getRegisteredModelNames();
      const stats = this.objectPool.getStats();
      this.runtime.logger.info('startup_summary', {
        typesPreseeded: preseededTypes.length,
        poolSize: stats.size,
        typeCounts: stats.typeCounts,
      });
    } catch {}
  }

  /**
   * Re-hydrate InstanceCache from IndexedDB when the pool already has data.
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
      return meta?.loadStrategy === LoadStrategy.instant;
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
          const healResult = this.healModelRecord(modelType, withType);
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
              // void is safe: the handler's body is fully try/catch'd.
              void Promise.resolve().then(async () => {
                try {
                  await this.database.putRecord(modelType, id, healedData);
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
            this.runtime.observability.breadcrumb(
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
        this.runtime.observability.captureBootstrapFailure(error, { type: `rehydrate-${modelType}` });
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

    this.runtime.logger.info('[SyncClient.rehydrate] Complete', {
      ...stats,
      poolSize: this.objectPool.size,
      ghostIds: ghostIds.length > 0 ? ghostIds.slice(0, 5).map((id) => id.slice(0, 8)) : [],
    });

    this.runtime.observability.breadcrumb('Rehydration complete', 'sync.bootstrap', 'info', {
      added: stats.added,
      updated: stats.updated,
      removed: stats.removed,
      elapsedMs: stats.elapsedMs,
    });

    return stats;
  }

  /**
   * Apply a mutation to a model optimistically and queue it for server sync.
   * IndexedDB is updated only once the server confirms the change with a delta
   * packet.
   *
   * A model's changes are captured before the pool action runs, because a pool
   * operation such as an upsert can clear the model's local change set;
   * capturing first ensures those changes are never lost. The captured set is
   * frozen and handed to {@link queueMutation}.
   */
  private mutate(
    type: 'create' | 'update' | 'delete' | 'archive',
    model: Model,
    poolAction: () => void,
    writeOptions?: WriteOptions,
    capturedChangesOverride?: Record<string, unknown>,
  ): Promise<void> | undefined {
    // No-op UPDATE guard (O(1)). An update with no dirty fields would travel
    // to the server, get dropped by `coalesceOperations` Rule 4 (empty input),
    // and — if it was the only op — come back as `lastSyncId: 0`. That trips
    // `captureCommitZeroSyncId` (false-positive Sentry anomaly) AND parks the
    // tx in `awaiting_delta` for a 30s reconciliation timeout on a write that
    // changed nothing. `Model.hasChanges` reads `modifiedProperties.size`, so
    // this costs O(1) with no allocation (vs. O(N) materializing getChanges()).
    //
    // Strict `=== false` is deliberate: `rowAsModel` only casts, so a non-Model
    // object can reach here with `hasChanges === undefined`. `undefined === false`
    // is false → we fall through to the normal path rather than risk dropping a
    // real write. Only a genuine Model with an empty dirty-set is skipped.
    const hasChanges: unknown = model.hasChanges;
    if (
      type === 'update' &&
      hasChanges === false &&
      capturedChangesOverride === undefined
    ) {
      return Promise.resolve();
    }

    // Capture changes before the pool action runs. Pool operations —
    // upsert in particular — can clear the model's local changes, so
    // capturing first ensures they are never lost.
    const capturedChanges = capturedChangesOverride !== undefined
      ? Object.freeze({ ...capturedChangesOverride })
      : type === 'update' || type === 'create'
        ? this.captureModelChanges(model)
        : undefined;

    poolAction();
    const confirmation = this.stageMutation(type, model, capturedChanges, writeOptions);
    this.notifyObservers({
      type,
      modelType: model.getModelName(),
      model: type !== 'delete' ? model : undefined,
      modelId: model.id,
    });
    return confirmation;

    // QueryProcessor uses `models:changed` to invalidate caches. Coalesce
    // to one event per microtask: a paste of 100 rows should re-run
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
  add(model: Model, options?: WriteOptions): Promise<void> | undefined {
    return this.mutate('create', model, () => { this.objectPool.add(model, ModelScope.live); }, options);
  }

  /** Update existing model (UPDATE) - works offline */
  update(
    model: Model,
    options?: WriteOptions,
    capturedChanges?: Record<string, unknown>,
  ): Promise<void> | undefined {
    return this.mutate(
      'update',
      model,
      () => { this.objectPool.upsert(model, ModelScope.live); },
      options,
      capturedChanges,
    );
  }

  /**
   * Update existing model with pre-computed changes.
   * Used by saveManyOptimized when incoming models have empty change-tracking
   * (e.g. freshly constructed cell models from a bulk document decomposition).
   */
  updateWithChanges(model: Model, changes?: Record<string, unknown>): void {
    this.runtime.logger.debug(`SyncClient.updateWithChanges`, {
      modelId: model.id,
      modelType: model.getModelName(),
    });

    // Use pre-computed changes if provided, otherwise fall back to model.getChanges()
    const capturedChanges =
      changes && Object.keys(changes).length > 0
        ? Object.freeze({ ...changes })
        : this.captureModelChanges(model);

    // No-op UPDATE guard: neither an explicit change set nor model dirty-fields.
    // `captureModelChanges` already returns undefined for an empty dirty-set, so
    // an undefined here means there is genuinely nothing to send — skip rather
    // than emit an empty-input update that the server coalesces to lastSyncId 0
    // (see the same guard in `mutate`).
    if (capturedChanges === undefined) return;

    this.objectPool.upsert(model, ModelScope.live);
    void this.stageMutation('update', model, capturedChanges);
    this.notifyObservers({
      type: 'update',
      modelType: model.getModelName(),
      model,
      modelId: model.id,
    });
  }

  /** Expose the GraphQL client for atomic mutations (e.g., createSectionWithBlocks).
   *  Used by SyncedStore for operations that bypass the transaction queue
   *  but still need optimistic pool updates at the sync layer. */
  get gql() {
    return this.mutationExecutor;
  }

  /** Delete model (DELETE) - works offline */
  delete(model: Model, options?: WriteOptions): Promise<void> | undefined {
    // Clear pending mutations first to prevent "not found" errors on fast delete
    this.mutationQueue.cancelTransactionsForModel(model.id);
    return this.mutate('delete', model, () => this.objectPool.remove(model.id), options);
  }

  private fileUploadContext(): FileUploadContext {
    return {
      userId: this.userId,
      organizationId: this.organizationId,
      mutationQueue: this.mutationQueue,
      objectPool: this.objectPool,
      observability: this.runtime.observability,
      notifyCreated: (model) => {
        this.notifyObservers({ type: 'create', modelType: model.getModelName(), model });
      },
    };
  }

  uploadFile(file: File, options: FileUploadOptions): Promise<Model | null> {
    return uploadFile(this.fileUploadContext(), file, options);
  }

  batchUploadFiles(files: File[], options: BatchFileUploadOptions): Promise<Model[]> {
    return batchUploadFiles(this.fileUploadContext(), files, options);
  }

  /** Archive model (ARCHIVE) - works offline */
  archive(model: Model): Promise<void> | undefined {
    return this.mutate('archive', model, () => { this.objectPool.updateScope(model.id, ModelScope.archived); });
  }

  /**
   * Append a mutation to the pending queue and schedule its sync work.
   *
   * IndexedDB persistence and the server push are deferred to a microtask, so
   * many pushes within the same tick collapse into a single serialization and
   * a single process call. Without the deferral, queueing a hundred mutations
   * at once — a large paste, a document import, bulk row creation — would
   * reserialize the whole growing queue a hundred times, an O(N²) cost in
   * `model.toJSON()`.
   *
   * @param mutation.capturedChanges - Pre-captured, frozen changes, used to
   *   avoid re-reading a model after pool operations that might clear them.
   */
  /** Stage one mutation through the queue, which owns durability and execution. */
  private stageMutation(
    type: 'create' | 'update' | 'delete' | 'archive',
    model: Model,
    capturedChanges?: Record<string, unknown>,
    writeOptions?: WriteOptions,
  ): Promise<void> | undefined {
    if (this.isDisposed) return Promise.resolve();
    if (!this.userId || !this.organizationId) {
      this.mutationQueue.deferMutation(type, model, capturedChanges, writeOptions);
      return;
    }
    const context = { userId: this.userId, organizationId: this.organizationId };
    const staging = this.mutationQueue.enqueueModelMutation(
      type,
      model,
      context,
      capturedChanges,
      writeOptions,
    );
    const confirmation = staging.then(async (transaction) => {
      await transaction.confirmation;
    });
    // Most internal callers intentionally use fire-and-forget writes. Observe
    // their rejection without replacing the exact promise returned to model
    // operations that need authoritative per-transaction confirmation.
    void confirmation.catch(ignoreSeparatelyObservedMutationFailure);
    const pending = staging.then(() => undefined).catch((error: Error) => {
      this.runtime.observability.captureMutationFailure({
        context: `stage-mutation-${type}`,
        modelName: model.getModelName(),
        modelId: model.id,
        error,
      });
    });
    this.pendingStages.add(pending);
    void pending.finally(() => this.pendingStages.delete(pending));
    return confirmation;
  }

  private scheduleSync(): void {
    if (!this.runtime.onlineStatus.isOnline() || this.isDisposed) return;
    void this.processPendingMutations().catch((error: Error) => {
      this.runtime.observability.captureMutationFailure({
        context: 'background-sync',
        error,
      });
    });
  }

  async processPendingMutations(): Promise<void> {
    if (this.pendingStages.size > 0) {
      await Promise.all([...this.pendingStages]);
    }
    await this.drainPendingConfirmations();
  }

  /**
   * Resolve a conflict between the local model and incoming server data,
   * called while processing deltas from the WebSocket. Certain server states,
   * such as deletions and deactivations, always take precedence even when the
   * local model has unsynced changes, so the two sides stay consistent.
   */
  resolveConflicts(localModel: Model, serverData: Record<string, unknown>): Model {
    // No entry-point debug here: this runs once per incoming update delta,
    // and a debug call's payload is BUILT even when the logger discards it —
    // a per-delta model scan on the apply hot path. The outcome branches
    // below log the cases worth reading.

    // PRIORITY 1: Check for critical server states that must be respected.
    // These states override any local changes to maintain data consistency.
    // Checked inline — the collected-object form (`extractCriticalState`)
    // only materializes on the rare force-accept branch, for its log line.
    const shouldForceAcceptServer =
      (serverData.deletedAt !== undefined && serverData.deletedAt !== null) ||
      (serverData.archivedAt !== undefined && serverData.archivedAt !== null) ||
      serverData.isActive === false;

    if (shouldForceAcceptServer) {
      this.runtime.logger.debug('Accepting server update - critical state change detected', {
        modelId: localModel.id,
        criticalStates: this.extractCriticalState(serverData),
      });

      // Force accept server state for critical changes
      localModel.updateFromData(serverData);
      localModel.clearChanges();
      localModel.markAsSynced();
      return localModel;
    }

    // Local-first: if we have local dirty fields, merge by field.
    // Keep locally changed fields; apply server for the rest.
    if (localModel.hasChanges) {
      const localChanges = localModel.getChanges();
      this.runtime.logger.debug('Merging server update with local dirty fields', {
        modelId: localModel.id,
        keptFields: Object.keys(localChanges || {}),
      });

      // Merge: server baseline + local dirty fields win
      const merged: ModelData = { ...serverData, ...(localChanges || {}) };

      // Preserve the most recent updatedAt without clearing dirty flags
      if (serverData.updatedAt || localModel.updatedAt) {
        // Safely get timestamp, handling both Date objects and strings
        const localUpdatedAt = localModel.updatedAt
          ? localModel.updatedAt instanceof Date
            ? localModel.updatedAt.getTime()
            : new Date(localModel.updatedAt).getTime()
          : 0;
        const serverUpdatedAt = toEpochMs(serverData.updatedAt);
        const mergedUpdatedAt = new Date(Math.max(localUpdatedAt, serverUpdatedAt));
        // updateFromData accepts Date or ISO string for dates
        merged.updatedAt = mergedUpdatedAt;
      }

      localModel.updateFromData(merged);
      // Intentionally DO NOT clearChanges here; pending tx will confirm and clear
      return localModel;
    }

    // No local changes: fall back to LWW to converge. Accept server
    // regardless of timestamp equality to stay in sync. Not logged — this is
    // the common path for every collaborator update a client receives.
    localModel.updateFromData(serverData);
    localModel.clearChanges();
    localModel.markAsSynced();
    return localModel;
  }

  /**
   * Extract the critical state fields from server data. These are the states
   * that must be honored even when the local model has unsynced changes. The
   * conflict resolver reads exactly these fields and no others.
   */
  private extractCriticalState(serverData: Record<string, unknown>): Record<string, unknown> {
    const critical: Record<string, unknown> = {};

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

    // Deactivation states are always critical.
    if (serverData.isActive !== undefined && serverData.isActive === false) {
      critical.isActive = false;
    }
    return critical;
  }

  /**
   * Handle network reconnection
   */
  private async handleReconnection(): Promise<void> {
    this.runtime.observability.breadcrumb('Network reconnected', 'sync.offline');
    this.emit('sync:reconnecting');

    try {
      // MutationQueue owns the durable flush and commit lanes.
      await this.processPendingMutations();

      this.setConnectionState('connected');
      this.emit('sync:reconnected');
    } catch (error) {
      this.runtime.observability.captureMutationFailure({
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
    this.runtime.observability.breadcrumb('Network disconnected', 'sync.offline');
    this.setConnectionState('disconnected');
    this.emit('sync:offline');
  }

  /**
   * Get current sync state
   */
  getState(): SyncState {
    return {
      connectionState: this.connectionState,
      pendingMutations: this.mutationQueue.getOutstandingTransactionCount(),
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
      this.runtime.observability.setConnectionState(state);
      this.runtime.observability.breadcrumb(`Connection: ${oldState} → ${state}`, 'sync.websocket');
      if (state === 'connected') {
        this.emit('connection:established');
        this.mutationQueue.setConnectionState('connected');
      } else if (state === 'disconnected') {
        this.emit('connection:disconnected');
        this.mutationQueue.setConnectionState('disconnected');
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
          this.runtime.observability.breadcrumb('Observer error', 'sync.transaction', 'error', {
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
    // Browser online state may have marked the client connected before the
    // WebSocket itself was ready. Kick the durable lanes through the staging
    // barrier: a model mutation enters the in-memory store before its journal
    // row finishes saving, so a direct reconnect drain can otherwise try to
    // seal a source record that does not exist yet. The pending drain also
    // starts the atomic commit lane, so one ordered entry point covers both.
    void this.processPendingMutations();
  }

  private drainPendingConfirmations(): Promise<void> {
    return this.reconnectDrain.drain(() => this.mutationQueue.drainPending());
  }

  /**
   * Dispose and cleanup
   */
  dispose(): void {
    this.isDisposed = true;
    this.disconnect();
    // The queue owns commit retry, replication-lag, offline-grace, and
    // per-mutation timers. A disposed client must release those resources too;
    // otherwise an atomic commit can keep a worker process alive after the
    // public client has been disposed.
    this.mutationQueue.dispose();
    this.networkMonitor.dispose();
    this.observers.clear();
    this.pendingStages.clear();
    this.removeAllListeners();
  }

  /**
   * Notify the {@link MutationQueue} of an incoming delta so it can confirm
   * hosted writes by sync-id threshold and queued forwards by their echoed
   * source-batch correlation id.
   * @param syncId - The sync id of the received delta.
   * @param transactionId - Optional server echo of the originating local write.
   * @param correlationId - Opaque batch identity decoded from a source WAL echo.
   */
  onDeltaReceived(
    syncId: number,
    transactionId?: string,
    correlationId?: string,
  ): void {
    try {
      this.mutationQueue.onDeltaReceived(
        syncId,
        transactionId,
        correlationId,
      );
    } catch (e) {
      this.runtime.observability.breadcrumb(
        'Failed to notify delta received',
        'sync.transaction',
        'warning',
        {
          syncId,
          transactionId,
          correlationId,
        }
      );
    }
  }

  /**
   * Cancel pending transactions for child entities orphaned by a parent's
   * deletion. The store calls this when a delete delta arrives for a parent,
   * cancelling any queued writes on children that reference it.
   *
   * @param childModelName - The child model type (for example, `Block`).
   * @param foreignKey - The foreign-key property name (for example, `sectionId`).
   * @param parentId - The id of the deleted parent.
   * @returns The number of transactions cancelled.
   */
  cancelTransactionsByForeignKey(
    childModelName: string,
    foreignKey: string,
    parentId: string
  ): number {
    return this.mutationQueue.cancelTransactionsByForeignKey(
      childModelName,
      foreignKey,
      parentId
    );
  }

  /**
   * Wait for a transaction to be confirmed by its delta echo. Delegates to the
   * {@link MutationQueue}, which handles the confirmation timeout.
   */
  waitForDeltaConfirmation(transactionId: string): Promise<void> {
    return this.mutationQueue.waitForConfirmation(transactionId);
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
   * to its three states, `objectPoolStats` typed by `InstanceCache.getStats`.
   */
  getSyncStats(): {
    connectionState: 'connected' | 'disconnected' | 'connecting';
    pendingMutations: number;
    objectPoolStats: ReturnType<InstanceCache['getStats']>;
  } {
    return {
      connectionState: this.connectionState,
      pendingMutations: this.mutationQueue.getOutstandingTransactionCount(),
      objectPoolStats: this.objectPool.getStats(),
    };
  }

  /**
   * Get pending transaction count from MutationQueue
   * Used by SyncedStore to compute hasUnsyncedChanges
   */
  getPendingTransactionCount(): number {
    const stats = this.mutationQueue.getStats();
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
    this.mutationQueue.on(eventName, callback);
    return () => this.mutationQueue.off(eventName, callback);
  }

  /**
   * Subscribe to mutation failures with the full payload. Mirrors the
   * underlying MutationQueue 'transaction:failed' shape so consumers
   * can render typed UI (toast keyed by `AbloError.type`, route-level
   * "this entity reverted" boundaries, telemetry).
   *
   * Distinct from `onTransactionEvent('failed', cb)`, which serves the
   * parameterless `pendingChanges` counter and intentionally drops the
   * payload. The two coexist: the counter callback stays lightweight, while
   * this typed listener drives user-visible surfaces.
   */
  onMutationFailure(
    listener: (payload: {
      transaction: QueuedMutation;
      error: Error;
      permanent?: boolean;
    }) => void,
  ): () => void {
    this.mutationQueue.on('transaction:failed', listener);
    return () => this.mutationQueue.off('transaction:failed', listener);
  }

  /**
   * Subscribe to commit round-trip latency, split into the local seal and the
   * remote acknowledgement. Fires once per completed commit.
   *
   * Taps the {@link MutationQueue} emitter for the same reason
   * {@link onMutationFailure} does: the commit lifecycle events originate
   * there and the SyncClient's own emitter never rebroadcasts them.
   */
  onCommitLatency(listener: (sample: CommitLatencySample) => void): () => void {
    return observeCommitLatency(this.mutationQueue, listener);
  }

  /**
   * Subscribe to local transaction creation with the full {@link QueuedMutation}
   * payload (`type`, `modelName`, `modelId`, `data`, `previousData`). This is
   * the feed the store's local-mutation subscription taps for undo recording.
   *
   * It subscribes to the {@link MutationQueue}'s emitter directly, since
   * that is the only emitter that fires `transaction:created`. The SyncClient's
   * own emitter (reached through {@link subscribe}) never rebroadcasts that
   * event, so routing undo through `subscribe('transaction:created')` would
   * record nothing. {@link onMutationFailure} taps the queue for the same
   * reason.
   */
  onLocalTransaction(
    listener: (tx: QueuedMutation) => void,
  ): () => void {
    this.mutationQueue.on('transaction:created', listener);
    interface CommitEventOperation {
      type: string;
      model: string;
      id: string;
      input?: Record<string, unknown>;
    }
    const snapshotsByCommit = new Map<
      string,
      readonly (Record<string, unknown> | undefined)[]
    >();
    const onCommitStaging = (payload: {
      clientTxId: string;
      operations: readonly CommitEventOperation[];
    }): void => {
      snapshotsByCommit.set(
        payload.clientTxId,
        payload.operations.map((operation) => {
          if (operation.type === 'CREATE') return undefined;
          const resident = this.objectPool.get(operation.id);
          return resident?.toJSON() as Record<string, unknown> | undefined;
        }),
      );
    };
    const onCommitSealFailed = (payload: { clientTxId: string }): void => {
      snapshotsByCommit.delete(payload.clientTxId);
    };
    // Commit-lane writes (`ablo.commits.create` — the agent/atomic door) ride
    // their own `commit:created` event: they have no optimistic pool apply,
    // so they must not feed the echo tracker's `transaction:created` path.
    // Enrich each operation with previous state captured from the pool HERE
    // (the queue is pool-free) and hand the synthesized transaction to the
    // same listener, so undo observes every write door — one stream.
    const onCommitCreated = (payload: {
      clientTxId: string;
      operations: readonly CommitEventOperation[];
    }): void => {
      const stagedSnapshots = snapshotsByCommit.get(payload.clientTxId);
      snapshotsByCommit.delete(payload.clientTxId);
      const TYPE_BY_WIRE: Record<
        string,
        QueuedMutation['type']
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
        const snapshot =
          type === 'create'
            ? undefined
            : stagedSnapshots
              ? stagedSnapshots[index]
              : (this.objectPool.get(op.id)?.toJSON() as
                  | Record<string, unknown>
                  | undefined);
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
    this.mutationQueue.on('commit:staging', onCommitStaging);
    this.mutationQueue.on('commit:seal_failed', onCommitSealFailed);
    this.mutationQueue.on('commit:created', onCommitCreated);
    return () => {
      this.mutationQueue.off('transaction:created', listener);
      this.mutationQueue.off('commit:staging', onCommitStaging);
      this.mutationQueue.off('commit:seal_failed', onCommitSealFailed);
      this.mutationQueue.off('commit:created', onCommitCreated);
      snapshotsByCommit.clear();
    };
  }

  /**
   * Wait for the latest in-flight transaction for (modelName, modelId)
   * to be confirmed by the server, or reject if it's rolled back.
   * Resolves immediately when no transaction is in flight — see
   * `MutationQueue.confirmationFor` for the lookup contract.
   *
   * Distinct from `waitForDeltaConfirmation(transactionId)` which keys
   * off a known tx id; this variant is for call sites that hold a
   * Model reference but never see the underlying transaction.
   */
  waitForConfirmation(modelName: string, modelId: string): Promise<void> {
    return this.mutationQueue.confirmationFor(modelName, modelId);
  }


  /**
   * Get detailed debug info for the sync debug page
   */
  getDebugInfo() {
    return {
      connectionState: this.connectionState,
      pendingMutationsCount: this.mutationQueue.getOutstandingTransactionCount(),
      mutationQueue: this.mutationQueue.getDebugInfo(),
    };
  }

  // ── Delta + Bootstrap application (owns InstanceCache writes) ──────────────

  /**
   * Apply a batch of delta results from Database to the InstanceCache.
   * Owns: model creation, upsert, remove, archive, conflict resolution.
   * Returns: nothing — InstanceCache is updated in place.
   */
  /**
   * Mark a local transaction as optimistically applied. The matching
   * server delta (when it arrives with the same `transactionId`) will
   * be recognized as an echo and skip the pool mutation. Called
   * automatically by `MutationQueue` when a transaction is staged;
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
  getEchoMetrics(): Readonly<UnconfirmedWritesMetrics> {
    return this.echoTracker.getMetrics();
  }

  /**
   * Package-internal accessor for the {@link MutationQueue}. Used by
   * `Ablo.commits.create()` to route raw multi-operation envelopes through the
   * same retry-on-reconnect lane as the model proxy path, and by tests to
   * exercise the queue's interaction with {@link markTransactionPending} on the
   * real instance the SyncClient subscribes to. It is not re-exported to SDK
   * consumers; `Ablo` is the public surface.
   */
  getMutationQueue(): MutationQueue {
    return this.mutationQueue;
  }

  applyDeltaBatchToPool(
    dbResults: readonly AppliedChange[],
    enrichRelations: (modelName: string, data: Record<string, unknown>) => Record<string, unknown>,
  ): void {
    const projectedResults = this.projectDeltaBatchForPool(dbResults);
    // The WHOLE batch — conflict resolution and model mutation included, not
    // just the pool bookkeeping at the end — runs in one MobX action.
    // `resolveConflicts` writes model fields via `updateFromData`; when those
    // writes ran before the action, every delta opened its own top-level
    // action and flushed reactions at its boundary, so a large frame paid one
    // reaction pass per delta and an observer could see a partially applied
    // frame between them.
    runInAction(() => {
      this.applyDeltaBatchToPoolInAction(projectedResults, enrichRelations);
    });
  }

  /**
   * Drop fresh adds beyond a headless cache's currently free capacity. The
   * rows are already durable; with no row-level consumer there is no recency
   * signal that makes replacing one cold resident with another useful, so the
   * projection avoids constructing thousands of doomed Model/MobX objects.
   *
   * This must run before apply slicing. A 300k catch-up batch is revealed in
   * ~600-delta slices, each smaller than the 10k cache cap; projecting each
   * slice independently would therefore miss the redundant work entirely.
   */
  projectDeltaBatchForPool(
    dbResults: readonly AppliedChange[],
  ): readonly AppliedChange[] {
    const idsBeingRemoved = new Set<string>();
    const freshAddTypes = new Set<string>();
    let freshAddCount = 0;
    for (const result of dbResults) {
      if (result.action === 'remove') idsBeingRemoved.add(result.modelId);
    }
    for (const result of dbResults) {
      if (
        result.action === 'add' &&
        result.data &&
        !idsBeingRemoved.has(result.modelId) &&
        !this.objectPool.has(result.modelId)
      ) {
        freshAddTypes.add(result.modelName);
        freshAddCount++;
      }
    }
    const retentionLimit = this.objectPool.wireAddRetentionLimit(freshAddTypes);
    let freshAddsToDiscard =
      retentionLimit === undefined ? 0 : Math.max(0, freshAddCount - retentionLimit);
    if (freshAddsToDiscard === 0) return dbResults;

    return dbResults.filter((result) => {
      if (
        freshAddsToDiscard > 0 &&
        result.action === 'add' &&
        result.data &&
        !idsBeingRemoved.has(result.modelId) &&
        !this.objectPool.has(result.modelId)
      ) {
        freshAddsToDiscard--;
        return false;
      }
      return true;
    });
  }

  private applyDeltaBatchToPoolInAction(
    dbResults: readonly AppliedChange[],
    enrichRelations: (modelName: string, data: Record<string, unknown>) => Record<string, unknown>,
  ): void {
    const modelsToAdd: Model[] = [];
    const modelsToUpsert: Model[] = [];
    const idsToRemove: string[] = [];
    const idsToArchive: string[] = [];

    // Pre-pass: collect every id slated for `remove` in this batch. The
    // parent-delete flicker came from this exact pattern: a peer (or the
    // user themself) deletes a parent with N children; the commit produces
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
      const { modelName, modelId, action, transactionId, syncId } = result;

      // Every delta names the log position the row now reflects — recorded
      // before echo detection, because an own echo is exactly a position the
      // pooled row has reached even though its fields are not re-applied.
      const resident = this.objectPool.peek(modelId);
      if (resident) this.objectPool.watermarks.advance(resident, syncId);

      // Echo detection: if this delta carries a transaction id that matches
      // one already applied optimistically, the pool already reflects the
      // mutation, so the pool operation is skipped. The IndexedDB write in
      // Database.processDeltaBatch still runs; only the in-memory pool update
      // is suppressed. This prevents a resurrection flicker: a server-confirmed
      // create arriving after the user has optimistically deleted the row would
      // otherwise re-add it for the brief window before the matching delete
      // confirmation lands.
      if (this.echoTracker.consumeEcho(transactionId)) {
        // A direct assignment can re-enter change tracking while this
        // optimistic write is in flight. Leaving the acknowledged field dirty
        // makes conflict resolution preserve it over the next collaborator
        // delta, so peers appear desynchronized until refresh.
        //
        // Re-baseline only values this echo actually confirms. If the user has
        // edited the same field again since the write was sent, its current
        // dirty value differs from the echo and remains queued.
        if (resident && result.data) {
          const acknowledgedFields: string[] = [];
          for (const [field, change] of resident.modifiedProperties) {
            if (
              Object.prototype.hasOwnProperty.call(result.data, field) &&
              deepEqual(change.new, result.data[field])
            ) {
              acknowledgedFields.push(field);
            }
          }
          resident.consumeModifiedFields(acknowledgedFields);
          resident.markAsSynced();
        }
        continue;
      }

      // If a later op in this batch will remove this id, skip earlier
      // add/update ops on it. Server FK ordering can produce
      // U(child)+D(child) when an optimistic edit and a delete both
      // commit in the same window; only the final state matters.
      if ((action === 'add' || action === 'update') && idsBeingRemoved.has(modelId)) {
        continue;
      }

      switch (action) {
        case 'add': {
          // `peek`, not `get`: this loop is ingestion, not a consumer read.
          // `get()` activates deferred MobX instrumentation, so reading
          // through it here made the delta stream itself instrument every
          // row it touched — the dominant term of apply cost for rows no
          // consumer observes. Activation belongs to the consumer-facing
          // reads (`get`, views, subscribers), which are unchanged.
          const existing = this.objectPool.peek(modelId);
          if (existing) {
            existing.markAsSynced();
          } else if (result.data) {
            const data = enrichRelations(modelName, { ...result.data, __typename: modelName });
            const model = this.objectPool.createFromData(data, undefined, {
              deferObservability: true,
            });
            if (model) {
              this.objectPool.watermarks.advance(model, syncId);
              modelsToAdd.push(model);
            }
          }
          break;
        }
        case 'update': {
          const existing = this.objectPool.peek(modelId);
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
          // Self-healing: the next catch-up poll / reconnect re-fetches and
          // re-applies this delta, so it's forensic, not consumer-actionable → debug.
          this.runtime.logger.debug('[SyncClient.applyDeltaBatchToPool] skipping pool op for unpersisted delta', {
            modelName,
            modelId: modelId.slice(0, 12),
          });
          break;
      }
    }

    // Reveal the whole frame at one reaction boundary: the caller's single
    // action covers the collection loop above and these batch pool writes, so
    // dependents recompute exactly once regardless of how many models or
    // operation kinds the frame touched, and the app never observes a
    // partially applied frame.
    if (modelsToAdd.length > 0) this.objectPool.addBatch(modelsToAdd, ModelScope.live);
    if (modelsToUpsert.length > 0) this.objectPool.upsertBatch(modelsToUpsert, ModelScope.live);
    if (idsToRemove.length > 0) this.objectPool.removeBatch(idsToRemove);
    for (const id of idsToArchive) this.objectPool.updateScope(id, ModelScope.archived);

    // Emit changed model types so QueryProcessor can auto-invalidate.
    // Kept inside the action so any observable query-cache state it
    // flips is part of the same atomic reveal.
    const changedTypes = new Set(dbResults.map(r => r.modelName));
    if (changedTypes.size > 0) this.emit('models:changed', changedTypes);
  }

  /**
   * Apply bootstrap data to the InstanceCache with ghost removal.
   * Owns: model creation, batch upsert, ghost detection + removal.
   */
  applyBootstrapDataToPool(
    bootstrapData: BootstrapSnapshot,
    protectedIds?: ReadonlySet<string>,
    options?: {
      /**
       * Scoped backfill for the hydrate-on-enter path: the snapshot covers only
       * the groups just entered, not the whole model type. Two behaviors change
       * so the subset cannot corrupt the pool. First, a row the pool already
       * knows to reflect a position beyond the snapshot's `lastSyncId` is
       * skipped, so a concurrent live delta is not clobbered back to the
       * snapshot version. Second, ghost removal is skipped, because a subset
       * snapshot must never evict rows of the same type that belong to other,
       * unhydrated groups.
       */
      scoped?: boolean;
    },
  ): { added: number; updated: number; removed: number; skipped: number; healed: number } {
    if (!bootstrapData.models) {
      return { added: 0, updated: 0, removed: 0, skipped: 0, healed: 0 };
    }
    const snapshotPosition = bootstrapData.lastSyncId;

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

        // Scoped backfill for the hydrate-on-enter path: a subset snapshot is
        // taken at a server watermark. If a concurrent live delta already
        // advanced this row past the snapshot, skip it. `createFromData`
        // mutates the pooled model in place to keep instances alive, so this
        // guard has to run before it; a guard at the upsert layer would be too
        // late, because the row would already be clobbered.
        if (options?.scoped && recordId) {
          const existing = this.objectPool.peek(recordId);
          if (existing && this.objectPool.watermarks.isAheadOf(existing, snapshotPosition)) {
            skippedCount++;
            continue;
          }
        }

        try {
          const model = this.objectPool.createFromData(data);
          if (model) {
            this.objectPool.watermarks.advance(model, snapshotPosition);
            allModels.push(model);
          }
        } catch {
          skippedCount++;
        }
      }
    }

    // Upsert. The scoped stale-skip above already guarded the version, so a
    // plain upsert is correct here for both paths.
    const beforeSize = this.objectPool.size;
    this.objectPool.upsertBatch(allModels, ModelScope.live);
    const addedCount = this.objectPool.size - beforeSize;
    const updatedCount = allModels.length - addedCount;

    // Ghost removal: drop pool entities absent from the server snapshot. This
    // is valid only for a full bootstrap, where the snapshot is authoritative
    // for each returned type. A scoped subset snapshot must not remove rows of
    // the same type that belong to other, unhydrated groups.
    let removedCount = 0;
    if (!options?.scoped) {
      const ghostIds: string[] = [];
      for (const [modelType, serverIds] of serverIdsByType) {
        const poolIds = this.objectPool.getIdsByModelType(modelType);
        if (!poolIds) continue;
        for (const poolId of poolIds) {
          if (!serverIds.has(poolId) && !protectedIds?.has(poolId)) ghostIds.push(poolId);
        }
      }
      removedCount = this.objectPool.removeBatch(ghostIds);
    }

    // Emit changed model types so QueryProcessor can auto-invalidate
    const changedTypes = new Set(Object.keys(bootstrapData.models));
    if (changedTypes.size > 0) this.emit('models:changed', changedTypes);

    return { added: addedCount, updated: updatedCount, removed: removedCount, skipped: skippedCount, healed: healedCount };
  }
}
