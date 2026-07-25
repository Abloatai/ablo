import type { RuntimeContext } from '../../RuntimeContext.js';
import type { MutationPersistencePort } from '../../mutationPersistence.js';
import type { MutationQueueConfig } from './MutationQueue.js';
import type { CommitOutboxScope } from '@abloatai/transaction/transactions/settlement/commitEnvelope';
import type { QueuedMutation } from './commitPayload.js';
import { MutationStore } from './MutationStore.js';
import { normalizeModelKey } from './commitPayload.js';
import {
  deserializePersistedTransaction,
  legacyPendingMutationRecordSchema,
  pendingMutationRecordId,
  pendingMutationRecordSchema,
  persistedMutationSchema,
} from './replayValidation.js';

export interface MutationPersistenceContext {
  readonly runtime: RuntimeContext;
  readonly persistence: MutationPersistencePort | null;
  readonly commitOutboxScope: CommitOutboxScope | null;
  readonly config: Pick<MutationQueueConfig, 'enablePersistence'>;
  readonly store: MutationStore;
  readonly enqueue: (transaction: QueuedMutation) => void;
  readonly computePriorityScore: (type: QueuedMutation['type'], modelName: string) => number;
  readonly deserializeTransaction: (data: Parameters<typeof deserializePersistedTransaction>[0]) => QueuedMutation | null;
}

export async function persistQueuedTransaction(
    ctx: MutationPersistenceContext,
    transaction: QueuedMutation,
    modelData?: Record<string, unknown>,
  ): Promise<void> {
    if (!ctx.persistence) return;
    const mutationId = transaction.sourceMutationIds?.[0] ?? transaction.id;
    if (modelData && ctx.commitOutboxScope) {
      await ctx.persistence.saveTransaction({
        id: pendingMutationRecordId(mutationId),
        type: 'pending_mutation',
        storageVersion: 2,
        mutation: {
          mutationId,
          type: transaction.type,
          modelData,
          modelName: transaction.modelName,
          timestamp: new Date(transaction.createdAt).toISOString(),
          ...(transaction.type === 'update' && transaction.data
            ? { capturedChanges: transaction.data }
            : {}),
          ...(transaction.writeOptions !== undefined
            ? { writeOptions: transaction.writeOptions }
            : {}),
        },
        scope: ctx.commitOutboxScope,
        timestamp: transaction.createdAt,
      });
      return;
    }
    await ctx.persistence.saveTransaction({
      id: transaction.id,
      type: transaction.type,
      modelName: transaction.modelName,
      modelId: transaction.modelId,
      modelKey: transaction.modelKey,
      ...(transaction.data !== undefined ? { data: transaction.data } : {}),
      ...(transaction.previousData !== undefined ? { previousData: transaction.previousData } : {}),
      context: transaction.context,
      createdAt: transaction.createdAt,
      ...(transaction.writeOptions !== undefined ? { writeOptions: transaction.writeOptions } : {}),
      ...(transaction.sourceMutationIds !== undefined
        ? { sourceMutationIds: transaction.sourceMutationIds }
        : {}),
    });
  }


export function removePersistedTransaction(ctx: MutationPersistenceContext, transactionId: string): void {
    const ids = [transactionId, pendingMutationRecordId(transactionId), ...(
      ctx.store.get(transactionId)?.sourceMutationIds ?? []
    ).map(pendingMutationRecordId)];
    for (const id of ids) {
      void ctx.persistence?.removeTransaction(id).catch(() => undefined);
    }
  }


export function settlePersistedFailure(ctx: MutationPersistenceContext, transaction: { id?: string; sourceMutationIds?: string[] }): void {
    const sourceIds = new Set(transaction.sourceMutationIds ?? []);
    const queued = transaction.id
      ? ctx.store.get(transaction.id)
      : undefined;
    const match = queued ?? ctx.store.getAll().find((candidate) =>
      candidate.id === transaction.id ||
      sourceIds.has(candidate.id) ||
      (candidate.sourceMutationIds ?? []).some((id) => sourceIds.has(id)),
    );
    if (match) {
      ctx.store.updateStatus(match.id, 'failed');
      removePersistedTransaction(ctx, match.id);
    }
    for (const sourceId of sourceIds) removePersistedTransaction(ctx, sourceId);
  }


