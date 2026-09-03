/**
 * MutationQueue manages the lifecycle of local writes on their way to the
 * server: it applies each change optimistically, batches the writes made in one
 * event-loop tick into a single commit, retries transient failures, and rolls
 * back on permanent rejection.
 *
 * Key behaviours:
 * - Optimistic updates with rollback on failure.
 * - Configurable conflict resolution.
 * - Microtask batching: transactions created in the same event-loop tick share
 *   a batch id and commit together in one round trip.
 * - A dependency-injected executor, so several queues can coexist.
 */

import { EventEmitter } from 'events';
import { v4 as uuid } from 'uuid';
import type { LocalModel } from '../../localModelContract.js';
import type { MutationPersistencePort } from '../../mutationPersistence.js';
import { globalRuntime } from '../../context.js';
import type { RuntimeContext } from '../../RuntimeContext.js';
import {
  AbloConnectionError,
  AbloIdempotencyError,
} from '@abloatai/transaction/errors';
import {
  LogPosition,
  type LogPositionPort,
} from '../../logPosition.js';
import type { WriteOptions } from '../../interfaces/index.js';
import type { ReadDependency } from '@abloatai/transaction/coordination/schema';
import {
  type CommitOperationResult,
  type MutationCommitResult,
} from '@abloatai/transaction/commit';
import {
  computePriorityScore,
  normalizeModelKey,
  // Includes stale guards as well as request identity/audit barriers.
  type MutationInput,
  type QueuedMutation,
  type UserContext,
} from './commitPayload.js';
import {
  generateTransactionId,
  mergeMutationData,
  createDataFor,
  changesToInput,
  updateDataFor,
  previousDataFor,
} from './mutationInput.js';
import { MutationStore } from './MutationStore.js';
import {
  entityKey,
  takeUnsentCreateForModel,
  findCreateBarrierForDelete,
  deferDeleteUntilCreateSettles,
  releaseDeferredDeletesForCreate,
} from './coalesceRules.js';
import { DeltaConfirmationTracker } from './deltaConfirmation.js';
import {
  deserializePersistedTransaction,
  isNonReplayablePersistedRow,
  pendingMutationRecordId,
} from './replayValidation.js';
import {
  deserializeLegacyPendingMutation,
  loadPersistedTransactions,
  persistQueuedTransaction,
  removePersistedTransaction,
  settlePersistedFailure,
  type MutationPersistenceContext,
} from './mutationPersistence.js';
import {
  createCommitEnvelopeMember,
  type DurableCommitEnvelope,
  type CommitOutboxScope,
} from '@abloatai/transaction/commit';
import type { DurableWriteStore } from './durableWriteStore.js';
import {
  createLocalMutationPort,
  type LocalMutationPort,
} from './localMutation.js';
import {
  dispatchCommitBounded,
  parseMutationCommitResult,
  persistDurableCommitAcceptance,
  removeDurableCommit,
  sealDurableCommit,
  type CommitTransportContext,
} from './commitTransport.js';
import {
  processCommitLane,
  waitForCommitReceipt,
  type CommitLaneContext,
  type CommitReceiptContext,
  type CommitTransaction,
} from './commitLane.js';
import { enqueueCommit, type CommitApiContext } from './commitApi.js';
import {
  archive as archiveModel,
  create as createModel,
  remove as deleteModel,
  unarchive as unarchiveModel,
  update as updateModel,
  type ModelMutationContext,
} from './modelOperations.js';
import { enqueueTransaction, type QueueCoalescingContext } from './queueCoalescing.js';
import { processBatch, type BatchProcessingContext } from './batchProcessing.js';
import { handleFailure, type FailureHandlingContext } from './failureHandling.js';
import { handleConflict as resolveConflict, isPermanentError as classifyPermanentError, isDefinitiveRejection as classifyDefinitiveRejection, type ConflictResolutionContext } from './failurePolicy.js';
import { takeNextExecutionBatch as selectExecutionBatch } from './executionSelection.js';
import { scheduleProcessing as scheduleProcessingExternal, type ProcessingSchedulerContext } from './processingScheduler.js';
import { restoreDurableCommits as restoreDurableCommitsExternal, type DurableCommitRestoreContext } from './durableCommitRestore.js';

// The queue is split across sibling modules (`commitPayload`,
// `MutationStore`, `coalesceRules`, `deltaConfirmation`, `optimistic`).
// Re-export the shared public types here so importers can continue to reach
// them through this module.
export type { QueuedMutation, UserContext } from './commitPayload.js';
/**
 * A pre-built, multi-operation commit submitted through
 * `ablo.commits.create()`. Unlike the per-model {@link QueuedMutation} (see
 * `./commitPayload.js`), the caller supplies the operations and the whole
 * envelope commits atomically: the queue does not coalesce it, reorder its
 * operations for foreign keys, or apply it optimistically. It runs through the
 * same `mutationExecutor.commit()` as the model batch path, so its
 * retry-on-reconnect behaviour is identical.
 */
interface ConflictResolution {
  strategy: 'last-write-wins' | 'merge' | 'reject' | 'custom';
  resolver?: (local: MutationInput | undefined, remote: MutationInput) => MutationInput;
}

export interface MutationQueueConfig {
  /** Shared client position (see logPosition.ts). One per client. */
  position?: LogPositionPort;
  /** The owning client's runtime. Defaults to the module-global bridge. */
  runtime?: RuntimeContext;
  maxBatchSize: number;
  batchDelay: number;
  maxRetries: number;
  /**
   * Minimum wall-clock window for retrying transient write failures with the
   * same durable envelope and idempotency key. This absorbs managed-database
   * promotion and brief regional network incidents without double-applying a
   * write. Defaults to 120 seconds: the Aurora promotion drill recovered
   * writes just beyond 60 seconds, so a one-minute boundary discarded exact
   * envelopes at the instant the new writer became usable.
   */
  availabilityRetryWindowMs: number;
  conflictResolution: ConflictResolution;
  enablePersistence: boolean;
  enableOptimistic: boolean;
  /** Local adapter for applying and rolling back local writes. */
  localMutationPort?: LocalMutationPort;
  maxExecutingTransactions: number;
  // How long to wait, in milliseconds, for a change's confirming sync delta
  // before the retry-and-reconciliation cycle begins. For a source-forwarded
  // write this is also the awaited model-write deadline: expiry rejects the
  // waiter with `replication_lag_timeout` while the accepted write remains
  // pending. Defaults to 30000 (30 seconds); raise it for slow networks.
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
   * How long, in milliseconds, to wait after the connection drops before
   * failing any in-flight commit-lane transaction with an
   * {@link AbloConnectionError}. Brief disconnects, such as a server restart
   * or mobile network jitter, are absorbed transparently; only a disconnect
   * that outlasts this window surfaces as a failure. Set it lower for
   * interactive use (for example 10 seconds for chat) and higher for
   * background batch work. Defaults to 30 seconds.
   *
   * Without this deadline, `commits.create({ wait: 'confirmed' })` would wait
   * forever if the connection died while a commit was in flight.
   */
  commitOfflineGraceMs: number;
  /**
   * How long, in milliseconds, to wait for the transport to acknowledge a
   * dispatched commit before treating the silence as a retryable no-receipt
   * failure. A transport that never answers — a half-open socket, a dropped
   * response frame — would otherwise hold the commit in flight forever, and
   * with it the client's staged-batch lock: every later write in the session
   * queues silently behind the unanswered one. The envelope's idempotency key
   * is stable across retries, so a commit the server DID apply before the
   * timeout is deduplicated on the retry rather than double-applied.
   * Defaults to 30 seconds. Set `0` to disable the bound.
   */
  commitDispatchTimeoutMs: number;
}

export class MutationQueue extends EventEmitter {
  // Keep one hour of clock/network margin inside the server's 24-hour ledger.
  private static readonly DURABLE_REPLAY_WINDOW_MS = 23 * 60 * 60 * 1000;
  private store = new MutationStore();
  // Signature of the last permanent-error we logged at `warn`. A `create`
  // whose id already exists (`unique_violation`) is a permanent rejection
  // that a pending-work drain re-drives after reconnect/bootstrap — without
  // this, the identical cause prints on a loop. We log the first occurrence
  // and demote exact repeats to `debug`.
  private lastPermanentErrorSig?: string;
  // The executor bound to this queue instance, set by `setMutationExecutor(...)`
  // just after construction. When unset it falls back to the ambient executor
  // from `getContext()`.
  //
  // The binding matters because the ambient executor is a module-level
  // singleton: constructing a second client instance overwrites the first
  // instance's executor. Without a per-instance binding, commits on one
  // instance would dispatch through another instance's executor closure; once
  // that other instance disposed its store, the closure would resolve no live
  // connection and every commit here would fail with `ws_not_ready`, which the
  // queue treats as transient and retries endlessly.
  private _mutationExecutor: import('../../interfaces/index.js').MutationExecutor | null = null;
  private get mutationExecutor() {
    return this._mutationExecutor ?? this.runtime.mutationExecutor;
  }

