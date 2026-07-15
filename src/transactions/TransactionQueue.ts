/**
 * TransactionQueue manages the lifecycle of local writes on their way to the
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
import type { Database } from '../Database.js';
import { Model } from '../Model.js';
import { getContext } from '../context.js';
import type { MutationOperationType } from '../types/index.js';
import {
  AbloError,
  AbloConnectionError,
  AbloIdempotencyError,
  AbloNotFoundError,
  AbloValidationError,
  errorCodeSpec,
} from '../errors.js';
import { SyncPosition } from '../sync/syncPosition.js';
import type { WriteOptions } from '../interfaces/index.js';
import type { StaleNotification, ReadDependency } from '../coordination/schema.js';
import {
  mutationCommitResultSchema,
  type MutationCommitResult,
} from '../wire/commit.js';
import {
  projectCommitPayload,
  computePriorityScore,
  normalizeModelKey,
  // Includes stale guards as well as request identity/audit barriers.
  hasCommitCoalescingBarrier,
  applyWriteOptions,
  asTransportError,
  extractStatusCode,
  TX_TYPE_TO_MUTATION_OP,
  type MutationInput,
  type Transaction,
  type UserContext,
  type WriteOperationFields,
} from './commitPayload.js';
import { TransactionStore } from './TransactionStore.js';
import {
  entityKey,
  mergeUpdateData,
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
  createCommitEnvelopeMember,
  createDurableCommitEnvelope,
  commitEnvelopeRecordId,
  durableCommitEnvelopeSchema,
  type DurableCommitEnvelope,
  type DurableCommitOperation,
  type DurableCommitOperationInput,
  type CommitOutboxScope,
} from './commitEnvelope.js';
import type { DurableWriteStore } from './durableWriteStore.js';
import { stableStringify } from '../utils/json.js';
import {
  applyOptimisticCreate,
  applyOptimisticUpdate,
  applyOptimisticDelete,
  rollbackOptimistic,
  type OptimisticUpdateEntry,
} from './optimisticApply.js';

// The queue is split across sibling modules (`commitPayload`,
// `TransactionStore`, `coalesceRules`, `deltaConfirmation`, `optimistic`).
// Re-export the shared public types here so importers can continue to reach
// them through this module.
export type { Transaction, UserContext } from './commitPayload.js';

/**
 * A pre-built, multi-operation commit submitted through
 * `ablo.commits.create()`. Unlike the per-model {@link Transaction} (see
 * `./commitPayload.js`), the caller supplies the operations and the whole
 * envelope commits atomically: the queue does not coalesce it, reorder its
 * operations for foreign keys, or apply it optimistically. It runs through the
 * same `mutationExecutor.commit()` as the model batch path, so its
 * retry-on-reconnect behaviour is identical.
 */
interface CommitTransaction {
  id: string;
  kind: 'commit';
  operations: {
    type: DurableCommitOperation['type'];
    model: string;
    id: string;
    input?: Record<string, unknown>;
    transactionId?: string;
    readAt?: number | null;
    onStale?: 'reject' | 'overwrite' | 'notify' | null;
  }[];
  causedByTaskId?: string | null;
  /** Read dependencies for the whole batch, forwarded to the executor so the server can detect stale-context writes. */
  reads?: ReadDependency[] | null;
  status: 'pending' | 'executing' | 'awaiting_delta' | 'completed' | 'failed';
  createdAt: number;
  attempts: number;
  lastSyncId?: number;
  /** Opaque customer-side batch ledger key returned by a queued receipt. */
  correlationId?: string;
  error?: Error;
  sealedAt: number;
  sequence: number;
  sealPromise?: Promise<void>;
  durableEnvelope?: DurableCommitEnvelope;
  /** Journal entries atomically consumed when this request was sealed. */
  sourceMutationIds?: string[];
}

interface ConflictResolution {
  strategy: 'last-write-wins' | 'merge' | 'reject' | 'custom';
  resolver?: (local: MutationInput | undefined, remote: MutationInput) => MutationInput;
}

interface TransactionQueueConfig {
  /** Shared client position (see sync/syncPosition.ts). One per client. */
  position?: SyncPosition;
  maxBatchSize: number;
  batchDelay: number;
  maxRetries: number;
  conflictResolution: ConflictResolution;
  enablePersistence: boolean;
  enableOptimistic: boolean;
  // Backpressure control: caps how many transactions execute at once so the
  // server is not overwhelmed.
  maxExecutingTransactions: number;
  // How long to wait, in milliseconds, for a change's confirming sync delta
  // before the retry-and-reconciliation cycle begins. For a source-forwarded
  // write this is also the public `wait: 'confirmed'` deadline: expiry rejects
  // the waiter with `replication_lag_timeout` while the accepted write remains
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
}

export class TransactionQueue extends EventEmitter {
  // Keep one hour of clock/network margin inside the server's 24-hour ledger.
  private static readonly DURABLE_REPLAY_WINDOW_MS = 23 * 60 * 60 * 1000;
  private store = new TransactionStore();
  // Signature of the last permanent-error we logged at `warn`. A `create`
  // whose id already exists (`unique_violation`) is a permanent rejection
  // that the offline queue re-drives on every reconnect/bootstrap — without
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
  private _mutationExecutor: import('../interfaces/index.js').MutationExecutor | null = null;
  private get mutationExecutor() {
    return this._mutationExecutor ?? getContext().mutationExecutor;
  }

  private executionQueue: Transaction[] = [];
  private isProcessing = false;
  private processTimer?: NodeJS.Timeout;
  private processScheduled = false;

  // Staging area for transactions created in the same event-loop tick. Each one
  // lands here first, then a microtask commits them together.
  private createdTransactions: Transaction[] = [];
  private commitScheduled = false;

  // Per-model in-flight tracking and merge buffer
  private inFlightByModel = new Set<string>();
  private pendingMergeByModel = new Map<
    string,
    { data: MutationInput; sourceMutationIds: string[] }
  >();
  private deferredDeletesByCreate = new Map<string, Transaction[]>();

  // Commit lane: pre-built atomic multi-op envelopes from `ablo.commits.create()`.
  // Drained serially (one envelope at a time) since each is atomic; no
  // coalescing with model-proxy transactions.
  private commitLane: CommitTransaction[] = [];
  private commitStore = new Map<string, CommitTransaction>();
  /**
   * Small race buffer for authoritative echoes that arrive before the queued
   * mutation receipt. The forward and WAL stream are independent channels, so
   * either can win without changing the settlement result.
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
  private lastCommitSequence = 0;
  private durableReplayBlock: AbloIdempotencyError | null = null;
  /** Browser-backed strict outbox; absent for standalone/in-memory consumers. */
  private commitOutbox: DurableWriteStore | null = null;
  private commitOutboxScope: CommitOutboxScope | null = null;

  private nextCommitSequence(): number {
    const wallSequence = Date.now() * 1_000;
    this.lastCommitSequence = Math.max(wallSequence, this.lastCommitSequence + 1);
    return this.lastCommitSequence;
  }

