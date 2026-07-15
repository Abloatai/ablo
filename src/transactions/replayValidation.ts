/**
 * The validation boundary for replaying persisted transactions after a restart.
 *
 * Rows read back from the on-disk transaction store may have been written by an
 * earlier run — possibly by an older version of this package, possibly
 * corrupted. Rather than trust them, the schemas here validate exactly the
 * fields the transaction queue and the offline-mutation restore read during
 * replay. A row that fails to parse is dropped and reported, never replayed as
 * a malformed commit.
 *
 * The same store also holds two kinds of rows that are not replayable
 * transactions — the offline mutation queue (`type: 'queue'`) and delta-await
 * markers (`type: 'awaiting_delta'`), each owned by another part of the client.
 * {@link isNonReplayablePersistedRow} recognizes them so they are skipped
 * quietly rather than flagged as corruption.
 */

import { z } from 'zod';
import type { Transaction } from './commitPayload.js';
import { computePriorityScore, normalizeModelKey } from './commitPayload.js';
import {
  commitEnvelopeMemberSchema,
  commitOutboxScopeSchema,
} from './commitEnvelope.js';

/** The subset of a write's options that is stored with each transaction or queued mutation. */
const persistedWriteOptionsSchema = z
  .object({
    readAt: z.number().nullable().optional(),
    onStale: z.enum(['reject', 'overwrite', 'notify']).nullable().optional(),
    idempotencyKey: z.string().optional(),
    label: z.string().optional(),
    // Aligned with the `WriteOptions` type: a claimed write persisted offline
    // must replay carrying its fencing token (Option B), or a queued write that
    // survives a reload would lose its fence and could land as a stale blind
    // write. Declared (not just loose-passthrough) so it is validated as a
    // number on rehydration.
    fenceToken: z.number().nullable().optional(),
  })
  .loose();

/**
 * The shape of a persisted transaction that can be replayed: the fields the
 * transaction queue reads when it re-enqueues the row — its id, operation type,
 * model addressing, payload, and identity context. Any remaining bookkeeping is
 * filled in with defaults when the row is rehydrated by
 * {@link deserializePersistedTransaction}.
 */
export const persistedTransactionSchema = z
  .object({
    id: z.string().min(1),
    type: z.enum(['create', 'update', 'delete', 'archive', 'unarchive']),
    modelName: z.string().min(1),
    modelId: z.string().min(1),
    modelKey: z.string().min(1).optional(),
    data: z.record(z.string(), z.unknown()).optional(),
    previousData: z.record(z.string(), z.unknown()).nullable().optional(),
    context: z.object({
      userId: z.string().min(1),
      organizationId: z.string().min(1),
      role: z.string().optional(),
      teamIds: z.array(z.string()).optional(),
    }),
    createdAt: z.number().optional(),
    batchId: z.string().optional(),
    commitEnvelope: commitEnvelopeMemberSchema.optional(),
    sourceMutationIds: z.array(z.string().min(1)).optional(),
    writeOptions: persistedWriteOptionsSchema.optional(),
    localOnly: z.boolean().optional(),
  })
  .loose();

export type PersistedReplayableTransaction = z.infer<typeof persistedTransactionSchema>;

/** The `type` values of stored rows that belong to other parts of the client and are not replayable transactions. */
const NON_REPLAYABLE_TYPES = new Set([
  'queue',
  'awaiting_delta',
  'pending_mutation',
  'commit_envelope',
  'http_commit_envelope',
]);

/**
 * Reports whether a stored row is one of the non-transaction kinds, so callers
 * skip it instead of treating it as a corrupt transaction.
 */
export function isNonReplayablePersistedRow(row: unknown): boolean {
  return (
    typeof row === 'object' &&
    row !== null &&
    typeof (row as { type?: unknown }).type === 'string' &&
    NON_REPLAYABLE_TYPES.has((row as { type: string }).type)
  );
}

/**
 * Validates one stored row and rehydrates it into a {@link Transaction} ready
 * to replay, or returns `null` when the row fails validation. Bookkeeping
 * fields the stored row lacks — status, attempts, priority, timestamp — are
 * re-derived the same way a freshly staged transaction derives them.
 */
export function deserializePersistedTransaction(row: unknown): Transaction | null {
  const parsed = persistedTransactionSchema.safeParse(row);
  if (!parsed.success) return null;
  const tx = parsed.data;
  return {
    id: tx.id,
    type: tx.type,
    modelName: tx.modelName,
    modelId: tx.modelId,
    modelKey: tx.modelKey ?? normalizeModelKey(tx.modelName),
    ...(tx.data !== undefined ? { data: tx.data } : {}),
    ...(tx.previousData !== undefined ? { previousData: tx.previousData } : {}),
    context: tx.context,
    status: 'pending',
    createdAt: tx.createdAt ?? Date.now(),
    attempts: 0,
    priority: 'normal',
    priorityScore: computePriorityScore(tx.type, tx.modelName),
    ...(tx.batchId !== undefined ? { batchId: tx.batchId } : {}),
    ...(tx.commitEnvelope !== undefined
      ? { commitEnvelope: tx.commitEnvelope }
      : {}),
    ...(tx.sourceMutationIds !== undefined
      ? { sourceMutationIds: tx.sourceMutationIds }
      : {}),
    ...(tx.writeOptions !== undefined ? { writeOptions: tx.writeOptions } : {}),
    ...(tx.localOnly !== undefined ? { localOnly: tx.localOnly } : {}),
  };
}

/**
 * The shape of one entry in the persisted offline mutation queue — an item of
 * the `'queue'` row's `mutations` array, carrying the fields read when the
 * queue is restored on reconnect.
 */
export const persistedMutationSchema = z
  .object({
    mutationId: z.string().min(1).optional(),
    type: z.enum(['create', 'update', 'delete', 'archive']),
    modelData: z.record(z.string(), z.unknown()),
    modelName: z.string().min(1),
    timestamp: z.string(),
    capturedChanges: z.record(z.string(), z.unknown()).optional(),
    writeOptions: persistedWriteOptionsSchema.optional(),
  })
  .loose();

export type PersistedQueuedMutation = z.infer<typeof persistedMutationSchema>;

export const PENDING_MUTATION_RECORD_PREFIX = 'pending-mutation:';

/**
 * Stay one hour inside the server's 24-hour idempotency retention window.
 * A journaled write older than this can no longer be deduplicated by the
 * server, so restore holds it for review instead of replaying it.
 */
export const PENDING_MUTATION_REPLAY_WINDOW_MS = 23 * 60 * 60 * 1000;

const pendingMutationRecordBaseShape = {
  id: z.string().startsWith(PENDING_MUTATION_RECORD_PREFIX),
  type: z.literal('pending_mutation'),
  mutation: persistedMutationSchema.extend({
    mutationId: z.string().min(1),
  }),
  timestamp: z.number().int().nonnegative(),
} as const;

/** Scope-less records written by the first aggregate-journal release. */
export const legacyPendingMutationRecordSchema = z.strictObject({
  ...pendingMutationRecordBaseShape,
  storageVersion: z.literal(1),
});

export const pendingMutationRecordSchema = z.strictObject({
  ...pendingMutationRecordBaseShape,
  storageVersion: z.literal(2),
  scope: commitOutboxScopeSchema,
});

export type PendingMutationRecord = z.infer<typeof pendingMutationRecordSchema>;

export function pendingMutationRecordId(mutationId: string): string {
  return `${PENDING_MUTATION_RECORD_PREFIX}${mutationId}`;
}