export function deserializeLegacyPendingMutation(
    ctx: MutationPersistenceContext,
    row: object,
    fallbackMutationId?: string,
  ): QueuedMutation | null {
    const rowType = (row as { type?: string }).type;
    const parsed = persistedMutationSchema.safeParse(
      rowType === 'pending_mutation'
        ? (pendingMutationRecordSchema.safeParse(row).success
          ? pendingMutationRecordSchema.parse(row).mutation
          : legacyPendingMutationRecordSchema.safeParse(row).success
            ? legacyPendingMutationRecordSchema.parse(row).mutation
            : null)
        : row,
    );
    if (!parsed.success) return null;
    const mutation = parsed.data;
    const writtenAt = Date.parse(mutation.timestamp);
    if (!Number.isFinite(writtenAt) || Date.now() - writtenAt >= 23 * 60 * 60 * 1000) {
      return null;
    }
    const mutationId = mutation.mutationId ?? fallbackMutationId;
    const modelId = mutation.modelData.id;
    if (!mutationId || typeof modelId !== 'string') return null;
    const scope = ctx.commitOutboxScope;
    if (!scope) return null;
    const type = mutation.type;
    return {
      id: mutationId,
      type,
      modelName: mutation.modelName,
      modelId,
      modelKey: normalizeModelKey(mutation.modelName),
      ...(type === 'create'
        ? { data: mutation.modelData }
        : type === 'update'
          ? { data: mutation.capturedChanges ?? mutation.modelData }
          : {}),
      ...(type === 'delete' || type === 'archive'
        ? { previousData: mutation.modelData }
        : { previousData: null }),
      context: {
        userId: scope.participantId,
        organizationId: scope.organizationId,
      },
      status: 'pending',
      createdAt: Date.parse(mutation.timestamp) || Date.now(),
      attempts: 0,
      priority: 'normal',
      priorityScore: ctx.computePriorityScore(type, mutation.modelName),
      ...(mutation.writeOptions !== undefined ? { writeOptions: mutation.writeOptions } : {}),
      sourceMutationIds: [mutationId],
    };
  }


export async function loadPersistedTransactions(
    ctx: MutationPersistenceContext,
    persistence: MutationPersistencePort,
    sealedMutationIds: ReadonlySet<string> = new Set(),
  ): Promise<void> {
    if (!ctx.config.enablePersistence) return;

    try {
      const persisted = await persistence.getPersistedTransactions();

      for (const data of persisted) {
        if (data.type === 'pending_mutation') {
          const legacy = deserializeLegacyPendingMutation(ctx, data);
          if (legacy) {
            const v1 = legacyPendingMutationRecordSchema.safeParse(data);
            if (v1.success && ctx.commitOutboxScope) {
              await persistence.saveTransaction({
                ...data,
                storageVersion: 2,
                scope: ctx.commitOutboxScope,
              });
            }
            legacy.id = String(data.id);
            ctx.store.add(legacy);
            ctx.enqueue(legacy);
          } else {
            ctx.runtime.logger.debug('[SyncClient] Dropping malformed persisted mutation', {
              rowId: data.id,
            });
          }
          continue;
        }
        if (data.id === 'mutation-queue' && Array.isArray(data.mutations)) {
          if (data.mutations.length === 0) continue;
          let migrated = true;
          for (const [index, mutation] of data.mutations.entries()) {
            if (typeof mutation !== 'object' || mutation === null) {
              migrated = false;
              continue;
            }
            const transaction = deserializeLegacyPendingMutation(ctx,
              mutation,
              `legacy_mutation_${index}`,
            );
            if (!transaction) {
              migrated = false;
              ctx.runtime.logger.debug('[SyncClient] Dropping malformed persisted mutation', {
                rowId: `mutation-queue:${index}`,
              });
              continue;
            }
            await persistQueuedTransaction(ctx, transaction);
            ctx.store.add(transaction);
            ctx.enqueue(transaction);
          }
          if (migrated) await persistence.removeTransaction(data.id);
          continue;
        }
        const transaction = ctx.deserializeTransaction(data);
        if (!transaction) continue;
        if ((transaction.sourceMutationIds ?? []).some((id) => sealedMutationIds.has(id))) {
          continue;
        }
        ctx.store.add(transaction);
        ctx.enqueue(transaction);
      }
    } catch (error) {
      ctx.runtime.observability.captureMutationFailure({
        context: 'load-persisted-transactions',
        error: error instanceof Error ? error : String(error),
      });
    }
  }
