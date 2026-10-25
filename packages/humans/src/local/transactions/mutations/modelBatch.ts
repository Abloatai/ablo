import type { DurableCommitOperation } from '@abloatai/transaction/commit';
import { hasCommitCoalescingBarrier, hasVersionedFieldInput, type QueuedMutation } from './commitPayload.js';

/** Wire aggregation leaves source payloads, before-images and confirmations intact. */
export function buildModelBatchOperations(members: readonly { tx: QueuedMutation; op: DurableCommitOperation }[]): DurableCommitOperation[] {
  const operations: DurableCommitOperation[] = [];
  const pending = new Map<string, number>();
  for (const { tx, op } of members) {
    const key = JSON.stringify([op.model, op.id]);
    const mergeable = tx.type === 'update' && !tx.fieldIntent && !hasVersionedFieldInput(tx) && !hasCommitCoalescingBarrier(tx.writeOptions);
    const index = mergeable ? pending.get(key) : undefined;
    const previous = index === undefined ? undefined : operations[index];
    if (previous && index !== undefined) {
      operations[index] = { ...op, input: { ...previous.input, ...op.input } };
    } else {
      if (mergeable) pending.set(key, operations.length);
      else pending.delete(key);
      operations.push({ ...op });
    }
  }
  return operations;
}
