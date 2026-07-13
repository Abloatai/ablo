/**
 * Applies model mutations and manages the offline write queue. The
 * SyncClient turns local create, update, delete, and archive calls into
 * optimistic changes, holds them while the client is offline, sends them to
 * the server when connectivity returns, and resolves conflicts when the
 * server's version of a row disagrees with the local one. It sits between the
 * reactive object pool and the {@link TransactionQueue} that delivers writes
 * over the network.
 */

import { runInAction } from 'mobx';
import { v4 as uuid } from 'uuid';
import { InstanceCache, ModelScope } from './InstanceCache.js';
import { Model } from './Model.js';
import type { ModelData } from './types/modelData.js';
// ModelRegistry instance accessed via this.objectPool.registry
import { LoadStrategy } from './types/index.js';
import { getContext } from './context.js';
import { AbloAuthenticationError, AbloError, AbloValidationError } from './errors.js';
import { EventEmitter } from 'events';
import { NetworkMonitor } from './NetworkMonitor.js';
import { TransactionQueue } from './transactions/TransactionQueue.js';
import {
  legacyPendingMutationRecordSchema,
  PENDING_MUTATION_REPLAY_WINDOW_MS,
  pendingMutationRecordId,
  pendingMutationRecordSchema,
  persistedMutationSchema,
} from './transactions/replayValidation.js';
import {
  UnconfirmedWrites,
  type UnconfirmedWritesMetrics,
} from './transactions/UnconfirmedWrites.js';
import type { Database } from './Database.js';
import type { WriteOptions } from './interfaces/index.js';
import { SyncPosition } from './sync/syncPosition.js';
import {
  DatabaseCommitOutboxStore,
} from './transactions/commitOutboxStore.js';
import type { DurableWriteStore } from './transactions/durableWriteStore.js';

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

interface PendingMutation {
  mutationId: string;
  type: 'create' | 'update' | 'delete' | 'archive';
  model: Model;
  modelData: Record<string, unknown>;
  timestamp: Date;
  capturedChanges?: Record<string, unknown>;
  writeOptions?: WriteOptions;
  journaled: Promise<void>;
  resolveJournal?: () => void;
  rejectJournal?: (error: unknown) => void;
  /**
   * Settles once this mutation has a real transaction in the queue (or has
   * been definitively dropped). `syncNow()` awaits it so a `wait: 'confirmed'`
   * caller can never reach `confirmationFor` while its write is still
   * queued-but-unstaged — that gap resolves to "never staged" and would
   * confirm a write that has not touched the wire.
   */
  staged: Promise<void>;
  resolveStaged?: () => void;
  rejectStaged?: (error: unknown) => void;
}

/**
 * Reports whether an incoming snapshot record is strictly newer than the
 * model already in the pool. The comparison uses the server-stamped
 * `updatedAt` timestamp, since rows carry no numeric version and the delta
 * pipeline resolves order by arrival (last write wins). An undefined incoming
 * timestamp counts as not newer, so a known row is never clobbered; an
 * undefined existing timestamp means the pooled row is unversioned, so the
 * incoming record wins. The scoped hydrate-on-enter path uses this to drop
 * snapshot rows that a live delta has already advanced past.
 */
function rawRecordIsNewer(data: Record<string, unknown>, existing: Model): boolean {
  const raw = data.updatedAt;
  const inMs =
    raw instanceof Date
      ? raw.getTime()
      : typeof raw === 'string'
        ? (Number.isNaN(Date.parse(raw)) ? undefined : Date.parse(raw))
        : typeof raw === 'number'
          ? raw
          : undefined;
  const exMs = existing.updatedAt instanceof Date ? existing.updatedAt.getTime() : undefined;
  if (inMs === undefined) return false;
  if (exMs === undefined) return true;
  return inMs > exMs;
}

/**
 * Converts an untyped server `updatedAt` value — an ISO string, epoch number,
 * or Date read off an untyped row — into epoch milliseconds for
 * last-write-wins comparison. Falsy or non-date values become 0, matching the
 * conflict resolver's rule that a missing timestamp sorts as the epoch.
 */
function toEpochMs(value: unknown): number {
  if (!value) return 0;
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'string' || typeof value === 'number') {
    return new Date(value).getTime();
  }
  return 0;
}

export class SyncClient extends EventEmitter {
  private objectPool: InstanceCache;
  private database: Database;
  private get mutationExecutor() { return getContext().mutationExecutor; }
  private networkMonitor: NetworkMonitor;
  /**
   * @internal — test seam, stripped from the published declarations by
   * `stripInternal`. Unit suites deliver queue lifecycle events directly.
   */
  readonly transactionQueue: TransactionQueue;
  private observers = new Set<SyncObserver>();

  // Authentication context
  private userId: string | null = null;
  private organizationId: string | null = null;

