import type { RuntimeContext } from '../../RuntimeContext.js';
import type { MutationQueueConfig } from './MutationQueue.js';
import type { MutationInput, QueuedMutation } from './commitPayload.js';
import type { MutationStore } from './MutationStore.js';
import type { OptimisticUpdateEntry } from './localMutation.js';
import type { DeltaConfirmationTracker } from './deltaConfirmation.js';
import type { MutationCommitResult } from '@abloatai/transaction/commit';
import type { DurableCommitEnvelope } from '@abloatai/transaction/commit';
import { AbloError, AbloNotFoundError } from '@abloatai/transaction/errors';
import { applyWriteOptions, collectQueuedReads, normalizeModelKey, TX_TYPE_TO_MUTATION_OP, type WriteOperationFields } from './commitPayload.js';
import type { MutationOperationType } from '@abloatai/transaction/types';

export interface BatchProcessingContext {
  readonly runtime: RuntimeContext;
  readonly config: MutationQueueConfig;
  readonly durableReplayBlock: object | null;
  readonly executionQueue: QueuedMutation[];
  readonly isProcessing: boolean;
  readonly setIsProcessing: (value: boolean) => void;
  readonly takeNextExecutionBatch: () => QueuedMutation[];
  readonly ensureDerivedFields: (transaction: QueuedMutation) => void;
  readonly ensureCommitEnvelope: (batch: QueuedMutation[]) => string;
  readonly executingCount: number;
  readonly setExecutingCount: (value: number) => void;
  readonly inFlightByModel: Set<string>;
  readonly pendingMergeByModel: Map<string, { data: MutationInput; sourceMutationIds: string[] }>;
  readonly generateId: () => string;
  readonly computePriorityScore: (type: QueuedMutation['type'], modelName: string) => number;
  readonly store: MutationStore;
  readonly enqueue: (transaction: QueuedMutation) => void;
  readonly optimisticUpdates: Map<string, OptimisticUpdateEntry>;
  readonly commitMissingIds: Map<string, string[]>;
  readonly sourceMutationIdsFor: (batch: readonly QueuedMutation[]) => string[];
  readonly dispatchCommitBounded: (...args: Parameters<import('../../interfaces/index.js').MutationExecutor['commit']>) => ReturnType<import('../../interfaces/index.js').MutationExecutor['commit']>;
  readonly parseMutationCommitResult: (value: Awaited<ReturnType<import('../../interfaces/index.js').MutationExecutor['commit']>>) => MutationCommitResult;
  readonly persistDurableCommitAcceptance: (envelope: DurableCommitEnvelope, result: MutationCommitResult) => Promise<DurableCommitEnvelope>;
  readonly removeDurableCommit: (idempotencyKey: string) => Promise<void>;
  readonly assertEnvelopeInsideReplayWindow: (envelope: DurableCommitEnvelope) => void;
  readonly sealDurableCommit: (input: Parameters<typeof import('./commitTransport.js').sealDurableCommit>[1]) => Promise<DurableCommitEnvelope>;
  readonly noteAck: (syncId: number | undefined) => void;
  readonly scheduleReplicationLagTimeout: (transactionId: string, clientTxId?: string, correlationId?: string) => void;
  readonly scheduleDeltaConfirmationTimeout: (transaction: QueuedMutation, timeoutMs: number) => void;
  readonly clearReplicationLagState: (transactionId: string) => void;
  readonly completeQueuedCommit: (transaction: import('./commitLane.js').CommitTransaction, syncId: number) => void;
  readonly queuedCommitMatchesCorrelation: (transaction: import('./commitLane.js').CommitTransaction, correlationId: string) => boolean;
  readonly recentDeltaCorrelations: Map<string, number>;
  readonly lastSeenSyncId: number;
  readonly scheduleProcessing: (immediate?: boolean) => void;
  readonly handleFailure: (transaction: QueuedMutation, error: Error) => Promise<void>;
  readonly isDefinitiveRejection: (error: Error) => boolean;
  readonly emitCommitLifecycle: (event: string, payload: object) => void;
  readonly emit: (event: string, payload: object) => boolean;
  readonly rollbackOptimistic: (transaction: QueuedMutation, reason: string, error?: Error) => Promise<void>;
}

