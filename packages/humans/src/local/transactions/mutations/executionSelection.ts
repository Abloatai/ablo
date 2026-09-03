import type { QueuedMutation } from './commitPayload.js';

export function takeNextExecutionBatch(
  executionQueue: QueuedMutation[],
  maxBatchSize: number,
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
  const fresh = pendingQueue.filter((tx) => !tx.commitEnvelope);
  const firstFresh = fresh[0];
  if (!firstFresh) return { batch: [], remaining: pendingQueue };
  const explicitIndex = fresh.findIndex((tx) => typeof tx.writeOptions?.idempotencyKey === 'string');
  const selected = explicitIndex === 0
    ? [firstFresh]
    : fresh.slice(0, Math.min(maxBatchSize, explicitIndex > 0 ? explicitIndex : fresh.length));
  const selectedIds = new Set(selected.map((tx) => tx.id));
  return { batch: selected, remaining: pendingQueue.filter((tx) => !selectedIds.has(tx.id)) };
}