  private readonly runtime: RuntimeContext;
  /** Durable transaction journal owned by this queue, before commit sealing. */
  private persistence: MutationPersistencePort | null = null;
  private deferredMutations: {
    type: 'create' | 'update' | 'delete' | 'archive';
    model: LocalModel;
    capturedChanges?: Record<string, unknown>;
    writeOptions?: WriteOptions;
  }[] = [];
  private pendingPersistenceStages: {
    transaction: QueuedMutation;
    modelData: Record<string, unknown>;
    resolve: () => void;
    reject: (error: Error) => void;
  }[] = [];
  private persistenceStageScheduled = false;
  private pendingDrainPromise: Promise<void> | null = null;
  private modelProcessingPromise: Promise<void> | null = null;

  private executionQueue: QueuedMutation[] = [];
  private isProcessing = false;
  private processTimer?: NodeJS.Timeout;
  private processScheduled = false;

  // Staging area for transactions created in the same event-loop tick. Each one
  // lands here first, then a microtask commits them together.
  private createdTransactions: QueuedMutation[] = [];
  private commitScheduled = false;

  // Per-model in-flight tracking and merge buffer
  private inFlightByModel = new Set<string>();
  private pendingMergeByModel = new Map<
    string,
    { data: MutationInput; sourceMutationIds: string[] }
  >();
  private deferredDeletesByCreate = new Map<string, QueuedMutation[]>();

  // Commit lane: pre-built atomic multi-op envelopes from `ablo.commits.create()`.
  // Drained serially (one envelope at a time) since each is atomic; no
  // coalescing with model-proxy transactions.
  private commitLane: CommitTransaction[] = [];
  private commitStore = new Map<string, CommitTransaction>();
  /**
   * Small race buffer for authoritative echoes that arrive before the queued
   * mutation receipt. The forward and WAL stream are independent channels, so
   * either can win without changing the confirmation result.
   */
  private recentDeltaCorrelations = new Map<string, number>();
  /**
   * Client-facing confirmation deadlines for source-forwarded writes. These
   * timers settle only the caller waiting for `confirmed`; the accepted write
   * remains in `awaiting_delta`, with its durable envelope intact, until the
   * authoritative WAL echo arrives.
   */
  private replicationLagTimeouts = new Map<string, ReturnType<typeof setTimeout>>();
  private replicationLagErrors = new Map<string, AbloConnectionError>();
  private commitProcessing = false;
  private commitRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private lastCommitSequence = 0;
  private durableReplayBlock: AbloIdempotencyError | null = null;
  /** Browser-backed strict outbox; absent for standalone/in-memory consumers. */
  private commitOutbox: DurableWriteStore | null = null;
  private commitOutboxScope: CommitOutboxScope | null = null;

  private get commitTransportContext(): CommitTransportContext {
    return {
      runtime: this.runtime,
      config: {
        enablePersistence: this.config.enablePersistence,
        commitDispatchTimeoutMs: this.config.commitDispatchTimeoutMs,
      },
      commitOutbox: this.commitOutbox,
      commitOutboxScope: this.commitOutboxScope,
      mutationExecutor: this.mutationExecutor,
      emitCommitLifecycle: (event, payload) => { this.emitCommitLifecycle(event, payload); },
    };
  }

  private get commitLaneContext(): CommitLaneContext {
    return {
      runtime: this.runtime,
      config: {
        maxRetries: this.config.maxRetries,
        availabilityRetryWindowMs: this.config.availabilityRetryWindowMs,
        retryBackoff: this.config.retryBackoff,
      },
      commitLane: this.commitLane,
      commitMissingIds: this.commitMissingIds,
      commitProcessing: this.commitProcessing,
      setCommitProcessing: (value) => { this.commitProcessing = value; },
      durableReplayBlock: this.durableReplayBlock,
      sealDurableCommit: (input) => this.sealDurableCommit(input),
      assertEnvelopeInsideReplayWindow: (envelope) => { this.assertEnvelopeInsideReplayWindow(envelope); },
      dispatchCommit: async (envelope) => this.parseMutationCommitResult(
        await this.dispatchCommitBounded(envelope.operations, {
          idempotencyKey: envelope.idempotencyKey,
          ...(envelope.commitOptions.reads ? { reads: envelope.commitOptions.reads } : {}),
        }),
      ),
      persistDurableCommitAcceptance: (envelope, result) => this.persistDurableCommitAcceptance(envelope, result),
      removeDurableCommit: (idempotencyKey) => this.removeDurableCommit(idempotencyKey),
      queuedCommitEchoSyncId: (transaction) => this.queuedCommitEchoSyncId(transaction),
      completeQueuedCommit: (transaction, syncId) => { this.completeQueuedCommit(transaction, syncId); },
      scheduleReplicationLagTimeout: (transactionId, clientTxId, correlationId) => { this.scheduleReplicationLagTimeout(transactionId, clientTxId, correlationId); },
      noteAck: (syncId) => { this.noteAck(syncId); },
      isDefinitiveRejection: (error) => this.isDefinitiveRejection(error),
      isPermanentError: (error) => this.isPermanentError(error),
      scheduleRetry: (delayMs) => {
        if (this.commitRetryTimer !== null) clearTimeout(this.commitRetryTimer);
        this.commitRetryTimer = setTimeout(() => {
          this.commitRetryTimer = null;
          void this.processCommitLane();
        }, delayMs);
      },
      emitCommitLifecycle: (event, payload) => { this.emitCommitLifecycle(event, payload); },
    };
  }

  private get commitReceiptContext(): CommitReceiptContext {
    return {
      commitStore: this.commitStore,
      commitMissingIds: this.commitMissingIds,
      replicationLagErrors: this.replicationLagErrors,
      on: (event, listener) => this.on(event, listener),
      off: (event, listener) => this.off(event, listener),
    };
  }

  private get commitApiContext(): CommitApiContext {
    return {
      assertDurableReplayOpen: () => { this.assertDurableReplayOpen(); },
      commitStore: this.commitStore,
      commitLane: this.commitLane,
      replicationLagErrors: this.replicationLagErrors,
      clearReplicationLagState: (transactionId) => { this.clearReplicationLagState(transactionId); },
      nextCommitSequence: () => this.nextCommitSequence(),
      sealDurableCommit: (input) => this.sealDurableCommit(input),
      processCommitLane: () => this.processCommitLane(),
      emitCommitLifecycle: (event, payload) => { this.emitCommitLifecycle(event, payload); },
    };
  }

  private get modelMutationContext(): ModelMutationContext {
    return {
      enableOptimistic: this.config.enableOptimistic,
      persistenceReady: !!this.persistence && !!this.commitOutboxScope,
      assertDurableReplayOpen: () => { this.assertDurableReplayOpen(); },
      generateId: () => this.generateId(),
      normalizeModelKey,
      computePriorityScore: (type, modelName) => this.computePriorityScore(type, modelName),
      extractCreateData: (model) => this.extractCreateData(model),
      extractUpdateData: (model) => this.extractUpdateData(model),
      extractPreviousData: (model, input) => this.extractPreviousData(model, input),
      mapChangesToInput: (modelName, changes) => this.mapChangesToInput(modelName, changes),
      isReorderPayload: (input) => this.isReorderPayload(input),
      attachConfirmation: (transaction) => { this.attachConfirmation(transaction); },
      add: (transaction) => { this.store.add(transaction); },
      applyOptimisticCreate: (model, transaction) => { this.applyOptimisticCreate(model, transaction); },
      applyOptimisticUpdate: (model, transaction) => { this.applyOptimisticUpdate(model, transaction); },
      applyOptimisticDelete: (model, transaction) => { this.applyOptimisticDelete(model, transaction); },
      takeUnsentCreateForModel: (modelName, modelId) => this.takeUnsentCreateForModel(modelName, modelId),
      cancelUnsentCreateForDelete: (transaction) => this.cancelUnsentCreateForDelete(transaction),
      completeLocalDelete: (model, context, writeOptions, sourceMutationIds) => this.completeLocalDelete(model, context, writeOptions, sourceMutationIds),
      cancelTransactionsForModel: (modelId, type) => this.cancelTransactionsForModel(modelId, type),
      pendingMergeByModel: this.pendingMergeByModel,
      inFlightByModel: this.inFlightByModel,
      findCreateBarrierForDelete: (modelName, modelId) => this.findCreateBarrierForDelete(modelName, modelId),
      deferDeleteUntilCreateSettles: (create, transaction) => { this.deferDeleteUntilCreateSettles(create, transaction); },
      logger: this.runtime.logger,
      persistAndStage: (transaction, modelData) => this.persistAndStage(transaction, modelData),
      persistQueuedTransaction: (transaction, modelData) => this.persistQueuedTransaction(transaction, modelData),
      stageTransaction: (transaction) => { this.stageTransaction(transaction); },
      emit: (event, payload) => this.emit(event, payload),
    };
  }

