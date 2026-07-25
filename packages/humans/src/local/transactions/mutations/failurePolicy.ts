import type { MutationInput, QueuedMutation } from './commitPayload.js';
import { asTransportError, extractStatusCode } from './commitPayload.js';
import { mergeUpdateData } from './coalesceRules.js';
import { AbloConnectionError, errorCodeSpec } from '@ablo/transaction/errors';
import type { MutationQueueConfig } from './MutationQueue.js';
import type { MutationStore } from './MutationStore.js';

export function isPermanentError(error: Error): boolean {
  if (error instanceof AbloConnectionError) return false;
  const code = (error as { code?: string }).code;
  const spec = code ? errorCodeSpec(code) : undefined;
  if (spec) return !spec.retryable;
  const message = error.message.toLowerCase();
  if (['failed to fetch', 'network error', 'networkerror', 'connection refused', 'connection reset', 'timeout', 'econnrefused', 'econnreset', 'etimedout', 'socket hang up'].some((value) => message.includes(value))) return false;
  const status = extractStatusCode(error);
  if (status !== undefined) return status < 500 && status !== 429;
  return !(asTransportError(error).response?.errors?.length);
}

export function isDefinitiveRejection(error: Error): boolean {
  const code = (error as { code?: string }).code;
  const spec = code ? errorCodeSpec(code) : undefined;
  if (spec) return !spec.retryable;
  const status = extractStatusCode(error);
  return status !== undefined && status >= 400 && status < 500 && status !== 429;
}

export interface ConflictPolicyContext {
  readonly config: Pick<MutationQueueConfig, 'conflictResolution'>;
  readonly store: MutationStore;
  readonly rollbackOptimistic: (transaction: QueuedMutation, reason: string) => Promise<void>;
  readonly mergeData: (local: MutationInput | undefined, remote: MutationInput) => MutationInput;
  readonly enqueue: (transaction: QueuedMutation) => void;
}

export async function handleConflict(
  ctx: ConflictPolicyContext,
  transaction: QueuedMutation,
  serverData: MutationInput,
): Promise<void> {
  const { strategy, resolver } = ctx.config.conflictResolution;
  switch (strategy) {
    case 'last-write-wins':
      ctx.store.updateStatus(transaction.id, 'rolled_back');
      await ctx.rollbackOptimistic(transaction, 'conflict_server_wins');
      break;
    case 'merge':
      transaction.data = ctx.mergeData(transaction.data, serverData);
      ctx.enqueue(transaction);
      break;
    case 'reject':
      ctx.enqueue(transaction);
      break;
    case 'custom':
      if (resolver) {
        transaction.data = resolver(transaction.data, serverData);
        ctx.enqueue(transaction);
      }
      break;
  }
}
