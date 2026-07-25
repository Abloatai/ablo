import type { QueuedMutation } from './commitPayload.js';
import { mergeUpdateData } from './coalesceRules.js';
import { hasCommitCoalescingBarrier } from './commitPayload.js';

export interface QueueCoalescingContext {
  readonly executionQueue: QueuedMutation[];
  readonly inFlightByModel: Set<string>;
  readonly pendingMergeByModel: Map<string, { data: QueuedMutation['data']; sourceMutationIds: string[] }>;
  readonly ensureDerivedFields: (transaction: QueuedMutation) => void;
  readonly scheduleProcessing: (immediate: boolean) => void;
  readonly storeRemove: (transactionId: string) => void;
}

export function enqueueTransaction(ctx: QueueCoalescingContext, transaction: QueuedMutation): void {
  ctx.ensureDerivedFields(transaction);
  const modelKey = `${transaction.modelName}:${transaction.modelId}`;
  if (transaction.type === 'update' && transaction.attempts === 0 && !transaction.commitEnvelope) {
    const preserveWatermark = hasCommitCoalescingBarrier(transaction.writeOptions);
    if (!preserveWatermark && ctx.inFlightByModel.has(modelKey)) {
      const previous = ctx.pendingMergeByModel.get(modelKey);
      const merged = mergeUpdateData(previous?.data ?? {}, transaction.data || {}, transaction.modelName);
      ctx.pendingMergeByModel.set(modelKey, {
        data: merged,
        sourceMutationIds: [...new Set([...(previous?.sourceMutationIds ?? []), ...(transaction.sourceMutationIds ?? [])])],
      });
      ctx.storeRemove(transaction.id);
      return;
    }
    const pendingInQueue = ctx.executionQueue.find((candidate) =>
      candidate.id !== transaction.id && candidate.type === 'update' &&
      candidate.modelId === transaction.modelId && candidate.modelName === transaction.modelName &&
      !hasCommitCoalescingBarrier(candidate.writeOptions));
    if (!preserveWatermark && pendingInQueue) {
      pendingInQueue.data = mergeUpdateData(pendingInQueue.data || {}, transaction.data || {}, transaction.modelName);
      pendingInQueue.sourceMutationIds = [...new Set([
        ...(pendingInQueue.sourceMutationIds ?? []), ...(transaction.sourceMutationIds ?? []),
      ])];
      ctx.storeRemove(transaction.id);
      return;
    }
  }
  if (transaction.priority === 'high') ctx.executionQueue.unshift(transaction);
  else ctx.executionQueue.push(transaction);
  ctx.scheduleProcessing(transaction.priority === 'high');
}
