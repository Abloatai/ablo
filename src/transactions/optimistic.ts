/**
 * Optimistic apply/rollback — the queue's local-first bookkeeping, lifted out
 * of `TransactionQueue.ts` as a pure leaf. The queue never mutates the pool
 * itself: applying/rolling back records an entry in the host-owned ledger and
 * emits `optimistic:*` events that the pool-side listeners act on. These
 * functions take that ledger plus a minimal emitter interface (never the host
 * class type), so the rules stay cycle-free and testable in isolation.
 */

import type { Model } from '../Model.js';
import type { MutationInput, Transaction } from './commitPayload.js';

/** One tracked optimistic mutation: the live model + its pre-image. */
export interface OptimisticUpdateEntry {
  model: Model;
  previousState: MutationInput | null | undefined;
  transaction: Transaction;
}

/** The host's event surface — the only queue capability these rules need. */
export interface OptimisticEmitter {
  emit(event: string, payload: unknown): void;
}

export function applyOptimisticCreate(
  optimisticUpdates: Map<string, OptimisticUpdateEntry>,
  emitter: OptimisticEmitter,
  model: Model,
  transaction: Transaction,
): void {
  optimisticUpdates.set(transaction.id, {
    model,
    previousState: null,
    transaction,
  });

  emitter.emit('optimistic:create', { model, transaction });
}

export function applyOptimisticUpdate(
  optimisticUpdates: Map<string, OptimisticUpdateEntry>,
  emitter: OptimisticEmitter,
  model: Model,
  transaction: Transaction,
): void {
  optimisticUpdates.set(transaction.id, {
    model,
    previousState: transaction.previousData,
    transaction,
  });

  emitter.emit('optimistic:update', { model, transaction });
}

export function applyOptimisticDelete(
  optimisticUpdates: Map<string, OptimisticUpdateEntry>,
  emitter: OptimisticEmitter,
  model: Model,
  transaction: Transaction,
): void {
  optimisticUpdates.set(transaction.id, {
    model,
    previousState: transaction.previousData,
    transaction,
  });

  emitter.emit('optimistic:delete', { model, transaction });
}

export async function rollbackOptimistic(
  optimisticUpdates: Map<string, OptimisticUpdateEntry>,
  emitter: OptimisticEmitter,
  transaction: Transaction,
  reason?: string,
  error?: Error,
): Promise<void> {
  const optimistic = optimisticUpdates.get(transaction.id);
  if (!optimistic) return;

  emitter.emit('optimistic:rollback', {
    model: optimistic.model,
    previousState: optimistic.previousState,
    transaction,
    reason: reason ?? 'unknown',
    error,
  });

  optimisticUpdates.delete(transaction.id);
}
