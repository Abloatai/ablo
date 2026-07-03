/**
 * Coalescing rules — the queue's same-entity causality guards, lifted out of
 * `TransactionQueue.ts` as a leaf over a minimal store-shaped interface:
 *
 *   • create-then-delete cancellation (`takeUnsentCreateForModel`): a delete
 *     of a row whose create never left the client cancels both locally;
 *   • the create barrier (`findCreateBarrierForDelete`) + deferred-delete
 *     parking (`deferDeleteUntilCreateSettles` / `release…`): once a create
 *     HAS been sent, a delete must wait for it to settle or the server could
 *     see DELETE-before-CREATE;
 *   • update-payload merging (`mergeUpdateData`): collapses rapid same-entity
 *     updates into one wire op.
 *
 * The queue's `enqueue`/`delete` verbs stay in the host (they orchestrate
 * optimistic state + events); the RULES live here.
 */

import type { MutationInput, Transaction } from './commitPayload.js';

/** The slice of `TransactionStore` the coalescing rules read. */
export interface TransactionStoreLike {
  get(id: string): Transaction | undefined;
  getByStatus(status: Transaction['status']): Transaction[];
}

export const entityKey = (modelName: string, modelId: string): string =>
  `${modelName}:${modelId}`;

const isTransactionForModel = (
  transaction: Transaction,
  modelName: string,
  modelId: string,
): boolean => transaction.modelName === modelName && transaction.modelId === modelId;

/**
 * Find-and-remove a create for (model, id) that has never been sent —
 * checking the microtask staging area, the execution queue, and the store's
 * pending bucket, in that order. Splices the winner out of whichever queue
 * held it so the caller can cancel it instead of shipping create+delete.
 */
export function takeUnsentCreateForModel(
  staged: Transaction[],
  queued: Transaction[],
  store: Pick<TransactionStoreLike, 'getByStatus'>,
  modelName: string,
  modelId: string,
): Transaction | undefined {
  const isUnsentCreate = (tx: Transaction): boolean =>
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

export function findCreateBarrierForDelete(
  store: Pick<TransactionStoreLike, 'getByStatus'>,
  modelName: string,
  modelId: string,
): Transaction | undefined {
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

export function deferDeleteUntilCreateSettles(
  deferredDeletesByCreate: Map<string, Transaction[]>,
  createTransaction: Transaction,
  deleteTransaction: Transaction,
): void {
  const key = entityKey(createTransaction.modelName, createTransaction.modelId);
  const deferred = deferredDeletesByCreate.get(key) ?? [];
  deferred.push(deleteTransaction);
  deferredDeletesByCreate.set(key, deferred);
}

export function releaseDeferredDeletesForCreate(
  deferredDeletesByCreate: Map<string, Transaction[]>,
  store: Pick<TransactionStoreLike, 'get'>,
  enqueue: (transaction: Transaction) => void,
  createTransaction: Transaction,
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

// Merge two GraphQL update payloads with special handling for metadata fields
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