export async function processBatch(ctx: BatchProcessingContext): Promise<void> {    if (ctx.durableReplayBlock) return;
    const batchStart = typeof performance !== 'undefined' ? performance.now() : Date.now();

    if (ctx.isProcessing || ctx.executionQueue.length === 0) {
      return;
    }

    ctx.setIsProcessing(true);

    // Declare batch outside try so it's accessible in finally for backpressure tracking
    let batch: QueuedMutation[] = [];

    await ctx.runtime.observability.startSpanAsync(
      'sync.batch',
      'sync.transaction.batch',
      async () => {
        try {
          // Sort the execution queue by foreign-key priority before selecting a
          // batch, so a parent row is always committed before its children, even
          // across batch boundaries.
          ctx.executionQueue.sort((a, b) => {
            // Ensure derived fields exist (covers restored/persisted transactions)
            ctx.ensureDerivedFields(a);
            ctx.ensureDerivedFields(b);
            if (a.modelName === b.modelName && a.modelId === b.modelId && a.type !== b.type) {
              if (a.type === 'create') return -1;
              if (b.type === 'create') return 1;
            }
            return a.priorityScore - b.priorityScore;
          });

          // Take a fresh batch or one complete retry envelope. Retry envelopes
          // retain both their original membership and operation order.
          batch = ctx.takeNextExecutionBatch();
          if (batch.length === 0) return;
          const commitIdempotencyKey = ctx.ensureCommitEnvelope(batch);

          // Track executing count for backpressure
          ctx.setExecutingCount(ctx.executingCount + batch.length);

          // Mark all as executing
          for (const tx of batch) {
            const key = `${tx.modelName}:${tx.modelId}`;
            if (tx.type === 'update') ctx.inFlightByModel.add(key);
            ctx.store.updateStatus(tx.id, 'executing');
          }

          // Build every operation for one unified commit (a single round trip).
          const batchOps: {
            tx: QueuedMutation;
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
              let durableEnvelope = batch[0]?.durableEnvelope;
              if (durableEnvelope) {
                const mismatched = batch.some(
                  (transaction) =>
                    transaction.durableEnvelope?.idempotencyKey !==
                    durableEnvelope?.idempotencyKey,
                );
                if (mismatched || durableEnvelope.idempotencyKey !== commitIdempotencyKey) {
                  throw new Error('Cannot replay a model batch with inconsistent durable envelopes');
                }
              } else {
                durableEnvelope = await ctx.sealDurableCommit({
                  idempotencyKey: commitIdempotencyKey,
                  origin: 'model_batch',
                  operations: batchOps.map(({ op }) => op),
                  sourceMutationIds: ctx.sourceMutationIdsFor(batch),
                  commitOptions: { reads: collectQueuedReads(batch) },
                  createdAt: Math.min(...batch.map((transaction) => transaction.createdAt)),
                  sealedAt: batch[0]?.commitEnvelope?.sealedAt ?? Date.now(),
                  sequence: batch[0]?.commitEnvelope?.sequence,
                });
                for (const transaction of batch) {
                  transaction.durableEnvelope = durableEnvelope;
                }
              }
              const operations = durableEnvelope.operations;

              // Capture lastSyncId from the server response for threshold-based
              // confirmation.
              //
              // The queue owns request identity. A lost acknowledgement may be
              // retried after a backoff or reconnect, so every retry must send
              // the exact key assigned before the first transport attempt.
              ctx.assertEnvelopeInsideReplayWindow(durableEnvelope);
              dispatchStarted = true;
              const result = ctx.parseMutationCommitResult(
                await ctx.dispatchCommitBounded(operations, {
                  idempotencyKey: commitIdempotencyKey,
                  ...(durableEnvelope.commitOptions.reads !== undefined
                    ? { reads: durableEnvelope.commitOptions.reads }
                    : {}),
                }),
              );
              await ctx.persistDurableCommitAcceptance(
                durableEnvelope,
                result,
              );
              const lastSyncId = result.lastSyncId;

              const missingIds = new Set(result.missingIds ?? []);
              const settlingBatchOps: typeof batchOps = [];
              for (const entry of batchOps) {
                const { tx } = entry;
                if (missingIds.has(tx.modelId)) {
                  await ctx.handleFailure(
                    tx,
                    new AbloNotFoundError(
                      `${tx.modelName}/${tx.modelId} was not found or is outside this credential's scope.`,
                      [tx.modelId],
                    ),
                  );
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
                  await ctx.removeDurableCommit(commitIdempotencyKey);
                }
                for (const { tx } of settlingBatchOps) {
                  tx.requiresCorrelatedDelta = true;
                  tx.syncIdNeededForCompletion = undefined;
                  tx.correlationId = result.correlationId;
                  const echoSyncId = result.correlationId
                    ? ctx.recentDeltaCorrelations.get(result.correlationId)
                    : undefined;
                  if (echoSyncId !== undefined) {
                    ctx.store.updateStatus(tx.id, 'completed');
                    ctx.emit('transaction:completed', tx);
                    ctx.emit(`transaction:completed:${tx.id}`, tx);
                    ctx.optimisticUpdates.delete(tx.id);
                    continue;
                  }
                  ctx.store.updateStatus(tx.id, 'awaiting_delta');
                  ctx.scheduleReplicationLagTimeout(
                    tx.id,
                    commitIdempotencyKey,
                    result.correlationId,
                  );
                  ctx.runtime.logger.debug('tx:awaiting_delta', {
                    txId: tx.id.slice(0, 8),
                    model: tx.modelName,
                    reason: 'queued_forward_waiting_for_correlated_echo',
                  });
                  ctx.scheduleDeltaConfirmationTimeout(
                    tx,
                    ctx.config.deltaConfirmationTimeout,
                  );
                }
                if (
                  settlingBatchOps.length > 0 &&
                  settlingBatchOps.every(({ tx }) => tx.status === 'completed')
                ) {
                  await ctx.removeDurableCommit(commitIdempotencyKey);
                }
              } else {
                await ctx.removeDurableCommit(commitIdempotencyKey);
                ctx.noteAck(lastSyncId);

                // A lastSyncId of 0 means the mutation succeeded but the server
                // emitted no sync delta; record that anomaly for observability.
                if (lastSyncId === 0) {
                  ctx.runtime.observability.captureCommitZeroSyncId({
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
                    ctx.store.updateStatus(tx.id, 'completed');
                    ctx.emit('transaction:completed', tx);
                    ctx.emit(`transaction:completed:${tx.id}`, tx);
                    ctx.optimisticUpdates.delete(tx.id);
                    ctx.runtime.logger.debug('tx:confirm_delete_zero_syncid', {
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
                    ctx.store.updateStatus(tx.id, 'completed');
                    ctx.emit('transaction:completed', tx);
                    ctx.emit(`transaction:completed:${tx.id}`, tx);
                    ctx.optimisticUpdates.delete(tx.id);
                    ctx.runtime.logger.debug('tx:confirm_ack', {
                      txId: tx.id.slice(0, 8),
                      model: tx.modelName,
                      serverSyncId: lastSyncId,
                      lastSeenSyncId: ctx.lastSeenSyncId,
                    });
                  } else {
                    ctx.store.updateStatus(tx.id, 'awaiting_delta');
                    ctx.runtime.logger.debug('tx:awaiting_delta', {
                      txId: tx.id.slice(0, 8),
                      model: tx.modelName,
                      neededSyncId: lastSyncId,
                      lastSeenSyncId: ctx.lastSeenSyncId,
                      reason: 'zero_sync_id_anomaly',
                    });
                    ctx.scheduleDeltaConfirmationTimeout(
                      tx,
                      ctx.config.deltaConfirmationTimeout,
                    );
                  }
                }
              }
            } catch (error) {
              const errorMessage = (error as Error).message || '';
              if (dispatchStarted && ctx.isDefinitiveRejection(error as Error)) {
                await ctx.removeDurableCommit(commitIdempotencyKey);
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
              ctx.runtime.logger.debug('[MutationQueue] Batch commit rejected', {
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
                  await ctx.removeDurableCommit(commitIdempotencyKey);
                }
                ctx.runtime.logger.info('[MutationQueue] Graceful handling: entity already deleted', {
                  batchSize: batchOps.length,
                });

                for (const { tx, op } of batchOps) {
                  if (op.type === 'UPDATE' || op.type === 'DELETE') {
                    // Row already gone: the intended state holds, mark completed.
                    ctx.store.updateStatus(tx.id, 'completed');
                    ctx.emit('transaction:completed', tx);

                    ctx.runtime.logger.debug('[MutationQueue] Orphaned transaction treated as success', {
                      txId: tx.id.slice(0, 12),
                      model: tx.modelName,
                      type: op.type,
                    });
                  } else {
                    // CREATE operations on non-existent parent are real failures
                    await ctx.handleFailure(tx, error as Error);
                  }
                }
              } else {
                // Handle other batch failures - mark all as failed
                for (const { tx } of batchOps) {
                  await ctx.handleFailure(tx, error as Error);
                }
              }
            }
          }

          // Handle post-execution merge for updates
          for (const tx of batch) {
            const key = `${tx.modelName}:${tx.modelId}`;
            if (tx.type === 'update') {
              ctx.inFlightByModel.delete(key);
              const pending = ctx.pendingMergeByModel.get(key);
              if (pending && Object.keys(pending.data).length > 0) {
                // Create a single merged follow-up transaction
                const followUp: QueuedMutation = {
                  id: ctx.generateId(),
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
                  priorityScore: ctx.computePriorityScore('update', tx.modelName),
                  sourceMutationIds: pending.sourceMutationIds,
                };
                ctx.pendingMergeByModel.delete(key);
                ctx.store.add(followUp);
                ctx.enqueue(followUp);
              }
            }
          }
        } finally {
          ctx.setIsProcessing(false);

          // Decrement executing count for backpressure tracking
          ctx.setExecutingCount(ctx.executingCount - batch.length);

          // Process next batch if needed
          if (ctx.executionQueue.length > 0 && batch.length > 0) {
            ctx.scheduleProcessing(true);
          }

          const batchEnd = typeof performance !== 'undefined' ? performance.now() : Date.now();
          ctx.runtime.logger.debug('txn:batch', batchEnd - batchStart, {
            maxBatchSize: ctx.config.maxBatchSize,
            remaining: ctx.executionQueue.length,
            executingCount: ctx.executingCount,
          });
        }
      },
      { batchSize: ctx.executionQueue.length + (batch?.length ?? 0) }
    );
}
