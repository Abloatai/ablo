import type { RuntimeContext } from '../../RuntimeContext.js';
import type { QueuedMutation } from './commitPayload.js';
import type { MutationStore } from './MutationStore.js';
import type { OptimisticUpdateEntry } from './localMutation.js';
import type { MutationCommitResult } from '@ablo/transaction/wire/commit';
import type { DurableCommitEnvelope } from '@ablo/transaction/transactions/settlement/commitEnvelope';
import { applyWriteOptions, TX_TYPE_TO_MUTATION_OP } from './commitPayload.js';

export interface PendingDrainContext {
  readonly runtime: RuntimeContext;
  readonly config: { deltaConfirmationTimeout: number };
  readonly store: MutationStore;
  executionQueue: QueuedMutation[];
  readonly optimisticUpdates: Map<string, OptimisticUpdateEntry>;
  readonly assertDurableReplayOpen: () => void;
  readonly processCommitLane: () => Promise<void>;
  readonly takePendingDrainBatch: (pending: QueuedMutation[]) => QueuedMutation[];
  readonly ensureCommitEnvelope: (batch: QueuedMutation[]) => string;
  readonly ensureDerivedFields: (transaction: QueuedMutation) => void;
  readonly sourceMutationIdsFor: (batch: readonly QueuedMutation[]) => string[];
  readonly sealDurableCommit: (input: Parameters<typeof import('./commitTransport.js').sealDurableCommit>[1]) => Promise<DurableCommitEnvelope>;
  readonly assertEnvelopeInsideReplayWindow: (envelope: DurableCommitEnvelope) => void;
  readonly parseMutationCommitResult: (value: Awaited<ReturnType<import('../../interfaces/index.js').MutationExecutor['commit']>>) => MutationCommitResult;
  readonly dispatchCommitBounded: (...args: Parameters<import('../../interfaces/index.js').MutationExecutor['commit']>) => ReturnType<import('../../interfaces/index.js').MutationExecutor['commit']>;
  readonly persistDurableCommitAcceptance: (envelope: DurableCommitEnvelope, result: MutationCommitResult) => Promise<DurableCommitEnvelope>;
  readonly removeDurableCommit: (idempotencyKey: string) => Promise<void>;
  readonly scheduleReplicationLagTimeout: (transactionId: string, clientTxId?: string, correlationId?: string) => void;
  readonly scheduleDeltaConfirmationTimeout: (transaction: QueuedMutation, timeoutMs: number) => void;
  readonly enqueue: (transaction: QueuedMutation) => void;
  readonly recentDeltaCorrelations: Map<string, number>;
  readonly emit: (event: string, payload: object) => boolean;
}

export async function drainPendingSettlements(ctx: PendingDrainContext): Promise<void> {
    ctx.assertDurableReplayOpen();
    // Kick the commit lane too: atomic envelopes from `commits.create()` may
    // have been left at the head of the lane while the connection was down.
    // Fire-and-forget; processCommitLane serializes itself.
    void ctx.processCommitLane();

    // Collect pending transactions in created order
    const pending = ctx.store.getByStatus('pending').sort((a, b) => a.createdAt - b.createdAt);
    if (pending.length === 0) return;
    const pendingIds = new Set(pending.map((tx) => tx.id));
    // These rows may already be waiting behind the normal batch timer. The
    // reconnect fast path takes ownership of them for this attempt so the same
    // transaction cannot dispatch concurrently through both paths.
    ctx.executionQueue = ctx.executionQueue.filter(
      (tx) => !pendingIds.has(tx.id),
    );

    const remaining = [...pending];
    while (remaining.length > 0) {
      const batch = ctx.takePendingDrainBatch(remaining);
      if (batch.length === 0) break;
      const batchIds = new Set(batch.map((tx) => tx.id));
      const nextRemaining = remaining.filter((tx) => !batchIds.has(tx.id));

      try {
        const idempotencyKey = ctx.ensureCommitEnvelope(batch);
        const projectedOperations = batch.map((tx) => {
          ctx.ensureDerivedFields(tx);
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
        const durableEnvelope = await ctx.sealDurableCommit({
          idempotencyKey,
          origin: 'model_batch',
          operations: projectedOperations,
          sourceMutationIds: ctx.sourceMutationIdsFor(batch),
          createdAt: Math.min(...batch.map((transaction) => transaction.createdAt)),
          sealedAt: batch[0]?.commitEnvelope?.sealedAt ?? Date.now(),
          sequence: batch[0]?.commitEnvelope?.sequence,
        });
        ctx.assertEnvelopeInsideReplayWindow(durableEnvelope);
        const result = ctx.parseMutationCommitResult(
          await ctx.dispatchCommitBounded(durableEnvelope.operations, {
            idempotencyKey,
          }),
        );
        await ctx.persistDurableCommitAcceptance(durableEnvelope, result);
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
              idempotencyKey,
              result.correlationId,
            );
            ctx.scheduleDeltaConfirmationTimeout(
              tx,
              ctx.config.deltaConfirmationTimeout,
            );
          }
          if (batch.every((tx) => tx.status === 'completed')) {
            await ctx.removeDurableCommit(idempotencyKey);
          }
        } else {
          await ctx.removeDurableCommit(idempotencyKey);
          // Mark this request envelope as completed before moving to the next.
          for (const tx of batch) {
            ctx.store.updateStatus(tx.id, 'completed');
            ctx.emit('transaction:completed', tx);
            ctx.emit(`transaction:completed:${tx.id}`, tx);
            ctx.optimisticUpdates.delete(tx.id);
          }
        }
        ctx.runtime.logger.debug('txn:commit', 0, {
          count: batch.length,
          lastSyncId: result.lastSyncId,
        });
        remaining.splice(0, remaining.length, ...nextRemaining);
      } catch (err) {
        // If one request fails, hand it and every later request back to the
        // normal lane. Their envelopes stay attached for safe retry.
        const networkUnavailable = !ctx.runtime.onlineStatus.isOnline();
        const isNetworkError =
          err instanceof Error &&
          (err.message.includes('Failed to fetch') ||
            err.message.includes('Network request failed') ||
            err.message.includes('NetworkError'));

        if (!networkUnavailable || !isNetworkError) {
          ctx.runtime.observability.breadcrumb('Batch flush fallback failed', 'sync.transaction', 'warning', {
            error: err instanceof Error ? err.message : String(err),
          });
        }

        for (const tx of [...batch, ...nextRemaining]) {
          ctx.enqueue(tx);
        }
        return;
      }
    }
}