  // Pending mutations queue
  private pendingMutations: PendingMutation[] = [];
  private readonly stagedMutationIds = new Set<string>();
  private pendingJournalBatch: PendingMutation[] = [];
  private journalFlushScheduled = false;
  private readonly commitOutboxNamespace: string;

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
   * canonical {@link SyncPosition} instance. The store advances `applied` and
   * `persisted` as deltas land, the queue advances `acked` on commit
   * responses, and snapshots and claims read `readFloor`.
   */
  readonly position = new SyncPosition();

  constructor(
    objectPool: InstanceCache,
    database: Database,
    commitOutbox: DurableWriteStore = new DatabaseCommitOutboxStore(database),
    commitOutboxNamespace = 'default',
  ) {
    super();
    this.objectPool = objectPool;
    this.database = database;
    this.commitOutboxNamespace = commitOutboxNamespace;
    this.networkMonitor = new NetworkMonitor();

    // Initialize TransactionQueue with proper configuration
    this.transactionQueue = new TransactionQueue({
      position: this.position,
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
    this.transactionQueue.setCommitOutbox(commitOutbox);
    this.transactionQueue.on(
      'commit:envelope_persisted',
      (event: { sourceMutationIds: string[] }) => {
        if (event.sourceMutationIds.length === 0) return;
        const consumed = new Set(event.sourceMutationIds);
        this.pendingMutations = this.pendingMutations.filter(
          (mutation) => !consumed.has(mutation.mutationId),
        );
        for (const mutationId of consumed) this.stagedMutationIds.delete(mutationId);
        if (this.stagedMutationIds.size === 0 && this.pendingMutations.length > 0) {
          this.scheduleSync();
        }
      },
    );
    this.transactionQueue.on(
      'transaction:completed',
      (transaction: { sourceMutationIds?: string[] }) => {
        const completed = new Set(transaction.sourceMutationIds ?? []);
        if (completed.size > 0) {
          this.pendingMutations = this.pendingMutations.filter(
            (mutation) => !completed.has(mutation.mutationId),
          );
        }
        for (const mutationId of transaction.sourceMutationIds ?? []) {
          this.stagedMutationIds.delete(mutationId);
          void this.database
            .removeTransaction(pendingMutationRecordId(mutationId))
            .catch(() => undefined);
        }
        if (this.stagedMutationIds.size === 0 && this.pendingMutations.length > 0) {
          this.scheduleSync();
        }
      },
    );
    this.transactionQueue.on(
      'transaction:failed',
      ({ transaction }: { transaction: { sourceMutationIds?: string[] } }) => {
        const failed = transaction.sourceMutationIds ?? [];
        if (failed.length === 0) return;
        const failedSet = new Set(failed);
        this.pendingMutations = this.pendingMutations.filter(
          (mutation) => !failedSet.has(mutation.mutationId),
        );
        for (const mutationId of failed) {
          this.stagedMutationIds.delete(mutationId);
          // The queue has already rolled the model back, so replaying the
          // journal row on the next boot would resurrect a rejected write.
          void this.database
            .removeTransaction(pendingMutationRecordId(mutationId))
            .catch(() => undefined);
        }
        // Without this drain, terminally failed ids stayed claimed forever and
        // the size guard in processPendingMutations stalled every later write.
        if (this.stagedMutationIds.size === 0 && this.pendingMutations.length > 0) {
          this.scheduleSync();
        }
      },
    );

    // Provide connection state to TransactionQueue - prevents rollbacks during disconnection
    this.transactionQueue.setConnectionChecker(() => this.connectionState === 'connected');

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
        getContext().observability.captureTransactionFailure({
          context: 'network-online-reconnection',
          error: error instanceof Error ? error : new Error(String(error)),
        });
      });
    });
    this.networkMonitor.on('offline', () => {
      void this.handleDisconnection().catch((error: unknown) => {
        getContext().observability.captureTransactionFailure({
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
        // Mechanic-level breadcrumb only. The authoritative, user-facing
        // reason is logged once at `warn` by `TransactionQueue.handleFailure`
        // (`Permanent error - rolling back`). Logging the same typed cause
        // again here at `warn` is what produced three identical dumps per
        // rejected write — keep it at `debug` so the rollback mechanics are
        // available when debugging but don't double the console noise.
        const abloErr = error instanceof AbloError ? error : undefined;
        getContext().logger.debug('[SyncClient.rollback]', {
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
              // Follow-on of an already-logged permanent error, not its own
              // problem: the tx that failed has already surfaced the cause in
              // TransactionQueue. Restoring a disposed model is a no-op by
              // design (can't revive the private isDisposed flag), so keep this
              // at `debug` instead of emitting a second `warn` that reads as a
              // distinct failure in the console.
              getContext().logger.debug('[SyncClient] Rollback skipped restore (model already disposed)', {
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
   * Forward reconciliation requests from the {@link TransactionQueue} to the
   * sync layer. When delta confirmation times out, the queue emits
   * `reconciliation:needed` instead of rolling back, so optimistic state the
   * server may already have committed is never destroyed.
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
   * Persist unconfirmed transactions to IndexedDB. When delta-confirmation
   * retries are exhausted, the transaction is cached so it survives a tab
   * close. On the next session, a WebSocket reconnect and delta catch-up
   * deliver the missing deltas and confirm the transaction.
   */
  private setupAwaitingTransactionPersistence(): void {
    this.transactionQueue.on(
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

    // Clean up persisted awaiting transactions when they're finally confirmed
    this.transactionQueue.on(
      'transaction:completed',
      (tx: { id: string; modelName: string; modelId: string }) => {
        // void is safe: the handler's body is fully try/catch'd.
        void this.removeAwaitingTransaction(tx.id);
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
      (tx: { id: string; localOnly?: boolean }) => {
        if (!tx.localOnly) this.echoTracker.markPending(tx.id);
      },
    );
    this.transactionQueue.on(
      'optimistic:rollback',
      (event: { transaction: { id: string } }) => {
        this.echoTracker.drainOnRollback(event.transaction.id);
      },
    );
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

    getContext().observability.setContext(userId, organizationId);

    this.transactionQueue.setCommitOutboxScope({
      organizationId,
      participantId: userId,
      namespace: this.commitOutboxNamespace,
    });

    // Calls made during startup are allowed to queue before identity arrives,
    // but they cannot be serialized with a trustworthy scope until now. Flush
    // those already-created journal promises before any write can be staged.
    if (this.pendingJournalBatch.length > 0) {
      this.scheduleJournalFlush();
      await Promise.all(this.pendingMutations.map((mutation) => mutation.journaled));
    }

    // Restore exact, already-sealed requests first. The returned source ids
    // suppress any legacy queue entry left behind by an older non-atomic
    // handoff.
    const sealedMutationIds = await this.transactionQueue.restoreDurableCommits();
    await this.restoreMutationQueue(sealedMutationIds);

    // Read the initial network status from the injected OnlineStatusProvider.
    // In the browser this reflects the host's connectivity signal; in Node it
    // reports online by default. NetworkMonitor drives the ongoing
    // online/offline transitions below — this read is only the initial
    // snapshot taken when identity is set.
    if (getContext().onlineStatus.isOnline()) {
      this.setConnectionState('connected');
    } else {
      // Offline - start in offline mode
      this.setConnectionState('disconnected');
      this.emit('sync:offline');
    }
    if (this.pendingMutations.length > 0) this.scheduleSync();
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
      return (
        meta?.loadStrategy === LoadStrategy.instant || meta?.loadStrategy === LoadStrategy.partial
      );
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
          getContext().logger.info(
            `[SyncClient.hydrate] Persisting ${recordsToHeal.length} healed ${modelType} records to IndexedDB`
          );
          // Use fire-and-forget to not block hydration.
          // void is safe: the handler's body is fully try/catch'd.
          void Promise.resolve().then(async () => {
            try {
              for (const { id, data } of recordsToHeal) {
                await this.database.putRecord(modelType, id, data);
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
  ): void {
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
    if (type === 'update' && model.hasChanges === false) return;

    // Capture changes before the pool action runs. Pool operations —
    // upsert in particular — can clear the model's local changes, so
    // capturing first ensures they are never lost.
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
    this.mutate('create', model, () => { this.objectPool.add(model, ModelScope.live); }, options);
  }

  /** Update existing model (UPDATE) - works offline */
  update(model: Model, options?: WriteOptions): void {
    this.mutate('update', model, () => { this.objectPool.upsert(model, ModelScope.live); }, options);
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

    // No-op UPDATE guard: neither an explicit change set nor model dirty-fields.
    // `captureModelChanges` already returns undefined for an empty dirty-set, so
    // an undefined here means there is genuinely nothing to send — skip rather
    // than emit an empty-input update that the server coalesces to lastSyncId 0
    // (see the same guard in `mutate`).
    if (capturedChanges === undefined) return;

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
    const removed = this.pendingMutations.filter((mutation) => mutation.model.id === modelId);
    this.pendingMutations = this.pendingMutations.filter((m) => m.model.id !== modelId);
    const afterCount = this.pendingMutations.length;

    if (beforeCount !== afterCount) {
      getContext().logger.debug('[SyncClient.clearPendingMutationsForModel] Cleared pending mutations', {
        modelId,
        clearedCount: beforeCount - afterCount,
        remainingCount: afterCount,
      });

      for (const mutation of removed) {
        // Once staged, TransactionQueue owns cancellation and transfers this
        // source id into the superseding delete envelope. Deleting the journal
        // row here would make that valid atomic promotion look like a
        // multi-tab loser. Truly unstaged work can be canceled locally.
        if (this.stagedMutationIds.has(mutation.mutationId)) continue;
        this.stagedMutationIds.delete(mutation.mutationId);
        void mutation.journaled
          .then(() =>
            this.database.removeTransaction(
              pendingMutationRecordId(mutation.mutationId),
            ),
          )
          .catch(() => undefined);
      }
    }
  }

  /**
   * Upload a file and create its attachment record. The upload runs through
   * the {@link TransactionQueue}, and a model is built from the server's
   * response and added to the pool.
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
    this.mutate('archive', model, () => { this.objectPool.updateScope(model.id, ModelScope.archived); });
  }

  /**
   * Append a mutation to the pending queue and schedule its sync work.
   *
   * IndexedDB persistence and the server push are deferred to a microtask, so
   * many pushes within the same tick collapse into a single serialization and
   * a single process call. Without the deferral, queueing a hundred mutations
   * at once — a large paste, a document import, bulk layer creation — would
   * reserialize the whole growing queue a hundred times, an O(N²) cost in
   * `model.toJSON()`.
   *
   * @param mutation.capturedChanges - Pre-captured, frozen changes, used to
   *   avoid re-reading a model after pool operations that might clear them.
   */
  private queueMutation(mutation: {
    type: 'create' | 'update' | 'delete' | 'archive';
    model: Model;
    timestamp: Date;
    capturedChanges?: Record<string, unknown>;
    writeOptions?: WriteOptions;
  }): void {
    const mutationId = `mutation_${uuid()}`;
    const modelData = mutation.model.toJSON
      ? mutation.model.toJSON()
      : { ...mutation.model };
    let resolveJournal!: () => void;
    let rejectJournal!: (error: unknown) => void;
    const journaled = new Promise<void>((resolve, reject) => {
      resolveJournal = resolve;
      rejectJournal = reject;
    });
    let resolveStaged!: () => void;
    let rejectStaged!: (error: unknown) => void;
    const staged = new Promise<void>((resolve, reject) => {
      resolveStaged = resolve;
      rejectStaged = reject;
    });
    const pending: PendingMutation = {
      ...mutation,
      mutationId,
      modelData,
      journaled,
      resolveJournal,
      rejectJournal,
      staged,
      resolveStaged,
      rejectStaged,
    };
    this.pendingJournalBatch.push(pending);
    this.scheduleJournalFlush();
    // Offline drains may not await this until much later. Observe rejection
    // immediately to avoid an unhandled-promise report while retaining the
    // original rejecting promise for fail-closed dispatch.
    void pending.journaled.catch(() => undefined);
    void pending.staged.catch(() => undefined);
    this.pendingMutations.push(pending);
    this.scheduleSync();
  }

  private scheduleJournalFlush(): void {
    if (this.journalFlushScheduled) return;
    this.journalFlushScheduled = true;
    const schedule =
      typeof queueMicrotask === 'function'
        ? queueMicrotask
        : (callback: () => void) => { void Promise.resolve().then(callback); };
    schedule(() => {
      this.journalFlushScheduled = false;
      const batch = this.pendingJournalBatch;
      this.pendingJournalBatch = [];
      void this.flushPendingMutationJournal(batch);
    });
  }

  private async flushPendingMutationJournal(batch: PendingMutation[]): Promise<void> {
    if (batch.length === 0) return;
    if (!this.userId || !this.organizationId) {
      // Startup writes remain behind their unresolved journal promise. Identity
      // initialization re-kicks this batch once its durable scope is known.
      this.pendingJournalBatch = [...batch, ...this.pendingJournalBatch];
      return;
    }
    try {
      const records = batch.map((mutation) => this.pendingMutationRecord(mutation));
      const database = this.database as Database & {
        saveTransactions?: (rows: typeof records) => Promise<void>;
      };
      if (database.saveTransactions) {
        await database.saveTransactions(records);
      } else {
        await Promise.all(records.map((record) => database.saveTransaction(record)));
      }
      for (const mutation of batch) mutation.resolveJournal?.();
    } catch (error) {
      for (const mutation of batch) mutation.rejectJournal?.(error);
    } finally {
      for (const mutation of batch) {
        mutation.resolveJournal = undefined;
        mutation.rejectJournal = undefined;
      }
    }
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

  private pendingMutationRecord(mutation: PendingMutation) {
    if (!this.userId || !this.organizationId) {
      throw new AbloValidationError(
        'Cannot persist a mutation before participant scope is initialized',
        { code: 'write_options_invalid' },
      );
    }
    return pendingMutationRecordSchema.parse({
      id: pendingMutationRecordId(mutation.mutationId),
      type: 'pending_mutation',
      storageVersion: 2,
      mutation: {
        mutationId: mutation.mutationId,
        type: mutation.type,
        modelData: mutation.modelData,
        modelName: mutation.model.getModelName(),
        timestamp: mutation.timestamp.toISOString(),
        ...(mutation.capturedChanges !== undefined
          ? { capturedChanges: mutation.capturedChanges }
          : {}),
        ...(mutation.writeOptions !== undefined
          ? { writeOptions: mutation.writeOptions }
          : {}),
      },
      scope: {
        organizationId: this.organizationId,
        participantId: this.userId,
        namespace: this.commitOutboxNamespace,
      },
      timestamp: mutation.timestamp.getTime(),
    });
  }

  private async persistPendingMutation(mutation: PendingMutation): Promise<void> {
    await this.database.saveTransaction(this.pendingMutationRecord(mutation));
  }

  /**
   * Restore the mutation queue from IndexedDB.
   *
   * The persisted record was written by an earlier session, possibly by an
   * older build of the SDK, so each entry is validated as it is replayed:
   * corrupt entries are dropped and logged at debug level, and a failure is
   * never swallowed silently, because the survival of offline writes must be
   * observable.
   */
  private async restoreMutationQueue(
    sealedMutationIds: ReadonlySet<string> = new Set(),
  ): Promise<void> {
    if (!this.database || !this.userId) return;

    try {
      const stored = await this.database.getPersistedTransactions();
      const restoredMutationIds = new Set<string>();
      let heldForReview = 0;
      const restore = async (
        mutation: unknown,
        migrateLegacy: boolean,
        legacyMutationId?: string,
      ): Promise<void> => {
          const parsed = persistedMutationSchema.safeParse(mutation);
          if (!parsed.success) {
            getContext().logger.debug('[SyncClient] Dropping malformed persisted mutation', {
              issues: parsed.error.issues.map((i) => i.path.join('.')).join(', '),
            });
            return;
          }
          // The window is anchored to when the write was made, because a
          // record re-sealed on restore would otherwise reset its own expiry
          // clock. An unparseable timestamp is held rather than replayed.
          const writtenAt = Date.parse(parsed.data.timestamp);
          const age = Date.now() - writtenAt;
          if (!(age < PENDING_MUTATION_REPLAY_WINDOW_MS)) {
            heldForReview += 1;
            getContext().logger.warn(
              'A saved local write is older than the server idempotency window and was held for review.',
            );
            return;
          }
          const mutationId =
            parsed.data.mutationId ?? legacyMutationId ?? `mutation_${uuid()}`;
          if (
            sealedMutationIds.has(mutationId) ||
            restoredMutationIds.has(mutationId)
          ) return;
          const model = this.objectPool.createFromData(parsed.data.modelData);
          if (model) {
            const pending: PendingMutation = {
              mutationId,
              type: parsed.data.type,
              model,
              modelData: parsed.data.modelData,
              timestamp: new Date(parsed.data.timestamp),
              ...(parsed.data.capturedChanges !== undefined
                ? { capturedChanges: parsed.data.capturedChanges }
                : {}),
              ...(parsed.data.writeOptions !== undefined
                ? { writeOptions: parsed.data.writeOptions }
                : {}),
              journaled: Promise.resolve(),
              // Restored mutations have no live `wait: 'confirmed'` caller, so
              // their staging needs no waiter handshake.
              staged: Promise.resolve(),
            };
            if (migrateLegacy) {
              pending.journaled = this.persistPendingMutation(pending);
              await pending.journaled;
            }
            this.pendingMutations.push(pending);
            restoredMutationIds.add(mutationId);
          }
      };

      for (const row of stored) {
        if (row.type !== 'pending_mutation') continue;
        const parsed = pendingMutationRecordSchema.safeParse(row);
        if (!parsed.success) {
          const legacy = legacyPendingMutationRecordSchema.safeParse(row);
          if (legacy.success) {
            await restore(legacy.data.mutation, true);
            continue;
          }
          getContext().logger.debug('[SyncClient] Dropping malformed pending mutation record', {
            rowId: row.id,
          });
          continue;
        }
        if (
          parsed.data.scope.organizationId !== this.organizationId ||
          parsed.data.scope.participantId !== this.userId ||
          parsed.data.scope.namespace !== this.commitOutboxNamespace
        ) {
          getContext().logger.warn(
            'A saved local write belongs to a different account or server and was held for review.',
          );
          continue;
        }
        await restore(parsed.data.mutation, false);
      }

      const legacyQueue = stored.find((row) => row.id === 'mutation-queue');
      if (legacyQueue?.mutations) {
        const heldBefore = heldForReview;
        for (const [index, mutation] of legacyQueue.mutations.entries()) {
          await restore(mutation, true, `legacy_mutation_${index}`);
        }
        // Deleting the legacy row would discard any entry held for review, so
        // it is only removed once every entry has migrated.
        if (heldForReview === heldBefore) {
          await this.database.removeTransaction('mutation-queue');
        }
      }
    } catch (error) {
      // A restore failure means queued offline writes did NOT rehydrate.
      // Self-healing is impossible here (the record may be unreadable), but
      // the failure must be visible for diagnosis instead of silent loss.
      getContext().logger.debug('[SyncClient] Failed to restore offline mutation queue', {
        error: error instanceof Error ? error.message : String(error),
      });
      getContext().observability.captureTransactionFailure({
        context: 'restore-mutation-queue',
        error: error instanceof Error ? error : String(error),
      });
    }
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
      // Internal invariant, not a consumer-actionable error: identity (user +
      // org) hasn't arrived yet. The mutations stay queued and retry once it
      // does, so this is `debug` — a transient startup race is normal. If it
      // never clears it means the host app finished sign-in without seeding
      // identity, which surfaces downstream as "writes never confirm"; we do
      // NOT name internal wiring (`SyncClient.initialize`) here because that
      // method isn't part of the @abloatai/ablo surface a reader could act on.
      getContext().logger.debug(
        '[sync] writes waiting for identity (user/org not set yet) — queued, will retry',
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

    if (this.stagedMutationIds.size > 0) return;
    const mutations = this.pendingMutations.filter(
      (mutation) => !this.stagedMutationIds.has(mutation.mutationId),
    ).slice(0, 500);
    if (mutations.length === 0) return;

    // Claim the batch BEFORE awaiting the journal. This method runs
    // concurrently — the scheduleSync microtask and a direct syncNow() caller
    // land in the same tick — and both would otherwise capture this same
    // batch, suspend on the identical `journaled` promises, and stage every
    // mutation twice (two transactions on the wire for one write). Claiming
    // synchronously makes the second caller hit the guard above and return.
    for (const mutation of mutations) {
      this.stagedMutationIds.add(mutation.mutationId);
    }

    // A journal rejection is permanent for that mutation (fail-closed: it can
    // never dispatch without its durable record), so drop it rather than
    // leaving it queued to poison every later pass. Healthy batch members
    // still stage.
    // Settle each mutation into an object that keeps the mutation bound to its
    // own outcome. Correlating by array index would force a `mutations[index]!`
    // non-null assertion (the lookup is `T | undefined` under
    // noUncheckedIndexedAccess); carrying the reference makes it unnecessary.
    const journalOutcomes = await Promise.all(
      mutations.map(async (mutation) => {
        try {
          await mutation.journaled;
          return { mutation, ok: true as const };
        } catch (reason) {
          return { mutation, ok: false as const, reason };
        }
      }),
    );
    const journaledMutations: PendingMutation[] = [];
    for (const outcome of journalOutcomes) {
      const { mutation } = outcome;
      if (outcome.ok) {
        journaledMutations.push(mutation);
        continue;
      }
      this.stagedMutationIds.delete(mutation.mutationId);
      this.pendingMutations = this.pendingMutations.filter(
        (pending) => pending.mutationId !== mutation.mutationId,
      );
      mutation.rejectStaged?.(outcome.reason);
      getContext().observability.captureTransactionFailure({
        context: 'persist-pending-mutation',
        error:
          outcome.reason instanceof Error
            ? outcome.reason
            : new Error(String(outcome.reason)),
      });
    }

    // Stage every mutation synchronously within the same event-loop tick;
    // the transaction queue's microtask batches and sends them together.
    for (const mutation of journaledMutations) {
      // Stage synchronously - TransactionQueue handles batching, retry, and errors
      this.stageMutation(mutation);
    }
  }

  /**
   * Stage mutation to TransactionQueue - mutations in same tick are batched via microtask
   *
   * @param mutation.capturedChanges - Pre-captured changes to use instead of re-reading from model
   */
  private stageMutation(mutation: PendingMutation): void {
    if (!this.userId || !this.organizationId) {
      // Nothing will stage this call; settle the waiter with the legacy
      // "silently dropped" semantics rather than hanging a `wait: 'confirmed'`.
      mutation.resolveStaged?.();
      return;
    }

    const ctx = { userId: this.userId, organizationId: this.organizationId };

    // Settlement is delivered via transaction.confirmation, not this promise —
    // it only rejects when staging itself throws (change extraction, optimistic
    // apply, store add). That means the write never entered the queue, so
    // capture it instead of dropping it silently.
    const captureStagingFailure = (error: unknown): void => {
      getContext().observability.captureTransactionFailure({
        context: `stage-mutation-${mutation.type}`,
        modelName: mutation.model.getModelName(),
        modelId: mutation.model.id,
        error: error instanceof Error ? error : new Error(String(error)),
      });
      this.stagedMutationIds.delete(mutation.mutationId);
    };

    const staging =
      mutation.type === 'update'
        ? this.transactionQueue.update(
            mutation.model,
            ctx,
            mutation.capturedChanges,
            mutation.writeOptions,
            mutation.mutationId,
          )
        : this.transactionQueue[mutation.type].bind(this.transactionQueue)(
            mutation.model,
            ctx,
            mutation.writeOptions,
            mutation.mutationId,
          );
    staging
      .then(() => mutation.resolveStaged?.())
      .catch((error: unknown) => {
        captureStagingFailure(error);
        mutation.rejectStaged?.(error);
      });
  }

  /**
   * Resolve a conflict between the local model and incoming server data,
   * called while processing deltas from the WebSocket. Certain server states,
   * such as deletions and deactivations, always take precedence even when the
   * local model has unsynced changes, so the two sides stay consistent.
   */
  resolveConflicts(localModel: Model, serverData: Record<string, unknown>): Model {
    const hasLocalChanges = localModel.hasChanges;
    // Safely get timestamp, handling both Date objects and strings
    const localUpdatedAt = localModel.updatedAt
      ? localModel.updatedAt instanceof Date
        ? localModel.updatedAt.getTime()
        : new Date(localModel.updatedAt).getTime()
      : 0;
    const serverUpdatedAt = toEpochMs(serverData.updatedAt);

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
      if (serverData.updatedAt || localModel.updatedAt) {
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
  private hasCriticalStateChange(criticalStates: Record<string, unknown>): boolean {
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
    // Browser online state may have marked the client connected before the
    // WebSocket itself was ready. Always kick both durable lanes on the real
    // socket event, even when the high-level state did not change.
    void this.transactionQueue.flushOfflineQueue().catch((error: unknown) => {
      getContext().observability.captureTransactionFailure({
        context: 'restore-commit-outbox',
        error: error instanceof Error ? error : new Error(String(error)),
      });
    });
    void this.processPendingMutations();
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
   * Notify the {@link TransactionQueue} of an incoming delta so it can confirm
   * transactions by sync-id threshold. A transaction is confirmed once any
   * delta with an id at or beyond its `lastSyncId` threshold arrives.
   * @param syncId - The sync id of the received delta.
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
   * Cancel pending transactions for child entities orphaned by a parent's
   * deletion. The store calls this when a delete delta arrives for a parent,
   * cancelling any queued writes on children that reference it.
   *
   * @param childModelName - The child model type (for example, `SlideLayer`).
   * @param foreignKey - The foreign-key property name (for example, `slideId`).
   * @param parentId - The id of the deleted parent.
   * @returns The number of transactions cancelled.
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
   * Wait for a transaction to be confirmed by its delta echo. Delegates to the
   * {@link TransactionQueue}, which handles the confirmation timeout.
   */
  waitForDeltaConfirmation(transactionId: string): Promise<void> {
    return this.transactionQueue.waitForConfirmation(transactionId);
  }

  /**
   * Force sync now - process pending mutations
   */
  async syncNow(): Promise<void> {
    // Snapshot before draining: a concurrent drain may already have claimed
    // this caller's write, in which case processPendingMutations returns
    // without staging anything. `wait: 'confirmed'` resolves on finding no
    // in-flight work, so it must not run until every write queued before this
    // call has a real transaction in the queue or was definitively dropped.
    const queuedBeforeCall = this.pendingMutations.map((mutation) => mutation.staged);
    await this.processPendingMutations();
    await Promise.allSettled(queuedBeforeCall);
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
   * Distinct from `onTransactionEvent('failed', cb)`, which serves the
   * parameterless `pendingChanges` counter and intentionally drops the
   * payload. The two coexist: the counter callback stays lightweight, while
   * this typed listener drives user-visible surfaces.
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
   * Subscribe to local transaction creation with the full {@link Transaction}
   * payload (`type`, `modelName`, `modelId`, `data`, `previousData`). This is
   * the feed the store's local-mutation subscription taps for undo recording.
   *
   * It subscribes to the {@link TransactionQueue}'s emitter directly, since
   * that is the only emitter that fires `transaction:created`. The SyncClient's
   * own emitter (reached through {@link subscribe}) never rebroadcasts that
   * event, so routing undo through `subscribe('transaction:created')` would
   * record nothing. {@link onMutationFailure} taps the queue for the same
   * reason.
   */
  onLocalTransaction(
    listener: (tx: import('./transactions/TransactionQueue.js').Transaction) => void,
  ): () => void {
    this.transactionQueue.on('transaction:created', listener);
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
    this.transactionQueue.on('commit:staging', onCommitStaging);
    this.transactionQueue.on('commit:seal_failed', onCommitSealFailed);
    this.transactionQueue.on('commit:created', onCommitCreated);
    return () => {
      this.transactionQueue.off('transaction:created', listener);
      this.transactionQueue.off('commit:staging', onCommitStaging);
      this.transactionQueue.off('commit:seal_failed', onCommitSealFailed);
      this.transactionQueue.off('commit:created', onCommitCreated);
      snapshotsByCommit.clear();
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
  getEchoMetrics(): Readonly<UnconfirmedWritesMetrics> {
    return this.echoTracker.getMetrics();
  }

  /**
   * Package-internal accessor for the {@link TransactionQueue}. Used by
   * `Ablo.commits.create()` to route raw multi-operation envelopes through the
   * same retry-on-reconnect lane as the model proxy path, and by tests to
   * exercise the queue's interaction with {@link markTransactionPending} on the
   * real instance the SyncClient subscribes to. It is not re-exported to SDK
   * consumers; `Ablo` is the public surface.
   */
  getTransactionQueue(): TransactionQueue {
    return this.transactionQueue;
  }

  applyDeltaBatchToPool(
    dbResults: {
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
    }[],
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

      // Echo detection: if this delta carries a transaction id that matches
      // one already applied optimistically, the pool already reflects the
      // mutation, so the pool operation is skipped. The IndexedDB write in
      // Database.processDeltaBatch still runs; only the in-memory pool update
      // is suppressed. This prevents a resurrection flicker: a server-confirmed
      // create arriving after the user has optimistically deleted the row would
      // otherwise re-add it for the brief window before the matching delete
      // confirmation lands.
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
          // Self-healing: the next catch-up poll / reconnect re-fetches and
          // re-applies this delta, so it's forensic, not consumer-actionable → debug.
          getContext().logger.debug('[SyncClient.applyDeltaBatchToPool] skipping pool op for unpersisted delta', {
            modelName,
            modelId: modelId.slice(0, 12),
          });
          break;
      }
    }

    // Reveal the whole frame in a single MobX action. `addBatch`,
    // `upsertBatch`, `removeBatch`, and `updateScope` are each individually
    // wrapped in an action, so calling them in sequence flushes reactions at
    // every action boundary — a catch-up frame that adds, updates, and removes
    // would fire every dependent reaction several times in a row, re-rendering
    // and re-sorting on each. Wrapping them in one outer `runInAction` defers
    // all reaction flushes to a single boundary, so dependents recompute
    // exactly once regardless of how many models or operation kinds the frame
    // touched. The app therefore never observes a partially applied frame.
    runInAction(() => {
      if (modelsToAdd.length > 0) this.objectPool.addBatch(modelsToAdd, ModelScope.live);
      if (modelsToUpsert.length > 0) this.objectPool.upsertBatch(modelsToUpsert, ModelScope.live);
      if (idsToRemove.length > 0) this.objectPool.removeBatch(idsToRemove);
      for (const id of idsToArchive) this.objectPool.updateScope(id, ModelScope.archived);

      // Emit changed model types so QueryProcessor can auto-invalidate.
      // Kept inside the action so any observable query-cache state it
      // flips is part of the same atomic reveal.
      const changedTypes = new Set(dbResults.map(r => r.modelName));
      if (changedTypes.size > 0) this.emit('models:changed', changedTypes);
    });
  }

  /**
   * Apply bootstrap data to the InstanceCache with ghost removal.
   * Owns: model creation, batch upsert, ghost detection + removal.
   */
  applyBootstrapDataToPool(
    bootstrapData: { models?: Record<string, unknown[]>; failedModels?: string[] },
    protectedIds?: ReadonlySet<string>,
    options?: {
      /**
       * Scoped backfill for the hydrate-on-enter path: the snapshot covers only
       * the groups just entered, not the whole model type. Two behaviors change
       * so the subset cannot corrupt the pool. First, the upsert is
       * version-guarded ({@link InstanceCache.upsertIfNewer}) so a concurrent live
       * delta is not clobbered back to the snapshot version. Second, ghost
       * removal is skipped, because a subset snapshot must never evict rows of
       * the same type that belong to other, unhydrated groups.
       */
      scoped?: boolean;
    },
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

        // Scoped backfill for the hydrate-on-enter path: a subset snapshot is
        // taken at a server watermark. If a concurrent live delta already
        // advanced this row past the snapshot, skip it. `createFromData`
        // mutates the pooled model in place to keep instances alive, so this
        // version guard has to run before it; a guard at the upsert layer would
        // be too late, because the row would already be clobbered.
        if (options?.scoped && recordId) {
          const existing = this.objectPool.get(recordId);
          if (existing && !rawRecordIsNewer(data, existing)) { skippedCount++; continue; }
        }

        try {
          const model = this.objectPool.createFromData(data);
          if (model) allModels.push(model);
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