  private get queueCoalescingContext(): QueueCoalescingContext {
    return {
      executionQueue: this.executionQueue,
      inFlightByModel: this.inFlightByModel,
      pendingMergeByModel: this.pendingMergeByModel,
      ensureDerivedFields: (transaction) => { this.ensureDerivedFields(transaction); },
      scheduleProcessing: (immediate) => { this.scheduleProcessing(immediate); },
      storeRemove: (transactionId) => { this.store.remove(transactionId); },
    };
  }

  private get batchProcessingContext(): BatchProcessingContext {
    return {
      runtime: this.runtime,
      config: this.config,
      durableReplayBlock: this.durableReplayBlock,
      executionQueue: this.executionQueue,
      isProcessing: this.isProcessing,
      setIsProcessing: (value) => { this.isProcessing = value; },
      takeNextExecutionBatch: () => this.takeNextExecutionBatch(),
      ensureDerivedFields: (transaction) => { this.ensureDerivedFields(transaction); },
      ensureCommitEnvelope: (batch) => this.ensureCommitEnvelope([...batch]),
      executingCount: this.executingCount,
      setExecutingCount: (value) => { this.executingCount = value; },
      inFlightByModel: this.inFlightByModel,
      pendingMergeByModel: this.pendingMergeByModel,
      generateId: () => this.generateId(),
      computePriorityScore: (type, modelName) => this.computePriorityScore(type, modelName),
      store: this.store,
      enqueue: (transaction) => { this.enqueue(transaction); },
      optimisticUpdates: this.localMutationPort.updates,
      commitMissingIds: this.commitMissingIds,
      sourceMutationIdsFor: (batch) => this.sourceMutationIdsFor(batch),
      dispatchCommitBounded: (...args) => this.dispatchCommitBounded(...args),
      parseMutationCommitResult: (value) => this.parseMutationCommitResult(value),
      persistDurableCommitAcceptance: (envelope, result) => this.persistDurableCommitAcceptance(envelope, result),
      removeDurableCommit: (idempotencyKey) => this.removeDurableCommit(idempotencyKey),
      assertEnvelopeInsideReplayWindow: (envelope) => { this.assertEnvelopeInsideReplayWindow(envelope); },
      sealDurableCommit: (input) => this.sealDurableCommit(input),
      noteAck: (syncId) => { this.noteAck(syncId); },
      scheduleReplicationLagTimeout: (transactionId, clientTxId, correlationId) => { this.scheduleReplicationLagTimeout(transactionId, clientTxId, correlationId); },
      scheduleDeltaConfirmationTimeout: (transaction, timeoutMs) => { this.scheduleDeltaConfirmationTimeout(transaction, timeoutMs); },
      clearReplicationLagState: (transactionId) => { this.clearReplicationLagState(transactionId); },
      completeQueuedCommit: (transaction, syncId) => { this.completeQueuedCommit(transaction, syncId); },
      queuedCommitMatchesCorrelation: (transaction, correlationId) => this.queuedCommitMatchesCorrelation(transaction, correlationId),
      recentDeltaCorrelations: this.recentDeltaCorrelations,
      lastSeenSyncId: this.lastSeenSyncId,
      scheduleProcessing: (immediate) => { this.scheduleProcessing(immediate); },
      handleFailure: (transaction, error) => this.handleFailure(transaction, error),
      isDefinitiveRejection: (error) => this.isDefinitiveRejection(error),
      emitCommitLifecycle: (event, payload) => { this.emitCommitLifecycle(event, payload); },
      emit: (event, payload) => this.emit(event, payload),
      rollbackOptimistic: (transaction, reason, error) => this.rollbackOptimistic(transaction, reason, error),
    };
  }

  private get failureHandlingContext(): FailureHandlingContext {
    return {
      runtime: this.runtime,
      config: this.config,
      store: this.store,
      isPermanentError: (error) => this.isPermanentError(error),
      rollbackOptimistic: (transaction, reason, error) => this.rollbackOptimistic(transaction, reason, error),
      enqueue: (transaction) => { this.enqueue(transaction); },
      getLastPermanentErrorSignature: () => this.lastPermanentErrorSig,
      setLastPermanentErrorSignature: (signature) => { this.lastPermanentErrorSig = signature; },
      emit: (event, payload) => this.emit(event, payload),
    };
  }

  private get conflictResolutionContext(): ConflictResolutionContext {
    return {
      config: this.config,
      store: this.store,
      rollbackOptimistic: (transaction, reason) => this.rollbackOptimistic(transaction, reason),
      mergeData: (local, remote) => this.mergeData(local, remote),
      enqueue: (transaction) => { this.enqueue(transaction); },
    };
  }

  private get processingSchedulerContext(): ProcessingSchedulerContext {
    return {
      processScheduled: this.processScheduled,
      setProcessScheduled: (value) => { this.processScheduled = value; },
      processTimer: this.processTimer,
      setProcessTimer: (timer) => { this.processTimer = timer; },
      executingCount: this.executingCount,
      maxExecutingTransactions: this.config.maxExecutingTransactions,
      batchDelay: this.config.batchDelay,
      processBatch: () => { void this.processBatch(); },
      logger: this.runtime.logger,
    };
  }

  private get durableCommitRestoreContext(): DurableCommitRestoreContext {
    return {
      config: this.config,
      commitOutbox: this.commitOutbox,
      commitOutboxScope: this.commitOutboxScope,
      commitStore: this.commitStore,
      commitLane: this.commitLane,
      runtime: this.runtime,
      processCommitLane: () => this.processCommitLane(),
      durableReplayWindowMs: MutationQueue.DURABLE_REPLAY_WINDOW_MS,
    };
  }

  private get persistenceContext(): MutationPersistenceContext {
    return {
      runtime: this.runtime,
      persistence: this.persistence,
      commitOutboxScope: this.commitOutboxScope,
      config: this.config,
      store: this.store,
      enqueue: (transaction) => { this.enqueue(transaction); },
      computePriorityScore: (type, modelName) => this.computePriorityScore(type, modelName),
      deserializeTransaction: (data) => this.deserializeTransaction(data),
    };
  }

  private nextCommitSequence(): number {
    const wallSequence = Date.now() * 1_000;
    this.lastCommitSequence = Math.max(wallSequence, this.lastCommitSequence + 1);
    return this.lastCommitSequence;
  }

  private emitCommitLifecycle(event: string, payload: unknown): void {
    try {
      this.emit(event, payload);
    } catch (error) {
      this.runtime.observability.captureMutationFailure({
        context: `commit-lifecycle-listener:${event}`,
        error: error instanceof Error ? error : String(error),
      });
    }
  }

  private assertDurableReplayOpen(): void {
    if (this.durableReplayBlock) throw this.durableReplayBlock;
  }

  private assertEnvelopeInsideReplayWindow(
    envelope: Pick<DurableCommitEnvelope, 'sealedAt' | 'acceptedAt'>,
  ): void {
    this.assertDurableReplayOpen();
    if (
      envelope.acceptedAt === undefined &&
      Date.now() - envelope.sealedAt >=
      MutationQueue.DURABLE_REPLAY_WINDOW_MS
    ) {
      this.durableReplayBlock = new AbloIdempotencyError(
        'A pending commit is older than the server idempotency window; newer writes are blocked until it is reviewed.',
        { code: 'idempotency_conflict' },
      );
      // This gate stops EVERY subsequent write on this client, and each of
      // those rejections is captured to observability rather than surfaced to
      // the caller — without this line the session degrades into "nothing
      // saves and nothing errors". One loud line at the moment the block
      // engages is the only visible trace.
      this.runtime.logger.warn(
        'sync paused: a saved write from an earlier session is older than the server replay window, so newer writes are held until it is reviewed',
        { sealedAt: envelope.sealedAt },
      );
      throw this.durableReplayBlock;
    }
  }

