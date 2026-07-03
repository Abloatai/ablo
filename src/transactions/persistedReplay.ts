/**
 * persistedReplay — the Zod boundary for IDB → commit replay (T1.8).
 *
 * Rows read back from the persisted-transaction store were written by a
 * PREVIOUS session — possibly by an older SDK version, possibly corrupted.
 * Spreading them straight into a `Transaction` re-entered the commit path
 * with zero validation. These schemas validate exactly the fields the queue
 * (and the offline mutation-queue restore) actually read on replay; rows
 * that don't parse are DROPPED (and surfaced through observability), never
 * replayed as garbage commits.
 *
 * The same IDB store also holds two NON-replayable row kinds written by
 * other subsystems — the `'queue'` record (`SyncClient.persistMutationQueue`)
 * and `'awaiting_delta'` markers (`setupAwaitingTransactionPersistence`).
 * Those are recognized and skipped silently: they are expected neighbors,
 * not corruption.
 */

import { z } from 'zod';
import type { Transaction } from './commitPayload.js';
import { computePriorityScore, normalizeModelKey } from './commitPayload.js';

/** Write-option subset persisted per transaction / mutation. */
const persistedWriteOptionsSchema = z
  .object({
    readAt: z.number().nullable().optional(),
    onStale: z.enum(['reject', 'overwrite', 'notify']).nullable().optional(),
    idempotencyKey: z.string().optional(),
    label: z.string().optional(),
  })
  .passthrough();

/**
 * A replayable persisted transaction — the fields `TransactionQueue`
 * actually reads when re-enqueueing (id/type/model addressing + payload +
 * identity context). Everything else is defaulted at rehydration time.
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
    writeOptions: persistedWriteOptionsSchema.optional(),
    localOnly: z.boolean().optional(),
  })
  .passthrough();

export type PersistedReplayableTransaction = z.infer<typeof persistedTransactionSchema>;

/** Row kinds that share the store but are owned by other subsystems. */
const NON_REPLAYABLE_TYPES = new Set(['queue', 'awaiting_delta']);

/** Whether a persisted row belongs to another subsystem (skip, don't flag). */
export function isNonReplayablePersistedRow(row: unknown): boolean {
  return (
    typeof row === 'object' &&
    row !== null &&
    typeof (row as { type?: unknown }).type === 'string' &&
    NON_REPLAYABLE_TYPES.has((row as { type: string }).type)
  );
}

/**
 * Validate + rehydrate one persisted row into a replayable `Transaction`,
 * or `null` when the row doesn't parse. Missing bookkeeping fields are
 * re-derived exactly like a fresh staging would derive them.
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
    ...(tx.writeOptions !== undefined ? { writeOptions: tx.writeOptions } : {}),
    ...(tx.localOnly !== undefined ? { localOnly: tx.localOnly } : {}),
  };
}

/**
 * One entry of the persisted offline mutation queue (the `'queue'` row's
 * `mutations` array) — the fields `SyncClient.restoreMutationQueue` reads.
 */
export const persistedMutationSchema = z
  .object({
    type: z.enum(['create', 'update', 'delete', 'archive']),
    modelData: z.record(z.string(), z.unknown()),
    modelName: z.string().min(1),
    timestamp: z.string(),
    writeOptions: persistedWriteOptionsSchema.optional(),
  })
  .passthrough();

export type PersistedQueuedMutation = z.infer<typeof persistedMutationSchema>;
