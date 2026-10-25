import type { QueuedMutation } from './commitPayload.js';
import { hasCommitCoalescingBarrier, hasVersionedFieldInput } from './commitPayload.js';

export interface ExecutionQueueContext {
  readonly executionQueue: QueuedMutation[];
  readonly ensureDerivedFields: (transaction: QueuedMutation) => void;
  readonly scheduleProcessing: (immediate: boolean) => void;
}

/** Every caller stays in the primary ledger until its own confirmation settles. */
export function enqueueTransaction(ctx: ExecutionQueueContext, transaction: QueuedMutation): void {
  if (transaction.status !== 'pending' || ctx.executionQueue.some((candidate) => candidate.id === transaction.id)) return;
  ctx.ensureDerivedFields(transaction);
  if (transaction.priority === 'high') ctx.executionQueue.unshift(transaction);
  else ctx.executionQueue.push(transaction);
  ctx.scheduleProcessing(transaction.priority === 'high');
}

export function takeNextExecutionBatch(
  executionQueue: QueuedMutation[],
  maxBatchSize: number,
  outstanding: readonly QueuedMutation[] = executionQueue,
): { batch: QueuedMutation[]; remaining: QueuedMutation[] } {
  // Cancellation, delta confirmation, and failure settlement can all make a
  // queued reference terminal before its scheduler callback runs. Terminal or
  // currently executing rows have no authority to cross the dispatch boundary.
  const pendingQueue = executionQueue.filter((tx) => tx.status === 'pending');
  const retryGroups = new Map<string, Map<string, QueuedMutation>>();
  for (const tx of pendingQueue) {
    const envelope = tx.commitEnvelope;
    if (!envelope) continue;
    const group = retryGroups.get(envelope.idempotencyKey) ?? new Map<string, QueuedMutation>();
    group.set(tx.id, tx);
    retryGroups.set(envelope.idempotencyKey, group);
  }
  for (const [idempotencyKey, byId] of retryGroups) {
    const members = [...byId.values()];
    const expectedCount = members[0]?.commitEnvelope?.operationCount;
    if (expectedCount === undefined || members.length !== expectedCount) continue;
    const remaining = pendingQueue.filter((tx) => tx.commitEnvelope?.idempotencyKey !== idempotencyKey);
    members.sort((a, b) => (a.commitEnvelope?.operationIndex ?? 0) - (b.commitEnvelope?.operationIndex ?? 0));
    return { batch: members, remaining };
  }
  // A sealed request in retry backoff still owns its row's earlier position.
  const sealedRows = new Set(outstanding.filter((tx) => tx.commitEnvelope &&
    (tx.status === 'pending' || tx.status === 'executing'))
    .map((tx) => JSON.stringify([tx.modelName, tx.modelId])));
  for (const tx of outstanding) {
    if (tx.status === 'pending' && !pendingQueue.some((candidate) => candidate.id === tx.id)) {
      sealedRows.add(JSON.stringify([tx.modelName, tx.modelId]));
    }
  }
  const fresh = pendingQueue.filter((tx) => !tx.commitEnvelope && !sealedRows.has(JSON.stringify([tx.modelName, tx.modelId])));
  const firstFresh = fresh[0];
  if (!firstFresh) return { batch: [], remaining: pendingQueue };
  const explicitIndex = fresh.findIndex((tx) => typeof tx.writeOptions?.idempotencyKey === 'string');
  const candidates = explicitIndex === 0
    ? [firstFresh]
    : fresh.slice(0, Math.min(maxBatchSize, explicitIndex > 0 ? explicitIndex : fresh.length));
  const selected: QueuedMutation[] = [];
  const blockedRows = new Set<string>();
  for (const candidate of candidates) {
    const key = JSON.stringify([candidate.modelName, candidate.modelId]);
    if (blockedRows.has(key)) continue;
    const prior = selected.find((tx) => tx.modelName === candidate.modelName && tx.modelId === candidate.modelId);
    if (prior && (hasVersionedFieldInput(prior) || hasVersionedFieldInput(candidate) ||
      hasCommitCoalescingBarrier(prior.writeOptions) || hasCommitCoalescingBarrier(candidate.writeOptions))) {
      blockedRows.add(key);
      continue;
    }
    selected.push(candidate);
  }
  const selectedIds = new Set(selected.map((tx) => tx.id));
  return { batch: selected, remaining: pendingQueue.filter((tx) => !selectedIds.has(tx.id)) };
}