  private computePriorityScore(type: QueuedMutation['type'], modelName: string): number {
    return computePriorityScore(type, modelName, this.runtime);
  }

  private ensureDerivedFields(transaction: QueuedMutation): void {
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

  private entityKey(modelName: string, modelId: string): string {
    return entityKey(modelName, modelId);
  }

  /* Stale receipt classification was removed; stale premises now reject. */

  private resolveConfirmation(transaction: QueuedMutation): void {
    const resolver = this.confirmationResolvers.get(transaction.id);
    if (!resolver) return;
    this.confirmationResolvers.delete(transaction.id);
    resolver.resolve();
  }

  private takeUnsentCreateForModel(modelName: string, modelId: string): QueuedMutation | undefined {
    return takeUnsentCreateForModel(
      this.createdTransactions,
      this.executionQueue,
      this.store,
      modelName,
      modelId,
    );
  }

  private async cancelUnsentCreateForDelete(transaction: QueuedMutation): Promise<void> {
    this.store.updateStatus(transaction.id, 'rolled_back');
    if (this.config.enableOptimistic) {
      await this.rollbackOptimistic(transaction, 'model_cancelled');
    }
    this.resolveConfirmation(transaction);
  }

  private findCreateBarrierForDelete(modelName: string, modelId: string): QueuedMutation | undefined {
    return findCreateBarrierForDelete(this.store, modelName, modelId);
  }

  private completeLocalDelete(
    model: LocalModel,
    context: UserContext,
    writeOptions: WriteOptions | undefined,
    sourceMutationIds: readonly string[] = [],
  ): QueuedMutation {
    const actualModelName = model.getModelName();
    const modelKey = normalizeModelKey(actualModelName);
    const transaction: QueuedMutation = {
      id: this.generateId(),
      type: 'delete',
      modelName: actualModelName,
      modelId: model.id,
      modelKey,
      priorityScore: this.computePriorityScore('delete', actualModelName),
      previousData: model.toJSON ? model.toJSON() : { ...model },
      context,
      status: 'completed',
      createdAt: Date.now(),
      attempts: 0,
      priority: 'high',
      writeOptions,
      ...(sourceMutationIds.length > 0
        ? { sourceMutationIds: [...new Set(sourceMutationIds)] }
        : {}),
      localOnly: true,
    };

    this.attachConfirmation(transaction);
    this.store.add(transaction);

    if (this.config.enableOptimistic) {
      this.applyOptimisticDelete(model, transaction);
    }

    this.emit('transaction:created', transaction);
    this.emit('transaction:completed', transaction);
    this.emit(`transaction:completed:${transaction.id}`, transaction);
    this.localMutationPort.updates.delete(transaction.id);
    return transaction;
  }

  private deferDeleteUntilCreateSettles(createTransaction: QueuedMutation, deleteTransaction: QueuedMutation): void {
    deferDeleteUntilCreateSettles(this.deferredDeletesByCreate, createTransaction, deleteTransaction);
  }

  private releaseDeferredDeletesForCreate(createTransaction: QueuedMutation): void {
    releaseDeferredDeletesForCreate(
      this.deferredDeletesByCreate,
      this.store,
      (tx) => { this.enqueue(tx); },
      createTransaction,
    );
  }

  // Default configuration, tuned so more operations coalesce into a single
  // commit: a larger batch size and delay give rapid operations more time to
  // merge before the batch is sent.
  private config: MutationQueueConfig = {
    maxBatchSize: 50, // send up to this many operations per commit
    batchDelay: 150, // milliseconds to wait for more operations before sending
    maxRetries: 3,
    availabilityRetryWindowMs: 120_000,
    conflictResolution: {
      strategy: 'last-write-wins',
    },
    enablePersistence: true,
    enableOptimistic: true,
    maxExecutingTransactions: 100,
    deltaConfirmationTimeout: 30000,
    retryBackoff: { baseMs: 200, capMs: 1500 },
    commitOfflineGraceMs: 30_000,
    commitDispatchTimeoutMs: 30_000,
  };

  // Track executing transactions for backpressure
  private executingCount = 0;

  private readonly localMutationPort: LocalMutationPort;

  /** Zero-row targets returned on a successful atomic commit receipt. */
  private commitMissingIds = new Map<string, string[]>();

  // Delta-confirmation tracking (ack watermark advance + the awaiting_delta
  // timeout/retry maps) lives in `./deltaConfirmation.js`. Constructed in the
  // constructor once `position` is bound.
  private readonly deltaConfirmation: DeltaConfirmationTracker;

  // Connection-state check, supplied by the client, used to hold off rollbacks
  // while disconnected.
  private isConnectedFn: () => boolean = () => true;

  // Grace timer that, when fired, fails any commit-lane transaction
  // still awaiting an ack. Started on `setConnectionState('disconnected')`,
  // cleared on `'connected'`. The reconnect-retry behavior of the queue
  // is preserved for brief blips; this only catches persistent disconnects.
  private commitOfflineGraceTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * This client's place in the global order of sync deltas. The instance is
   * shared: the client injects one, and a standalone queue creates its own. The
   * queue advances the `acked` cursor as commit responses arrive, the store
   * advances `applied` and `persisted`, and snapshots and claims read
   * `readFloor`. See `../logPosition.js` for the full contract.
   */
  readonly position: LogPositionPort;

  /** Applied-cursor alias, kept so the many internal read sites stay legible. */
  private get lastSeenSyncId(): number {
    return this.position.applied;
  }

  private noteAck(lastSyncId: number | undefined): void {
    this.deltaConfirmation.noteAck(lastSyncId);
  }

  // Batch management
  private batchIndex = 0;

  /** Mints the request identity once; retry paths only read the stored value. */
  private generateCommitIdempotencyKey(): string {
    return `commit_${uuid()}`;
  }

  /**
   * Binds an ordered transaction batch to one wire-level idempotency key.
   * Existing envelopes are validated and restored to their original order;
   * they are never extended with newly queued work.
   */
  private ensureCommitEnvelope(batch: QueuedMutation[]): string {
    const firstTransaction = batch[0];
    if (!firstTransaction) {
      throw new Error('Cannot create an idempotency envelope for an empty commit');
    }

    const existingKeys = new Set(
      batch
        .map((tx) => tx.commitEnvelope?.idempotencyKey)
        .filter((key) => key !== undefined),
    );
    if (existingKeys.size > 1) {
      throw new Error('Cannot combine transactions from different commit envelopes');
    }

    const existingKey = existingKeys.values().next().value;
    if (existingKey) {
      const expectedCount = firstTransaction.commitEnvelope?.operationCount;
      const indexes = new Set(batch.map((tx) => tx.commitEnvelope?.operationIndex));
      const isCompleteEnvelope =
        expectedCount === batch.length &&
        indexes.size === batch.length &&
        batch.every(
          (tx) =>
            tx.commitEnvelope?.idempotencyKey === existingKey &&
            tx.commitEnvelope.operationCount === expectedCount &&
            tx.commitEnvelope.operationIndex < expectedCount,
        );
      if (!isCompleteEnvelope) {
        throw new Error('Cannot replay a partial or malformed commit envelope');
      }
      const persistedSealTimes = new Set(
        batch
          .map((transaction) => transaction.commitEnvelope?.sealedAt)
          .filter((sealedAt) => sealedAt !== undefined),
      );
      if (persistedSealTimes.size > 1) {
        throw new Error('Cannot replay a commit envelope with inconsistent seal times');
      }
      const sealedAt = persistedSealTimes.values().next().value ?? Date.now();
      for (const transaction of batch) {
        if (transaction.commitEnvelope) transaction.commitEnvelope.sealedAt = sealedAt;
      }
      batch.sort(
        (a, b) =>
          (a.commitEnvelope?.operationIndex ?? 0) -
          (b.commitEnvelope?.operationIndex ?? 0),
      );
      return existingKey;
    }

    // An explicit public key owns its request. Transactions carrying one are
    // selected as solo batches by takeNextExecutionBatch().
    const explicitKey =
      batch.length === 1
        ? firstTransaction.writeOptions?.idempotencyKey
        : undefined;
    const idempotencyKey =
      typeof explicitKey === 'string' && explicitKey.length > 0
        ? explicitKey
        : this.generateCommitIdempotencyKey();
    const sealedAt = Date.now();
    const sequence = this.nextCommitSequence();

    batch.forEach((tx, operationIndex) => {
      tx.commitEnvelope = createCommitEnvelopeMember({
        idempotencyKey,
        operationIndex,
        operationCount: batch.length,
        sealedAt,
        sequence,
      });
    });
    return idempotencyKey;
  }

  /** Bind the strict local outbox used before any mutation reaches the wire. */
  setCommitOutbox(outbox: DurableWriteStore): void {
    this.commitOutbox = outbox;
  }

  async setCommitOutboxScope(scope: CommitOutboxScope): Promise<void> {
    this.commitOutboxScope = scope;
    const deferred = this.deferredMutations;
    this.deferredMutations = [];
    await Promise.all(deferred.map((mutation) =>
      this.enqueueModelMutation(
        mutation.type,
        mutation.model,
        { userId: scope.participantId, organizationId: scope.organizationId },
        mutation.capturedChanges,
        mutation.writeOptions,
      ),
    ));
  }
  deferMutation(
    type: 'create' | 'update' | 'delete' | 'archive',
    model: LocalModel,
    capturedChanges?: Record<string, unknown>,
    writeOptions?: WriteOptions,
  ): void {
    this.runtime.logger.debug('[MutationQueue] Deferring mutation until identity is resolved', { type, model: model.getModelName(), modelId: model.id });
    this.deferredMutations.push({ type, model, capturedChanges, writeOptions });
  }

  async enqueueModelMutation(
    type: 'create' | 'update' | 'delete' | 'archive',
    model: LocalModel,
    context: UserContext,
    capturedChanges?: Record<string, unknown>,
    writeOptions?: WriteOptions,
  ): Promise<QueuedMutation> {
    switch (type) {
      case 'create': return this.create(model, context, writeOptions);
      case 'update': return this.update(model, context, capturedChanges, writeOptions);
      case 'delete': return this.delete(model, context, writeOptions);
      case 'archive': return this.archive(model, context, writeOptions);
    }
  }

  /** Attach the durable journal supplied by the local/materializer layer. */
  setPersistence(persistence: MutationPersistencePort): void {
    this.persistence = persistence;
  }

  private async persistQueuedTransaction(transaction: QueuedMutation, modelData?: Record<string, unknown>): Promise<void> {
    await persistQueuedTransaction(this.persistenceContext, transaction, modelData);
  }

  private persistAndStage(
    transaction: QueuedMutation,
    modelData: Record<string, unknown>,
  ): Promise<void> {
    if (!this.persistence || !this.commitOutboxScope) {
      this.stageTransaction(transaction);
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      this.pendingPersistenceStages.push({ transaction, modelData, resolve, reject });
      if (this.persistenceStageScheduled) return;
      this.persistenceStageScheduled = true;
      queueMicrotask(async () => {
        this.persistenceStageScheduled = false;
        const batch = this.pendingPersistenceStages;
        this.pendingPersistenceStages = [];
        const results = await Promise.allSettled(
          batch.map(({ transaction: queued, modelData: data }) =>
            this.persistQueuedTransaction(queued, data),
          ),
        );
        for (const [index, result] of results.entries()) {
          const item = batch[index];
          if (!item) continue;
          if (result.status === 'fulfilled') {
            this.stageTransaction(item.transaction);
            item.resolve();
          } else {
            item.reject(result.reason instanceof Error ? result.reason : new Error(String(result.reason)));
          }
        }
      });
    });
  }

