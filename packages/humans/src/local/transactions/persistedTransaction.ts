import type { OnStaleMode } from '@abloatai/transaction/coordination/schema';

type ModelData = Record<string, unknown>;

/** One mutation retained in the durable local transaction journal. */
interface PersistedMutation {
  type: 'create' | 'update' | 'delete' | 'archive';
  modelData: ModelData;
  modelName: string;
  timestamp: string;
  writeOptions?: {
    readAt?: number | null;
    onStale?: OnStaleMode | null;
  };
}

/**
 * Persisted transaction for offline/retry support.
 *
 * The index signature is part of the contract: this targets the generic
 * record-shaped storage layer (`InMemoryObjectStore.put` and its IndexedDB
 * equivalent), both of which take `Record<string, unknown>`.
 */
export interface PersistedTransaction {
  id: string;
  type?: string;
  timestamp?: number;
  createdAt?: number;
  mutations?: PersistedMutation[];
  // Awaiting-delta transactions survive a tab close. Reconnect and delta
  // catch-up confirm them during the next session.
  awaitingDelta?: {
    syncIdNeeded: number;
    modelName: string;
    modelId: string;
    operationType: string;
  };
  [key: string]: unknown;
}

/** Compare the stable request identity while ignoring local seal timing. */
export function isSameOutboxRecord(
  existing: PersistedTransaction,
  candidate: PersistedTransaction,
): boolean {
  if (
    existing.type === 'http_commit_envelope' &&
    candidate.type === 'http_commit_envelope'
  ) {
    const identity = (record: PersistedTransaction): unknown => ({
      id: record.id,
      type: record.type,
      storageVersion: record.storageVersion,
      idempotencyKey: record.idempotencyKey,
      // Pre-versioning HTTP outbox rows are v1. Normalizing them preserves
      // idempotency when the same request is resealed after an upgrade.
      protocolVersion: record.protocolVersion ?? 1,
      request: record.request,
      scopeNamespace: record.scopeNamespace,
    });
    if (
      existing.correlationId !== undefined &&
      candidate.correlationId !== undefined &&
      existing.correlationId !== candidate.correlationId
    ) {
      return false;
    }
    return JSON.stringify(identity(existing)) === JSON.stringify(identity(candidate));
  }

  if (
    existing.type === 'commit_envelope' &&
    candidate.type === 'commit_envelope'
  ) {
    const identity = (record: PersistedTransaction): unknown => ({
      id: record.id,
      type: record.type,
      storageVersion: record.storageVersion,
      origin: record.origin,
      idempotencyKey: record.idempotencyKey,
      operations: record.operations,
      sourceMutationIds: record.sourceMutationIds,
      commitOptions: record.commitOptions,
      scope: record.scope,
    });
    if (
      existing.correlationId !== undefined &&
      candidate.correlationId !== undefined &&
      existing.correlationId !== candidate.correlationId
    ) {
      return false;
    }
    return JSON.stringify(identity(existing)) === JSON.stringify(identity(candidate));
  }

  return JSON.stringify(existing) === JSON.stringify(candidate);
}

/** An accepted envelope may replace the otherwise-identical pending envelope. */
export function isAcceptedOutboxPromotion(
  existing: PersistedTransaction | undefined,
  candidate: PersistedTransaction,
): boolean {
  return (
    existing !== undefined &&
    (existing.type === 'commit_envelope' ||
      existing.type === 'http_commit_envelope') &&
    existing.type === candidate.type &&
    existing.acceptedAt === undefined &&
    candidate.acceptedAt !== undefined
  );
}