  private emitCommitLifecycle(event: string, payload: unknown): void {
    try {
      this.emit(event, payload);
    } catch (error) {
      getContext().observability.captureTransactionFailure({
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
      TransactionQueue.DURABLE_REPLAY_WINDOW_MS
    ) {
      this.durableReplayBlock = new AbloIdempotencyError(
        'A pending commit is older than the server idempotency window; newer writes are blocked until it is reviewed.',
        { code: 'idempotency_conflict' },
      );
      throw this.durableReplayBlock;
    }
  }

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

  private entityKey(modelName: string, modelId: string): string {
    return entityKey(modelName, modelId);
  }

  /** Collision-safe receipt target identity across models sharing a row id. */
  private receiptTargetKey(modelName: string, modelId: string): string {
    return stableStringify([normalizeModelKey(modelName), modelId]);
  }

  /**
   * Relates stale notifications back to write targets without assuming the
   * server's canonical model name uses the same spelling as the public schema
   * key (`Task` versus `tasks`). Exact `(model,id)` wins; a globally unique id
   * is the compatibility fallback. An ambiguous same-id cross-model mismatch
   * is deliberately left unclassified, so it cannot falsely settle a queued
   * write. A notification with no write-target id (or an explicit group) is a
   * declared-read conflict and holds the whole batch.
   */
  private classifyReceiptNotifications(
    operations: readonly { model: string; id: string }[],
    notifications: readonly StaleNotification[],
  ): {
    holdsEntireBatch: boolean;
    heldTargets: Set<string>;
    notificationsByTarget: Map<string, StaleNotification[]>;
  } {
    const targets = operations.map((operation) => ({
      id: operation.id,
      key: this.receiptTargetKey(operation.model, operation.id),
    }));
    const heldTargets = new Set<string>();
    const notificationsByTarget = new Map<string, StaleNotification[]>();
    let holdsEntireBatch = false;

    for (const notification of notifications) {
      const candidates = targets.filter((target) => target.id === notification.id);
      const notificationKey = this.receiptTargetKey(
        notification.model,
        notification.id,
      );
      const exactTargets = candidates.filter(
        (target) => target.key === notificationKey,
      );
      const candidateKeys = new Set(
        (exactTargets.length > 0 ? exactTargets : candidates).map(
          (target) => target.key,
        ),
      );

      if (notification.group || candidates.length === 0) {
        holdsEntireBatch = true;
        continue;
      }
      if (candidateKeys.size !== 1) {
        // Same id across multiple differently named models with no exact match:
        // the id-only compatibility fallback is ambiguous. Await the echo.
        continue;
      }
      const [targetKey] = candidateKeys;
      if (!targetKey) continue;
      heldTargets.add(targetKey);
      const targetNotifications = notificationsByTarget.get(targetKey) ?? [];
      targetNotifications.push(notification);
      notificationsByTarget.set(targetKey, targetNotifications);
    }

    return { holdsEntireBatch, heldTargets, notificationsByTarget };
  }

  private resolveConfirmation(transaction: Transaction): void {
    const resolver = this.confirmationResolvers.get(transaction.id);
    if (!resolver) return;
    this.confirmationResolvers.delete(transaction.id);
    resolver.resolve();
  }

  private takeUnsentCreateForModel(modelName: string, modelId: string): Transaction | undefined {
    return takeUnsentCreateForModel(
      this.createdTransactions,
      this.executionQueue,
      this.store,
      modelName,
      modelId,
    );
  }

  private async cancelUnsentCreateForDelete(transaction: Transaction): Promise<void> {
    this.store.updateStatus(transaction.id, 'rolled_back');
    if (this.config.enableOptimistic) {
      await this.rollbackOptimistic(transaction, 'model_cancelled');
    }
    this.resolveConfirmation(transaction);
  }

  private findCreateBarrierForDelete(modelName: string, modelId: string): Transaction | undefined {
    return findCreateBarrierForDelete(this.store, modelName, modelId);
  }

  private completeLocalDelete(
    model: Model,
    context: UserContext,
    writeOptions: WriteOptions | undefined,
    sourceMutationIds: readonly string[] = [],
  ): Transaction {
    const actualModelName = model.getModelName();
    const modelKey = normalizeModelKey(actualModelName);
    const transaction: Transaction = {
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
    this.optimisticUpdates.delete(transaction.id);
    return transaction;
  }

  private deferDeleteUntilCreateSettles(createTransaction: Transaction, deleteTransaction: Transaction): void {
    deferDeleteUntilCreateSettles(this.deferredDeletesByCreate, createTransaction, deleteTransaction);
  }

  private releaseDeferredDeletesForCreate(createTransaction: Transaction): void {
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
  private config: TransactionQueueConfig = {
    maxBatchSize: 50, // send up to this many operations per commit
    batchDelay: 150, // milliseconds to wait for more operations before sending
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

  // Optimistic update tracking. The entry shape and apply/rollback rules live
  // in `./optimisticApply.js`; the map itself stays on the queue because the
  // completion paths, `getStats`, and `dispose` all read it.
  private optimisticUpdates = new Map<string, OptimisticUpdateEntry>();

  // Stale-context notifications, keyed by transaction id. When the server
  // accepts a commit but reports that an operation's read premise had moved,
  // the notification lands here from the commit acknowledgement and is drained
  // by `waitForCommitReceipt`, so the receipt can carry it back to the caller.
  private commitNotifications = new Map<string, StaleNotification[]>();
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
   * `readFloor`. See `../sync/syncPosition.js` for the full contract.
   */
  readonly position: SyncPosition;

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
  private ensureCommitEnvelope(batch: Transaction[]): string {
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

  setCommitOutboxScope(scope: CommitOutboxScope): void {
    this.commitOutboxScope = scope;
  }

  private sourceMutationIdsFor(batch: readonly Transaction[]): string[] {
    return [...new Set(batch.flatMap((transaction) => transaction.sourceMutationIds ?? []))];
  }

  /**
   * Atomically replaces staged mutation journal rows with one exact request.
   * The returned operations are the JSON-normalized values that must be sent;
   * callers never send a separately reconstructed payload after sealing.
   */
  private async sealDurableCommit(input: {
    idempotencyKey: string;
    origin: 'model_batch' | 'atomic_commit';
    operations: readonly DurableCommitOperationInput[];
    sourceMutationIds?: readonly string[];
    commitOptions?: {
      causedByTaskId?: string | null;
      reads?: readonly ReadDependency[] | null;
    };
    createdAt: number;
    sealedAt: number;
    sequence?: number;
  }): Promise<DurableCommitEnvelope> {
    const sourceMutationIds = [...new Set(input.sourceMutationIds ?? [])];
    const envelope = createDurableCommitEnvelope({
      idempotencyKey: input.idempotencyKey,
      origin: input.origin,
      operations: [...input.operations],
      sourceMutationIds,
      commitOptions: {
        ...(input.commitOptions?.causedByTaskId !== undefined
          ? { causedByTaskId: input.commitOptions.causedByTaskId }
          : {}),
        ...(input.commitOptions?.reads !== undefined
          ? {
              reads:
                input.commitOptions.reads === null
                  ? null
                  : [...input.commitOptions.reads],
            }
          : {}),
      },
      ...(this.commitOutboxScope ? { scope: this.commitOutboxScope } : {}),
      createdAt: input.createdAt,
      sealedAt: input.sealedAt,
      sequence: input.sequence ?? input.sealedAt * 1_000,
    });

    if (this.config.enablePersistence && this.commitOutbox) {
      try {
        await this.commitOutbox.seal(
          envelope,
          sourceMutationIds.map(pendingMutationRecordId),
        );
      } catch (cause) {
        if (cause instanceof AbloError) throw cause;
        throw new AbloConnectionError('Could not persist the durable write before dispatch', {
          code: 'db_not_opened',
          cause,
        });
      }
      this.emitCommitLifecycle('commit:envelope_persisted', {
        idempotencyKey: envelope.idempotencyKey,
        sourceMutationIds: envelope.sourceMutationIds,
      });
    }

    return envelope;
  }

  /** Best-effort cleanup after a definitive rejection, confirmed ack, or echo. */
  private async removeDurableCommit(idempotencyKey: string): Promise<void> {
    if (!this.config.enablePersistence || !this.commitOutbox) return;
    try {
      await this.commitOutbox.remove(commitEnvelopeRecordId(idempotencyKey));
    } catch (error) {
      getContext().logger.debug('[TransactionQueue] Durable-write cleanup deferred', {
        idempotencyKey,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Upgrade a sealed request with permanent connected-source acceptance before
   * exposing the queued receipt. This is not completion: the envelope remains
   * until the matching WAL correlation arrives. The upgrade only makes a
   * crash/restart safe after the hosted 24-hour replay window has elapsed.
   */
  private async persistDurableCommitAcceptance(
    envelope: DurableCommitEnvelope,
    result: MutationCommitResult,
  ): Promise<DurableCommitEnvelope> {
    if (result.status !== 'queued') return envelope;
    const correlationId = result.correlationId;
    if (!correlationId) {
      throw new AbloConnectionError(
        'The source accepted the commit without durable correlation evidence.',
        { code: 'commit_no_result' },
      );
    }
    if (
      envelope.correlationId !== undefined &&
      envelope.correlationId !== correlationId
    ) {
      throw new AbloIdempotencyError(
        'The same commit replay returned a different source correlation.',
        { code: 'idempotency_conflict' },
      );
    }
    if (envelope.acceptedAt !== undefined) return envelope;

    const accepted = durableCommitEnvelopeSchema.parse({
      ...envelope,
      acceptedAt: Math.max(Date.now(), envelope.sealedAt),
      correlationId,
    });
    if (this.config.enablePersistence && this.commitOutbox) {
      try {
        await this.commitOutbox.seal(accepted, []);
      } catch (cause) {
        if (cause instanceof AbloError) throw cause;
        throw new AbloConnectionError(
          'The source accepted the commit, but that acceptance could not be persisted locally.',
          { code: 'db_not_opened', cause },
        );
      }
    }
    return accepted;
  }

  /** Parse an untrusted/custom executor receipt without making ambiguity fatal. */
  private parseMutationCommitResult(value: unknown): MutationCommitResult {
    const parsed = mutationCommitResultSchema.safeParse(value);
    if (parsed.success) return parsed.data;
    throw new AbloConnectionError(
      'The mutation transport returned an invalid commit receipt; its outcome remains pending and is safe to retry.',
      { code: 'commit_no_result', cause: parsed.error },
    );
  }

  private clearReplicationLagState(transactionId: string): void {
    const timeout = this.replicationLagTimeouts.get(transactionId);
    if (timeout) clearTimeout(timeout);
    this.replicationLagTimeouts.delete(transactionId);
    this.replicationLagErrors.delete(transactionId);
  }

  /**
   * Bounds the public `wait: 'confirmed'` promise without changing the
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

  /**
   * Takes either one complete retry envelope or a fresh batch. A retry waits
   * until every original member has re-entered the queue, preventing an
   * ambiguous A+B commit from being replayed later as A and B separately.
   */
  private takeNextExecutionBatch(): Transaction[] {
    const retryGroups = new Map<string, Map<string, Transaction>>();
    for (const tx of this.executionQueue) {
      const envelope = tx.commitEnvelope;
      if (!envelope) continue;
      const group =
        retryGroups.get(envelope.idempotencyKey) ??
        new Map<string, Transaction>();
      group.set(tx.id, tx);
      retryGroups.set(envelope.idempotencyKey, group);
    }

    for (const [idempotencyKey, byId] of retryGroups) {
      const members = [...byId.values()];
      const expectedCount = members[0]?.commitEnvelope?.operationCount;
      if (expectedCount === undefined || members.length !== expectedCount) continue;

      this.executionQueue = this.executionQueue.filter(
        (tx) => tx.commitEnvelope?.idempotencyKey !== idempotencyKey,
      );
      members.sort(
        (a, b) =>
          (a.commitEnvelope?.operationIndex ?? 0) -
          (b.commitEnvelope?.operationIndex ?? 0),
      );
      return members;
    }

    const fresh = this.executionQueue.filter((tx) => !tx.commitEnvelope);
    const firstFresh = fresh[0];
    if (!firstFresh) return [];

    // A caller-supplied key describes exactly one public mutation call. Keep
    // that transaction out of an SDK-created aggregate batch so the key maps
    // to the request its caller intended.
    const explicitIndex = fresh.findIndex(
      (tx) => typeof tx.writeOptions?.idempotencyKey === 'string',
    );
    const selected =
      explicitIndex === 0
        ? [firstFresh]
        : fresh.slice(
            0,
            Math.min(
              this.config.maxBatchSize,
              explicitIndex > 0 ? explicitIndex : fresh.length,
            ),
          );
    const selectedIds = new Set(selected.map((tx) => tx.id));
    this.executionQueue = this.executionQueue.filter(
      (tx) => !selectedIds.has(tx.id),
    );
    return selected;
  }

  /**
   * Selects one reconnect batch without changing the request identity of work
   * that was already attempted. Explicit caller keys remain one-call batches;
   * an existing envelope is replayed only with all of its original members.
   */
  private takeOfflineFlushBatch(pending: Transaction[]): Transaction[] {
    const first = pending[0];
    if (!first) return [];

    const envelope = first.commitEnvelope;
    if (envelope) {
      return pending.filter(
        (tx) => tx.commitEnvelope?.idempotencyKey === envelope.idempotencyKey,
      );
    }

    if (typeof first.writeOptions?.idempotencyKey === 'string') {
      return [first];
    }

    const boundary = pending.findIndex(
      (tx) =>
        tx.commitEnvelope !== undefined ||
        typeof tx.writeOptions?.idempotencyKey === 'string',
    );
    return pending.slice(
      0,
      Math.min(
        this.config.maxBatchSize,
        boundary > 0 ? boundary : pending.length,
      ),
    );
  }

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
    this.position = config?.position ?? new SyncPosition();
    // Bind the confirmation tracker to this queue's store/ledger/events.
    // `isConnected` closes over `isConnectedFn` so `setConnectionChecker`
    // swaps stay visible to in-flight timeouts.
    this.deltaConfirmation = new DeltaConfirmationTracker({
      store: this.store,
      optimisticUpdates: this.optimisticUpdates,
      emit: (event, payload) => {
        this.emit(event, payload);
      },
      isConnected: () => this.isConnectedFn(),
      position: this.position,
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
    this.on('transaction:completed', (tx: Transaction) => {
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
    });
    this.on(
      'transaction:failed',
      ({ transaction, error }: { transaction: Transaction; error: Error }) => {
        const r = this.confirmationResolvers.get(transaction.id);
        if (r) {
          this.confirmationResolvers.delete(transaction.id);
          r.reject(error);
        }
        if (transaction.type === 'create') {
          this.releaseDeferredDeletesForCreate(transaction);
        }
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
   * {@link Transaction}: use this method at call sites that hold a model
   * returned by `ablo.<model>.create()` but never see the underlying
   * transaction.
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
    if (!latest) return Promise.resolve();
    return latest.confirmation ?? Promise.resolve();
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
  private attachConfirmation(tx: Transaction): void {
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
   * {@link flushOfflineQueue} resume the work on reconnect.
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
    getContext().logger.debug(
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
   * Binds the mutation executor for this queue instance. The owning client
   * calls this right after construction, so commits made here always dispatch
   * through this instance's connection even when several client instances exist
   * in the same process.
   */
  setMutationExecutor(executor: import('../interfaces/index.js').MutationExecutor): void {
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
  private stageTransaction(transaction: Transaction): void {
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

  /**
   * Flushes every pending transaction in one commit, the fast path taken on
   * reconnect. If transport fails, the transactions retain this exact commit
   * envelope when they fall back to normal queue processing.
   */
  async flushOfflineQueue(): Promise<void> {
    this.assertDurableReplayOpen();
    // Kick the commit lane too: atomic envelopes from `commits.create()` may
    // have been left at the head of the lane while the connection was down.
    // Fire-and-forget; processCommitLane serializes itself.
    void this.processCommitLane();

    // Collect pending transactions in created order
    const pending = this.store.getByStatus('pending').sort((a, b) => a.createdAt - b.createdAt);
    if (pending.length === 0) return;
    const pendingIds = new Set(pending.map((tx) => tx.id));
    // These rows may already be waiting behind the normal batch timer. The
    // reconnect fast path takes ownership of them for this attempt so the same
    // transaction cannot dispatch concurrently through both paths.
    this.executionQueue = this.executionQueue.filter(
      (tx) => !pendingIds.has(tx.id),
    );

    const remaining = [...pending];
    while (remaining.length > 0) {
      const batch = this.takeOfflineFlushBatch(remaining);
      if (batch.length === 0) break;
      const batchIds = new Set(batch.map((tx) => tx.id));
      const nextRemaining = remaining.filter((tx) => !batchIds.has(tx.id));

      try {
        const idempotencyKey = this.ensureCommitEnvelope(batch);
        const projectedOperations = batch.map((tx) => {
          this.ensureDerivedFields(tx);
          return applyWriteOptions(
            {
              type: TX_TYPE_TO_MUTATION_OP[tx.type],
              model: tx.modelKey,
              id: tx.modelId,
              input: tx.type === 'create' || tx.type === 'update' ? tx.data || {} : undefined,
              transactionId: tx.id,
            },
            tx,
          );
        });
        const durableEnvelope = await this.sealDurableCommit({
          idempotencyKey,
          origin: 'model_batch',
          operations: projectedOperations,
          sourceMutationIds: this.sourceMutationIdsFor(batch),
          createdAt: Math.min(...batch.map((transaction) => transaction.createdAt)),
          sealedAt: batch[0]?.commitEnvelope?.sealedAt ?? Date.now(),
          sequence: batch[0]?.commitEnvelope?.sequence,
        });
        this.assertEnvelopeInsideReplayWindow(durableEnvelope);
        const result = this.parseMutationCommitResult(
          await this.mutationExecutor.commit(durableEnvelope.operations, {
            idempotencyKey,
          }),
        );
        await this.persistDurableCommitAcceptance(durableEnvelope, result);
        if (result.status === 'queued') {
          // Reconnect flushes use the same accepted-vs-confirmed contract as
          // the normal lane. A queued source receipt retains the envelope and
          // waits for exact correlation; it is never promoted by the reconnect
          // shortcut itself.
          for (const tx of batch) {
            tx.requiresCorrelatedDelta = true;
            tx.syncIdNeededForCompletion = undefined;
            tx.correlationId = result.correlationId;
            const echoSyncId = result.correlationId
              ? this.recentDeltaCorrelations.get(result.correlationId)
              : undefined;
            if (echoSyncId !== undefined) {
              this.store.updateStatus(tx.id, 'completed');
              this.emit('transaction:completed', tx);
              this.emit(`transaction:completed:${tx.id}`, tx);
              this.optimisticUpdates.delete(tx.id);
              continue;
            }
            this.store.updateStatus(tx.id, 'awaiting_delta');
            this.scheduleReplicationLagTimeout(
              tx.id,
              idempotencyKey,
              result.correlationId,
            );
            this.scheduleDeltaConfirmationTimeout(
              tx,
              this.config.deltaConfirmationTimeout,
            );
          }
          if (batch.every((tx) => tx.status === 'completed')) {
            await this.removeDurableCommit(idempotencyKey);
          }
        } else {
          await this.removeDurableCommit(idempotencyKey);
          // Mark this request envelope as completed before moving to the next.
          for (const tx of batch) {
            this.store.updateStatus(tx.id, 'completed');
            this.emit('transaction:completed', tx);
            this.emit(`transaction:completed:${tx.id}`, tx);
            this.optimisticUpdates.delete(tx.id);
          }
        }
        getContext().logger.debug('txn:commit', 0, {
          count: batch.length,
          lastSyncId: result.lastSyncId,
        });
        remaining.splice(0, remaining.length, ...nextRemaining);
      } catch (err) {
        // If one request fails, hand it and every later request back to the
        // normal lane. Their envelopes stay attached for safe retry.
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

        for (const tx of [...batch, ...nextRemaining]) {
          this.enqueue(tx);
        }
        return;
      }
    }
  }

  /**
   * Records a create and applies it optimistically, then stages it for the next
   * batched commit. Returns the {@link Transaction}, whose `confirmation`
   * promise settles once the server confirms the write.
   */
  async create(
    model: Model,
    context: UserContext,
    writeOptions?: WriteOptions,
    sourceMutationId?: string,
  ): Promise<Transaction> {
    this.assertDurableReplayOpen();
    const actualModelName = model.getModelName();

    const transaction: Transaction = {
      id: this.generateId(),
      type: 'create',
      modelName: actualModelName,
      modelId: model.id,
      modelKey: normalizeModelKey(actualModelName),
      priorityScore: this.computePriorityScore('create', actualModelName),
      data: this.extractCreateData(model),
      // Rolling back a create removes the row, so there is no prior state to
      // restore and no snapshot is captured here.
      previousData: null,
      context,
      status: 'pending',
      createdAt: Date.now(),
      attempts: 0,
      priority: 'normal',
      writeOptions,
      ...(sourceMutationId ? { sourceMutationIds: [sourceMutationId] } : {}),
    };

    this.attachConfirmation(transaction);
    this.store.add(transaction);

    if (this.config.enableOptimistic) {
      this.applyOptimisticCreate(model, transaction);
    }

    // The microtask coalescer (`scheduleCommit`) collapses all creates in this
    // tick into one commit under a single `batchIndex` — see
    // `commitCreatedTransactions`. No batch call is needed at the call site.
    this.stageTransaction(transaction);
    this.emit('transaction:created', transaction);
    return transaction;
  }

  /**
   * Records an update and applies it optimistically, then stages it for the next
   * batched commit. Rapid updates to the same entity coalesce into a single wire
   * operation.
   * @param precomputedChanges - Optional pre-captured changes, used instead of re-reading them from the model.
   */
  async update(
    model: Model,
    context: UserContext,
    precomputedChanges?: Record<string, unknown>,
    writeOptions?: WriteOptions,
    sourceMutationId?: string,
  ): Promise<Transaction> {
    this.assertDurableReplayOpen();
    const actualModelName = model.getModelName();

    // Use pre-computed changes if provided, otherwise extract from model
    const updateInput = precomputedChanges
      ? this.mapChangesToInput(actualModelName, precomputedChanges)
      : this.extractUpdateData(model);
    const previousData = this.extractPreviousData(model, updateInput);
    // Advance the per-field baseline for the keys just frozen into this
    // transaction. The model records the first old value per field and clears it
    // only on sync acknowledgement, so a second update to the same field before
    // the first is acknowledged would otherwise re-capture the original value
    // instead of this update's result, corrupting the recorded undo inverse. The
    // wire payload is already frozen in `transaction.data`, so dropping the
    // consumed entries is safe.
    model.consumeModifiedFields(Object.keys(updateInput));
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
      ...(sourceMutationId ? { sourceMutationIds: [sourceMutationId] } : {}),
    };

    this.attachConfirmation(transaction);
    this.store.add(transaction);

    // Apply optimistic update
    if (this.config.enableOptimistic) {
      this.applyOptimisticUpdate(model, transaction);
    }

    // Stage the transaction for the microtask commit; updates made in the same
    // tick are batched together, and enqueue() still coalesces same-entity
    // updates.
    this.stageTransaction(transaction);

    this.emit('transaction:created', transaction);
    return transaction;
  }

  /**
   * Records a delete and applies it optimistically. If the row's own create has
   * not yet been sent, both are cancelled locally rather than sending a create
   * followed by a delete; if the create is already in flight, the delete waits
   * until it settles so the server never sees a delete before the create.
   */
  async delete(
    model: Model,
    context: UserContext,
    writeOptions?: WriteOptions,
    sourceMutationId?: string,
  ): Promise<Transaction> {
    this.assertDurableReplayOpen();
    // Use getModelName() rather than constructor.name, which is unreliable once
    // class names are minified.
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
        ...(sourceMutationId ? { sourceMutationIds: [sourceMutationId] } : {}),
        localOnly: true,
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

    const unsentCreate = this.takeUnsentCreateForModel(actualModelName, model.id);
    if (unsentCreate) {
      await this.cancelUnsentCreateForDelete(unsentCreate);
      return this.completeLocalDelete(model, context, writeOptions, [
        ...(unsentCreate.sourceMutationIds ?? []),
        ...(sourceMutationId ? [sourceMutationId] : []),
      ]);
    }

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
      ...(sourceMutationId ? { sourceMutationIds: [sourceMutationId] } : {}),
    };

    this.attachConfirmation(transaction);
    this.store.add(transaction);

    // Cancel any pending/in-flight updates for this model to prevent "no rows" errors
    // when the delete executes before the update (race condition fix)
    const canceledUpdates = this.cancelTransactionsForModel(model.id, 'update');
    const entityKey = this.entityKey(actualModelName, model.id);
    const pendingMerge = this.pendingMergeByModel.get(entityKey);
    transaction.sourceMutationIds = [
      ...new Set([
        ...(transaction.sourceMutationIds ?? []),
        ...canceledUpdates.flatMap((candidate) => candidate.sourceMutationIds ?? []),
        ...(pendingMerge?.sourceMutationIds ?? []),
      ]),
    ];
    this.pendingMergeByModel.delete(entityKey);
    this.inFlightByModel.delete(entityKey);

    // Apply optimistic delete
    if (this.config.enableOptimistic) {
      this.applyOptimisticDelete(model, transaction);
    }

    const createBarrier = this.findCreateBarrierForDelete(actualModelName, model.id);
    if (createBarrier) {
      this.deferDeleteUntilCreateSettles(createBarrier, transaction);
    } else {
      // Stage the transaction for the microtask commit; deletes in the same
      // tick are batched together.
      this.stageTransaction(transaction);
    }

    this.emit('transaction:created', transaction);
    return transaction;
  }

  /**
   * Uploads a single attachment, delegating to the mutation executor.
   */
  async uploadAttachment(
    _file: File,
    options: { id: string; [key: string]: unknown },
    _context: UserContext // eslint-disable-line @typescript-eslint/no-unused-vars -- reserved executor context
  ): Promise<{ url: string } | null> {
    return this.mutationExecutor.uploadAttachment?.(options.id, options) ?? null;
  }

  /**
   * Uploads several attachments in one call, delegating to the mutation executor.
   */
  async batchUploadAttachments(
    _files: File[],
    items: { id: string; [key: string]: unknown }[],
    _context: UserContext // eslint-disable-line @typescript-eslint/no-unused-vars -- reserved executor context
  ): Promise<{ id: string; url: string }[]> {
    return this.mutationExecutor.batchUploadAttachments?.(items.map(i => ({ id: i.id, input: i }))) ?? [];
  }

  /**
   * Records an archive and applies it optimistically, then stages it for the
   * next batched commit.
   */
  async archive(
    model: Model,
    context: UserContext,
    writeOptions?: WriteOptions,
    sourceMutationId?: string,
  ): Promise<Transaction> {
    this.assertDurableReplayOpen();
    // Use getModelName() rather than constructor.name, which is unreliable once
    // class names are minified.
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
      ...(sourceMutationId ? { sourceMutationIds: [sourceMutationId] } : {}),
    };

    this.attachConfirmation(transaction);
    this.store.add(transaction);

    // Stage the transaction for the microtask commit.
    this.stageTransaction(transaction);

    this.emit('transaction:created', transaction);
    return transaction;
  }

  /**
   * Records an unarchive and applies it optimistically, then stages it for the
   * next batched commit.
   */
  async unarchive(model: Model, context: UserContext): Promise<Transaction> {
    this.assertDurableReplayOpen();
    // Use getModelName() rather than constructor.name, which is unreliable once
    // class names are minified.
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

    // Stage the transaction for the microtask commit.
    this.stageTransaction(transaction);

    this.emit('transaction:created', transaction);
    return transaction;
  }

  /**
   * Places a transaction on the execution queue, coalescing it into an existing
   * same-entity update where possible so redundant writes collapse.
   */
  private enqueue(transaction: Transaction): void {
    this.ensureDerivedFields(transaction);
    const modelKey = `${transaction.modelName}:${transaction.modelId}`;

    // Coalescing for updates. Staging already batches everything created in one
    // event-loop tick, so only two cases remain here: merging into an in-flight
    // update, and merging into a pending same-entity update.
    //
    // Retries (attempts > 0 or an already assigned commit envelope) must not
    // take either merge path. A retry is re-enqueued while its own model key may
    // still be marked in `inFlightByModel`; treating it as a concurrent edit
    // would change the already-attempted request, discard its stable envelope,
    // and either defeat maxRetries or duplicate an ambiguously committed write.
    if (
      transaction.type === 'update' &&
      transaction.attempts === 0 &&
      !transaction.commitEnvelope
    ) {
      const preserveWatermark = hasCommitCoalescingBarrier(transaction.writeOptions);
      // If there is an in-flight update for this model, merge into post-flight buffer
      if (!preserveWatermark && this.inFlightByModel.has(modelKey)) {
        const previous = this.pendingMergeByModel.get(modelKey);
        const merged = mergeUpdateData(
          previous?.data ?? {},
          transaction.data || {},
          transaction.modelName,
        );
        this.pendingMergeByModel.set(modelKey, {
          data: merged,
          sourceMutationIds: [
            ...new Set([
              ...(previous?.sourceMutationIds ?? []),
              ...(transaction.sourceMutationIds ?? []),
            ]),
          ],
        });
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
          !hasCommitCoalescingBarrier(t.writeOptions)
      );
      if (!preserveWatermark && pendingInQueue) {
        pendingInQueue.data = mergeUpdateData(
          pendingInQueue.data || {},
          transaction.data || {},
          transaction.modelName
        );
        pendingInQueue.sourceMutationIds = [
          ...new Set([
            ...(pendingInQueue.sourceMutationIds ?? []),
            ...(transaction.sourceMutationIds ?? []),
          ]),
        ];
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

    // Backpressure: don't schedule another batch while too many transactions
    // are already executing, so the server is not flooded with concurrent
    // requests.
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
   * Processes one batch of transactions in a single commit. Rather than calling
   * the server once per operation type or model, it collects every batchable
   * operation and sends them together; the server applies the mixed operations
   * atomically within one transaction. This turns many round trips into one and
   * greatly reduces batch latency.
   */
  private async processBatch(): Promise<void> {
    if (this.durableReplayBlock) return;
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
          // Sort the execution queue by foreign-key priority before selecting a
          // batch, so a parent row is always committed before its children, even
          // across batch boundaries.
          this.executionQueue.sort((a, b) => {
            // Ensure derived fields exist (covers restored/persisted transactions)
            this.ensureDerivedFields(a);
            this.ensureDerivedFields(b);
            if (a.modelName === b.modelName && a.modelId === b.modelId && a.type !== b.type) {
              if (a.type === 'create') return -1;
              if (b.type === 'create') return 1;
            }
            return a.priorityScore - b.priorityScore;
          });

          // Take a fresh batch or one complete retry envelope. Retry envelopes
          // retain both their original membership and operation order.
          batch = this.takeNextExecutionBatch();
          if (batch.length === 0) return;
          const commitIdempotencyKey = this.ensureCommitEnvelope(batch);

          // Track executing count for backpressure
          this.executingCount += batch.length;

          // Mark all as executing
          for (const tx of batch) {
            const key = `${tx.modelName}:${tx.modelId}`;
            if (tx.type === 'update') this.inFlightByModel.add(key);
            this.store.updateStatus(tx.id, 'executing');
          }

          // Build every operation for one unified commit (a single round trip).
          const batchOps: {
            tx: Transaction;
            op: {
              type: MutationOperationType;
              model: string;
              id: string;
              input?: Record<string, unknown>;
              transactionId: string;
            } & WriteOperationFields;
          }[] = [];

          for (const tx of batch) {
            // The per-operation `transactionId` carries the local transaction id
            // over the wire so the server can stamp it on the resulting sync
            // delta. The receive path matches it through
            // {@link UnconfirmedWrites.consumeEcho} to avoid applying the
            // client's own optimistic change twice. This is separate from the
            // batch-level idempotency key recorded in `mutation_log`.
            const op = applyWriteOptions({
              type: TX_TYPE_TO_MUTATION_OP[tx.type],
              model: tx.modelKey,
              id: tx.modelId,
              input: tx.type === 'create' || tx.type === 'update' ? tx.data || {} : undefined,
              transactionId: tx.id,
            }, tx);
            batchOps.push({ tx, op });
          }

          // Execute the unified commit for every operation in one round trip.
          if (batchOps.length > 0) {
            let dispatchStarted = false;
            try {
              const durableEnvelope = await this.sealDurableCommit({
                idempotencyKey: commitIdempotencyKey,
                origin: 'model_batch',
                operations: batchOps.map(({ op }) => op),
                sourceMutationIds: this.sourceMutationIdsFor(batch),
                createdAt: Math.min(...batch.map((transaction) => transaction.createdAt)),
                sealedAt: batch[0]?.commitEnvelope?.sealedAt ?? Date.now(),
                sequence: batch[0]?.commitEnvelope?.sequence,
              });
              const operations = durableEnvelope.operations;

              // Capture lastSyncId from the server response for threshold-based
              // confirmation.
              //
              // The queue owns request identity. A lost acknowledgement may be
              // retried after a backoff or reconnect, so every retry must send
              // the exact key assigned before the first transport attempt.
              this.assertEnvelopeInsideReplayWindow(durableEnvelope);
              dispatchStarted = true;
              const result = this.parseMutationCommitResult(
                await this.mutationExecutor.commit(operations, {
                  idempotencyKey: commitIdempotencyKey,
                }),
              );
              await this.persistDurableCommitAcceptance(
                durableEnvelope,
                result,
              );
              const lastSyncId = result.lastSyncId;

              const notifications = result.notifications;
              const {
                holdsEntireBatch,
                heldTargets,
                notificationsByTarget,
              } = this.classifyReceiptNotifications(
                batchOps.map(({ op }) => ({ model: op.model, id: op.id })),
                notifications ?? [],
              );
              for (const { tx } of batchOps) {
                const txTarget = this.receiptTargetKey(tx.modelKey, tx.modelId);
                const txNotifs = holdsEntireBatch
                  ? notifications
                  : notificationsByTarget.get(txTarget);
                if (txNotifs && txNotifs.length > 0) {
                  this.commitNotifications.set(tx.id, txNotifs);
                }
              }
              const missingIds = new Set(result.missingIds ?? []);
              const settlingBatchOps: typeof batchOps = [];
              for (const entry of batchOps) {
                const { tx } = entry;
                if (missingIds.has(tx.modelId)) {
                  await this.handleFailure(
                    tx,
                    new AbloNotFoundError(
                      `${tx.modelName}/${tx.modelId} was not found or is outside this credential's scope.`,
                      [tx.modelId],
                    ),
                  );
                  continue;
                }
                if (
                  holdsEntireBatch ||
                  heldTargets.has(this.receiptTargetKey(tx.modelKey, tx.modelId))
                ) {
                  await this.rollbackOptimistic(tx, 'conflict_server_wins');
                  this.store.updateStatus(tx.id, 'completed');
                  this.emit('transaction:completed', tx);
                  this.emit(`transaction:completed:${tx.id}`, tx);
                  this.optimisticUpdates.delete(tx.id);
                  continue;
                }
                settlingBatchOps.push(entry);
              }

              // A forwarded write has been accepted, but the source database
              // remains authoritative. It must not enter any of the confirmed
              // paths below: in particular, a queued DELETE with sync id 0 is
              // not the hosted-path idempotent-delete shortcut, and a later
              // unrelated delta cannot stand in for the source echo.
              if (result.status === 'queued') {
                // Keep the exact envelope crash-durable while any forwarded
                // member is awaiting its WAL echo. If coordination/missing-row
                // handling consumed the whole request, there is no echo left
                // to await and the durable intent is definitive.
                if (settlingBatchOps.length === 0) {
                  await this.removeDurableCommit(commitIdempotencyKey);
                }
                for (const { tx } of settlingBatchOps) {
                  tx.requiresCorrelatedDelta = true;
                  tx.syncIdNeededForCompletion = undefined;
                  tx.correlationId = result.correlationId;
                  const echoSyncId = result.correlationId
                    ? this.recentDeltaCorrelations.get(result.correlationId)
                    : undefined;
                  if (echoSyncId !== undefined) {
                    this.store.updateStatus(tx.id, 'completed');
                    this.emit('transaction:completed', tx);
                    this.emit(`transaction:completed:${tx.id}`, tx);
                    this.optimisticUpdates.delete(tx.id);
                    continue;
                  }
                  this.store.updateStatus(tx.id, 'awaiting_delta');
                  this.scheduleReplicationLagTimeout(
                    tx.id,
                    commitIdempotencyKey,
                    result.correlationId,
                  );
                  getContext().logger.debug('tx:awaiting_delta', {
                    txId: tx.id.slice(0, 8),
                    model: tx.modelName,
                    reason: 'queued_forward_waiting_for_correlated_echo',
                  });
                  this.scheduleDeltaConfirmationTimeout(
                    tx,
                    this.config.deltaConfirmationTimeout,
                  );
                }
                if (
                  settlingBatchOps.length > 0 &&
                  settlingBatchOps.every(({ tx }) => tx.status === 'completed')
                ) {
                  await this.removeDurableCommit(commitIdempotencyKey);
                }
              } else {
                await this.removeDurableCommit(commitIdempotencyKey);
                this.noteAck(lastSyncId);

                // A lastSyncId of 0 means the mutation succeeded but the server
                // emitted no sync delta; record that anomaly for observability.
                if (lastSyncId === 0) {
                  getContext().observability.captureCommitZeroSyncId({
                    operationCount: operations.length,
                    operations: operations.map(
                      (op) => `${op.type}:${op.model}:${op.id?.slice(0, 8) ?? '?'}`
                    ),
                  });
                }

                // Mark each remaining transaction with the sync-id threshold
                // that will confirm it: any delta whose id is at least
                // lastSyncId.
                for (const { tx } of settlingBatchOps) {
                  tx.syncIdNeededForCompletion = lastSyncId;

                  // Safety net: a confirmed zero-sync DELETE is idempotent.
                  // This shortcut is intentionally unreachable for queued
                  // forwards, which must wait for their correlated echo.
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

                  // A real watermark is the established hosted-path
                  // confirmation. A zero watermark on a non-delete stays on
                  // the anomaly/reconciliation path.
                  if (lastSyncId > 0) {
                    this.store.updateStatus(tx.id, 'completed');
                    this.emit('transaction:completed', tx);
                    this.emit(`transaction:completed:${tx.id}`, tx);
                    this.optimisticUpdates.delete(tx.id);
                    getContext().logger.debug('tx:confirm_ack', {
                      txId: tx.id.slice(0, 8),
                      model: tx.modelName,
                      serverSyncId: lastSyncId,
                      lastSeenSyncId: this.lastSeenSyncId,
                    });
                  } else {
                    this.store.updateStatus(tx.id, 'awaiting_delta');
                    getContext().logger.debug('tx:awaiting_delta', {
                      txId: tx.id.slice(0, 8),
                      model: tx.modelName,
                      neededSyncId: lastSyncId,
                      lastSeenSyncId: this.lastSeenSyncId,
                      reason: 'zero_sync_id_anomaly',
                    });
                    this.scheduleDeltaConfirmationTimeout(
                      tx,
                      this.config.deltaConfirmationTimeout,
                    );
                  }
                }
              }
            } catch (error) {
              const errorMessage = (error as Error).message || '';
              if (dispatchStarted && this.isDefinitiveRejection(error as Error)) {
                await this.removeDurableCommit(commitIdempotencyKey);
              }
              // Surface the raw server rejection for the whole batch so a
              // cascaded failure — for example a foreign-key violation that
              // rolls back a multi-operation transaction — is attributable to a
              // specific cause rather than showing as a generic permanent error
              // on each operation.
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
                    return (cur).diagnostics;
                  }
                  cur = (cur as { cause?: unknown }).cause;
                }
                return undefined;
              };
              const diagnostics = readDiagnostics(error);
              // Mechanic-level breadcrumb. Every batch rejection — transient
              // (reconnect retries it) or permanent (`handleFailure` logs the
              // authoritative `warn` with the same typed cause) — passes
              // through here. Logging it at `warn` made one rejected write
              // surface three identical dumps; keep it at `debug`.
              getContext().logger.debug('[TransactionQueue] Batch commit rejected', {
                batchSize: batchOps.length,
                models: batchOps.map(({ op }) => `${op.type}:${op.model}`),
                errorType: abloErr?.type ?? (error as Error)?.name,
                errorCode: abloErr?.code,
                httpStatus: abloErr?.httpStatus,
                requestId: abloErr?.requestId,
                message: errorMessage,
                diagnostics,
              });

              // Handle "no rows in result set" gracefully: the row was already
              // deleted, so for update and delete operations this is effectively
              // success — the intended end state already holds — and the
              // transaction is treated as completed.
              if (errorMessage.includes('no rows in result set')) {
                if (dispatchStarted) {
                  await this.removeDurableCommit(commitIdempotencyKey);
                }
                getContext().logger.info('[TransactionQueue] Graceful handling: entity already deleted', {
                  batchSize: batchOps.length,
                });

                for (const { tx, op } of batchOps) {
                  if (op.type === 'UPDATE' || op.type === 'DELETE') {
                    // Row already gone: the intended state holds, mark completed.
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
              if (pending && Object.keys(pending.data).length > 0) {
                // Create a single merged follow-up transaction
                const followUp: Transaction = {
                  id: this.generateId(),
                  type: 'update',
                  modelName: tx.modelName,
                  modelId: tx.modelId,
                  modelKey: tx.modelKey ?? normalizeModelKey(tx.modelName),
                  data: pending.data,
                  previousData: undefined,
                  context: tx.context,
                  status: 'pending',
                  createdAt: Date.now(),
                  attempts: 0,
                  priority: 'normal',
                  priorityScore: this.computePriorityScore('update', tx.modelName),
                  sourceMutationIds: pending.sourceMutationIds,
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
          if (this.executionQueue.length > 0 && batch.length > 0) {
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
  private scheduleDeltaConfirmationTimeout(tx: Transaction, timeoutMs: number): void {
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

  /**
   * Enqueues a pre-built, multi-operation atomic commit — the
   * `ablo.commits.create()` path. The caller supplies the operations; the queue
   * only retries on reconnect and de-duplicates, and does not apply the change
   * optimistically or reorder for foreign keys. A duplicate `clientTxId`
   * already in flight is ignored. After an accepted write exceeds its
   * replication-confirmation deadline, an explicit same-key retry reuses the
   * exact sealed envelope as an idempotent status probe; the server's
   * `mutation_log` still prevents a second logical write.
   */
  async enqueueCommit(
    clientTxId: string,
    operations: CommitTransaction['operations'],
    options: { causedByTaskId?: string | null; reads?: ReadDependency[] | null } = {},
  ): Promise<void> {
    this.assertDurableReplayOpen();
    const existing = this.commitStore.get(clientTxId);
    if (existing) {
      await existing.sealPromise;
      const existingIntent = stableStringify({
        operations: existing.operations,
        causedByTaskId: existing.causedByTaskId ?? null,
        reads: existing.reads ?? null,
      });
      const incomingIntent = stableStringify({
        operations,
        causedByTaskId: options.causedByTaskId ?? null,
        reads: options.reads ?? null,
      });
      if (existingIntent !== incomingIntent) {
        throw new AbloIdempotencyError(
          'Idempotency key reused with a different atomic commit request',
          { code: 'idempotency_conflict' },
        );
      }
      if (
        existing.status === 'awaiting_delta' &&
        this.replicationLagErrors.has(existing.id)
      ) {
        // An explicit same-key retry after the confirmation deadline is an
        // idempotent status probe, not a second logical write. Reuse the exact
        // durable envelope and ask the server again: once the WAL echo has
        // materialized, mutation-log replay upgrades the old queued receipt to
        // confirmed. Passive awaiting remains untouched before the deadline,
        // so duplicate callers cannot cause eager re-dispatch.
        this.clearReplicationLagState(existing.id);
        existing.status = 'pending';
        this.commitLane.push(existing);
      }
      if (existing.status === 'pending') void this.processCommitLane();
      return;
    }
    this.emitCommitLifecycle('commit:staging', {
      clientTxId,
      operations,
    });
    const tx: CommitTransaction = {
      id: clientTxId,
      kind: 'commit',
      operations: [...operations],
      causedByTaskId: options.causedByTaskId ?? null,
      ...(options.reads ? { reads: options.reads } : {}),
      status: 'pending',
      createdAt: Date.now(),
      attempts: 0,
      sealedAt: Date.now(),
      sequence: this.nextCommitSequence(),
    };
    this.commitStore.set(clientTxId, tx);
    tx.sealPromise = this.sealDurableCommit({
      idempotencyKey: tx.id,
      origin: 'atomic_commit',
      operations: tx.operations,
      commitOptions: {
        causedByTaskId: tx.causedByTaskId ?? null,
        ...(tx.reads ? { reads: tx.reads } : {}),
      },
      createdAt: tx.createdAt,
      sealedAt: tx.sealedAt,
      sequence: tx.sequence,
    }).then((envelope) => {
      tx.durableEnvelope = envelope;
      tx.operations = envelope.operations.map((operation) => ({ ...operation }));
    });
    try {
      await tx.sealPromise;
    } catch (error) {
      this.commitStore.delete(clientTxId);
      this.emitCommitLifecycle('commit:seal_failed', { clientTxId });
      throw error;
    } finally {
      tx.sealPromise = undefined;
    }
    this.commitLane.push(tx);
    // Emit the envelope on its own event so the undo stream can record
    // commit-lane writes as well. This deliberately avoids `transaction:created`,
    // which also feeds the optimistic-echo tracker: commit-lane operations apply
    // nothing optimistically and so have no echo to suppress.
    this.emitCommitLifecycle('commit:created', {
      clientTxId,
      operations: tx.operations,
    });
    void this.processCommitLane();
  }

  /**
   * Drains the pending commit-lane envelopes one at a time. A transient
   * failure, such as a network error, leaves the envelope at the head of the
   * lane in `pending` and stops; reconnect re-kicks it through
   * {@link flushOfflineQueue}. A permanent failure emits
   * `transaction:failed:<id>` and drops the envelope.
   */
  private async processCommitLane(): Promise<void> {
    if (this.commitProcessing || this.durableReplayBlock) return;
    this.commitProcessing = true;
    try {
      while (this.commitLane.length > 0) {
        const tx = this.commitLane[0];
        if (!tx) break;
        if (tx.status !== 'pending') {
          this.commitLane.shift();
          continue;
        }
        tx.status = 'executing';
        tx.attempts += 1;
        let dispatchStarted = false;
        try {
          const durableEnvelope =
            tx.durableEnvelope ??
            (await this.sealDurableCommit({
              idempotencyKey: tx.id,
              origin: 'atomic_commit',
              operations: tx.operations,
              sourceMutationIds: tx.sourceMutationIds,
              commitOptions: {
                causedByTaskId: tx.causedByTaskId ?? null,
                ...(tx.reads ? { reads: tx.reads } : {}),
              },
              createdAt: tx.createdAt,
              sealedAt: tx.sealedAt,
              sequence: tx.sequence,
            }));
          tx.durableEnvelope = durableEnvelope;
          this.assertEnvelopeInsideReplayWindow(durableEnvelope);
          dispatchStarted = true;
          const result = this.parseMutationCommitResult(
            await this.mutationExecutor.commit(durableEnvelope.operations, {
              idempotencyKey: tx.id,
              causedByTaskId: durableEnvelope.commitOptions.causedByTaskId ?? undefined,
              ...(durableEnvelope.commitOptions.reads
                ? { reads: durableEnvelope.commitOptions.reads }
                : {}),
            }),
          );
          tx.durableEnvelope = await this.persistDurableCommitAcceptance(
            durableEnvelope,
            result,
          );
          tx.lastSyncId = result.lastSyncId;
          const notifications = result.notifications;
          if (notifications && notifications.length > 0) {
            this.commitNotifications.set(tx.id, notifications);
          }
          const missingIds = result.missingIds;
          if (missingIds && missingIds.length > 0) {
            this.commitMissingIds.set(tx.id, missingIds);
          }
          this.commitLane.shift();
          if (result.status === 'queued') {
            tx.correlationId = result.correlationId;
            tx.status = 'awaiting_delta';
            const echoSyncId = this.queuedCommitEchoSyncId(tx);
            if (echoSyncId !== undefined) {
              this.completeQueuedCommit(tx, echoSyncId);
            } else {
              this.scheduleReplicationLagTimeout(
                tx.id,
                tx.id,
                result.correlationId,
              );
              getContext().logger.debug('[TransactionQueue] commit lane awaiting source echo', {
                txId: tx.id.slice(0, 12),
              });
            }
          } else {
            await this.removeDurableCommit(tx.id);
            this.noteAck(tx.lastSyncId);
            tx.status = 'completed';
            // Guarded: a throwing observer here would land in the catch below,
            // whose permanent branch shifts the lane a second time and rejects a
            // commit the server has already durably applied.
            this.emitCommitLifecycle('transaction:completed', tx);
            this.emitCommitLifecycle(`transaction:completed:${tx.id}`, tx);
          }
        } catch (err) {
          const error = err instanceof Error ? err : new Error(String(err));
          if (dispatchStarted && this.isDefinitiveRejection(error)) {
            await this.removeDurableCommit(tx.id);
          }
          if (!this.isPermanentError(error)) {
            // Transient: leave it at the head and retry on the next kick
            // (reconnect or the next enqueueCommit) rather than tight-looping
            // while the connection is down.
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
          // Internal bookkeeping; the consumer-facing rejection is emitted on
          // 'transaction:failed' and surfaced by the permanent-error headline,
          // so this line stays at debug.
          getContext().logger.debug('[TransactionQueue] commit lane permanent error', {
            txId: tx.id.slice(0, 12),
            attempts: tx.attempts,
            message: error.message,
          });
          this.emitCommitLifecycle('transaction:failed', { transaction: tx, error, permanent: true });
          this.emitCommitLifecycle(`transaction:failed:${tx.id}`, { error });
        }
      }
    } finally {
      this.commitProcessing = false;
    }
  }

  /**
   * Resolves once a commit-lane transaction is confirmed, returning the server's
   * `lastSyncId` and any stale-context notifications; rejects on permanent
   * failure. This backs the `wait: 'confirmed'` semantics of
   * `ablo.commits.create()`.
   */
  waitForCommitReceipt(
    clientTxId: string,
  ): Promise<{
    lastSyncId: number;
    notifications?: StaleNotification[];
    missingIds?: string[];
  }> {
    // Drain any stale-context notifications stamped for this tx on the ack.
    const drainNotifications = (): StaleNotification[] | undefined => {
      const n = this.commitNotifications.get(clientTxId);
      if (!n) return undefined;
      this.commitNotifications.delete(clientTxId);
      return n.length > 0 ? n : undefined;
    };
    const drainMissingIds = (): string[] | undefined => {
      const ids = this.commitMissingIds.get(clientTxId);
      if (!ids) return undefined;
      this.commitMissingIds.delete(clientTxId);
      return ids.length > 0 ? ids : undefined;
    };
    const receipt = (lastSyncId: number) => {
      const notifications = drainNotifications();
      const missingIds = drainMissingIds();
      return {
        lastSyncId,
        notifications,
        ...(missingIds ? { missingIds } : {}),
      };
    };
    return new Promise((resolve, reject) => {
      const existing = this.commitStore.get(clientTxId);
      if (existing?.status === 'completed') {
        resolve(receipt(existing.lastSyncId ?? 0));
        return;
      }
      if (existing?.status === 'failed' && existing.error) {
        reject(existing.error);
        return;
      }
      const lagError = this.replicationLagErrors.get(clientTxId);
      if (lagError) {
        reject(lagError);
        return;
      }
      const onCompleted = (tx: CommitTransaction) => {
        cleanup();
        resolve(receipt(tx.lastSyncId ?? 0));
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
        this.off(`transaction:completed:${clientTxId}`, onCompleted);
        this.off(`transaction:failed:${clientTxId}`, onFailed);
        this.off(`transaction:confirmation_lagged:${clientTxId}`, onLagged);
      };
      this.on(`transaction:completed:${clientTxId}`, onCompleted);
      this.on(`transaction:failed:${clientTxId}`, onFailed);
      this.on(`transaction:confirmation_lagged:${clientTxId}`, onLagged);
    });
  }

  private isReorderPayload(data: MutationInput | undefined): boolean {
    if (!data || typeof data !== 'object') return false;
    return 'order' in data || 'orderKey' in data || 'position' in data;
  }

  /**
   * Classifies an error as transient (worth retrying) or permanent. The
   * approach is deliberately conservative: only known-transient errors are
   * retried, and anything unrecognized is treated as permanent so a failing
   * write cannot loop forever.
   *
   * Transient (retried):
   * - Network failures, connection errors, and timeouts.
   * - Server errors (HTTP 5xx).
   * - Rate limiting (HTTP 429).
   *
   * Permanent (not retried), among others:
   * - Validation errors and constraint violations.
   * - Not found, unauthorized, and forbidden.
   * - Any other business-logic error from the server.
   */
  private isPermanentError(error: Error): boolean {
    // Typed connection error (e.g. ws_not_ready, transport timeout) is
    // always transient — the message text varies ("SyncWebSocket not
    // connected", "commit timed out after ...") and string-matching them
    // is brittle. Class identity is the right signal.
    if (error instanceof AbloConnectionError) {
      return false;
    }

    // Registry-driven retryability is authoritative when the error carries a
    // known wire code: the error contract (errorCodes.ts) decides whether the
    // same request can succeed on retry, not message string-matching. This is
    // why rejected commits must arrive as typed AbloErrors (see
    // `errorFromWire`) — a bare `Error` has no code and falls through to the
    // heuristics below. Unknown / forward-compat codes (`errorCodeSpec`
    // returns undefined) also fall through, preserving the safe default.
    if (error instanceof AbloError && error.code) {
      const spec = errorCodeSpec(error.code);
      if (spec) return !spec.retryable;
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

  /** True only when the server definitively rejected before applying. */
  private isDefinitiveRejection(error: Error): boolean {
    if (error instanceof AbloError && error.code) {
      const spec = errorCodeSpec(error.code);
      if (spec) return !spec.retryable;
    }
    const status = extractStatusCode(error);
    return status !== undefined && status >= 400 && status < 500 && status !== 429;
  }

  /**
   * Handles a failed transaction: retries transient failures with backoff and
   * rolls back permanent ones, settling the transaction's confirmation promise
   * either way.
   */
  private async handleFailure(transaction: Transaction, error: Error): Promise<void> {
    transaction.attempts++;

    // Check whether this is a permanent error that should not be retried.
    if (this.isPermanentError(error)) {
      // Logged at warn: a permanent error means the server rejected the write,
      // so the developer should see the reason in the console. The typed
      // AbloError fields (`type`, `code`, `httpStatus`) are included so the
      // cause is visible — for example a foreign-key violation
      // (AbloValidationError) versus expired authentication
      // (AbloAuthenticationError).
      try {
        const abloErr = error instanceof AbloError ? error : undefined;
        const details = {
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
        };

        // A `create` whose id already exists is the benign idempotency case:
        // "this row is already there." It's the least alarming permanent
        // error, so it doesn't warrant a `warn` — `info` keeps it visible
        // without crying wolf. Everything else (FK violation, auth expiry,
        // server 500) stays at `warn`.
        const isBenignIdempotent =
          transaction.type === 'create' &&
          (abloErr?.code === 'unique_violation' ||
            abloErr?.type === 'AbloIdempotencyError');

        // Demote exact repeats (same write rejected for the same reason on
        // each reconnect replay) to `debug` so the loop logs once.
        const sig = `${details.type}:${details.model}:${details.modelId}:${details.errorCode ?? details.errorType}`;
        const isRepeat = sig === this.lastPermanentErrorSig;
        this.lastPermanentErrorSig = sig;

        const logger = getContext().logger;

        // Two registers from one call site, split by log level (the default
        // logger is gated at `warn`, so `debug` stays hidden unless
        // ABLO_LOG_LEVEL=debug is set to inspect the engine):
        //   - the default-visible line speaks the application developer's
        //     language: their verb (such as `update`), their model, the typed
        //     error's own message, and the wire `code` for searching. It uses
        //     no engine jargon and prints no JSON dump, which would alarm
        //     without helping.
        //   - the forensic `details` ride a companion `debug` line for anyone
        //     debugging the engine internals.
        const revertNote = this.config.enableOptimistic
          ? ' The local change was reverted.'
          : '';
        const reason = abloErr?.message ? ` — ${abloErr.message}` : '';
        const code = abloErr?.code ? ` (code: ${abloErr.code})` : '';
        const headline = `Your ${transaction.type} to "${transaction.modelName}" was not saved${reason}${code}.${revertNote}`;

        if (isRepeat) {
          // Same write rejected for the same reason on each reconnect replay —
          // log the forensics once, stay quiet after.
          logger.debug('write rejected again (same reason)', details);
        } else if (isBenignIdempotent) {
          // Already-exists on a `create` is expected on replay, not a problem.
          logger.info(`Your ${transaction.type} to "${transaction.modelName}" was skipped — this row already exists.`);
          logger.debug('idempotent skip — details', details);
        } else {
          logger.warn(headline);
          logger.debug('write rejection — details', details);
        }
      } catch {}

      // Mark as failed immediately and rollback
      this.store.updateStatus(transaction.id, 'failed');

      if (this.config.enableOptimistic) {
        await this.rollbackOptimistic(transaction, 'permanent_error', error);
      }

      this.emit('transaction:failed', { transaction, error, permanent: true });
      // The id-suffixed event is what `waitForConfirmation` (the
      // `wait:'confirmed'` path) listens on — without it a permanently
      // rejected write left the caller's promise hanging forever.
      this.emit(`transaction:failed:${transaction.id}`, { error });
      return;
    }

    if (transaction.attempts < this.config.maxRetries) {
      // Exponential backoff with full jitter on every transient retry:
      // `sleep = random(0, min(cap, base * 2^attempt))`. Throttling responses
      // (429/503) use a longer base than other transient errors. The re-enqueue
      // is scheduled rather than awaited, so one backing-off transaction cannot
      // stall unrelated commits.
      const { baseMs, capMs } = this.config.retryBackoff;
      let base = baseMs;
      try {
        const status = extractStatusCode(error);
        if (status === 429 || status === 503) base = Math.max(baseMs, 1_000);
      } catch {}
      const ceiling = Math.min(capMs, base * Math.pow(2, transaction.attempts - 1));
      const delay = Math.floor(Math.random() * ceiling);

      this.store.updateStatus(transaction.id, 'pending');
      setTimeout(() => {
        // The queue may have shut down or the tx may have been settled
        // (e.g. delta-confirmed) while we backed off.
        if (this.store.get(transaction.id)?.status !== 'pending') return;
        this.enqueue(transaction);
      }, delay);
    } else {
      // Mark as failed and rollback
      this.store.updateStatus(transaction.id, 'failed');

      if (this.config.enableOptimistic) {
        await this.rollbackOptimistic(transaction, 'max_retries_exhausted', error);
      }

      this.emit('transaction:failed', { transaction, error });
      // Settle `waitForConfirmation` waiters (see the permanent branch above).
      this.emit(`transaction:failed:${transaction.id}`, { error });
    }
  }

  /**
   * Resolves a conflict against server data using the configured strategy:
   * last-write-wins rolls the local change back, merge and reject re-enqueue it,
   * and custom applies the caller's resolver.
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
   * Optimistic updates. The apply and rollback rules live in `./optimisticApply.js`;
   * these methods bind them to the queue's own tracking map and event emitter.
   */
  private applyOptimisticCreate(model: Model, transaction: Transaction): void {
    applyOptimisticCreate(this.optimisticUpdates, this, model, transaction);
  }

  private applyOptimisticUpdate(model: Model, transaction: Transaction): void {
    applyOptimisticUpdate(this.optimisticUpdates, this, model, transaction);
  }

  private applyOptimisticDelete(model: Model, transaction: Transaction): void {
    applyOptimisticDelete(this.optimisticUpdates, this, model, transaction);
  }

  private async rollbackOptimistic(
    transaction: Transaction,
    reason?: string,
    error?: Error
  ): Promise<void> {
    await rollbackOptimistic(this.optimisticUpdates, this, transaction, reason, error);
  }

  /**
   * Loads transactions persisted from a previous session and re-enqueues them,
   * so writes made while offline survive a restart. Does nothing when
   * persistence is disabled.
   */
  async loadPersistedTransactions(database: Database): Promise<void> {
    if (!this.config.enablePersistence) return;

    try {
      const persisted = await database.getPersistedTransactions();

      for (const data of persisted) {
        const transaction = this.deserializeTransaction(data);
        if (!transaction) continue;
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

  /**
   * Restore exact sealed requests after the local database is open. Sealed
   * envelopes replay through the atomic commit lane and are never re-projected
   * through model/schema state from the new process.
   */
  async restoreDurableCommits(): Promise<Set<string>> {
    if (!this.config.enablePersistence) return new Set();

    const sourceMutationIds = new Set<string>();
    try {
      if (!this.commitOutbox) return sourceMutationIds;
      const rows = await this.commitOutbox.list();
      const envelopes: DurableCommitEnvelope[] = [];
      for (const row of rows) {
        if (
          typeof row !== 'object' ||
          row === null ||
          (row as { type?: unknown }).type !== 'commit_envelope'
        ) continue;
        const parsed = durableCommitEnvelopeSchema.safeParse(row);
        if (parsed.success) {
          envelopes.push(parsed.data);
        } else {
          getContext().logger.warn('A saved local write is unreadable and was held for review.');
          getContext().observability.captureTransactionFailure({
            context: 'restore-commit-envelope',
            error: parsed.error,
          });
          throw new AbloValidationError(
            'A saved commit envelope is unreadable; replay stopped before newer writes were sent.',
            { code: 'write_options_invalid', cause: parsed.error },
          );
        }
      }
      envelopes.sort(
        (a, b) =>
          (a.sequence ?? a.sealedAt * 1_000) -
            (b.sequence ?? b.sealedAt * 1_000) ||
          a.id.localeCompare(b.id),
      );

      for (const envelope of envelopes) {
        for (const mutationId of envelope.sourceMutationIds) {
          sourceMutationIds.add(mutationId);
        }
        if (
          envelope.acceptedAt === undefined &&
          Date.now() - envelope.sealedAt >=
          TransactionQueue.DURABLE_REPLAY_WINDOW_MS
        ) {
          getContext().logger.warn(
            'A saved local write is too old to retry safely and was held for review.',
          );
          getContext().observability.captureTransactionFailure({
            context: 'quarantine-expired-commit-envelope',
            error: `Envelope ${envelope.idempotencyKey} is too old to replay safely`,
          });
          throw new AbloIdempotencyError(
            'A saved commit is older than the server idempotency window and cannot be replayed safely.',
            { code: 'idempotency_conflict' },
          );
        }
        if (
          this.commitOutboxScope &&
          (
            !envelope.scope || // eslint-disable-line @typescript-eslint/prefer-optional-chain -- missing scope must quarantine
            envelope.scope.organizationId !== this.commitOutboxScope.organizationId ||
            envelope.scope.participantId !== this.commitOutboxScope.participantId ||
            envelope.scope.namespace !== this.commitOutboxScope.namespace
          )
        ) {
          getContext().logger.warn(
            'A saved local write belongs to a different account or server and was held for review.',
          );
          continue;
        }
        if (this.commitStore.has(envelope.idempotencyKey)) continue;
        const transaction: CommitTransaction = {
          id: envelope.idempotencyKey,
          kind: 'commit',
          operations: envelope.operations.map((operation) => ({ ...operation })),
          causedByTaskId: envelope.commitOptions.causedByTaskId ?? null,
          ...(envelope.commitOptions.reads
            ? { reads: [...envelope.commitOptions.reads] }
            : {}),
          status: 'pending',
          createdAt: envelope.createdAt,
          sealedAt: envelope.sealedAt,
          sequence: envelope.sequence ?? envelope.sealedAt * 1_000,
          attempts: 0,
          ...(envelope.correlationId
            ? { correlationId: envelope.correlationId }
            : {}),
          sourceMutationIds: [...envelope.sourceMutationIds],
          durableEnvelope: envelope,
        };
        this.commitStore.set(transaction.id, transaction);
        this.commitLane.push(transaction);
      }

      if (this.commitLane.length > 0) void this.processCommitLane();
    } catch (error) {
      getContext().logger.debug('[TransactionQueue] Failed to restore durable writes', {
        error: error instanceof Error ? error.message : String(error),
      });
      getContext().observability.captureTransactionFailure({
        context: 'restore-commit-envelopes',
        error: error instanceof Error ? error : String(error),
      });
      throw error;
    }
    return sourceMutationIds;
  }

  /**
   * Validates and rehydrates one persisted row. Rows written to the same store
   * by other subsystems are skipped, and rows that fail the persisted
   * transaction schema — from an older version or corruption — are dropped and
   * reported rather than replayed as commits.
   */
  private deserializeTransaction(data: unknown): Transaction | null {
    if (isNonReplayablePersistedRow(data)) return null;

    const transaction = deserializePersistedTransaction(data);
    if (!transaction) {
      const rowId =
        typeof data === 'object' && data !== null && typeof (data as { id?: unknown }).id === 'string'
          ? (data as { id: string }).id
          : undefined;
      getContext().logger.debug('[TransactionQueue] Dropping malformed persisted transaction', {
        rowId,
      });
      getContext().observability.captureTransactionFailure({
        context: 'deserialize-persisted-transaction',
        error: `Persisted transaction failed schema validation${rowId ? ` (id: ${rowId})` : ''}`,
      });
      return null;
    }
    return transaction;
  }

  /**
   * Cancels every pending or executing transaction for a given model id,
   * optionally limited to one operation type, rolling back their optimistic
   * state. Returns the cancelled transactions.
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
          // Sync caller: a rejected rollback (throwing optimistic:rollback
          // listener) must surface, not vanish — the status flip above is
          // already committed either way.
          void this.rollbackOptimistic(transaction, 'model_cancelled').catch((error: unknown) => {
            getContext().observability.captureTransactionFailure({
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
   * @param childModelName - The child model type (for example 'SlideLayer').
   * @param foreignKey - The foreign-key property name (for example 'slideId').
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
              getContext().observability.captureTransactionFailure({
                context: 'rollback-cascade-parent-deleted',
                error: error instanceof Error ? error : String(error),
              });
            }
          );
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
   * Returns the number of transactions still pending or executing.
   */
  getOutstandingTransactionCount(): number {
    return this.store.getByStatus('pending').length + this.store.getByStatus('executing').length;
  }

  /** Generates a unique local transaction id. */
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

  // Derive previous values for changed fields to support accurate rollback.
  // Model-specific special cases do not belong here; a model that needs to
  // surface previous state beyond `modifiedProperties` should expose a typed
  // `getPreviousData()` accessor for this method to call.
  private extractPreviousData(model: Model, updateInput?: MutationInput): MutationInput {
    // When the update's written keys are known, capture a before-image for
    // exactly those keys, so the recorded undo inverse reverts them and nothing
    // else — a full-row inverse would clobber concurrent edits to unrelated
    // fields. `fallbackToLive: false` makes `Model.capturePreviousValues` omit
    // any key it cannot resolve, and `buildUndoOps` then drops an un-revertible
    // inverse rather than inventing one. With no `updateInput` (a full extract)
    // it falls back to every tracked field. `Model.capturePreviousValues` is the
    // single before-image source, shared with
    // `RecordingTransaction.snapshotFields`.
    const keys = updateInput
      ? Object.keys(updateInput)
      : [...(model.modifiedProperties instanceof Map ? model.modifiedProperties.keys() : [])];
    return { id: model.id, ...model.capturePreviousValues(keys, { fallbackToLive: false }) };
  }

  /** Returns a snapshot of queue counts and the current configuration. */
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
  setConfig(config: Partial<TransactionQueueConfig>): void {
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

    // Clear store
    this.store.clear();
    this.optimisticUpdates.clear();
    this.executionQueue = [];
    this.createdTransactions = [];
    this.deferredDeletesByCreate.clear();
    this.recentDeltaCorrelations.clear();
    this.commitLane = [];
    this.commitStore.clear();
    this.commitNotifications.clear();
    this.commitMissingIds.clear();

    // Clear event listeners
    this.removeAllListeners();

    // Reset state
    this.isProcessing = false;
    this.batchIndex = 0;
  }
}