  private removePersistedTransaction(transactionId: string): void {
    removePersistedTransaction(this.persistenceContext, transactionId);
  }

  private settlePersistedFailure(transaction: { id?: string; sourceMutationIds?: string[] }): void {
    settlePersistedFailure(this.persistenceContext, transaction);
  }

  private sourceMutationIdsFor(batch: readonly QueuedMutation[]): string[] {
    return [...new Set(batch.flatMap((transaction) => transaction.sourceMutationIds ?? []))];
  }

  /** Atomically seals a commit before it is allowed onto the dispatch lane. */
  private async sealDurableCommit(input: Parameters<typeof sealDurableCommit>[1]): Promise<DurableCommitEnvelope> {
    return sealDurableCommit(this.commitTransportContext, input, pendingMutationRecordId);
  }

  private async removeDurableCommit(idempotencyKey: string): Promise<void> {
    return removeDurableCommit(this.commitTransportContext, idempotencyKey);
  }

  private async persistDurableCommitAcceptance(
    envelope: DurableCommitEnvelope,
    result: MutationCommitResult,
  ): Promise<DurableCommitEnvelope> {
    return persistDurableCommitAcceptance(this.commitTransportContext, envelope, result);
  }

  private parseMutationCommitResult(
    value: Awaited<ReturnType<import('../../interfaces/index.js').MutationExecutor['commit']>>,
  ): MutationCommitResult {
    return parseMutationCommitResult(value);
  }

  private dispatchCommitBounded(
    ...args: Parameters<import('../../interfaces/index.js').MutationExecutor['commit']>
  ): ReturnType<import('../../interfaces/index.js').MutationExecutor['commit']> {
    return dispatchCommitBounded(this.commitTransportContext, ...args);
  }

  private clearReplicationLagState(transactionId: string): void {
    const timeout = this.replicationLagTimeouts.get(transactionId);
    if (timeout) clearTimeout(timeout);
    this.replicationLagTimeouts.delete(transactionId);
    this.replicationLagErrors.delete(transactionId);
  }

  /**
   * Bounds the public model-write confirmation promise without changing the
   * accepted write's lifecycle. A lag timeout is not a rejection from the
   * source database, so it must never emit `transaction:failed`, roll back
   * optimistic state, or remove the durable replay envelope.
   */
  private scheduleReplicationLagTimeout(
    transactionId: string,
    clientTxId = transactionId,
    correlationId?: string,
  ): void {
    const previous = this.replicationLagTimeouts.get(transactionId);
    if (previous) clearTimeout(previous);
    this.replicationLagErrors.delete(transactionId);

    const timeoutMs = this.config.deltaConfirmationTimeout;
    const timeout = setTimeout(() => {
      this.replicationLagTimeouts.delete(transactionId);
      const modelTx = this.store.get(transactionId);
      const commitTx = this.commitStore.get(transactionId);
      if (
        modelTx?.status !== 'awaiting_delta' &&
        commitTx?.status !== 'awaiting_delta'
      ) return;

      const error = new AbloConnectionError(
        `The source accepted commit ${clientTxId}, but its replication echo did not arrive within ${timeoutMs}ms.`,
        {
          code: 'replication_lag_timeout',
          httpStatus: 504,
          details: {
            clientTxId,
            ...(correlationId ? { correlationId } : {}),
            timeoutMs,
            accepted: true,
          },
        },
      );
      this.replicationLagErrors.set(transactionId, error);

      // Model-proxy writes expose their waiter through the resolver table.
      // Reject that promise without moving the transaction out of
      // `awaiting_delta`; the eventual echo still completes it normally.
      const resolver = this.confirmationResolvers.get(transactionId);
      if (resolver) {
        this.confirmationResolvers.delete(transactionId);
        resolver.reject(error);
      }

      this.emitCommitLifecycle('transaction:confirmation_lagged', {
        transactionId,
        error,
      });
      this.emitCommitLifecycle(`transaction:confirmation_lagged:${transactionId}`, {
        error,
      });
      if (commitTx) {
        const firstOperation = commitTx.operations[0];
        this.emitCommitLifecycle('reconciliation:needed', {
          reason: 'replication_lag_timeout',
          txId: transactionId,
          model: firstOperation?.model ?? 'commit',
          modelId: firstOperation?.id ?? transactionId,
          lastSeenSyncId: this.lastSeenSyncId,
          retryCount: 1,
        });
      }
    }, timeoutMs);
    this.replicationLagTimeouts.set(transactionId, timeout);
  }

  private takeNextExecutionBatch(): QueuedMutation[] {
    const selected = selectExecutionBatch(this.executionQueue, this.config.maxBatchSize);
    this.executionQueue = selected.remaining;
    return selected.batch;
  }

  /**
   * Resolvers for per-transaction `confirmation` promises. Populated in
   * `attachConfirmation` at staging time, consumed by the constructor-time
   * listeners on `transaction:completed` / `transaction:failed`. Kept off
   * the QueuedMutation row so the store's iteration order stays plain-data
   * and serialization-friendly.
   */
  private confirmationResolvers = new Map<
    string,
    { resolve: () => void; reject: (err: Error) => void }
  >();

