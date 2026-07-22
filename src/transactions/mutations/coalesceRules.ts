/**
 * The queue's rules for coalescing operations that touch the same row, so their
 * causal order is preserved. {@link MutationQueue} calls into these through a
 * small store-shaped interface:
 *
 *   - Create-then-delete cancellation ({@link takeUnsentCreateForModel}):
 *     deleting a row whose create never left the client cancels both locally.
 *   - The create barrier ({@link findCreateBarrierForDelete}) and deferred-delete
 *     parking ({@link deferDeleteUntilCreateSettles} /
 *     {@link releaseDeferredDeletesForCreate}): once a create has been sent, a
 *     delete must wait for it to settle, or the server could receive the delete
 *     before the create.
 *   - Update-payload merging ({@link mergeUpdateData}): collapses rapid updates
 *     to the same row into one wire operation.
 *
 * The queue keeps the `enqueue` and `delete` methods that orchestrate optimistic
 * state and events; these functions hold only the coalescing rules.
 */

import type { MutationInput, QueuedMutation } from './commitPayload.js';

/** The subset of {@link MutationStore} that the coalescing rules read. */
export interface MutationStoreLike {
  get(id: string): QueuedMutation | undefined;
  getByStatus(status: QueuedMutation['status']): QueuedMutation[];
}

export const entityKey = (modelName: string, modelId: string): string =>
  `${modelName}:${modelId}`;

const isTransactionForModel = (
  transaction: QueuedMutation,
  modelName: string,
  modelId: string,
): boolean => transaction.modelName === modelName && transaction.modelId === modelId;

/**
 * Finds and removes a create for the given model and id that has never been
 * sent, searching the staging area, the execution queue, and the store's
 * pending bucket in that order. It splices the match out of whichever queue
 * held it, so the caller can cancel it rather than send a create followed by a
 * delete.
 */
export function takeUnsentCreateForModel(
  staged: QueuedMutation[],
  queued: QueuedMutation[],
  store: Pick<MutationStoreLike, 'getByStatus'>,
  modelName: string,
  modelId: string,
): QueuedMutation | undefined {
  const isUnsentCreate = (tx: QueuedMutation): boolean =>
    tx.type === 'create' &&
    tx.status === 'pending' &&
    tx.attempts === 0 &&
    isTransactionForModel(tx, modelName, modelId);

  const stagedIndex = staged.findIndex(isUnsentCreate);
  if (stagedIndex >= 0) {
    return staged.splice(stagedIndex, 1)[0];
  }

  const queuedIndex = queued.findIndex(isUnsentCreate);
  if (queuedIndex >= 0) {
    return queued.splice(queuedIndex, 1)[0];
  }

  return store.getByStatus('pending').find(isUnsentCreate);
}

/**
 * Returns the most recent in-flight create for the given model and id that a
 * delete must wait behind, or undefined if there is none. A pending create that
 * has never been attempted is not a barrier, because it can be cancelled
 * instead; once a create has been sent, even a retry-pending one is a barrier.
 */
export function findCreateBarrierForDelete(
  store: Pick<MutationStoreLike, 'getByStatus'>,
  modelName: string,
  modelId: string,
): QueuedMutation | undefined {
  const liveCreates = [
    ...store.getByStatus('pending'),
    ...store.getByStatus('executing'),
    ...store.getByStatus('awaiting_delta'),
  ].filter((tx) =>
    tx.type === 'create' &&
    isTransactionForModel(tx, modelName, modelId) &&
    // A never-attempted pending create can be cancelled instead. Once the
    // create has been sent, even a retry-pending state is a causal barrier:
    // the server may already have applied it and only the response was lost.
    (tx.status !== 'pending' || tx.attempts > 0)
  );

  return liveCreates.sort((a, b) => b.createdAt - a.createdAt)[0];
}

/**
 * Parks a delete until the create for the same row settles, keyed by the
 * create's model and id. {@link releaseDeferredDeletesForCreate} re-enqueues
 * the parked deletes once that create completes.
 */
export function deferDeleteUntilCreateSettles(
  deferredDeletesByCreate: Map<string, QueuedMutation[]>,
  createTransaction: QueuedMutation,
  deleteTransaction: QueuedMutation,
): void {
  const key = entityKey(createTransaction.modelName, createTransaction.modelId);
  const deferred = deferredDeletesByCreate.get(key) ?? [];
  deferred.push(deleteTransaction);
  deferredDeletesByCreate.set(key, deferred);
}

/**
 * Re-enqueues the deletes parked behind a create once that create settles,
 * skipping any whose status is no longer pending.
 */
export function releaseDeferredDeletesForCreate(
  deferredDeletesByCreate: Map<string, QueuedMutation[]>,
  store: Pick<MutationStoreLike, 'get'>,
  enqueue: (transaction: QueuedMutation) => void,
  createTransaction: QueuedMutation,
): void {
  const key = entityKey(createTransaction.modelName, createTransaction.modelId);
  const deferred = deferredDeletesByCreate.get(key);
  if (!deferred || deferred.length === 0) return;

  deferredDeletesByCreate.delete(key);

  for (const deleteTransaction of deferred) {
    if (store.get(deleteTransaction.id)?.status !== 'pending') continue;
    enqueue(deleteTransaction);
  }
}

/**
 * Merges two update payloads for the same row into one. Later values win, with
 * one exception: a `metadata` field is deep-merged as an object — parsing it
 * first when it arrives as a JSON string — rather than replaced, so partial
 * metadata updates accumulate instead of overwriting each other.
 */
export function mergeUpdateData(
  left: MutationInput | undefined,
  right: MutationInput | undefined,
  _modelName?: string
): MutationInput {
  const out: MutationInput = { ...(left || {}) };
  const src = right || {};

  for (const key of Object.keys(src)) {
    // Special case: metadata payloads may be JSON strings; merge objects instead of clobbering
    if (key === 'metadata') {
      const l = out.metadata;
      const r = src.metadata;

      // If both sides undefined/null, continue
      if (l == null && r == null) {
        continue;
      }

      // Normalize to objects
      const toObj = (v: unknown): Record<string, unknown> => {
        if (v == null) return {};
        if (typeof v === 'string') {
          try {
            return JSON.parse(v);
          } catch {
            return {};
          }
        }
        if (typeof v === 'object') return v as Record<string, unknown>;
        return {};
      };

      const lobj = toObj(l);
      const robj = toObj(r);
      const merged = { ...lobj, ...robj };
      // Re-stringify to match schema input type
      try {
        out.metadata = JSON.stringify(merged);
      } catch {
        // Fallback to right-hand side if stringify fails
        out.metadata = typeof r === 'string' ? r : JSON.stringify(robj || {});
      }
      continue;
    }

    // Default: shallow overwrite with right-hand value
    out[key] = src[key];
  }

  return out;
}
