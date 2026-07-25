import type { QueuedMutation } from './commitPayload.js';

export function takeNextExecutionBatch(
  executionQueue: QueuedMutation[],
  maxBatchSize: number,
): { batch: QueuedMutation[]; remaining: QueuedMutation[] } {
  const retryGroups = new Map<string, Map<string, QueuedMutation>>();
  for (const tx of executionQueue) {
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
    const remaining = executionQueue.filter((tx) => tx.commitEnvelope?.idempotencyKey !== idempotencyKey);
    members.sort((a, b) => (a.commitEnvelope?.operationIndex ?? 0) - (b.commitEnvelope?.operationIndex ?? 0));
    return { batch: members, remaining };
  }
  const fresh = executionQueue.filter((tx) => !tx.commitEnvelope);
  const firstFresh = fresh[0];
  if (!firstFresh) return { batch: [], remaining: executionQueue };
  const explicitIndex = fresh.findIndex((tx) => typeof tx.writeOptions?.idempotencyKey === 'string');
  const selected = explicitIndex === 0
    ? [firstFresh]
    : fresh.slice(0, Math.min(maxBatchSize, explicitIndex > 0 ? explicitIndex : fresh.length));
  const selectedIds = new Set(selected.map((tx) => tx.id));
  return { batch: selected, remaining: executionQueue.filter((tx) => !selectedIds.has(tx.id)) };
}

export function takePendingDrainBatch(pending: QueuedMutation[], maxBatchSize: number): QueuedMutation[] {
  const first = pending[0];
  if (!first) return [];
  const envelope = first.commitEnvelope;
  if (envelope) return pending.filter((tx) => tx.commitEnvelope?.idempotencyKey === envelope.idempotencyKey);
  if (typeof first.writeOptions?.idempotencyKey === 'string') return [first];
  const explicitIndex = pending.findIndex((tx) => typeof tx.writeOptions?.idempotencyKey === 'string');
  return pending.slice(0, Math.min(maxBatchSize, explicitIndex > 0 ? explicitIndex : pending.length));
}