  constructor(config?: Partial<MutationQueueConfig>) {
    super();
    this.runtime = config?.runtime ?? globalRuntime;
    this.position = config?.position ?? new LogPosition();
    this.localMutationPort = config?.localMutationPort ?? createLocalMutationPort(this);
    // Bind the confirmation tracker to this queue's store/ledger/events.
    // `isConnected` closes over `isConnectedFn` so `setConnectionChecker`
    // swaps stay visible to in-flight timeouts.
    this.deltaConfirmation = new DeltaConfirmationTracker({
      store: this.store,
      optimisticUpdates: this.localMutationPort.updates,
      emit: (event, payload) => {
        this.emit(event, payload);
      },
      isConnected: () => this.isConnectedFn(),
      position: this.position,
      runtime: this.runtime,
    });

        if (config) {
      this.config = { ...this.config, ...config };
    }

    // Centralized fan-in for `tx.confirmation`. Completion/failure are
    // emitted from ~10 sites (delta confirm, immediate confirm, batch
    // success, permanent error, max_retries_exhausted, …). Subscribing
    // once here keeps every emit site intact and guarantees the call-site
    // promise always settles, regardless of which path produced the
    // terminal state.
    this.on('transaction:completed', (tx: QueuedMutation) => {
      // Any successful write clears the permanent-error dedup, so a genuine
      // recurrence after recovery warns again instead of staying demoted.
      this.lastPermanentErrorSig = undefined;
      this.clearReplicationLagState(tx.id);
      const r = this.confirmationResolvers.get(tx.id);
      if (r) {
        this.confirmationResolvers.delete(tx.id);
        r.resolve();
      }
      if (tx.type === 'create') {
        this.releaseDeferredDeletesForCreate(tx);
      }
      this.removePersistedTransaction(tx.id);
    });
    this.on(
      'transaction:failed',
      ({ transaction, error }: { transaction: QueuedMutation; error: Error }) => {
        const r = this.confirmationResolvers.get(transaction.id);
        if (r) {
          this.confirmationResolvers.delete(transaction.id);
          r.reject(error);
        }
        if (transaction.type === 'create') {
          this.releaseDeferredDeletesForCreate(transaction);
        }
        this.settlePersistedFailure(transaction);
      }
    );
  }

  /**
   * Returns the in-flight confirmation promise for a given model and id. When
   * several transactions match, it returns the most recent one's promise; when
   * none is open it resolves immediately, which covers both "already confirmed"
   * and "never staged".
   *
   * It considers the three non-terminal statuses in which the write can still
   * be rolled back — `pending`, `executing`, and `awaiting_delta` — and ignores
   * `completed` (already settled) and `failed`/`rolled_back` (already
   * rejected). This complements the `confirmation` promise carried on a known
   * {@link QueuedMutation}: use this method at call sites that hold a model
   * returned by `ablo.<model>.create()` but never see the underlying
   * transaction.
   */
  confirmationFor(modelName: string, modelId: string): Promise<void> {
    const transactions = this.store.getAll();
    for (let index = transactions.length - 1; index >= 0; index--) {
      const transaction = transactions[index];
      if (
        transaction?.modelName === modelName &&
        transaction.modelId === modelId &&
        (transaction.status === 'pending' ||
          transaction.status === 'executing' ||
          transaction.status === 'awaiting_delta')
      ) {
        return transaction.confirmation ?? Promise.resolve();
      }
    }
    return Promise.resolve();
  }

  /**
   * Attaches a `confirmation` promise to a newly created transaction. Call this
   * before the transaction is staged so a caller can `await tx.confirmation`
   * immediately after a create, update, or delete returns. It is idempotent and
   * returns early if one is already attached.
   *
   * It also attaches a no-op rejection handler. Most callers never await the
   * confirmation, and without this the runtime would report an unhandled
   * rejection when a write fails. Callers that do want to observe failure simply
   * attach their own `.then`/`.catch`.
   */
  private attachConfirmation(tx: QueuedMutation): void {
    if (tx.confirmation) return;
    tx.confirmation = new Promise<void>((resolve, reject) => {
      this.confirmationResolvers.set(tx.id, { resolve, reject });
    });
    tx.confirmation.catch(() => {
      // Swallow unhandled rejections; callers that care attach their own handler.
    });
  }

  /**
   * Registers a predicate the queue uses to check whether it is connected.
   * While disconnected, confirmation timeouts re-schedule themselves instead of
   * escalating, so a transaction is never rolled back merely because the client
   * was briefly offline.
   */
  setConnectionChecker(fn: () => boolean): void {
    this.isConnectedFn = fn;
  }

  /**
   * Drives the offline-grace timer for in-flight commit-lane transactions.
   *
   * On `'disconnected'` it starts a one-shot timer of
   * `config.commitOfflineGraceMs`. If that timer fires — meaning the disconnect
   * outlasted the grace window — every commit-lane transaction still `pending`
   * or `executing` is failed with an {@link AbloConnectionError}, so
   * {@link waitForCommitReceipt} rejects within seconds instead of hanging.
   *
   * On `'connected'` it clears any pending grace timer. Brief disconnects are
   * absorbed transparently; {@link processCommitLane} and
   * {@link drainPending} resumes the work when the owner decides to drain.
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
    // Each failed commit reaches the consumer through its own rejection path,
    // so this aggregate line is forensic and logged at debug rather than warn.
    this.runtime.logger.debug(
      `[MutationQueue] WS disconnected > ${graceMs}ms; failing ${inFlight.length} in-flight commit(s) with AbloConnectionError`,
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
   * Binds the mutation executor for this queue instance. The owning client
   * calls this right after construction, so commits made here always dispatch
   * through this instance's connection even when several client instances exist
   * in the same process.
   */
  setMutationExecutor(executor: import('../../interfaces/index.js').MutationExecutor): void {
    this._mutationExecutor = executor;
  }

  // ============================================================================
  // Microtask-based transaction staging
  // ============================================================================
  //
  // Every transaction lands in the `createdTransactions` staging area first.
  // A microtask then commits them together under one batch index, so a bulk
  // operation such as importing a hundred rows is sent efficiently.
  //
  // Flow:
  // 1. create()/update()/delete() calls stageTransaction().
  // 2. stageTransaction() adds to createdTransactions and schedules a microtask.
  // 3. The microtask runs commitCreatedTransactions() once the current
  //    synchronous code finishes.
  // 4. All staged transactions share one batch index and move to the execution
  //    queue.
  // ============================================================================

  /**
   * Stages a transaction for commit. Transactions staged within the same
   * event-loop tick are committed together.
   */
  private stageTransaction(transaction: QueuedMutation): void {
    this.createdTransactions.push(transaction);
    this.scheduleCommit();
  }

  /**
   * Schedules the staged transactions to commit on a microtask, so all
   * transactions created synchronously within one tick are batched together.
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
   * Moves all staged transactions onto the execution queue, assigning them a
   * single shared batch index so they commit together.
   */
  private commitCreatedTransactions(): void {
    this.commitScheduled = false;

    if (this.createdTransactions.length === 0) return;

    // Increment batch index - all transactions in this commit share it
    this.batchIndex++;
    const currentBatchIndex = this.batchIndex;

    // Log batch commit for performance monitoring
    this.runtime.logger.debug('[MutationQueue] commitCreatedTransactions', {
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

  /**
   * Flushes every pending transaction in one commit, the fast path taken on
   * reconnect. If transport fails, the transactions retain this exact commit
   * envelope when they fall back to normal queue processing.
   */
  async drainPending(): Promise<void> {
    if (this.pendingDrainPromise) return this.pendingDrainPromise;
    const drain = this.drainPendingInternal();
    this.pendingDrainPromise = drain.finally(() => {
      this.pendingDrainPromise = null;
    });
    return this.pendingDrainPromise;
  }

  private async drainPendingInternal(): Promise<void> {
    // Explicit flushes and reconnects are merely another trigger for the one
    // model-mutation execution lane. A second sealing implementation can race
    // the scheduled lane, consume its journal sources, and later dispatch the
    // same transaction again. Move every staged row to the owned queue, then
    // drive the normal lane until the queue has handed off all current work.
    this.commitCreatedTransactions();
    await this.processCommitLane();
    while (this.executionQueue.length > 0 || this.modelProcessingPromise) {
      await this.processBatch();
    }
  }
  async create(
    model: LocalModel,
    context: UserContext,
    writeOptions?: WriteOptions,
    sourceMutationId?: string,
  ): Promise<QueuedMutation> {
    return createModel(this.modelMutationContext, model, context, writeOptions, sourceMutationId);
  }

  async update(
    model: LocalModel,
    context: UserContext,
    precomputedChanges?: Record<string, unknown>,
    writeOptions?: WriteOptions,
    sourceMutationId?: string,
  ): Promise<QueuedMutation> {
    return updateModel(this.modelMutationContext, model, context, precomputedChanges, writeOptions, sourceMutationId);
  }

  async delete(
    model: LocalModel,
    context: UserContext,
    writeOptions?: WriteOptions,
    sourceMutationId?: string,
  ): Promise<QueuedMutation> {
    return deleteModel(this.modelMutationContext, model, context, writeOptions, sourceMutationId);
  }

  async uploadAttachment(
    _file: File,
    options: { id: string; [key: string]: unknown },
    _context: UserContext // eslint-disable-line @typescript-eslint/no-unused-vars -- reserved executor context
  ): Promise<{ url: string } | null> {
    return this.mutationExecutor.uploadAttachment?.(options.id, options) ?? null;
  }

  async batchUploadAttachments(
    _files: File[],
    items: { id: string; [key: string]: unknown }[],
    _context: UserContext // eslint-disable-line @typescript-eslint/no-unused-vars -- reserved executor context
  ): Promise<{ id: string; url: string }[]> {
    return this.mutationExecutor.batchUploadAttachments?.(items.map(i => ({ id: i.id, input: i }))) ?? [];
  }

  async archive(
    model: LocalModel,
    context: UserContext,
    writeOptions?: WriteOptions,
    sourceMutationId?: string,
  ): Promise<QueuedMutation> {
    return archiveModel(this.modelMutationContext, model, context, writeOptions, sourceMutationId);
  }

  async unarchive(model: LocalModel, context: UserContext): Promise<QueuedMutation> {
    return unarchiveModel(this.modelMutationContext, model, context);
  }

  private enqueue(transaction: QueuedMutation): void {
    enqueueTransaction(this.queueCoalescingContext, transaction);
  }

  private scheduleProcessing(immediate = false): void {
    scheduleProcessingExternal(this.processingSchedulerContext, immediate);
  }

  private async processBatch(): Promise<void> {
    if (this.modelProcessingPromise) {
      await this.modelProcessingPromise;
      if (this.executionQueue.length > 0) await this.processBatch();
      return;
    }
    const processing = processBatch(this.batchProcessingContext);
    const tracked = processing.finally(() => {
      if (this.modelProcessingPromise === tracked) {
        this.modelProcessingPromise = null;
      }
    });
    this.modelProcessingPromise = tracked;
    await tracked;
  }

  private rememberDeltaCorrelation(correlationId: string, syncId: number): void {
    // Refresh insertion order when a replay repeats the same correlation id.
    this.recentDeltaCorrelations.delete(correlationId);
    this.recentDeltaCorrelations.set(correlationId, syncId);
    if (this.recentDeltaCorrelations.size <= 2_048) return;
    const oldest = this.recentDeltaCorrelations.keys().next().value;
    if (typeof oldest === 'string') this.recentDeltaCorrelations.delete(oldest);
  }

  private queuedCommitEchoSyncId(tx: CommitTransaction): number | undefined {
    return tx.correlationId
      ? this.recentDeltaCorrelations.get(tx.correlationId)
      : undefined;
  }

  private queuedCommitMatchesCorrelation(
    tx: CommitTransaction,
    correlationId: string,
  ): boolean {
    return tx.correlationId !== undefined && tx.correlationId === correlationId;
  }

  private completeQueuedCommit(tx: CommitTransaction, syncId: number): void {
    if (tx.status !== 'awaiting_delta') return;
    this.clearReplicationLagState(tx.id);
    tx.lastSyncId = syncId;
    tx.status = 'completed';
    // The queued receipt was only acceptance. The correlated source echo is
    // the first definitive success and therefore the point where the durable
    // replay envelope may be removed.
    void this.removeDurableCommit(tx.id);
    this.emitCommitLifecycle('transaction:completed', tx);
    this.emitCommitLifecycle(`transaction:completed:${tx.id}`, tx);
  }

  /**
   * Confirms awaiting writes. Hosted/anomaly receipts keep their sync-id
   * threshold semantics; queued forwards require the exact server correlation.
   */
  onDeltaReceived(
    syncId: number,
    _transactionId?: string,
    correlationId?: string,
  ): void {
    if (correlationId) this.rememberDeltaCorrelation(correlationId, syncId);
    const correlatedModelTransactions = correlationId
      ? this.store.getByStatus('awaiting_delta').filter(
          (tx) =>
            tx.requiresCorrelatedDelta === true &&
            tx.correlationId !== undefined &&
            tx.correlationId === correlationId,
        )
      : [];
    this.deltaConfirmation.onDeltaReceived(syncId, correlationId);
    if (correlatedModelTransactions.length > 0) {
      const envelopeIds = new Set<string>();
      for (const tx of correlatedModelTransactions) {
        this.clearReplicationLagState(tx.id);
        if (tx.commitEnvelope) envelopeIds.add(tx.commitEnvelope.idempotencyKey);
      }
      for (const envelopeId of envelopeIds) {
        const envelopeStillAwaiting = this.store
          .getByStatus('awaiting_delta')
          .some(
            (tx) => tx.commitEnvelope?.idempotencyKey === envelopeId,
          );
        if (!envelopeStillAwaiting) void this.removeDurableCommit(envelopeId);
      }
    }
    if (!correlationId) return;
    for (const tx of this.commitStore.values()) {
      if (tx.status !== 'awaiting_delta') continue;
      if (this.queuedCommitMatchesCorrelation(tx, correlationId)) {
        this.completeQueuedCommit(tx, syncId);
      }
    }
  }

  // Schedule the retry-and-reconciliation wait for a transaction's confirming
  // delta; see {@link DeltaConfirmationTracker} in `./deltaConfirmation.js`.
  private scheduleDeltaConfirmationTimeout(tx: QueuedMutation, timeoutMs: number): void {
    this.deltaConfirmation.scheduleDeltaConfirmationTimeout(tx, timeoutMs);
  }

  /**
   * Resolves once the given transaction is confirmed and rejects if it fails.
   * The confirming delta's timeout is handled by
   * {@link scheduleDeltaConfirmationTimeout}.
   */
  waitForConfirmation(transactionId: string): Promise<void> {
    return new Promise((resolve, reject) => {
      // Check if already completed
      const tx = this.store.get(transactionId);
      if (tx?.status === 'completed') {
        resolve();
        return;
      }
      const lagError = this.replicationLagErrors.get(transactionId);
      if (lagError) {
        reject(lagError);
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

      const onLagged = ({ error }: { error: Error }) => {
        cleanup();
        reject(error);
      };

      const cleanup = () => {
        this.off(`transaction:completed:${transactionId}`, onCompleted);
        this.off(`transaction:failed:${transactionId}`, onFailed);
        this.off(`transaction:confirmation_lagged:${transactionId}`, onLagged);
      };

      // Listen to existing events (timeout already handled by scheduleDeltaConfirmationTimeout)
      this.on(`transaction:completed:${transactionId}`, onCompleted);
      this.on(`transaction:failed:${transactionId}`, onFailed);
      this.on(`transaction:confirmation_lagged:${transactionId}`, onLagged);
    });
  }

  // Reports whether a client mutation id is known to this queue, which helps
  // identify a delta as this client's own echo.
  hasClientMutationId(id: string): boolean {
    return !!this.store.get(id) || this.commitStore.has(id);
  }

  /** Enqueues a pre-built atomic commit through the commit API coordinator. */
  async enqueueCommit(
    clientTxId: string,
    operations: CommitTransaction['operations'],
    options: { reads?: ReadDependency[] | null } = {},
  ): Promise<void> {
    return enqueueCommit(this.commitApiContext, clientTxId, operations, options);
  }

  private async processCommitLane(): Promise<void> {
    await processCommitLane(this.commitLaneContext);
  }

  waitForCommitReceipt(
    clientTxId: string,
  ): Promise<{
    lastSyncId: number;
    missingIds?: string[];
    operationResults?: CommitOperationResult[];
  }> {
    return waitForCommitReceipt(this.commitReceiptContext, clientTxId);
  }

  private isReorderPayload(data: MutationInput | undefined): boolean {
    if (!data || typeof data !== 'object') return false;
    return 'order' in data || 'orderKey' in data || 'position' in data;
  }

  private isPermanentError(error: Error): boolean {
    return classifyPermanentError(error);
  }

  private isDefinitiveRejection(error: Error): boolean {
    return classifyDefinitiveRejection(error);
  }

  private async handleFailure(transaction: QueuedMutation, error: Error): Promise<void> {
    await handleFailure(this.failureHandlingContext, transaction, error);
  }

  async handleConflict(transaction: QueuedMutation, serverData: MutationInput): Promise<void> {
    await resolveConflict(this.conflictResolutionContext, transaction, serverData);
  }

  private applyOptimisticCreate(model: LocalModel, transaction: QueuedMutation): void {
    this.localMutationPort.applyCreate(model, transaction);
  }

  private applyOptimisticUpdate(model: LocalModel, transaction: QueuedMutation): void {
    this.localMutationPort.applyUpdate(model, transaction);
  }

  private applyOptimisticDelete(model: LocalModel, transaction: QueuedMutation): void {
    this.localMutationPort.applyDelete(model, transaction);
  }

  private async rollbackOptimistic(
    transaction: QueuedMutation,
    reason?: string,
    error?: Error
  ): Promise<void> {
    await this.localMutationPort.rollback(transaction, reason, error);
  }

  private deserializeLegacyPendingMutation(row: object, fallbackMutationId?: string): QueuedMutation | null {
    return deserializeLegacyPendingMutation(this.persistenceContext, row, fallbackMutationId);
  }

  async loadPersistedTransactions(persistence: MutationPersistencePort, sealedMutationIds: ReadonlySet<string> = new Set()): Promise<void> {
    await loadPersistedTransactions(this.persistenceContext, persistence, sealedMutationIds);
  }

  async restoreDurableCommits(): Promise<Set<string>> {
    return restoreDurableCommitsExternal(this.durableCommitRestoreContext);
  }

  private deserializeTransaction(data: unknown): QueuedMutation | null {
    if (isNonReplayablePersistedRow(data)) return null;

    const transaction = deserializePersistedTransaction(data, this.runtime);
    if (!transaction) {
      const rowId =
        typeof data === 'object' && data !== null && typeof (data as { id?: unknown }).id === 'string'
          ? (data as { id: string }).id
          : undefined;
      this.runtime.logger.debug('[MutationQueue] Dropping malformed persisted transaction', {
        rowId,
      });
      this.runtime.observability.captureMutationFailure({
        context: 'deserialize-persisted-transaction',
        error: `Persisted transaction failed schema validation${rowId ? ` (id: ${rowId})` : ''}`,
      });
      return null;
    }
    return transaction;
  }

  cancelTransactionsForModel(modelId: string, transactionType?: string): QueuedMutation[] {
    const cancelledTransactions: QueuedMutation[] = [];

    const allTransactions = [
      ...this.store.getByStatus('pending'),
      ...this.store.getByStatus('executing'),
    ];

    for (const transaction of allTransactions) {
      if (transaction.modelId === modelId) {
        if (!transactionType || transaction.type === transactionType) {
          cancelledTransactions.push(transaction);
          this.store.updateStatus(transaction.id, 'rolled_back');
          // Sync caller: a rejected rollback (throwing optimistic:rollback
          // listener) must surface, not vanish — the status flip above is
          // already committed either way.
          void this.rollbackOptimistic(transaction, 'model_cancelled').catch((error: unknown) => {
            this.runtime.observability.captureMutationFailure({
              context: 'rollback-model-cancelled',
              error: error instanceof Error ? error : String(error),
            });
          });
        }
      }
    }

    return cancelledTransactions;
  }

  /**
   * Cancels pending transactions for child rows that reference a deleted parent,
   * used to cascade a parent deletion. The caller supplies the foreign-key
   * relationship; this method performs the cancellation.
   *
   * @param childModelName - The child model type (for example 'Block').
   * @param foreignKey - The foreign-key property name (for example 'sectionId').
   * @param parentId - The deleted parent's id.
   * @returns The number of transactions cancelled.
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
          void this.rollbackOptimistic(transaction, 'cascade_parent_deleted').catch(
            (error: unknown) => {
              this.runtime.observability.captureMutationFailure({
                context: 'rollback-cascade-parent-deleted',
                error: error instanceof Error ? error : String(error),
              });
            }
          );
          cancelled++;

          this.runtime.logger.debug('[MutationQueue] Cascade cancelled orphaned transaction', {
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
   * Returns the number of transactions still pending or executing.
   */
  getOutstandingTransactionCount(): number {
    return this.deferredMutations.length +
      this.store.getByStatus('pending').length +
      this.store.getByStatus('executing').length;
  }

  getOutstandingTransactions(): readonly QueuedMutation[] {
    return [
      ...this.store.getByStatus('pending'),
      ...this.store.getByStatus('executing'),
    ];
  }

  /** Generates a unique local transaction id. */
  // The payload rules live in `mutationInput`; these keep the call sites here
  // reading as the queue's own vocabulary.
  private generateId(): string {
    return generateTransactionId();
  }

  private mergeData(
    local: MutationInput | undefined,
    remote: MutationInput | undefined
  ): MutationInput {
    return mergeMutationData(local, remote);
  }

  private extractCreateData(model: LocalModel): MutationInput {
    return createDataFor(model, this.runtime);
  }

  private mapChangesToInput(modelName: string, changes: Record<string, unknown>): MutationInput {
    return changesToInput(modelName, changes, this.runtime);
  }

  private extractUpdateData(model: LocalModel): MutationInput {
    return updateDataFor(model, this.runtime);
  }

  private extractPreviousData(model: LocalModel, updateInput?: MutationInput): MutationInput {
    return previousDataFor(model, updateInput);
  }

  /** Returns a snapshot of queue counts and the current configuration. */
  getStats() {
    return {
      pending: this.store.getByStatus('pending').length,
      executing: this.store.getByStatus('executing').length,
      completed: this.store.getByStatus('completed').length,
      failed: this.store.getByStatus('failed').length,
      optimistic: this.localMutationPort.updates.size,
      totalTransactions: this.store.getAll().length,
      batchIndex: this.batchIndex,
      config: { ...this.config },
    };
  }

  /**
   * Returns detailed internal state — pending, executing, and awaiting-delta
   * transactions — to help diagnose delta-confirmation issues.
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

  /** Merges the given options into the queue's configuration. */
  setConfig(config: Partial<MutationQueueConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * Re-emits an incoming sync delta on the `sync:delta` event for the store to
   * apply. Because rows use stable ids, no id reconciliation is needed here.
   */
  handleSyncDelta(delta: { id: string; modelName: string; action: string; data: any }): boolean {
    // Row ids are stable, so no reconciliation is needed; re-emit the delta for
    // the store to apply directly.
    this.emit('sync:delta', {
      id: delta.id,
      modelName: delta.modelName,
      action: delta.action,
      data: delta.data,
    });

    return true;
  }

  /**
   * Releases the queue's resources: rolls back outstanding optimistic updates,
   * clears all timers and stored transactions, and removes event listeners.
   */
  dispose(): void {
    // Cancel all active optimistic updates
    for (const [, optimistic] of this.localMutationPort.updates) {
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

    // Clear every armed delta-confirmation timer (one per in-flight tx,
    // 30–120s each) — a disposed queue must not keep the process alive or
    // fire confirmation callbacks against the cleared store below.
    this.deltaConfirmation.dispose();
    for (const timeout of this.replicationLagTimeouts.values()) {
      clearTimeout(timeout);
    }
    this.replicationLagTimeouts.clear();
    this.replicationLagErrors.clear();

    // Clear the offline-grace timer armed by setConnectionState('disconnected').
    if (this.commitOfflineGraceTimer !== null) {
      clearTimeout(this.commitOfflineGraceTimer);
      this.commitOfflineGraceTimer = null;
    }
    if (this.commitRetryTimer !== null) {
      clearTimeout(this.commitRetryTimer);
      this.commitRetryTimer = null;
    }

    // Clear store
    this.store.clear();
    this.localMutationPort.updates.clear();
    this.executionQueue = [];
    this.createdTransactions = [];
    this.deferredDeletesByCreate.clear();
    this.recentDeltaCorrelations.clear();
    this.commitLane = [];
    this.commitStore.clear();
    this.commitMissingIds.clear();

    // Clear event listeners
    this.removeAllListeners();

    // Reset state
    this.isProcessing = false;
    this.batchIndex = 0;
  }
}
