/**
 * Local-first apply and rollback bookkeeping for pending mutations.
 *
 * When a change is written before the server confirms it, these functions
 * record it in a ledger and emit an `optimistic:*` event; separate listeners
 * apply the change to the in-memory data and, on rollback, restore the value
 * it replaced. Each function takes the ledger and a small event emitter rather
 * than any larger object, so the rules have no dependencies of their own and
 * can be tested in isolation.
 */

import type { LocalModel as Model } from '../../localModelContract.js';
import type { MutationInput, QueuedMutation } from './commitPayload.js';

/**
 * One tracked optimistic mutation: the live model plus the value it held
 * before the change, kept so a rollback can restore it.
 */
export interface OptimisticUpdateEntry {
  model: Model;
  previousState: MutationInput | null | undefined;
  transaction: QueuedMutation;
}

/**
 * The event emitter these functions use to announce each optimistic change and
 * its rollback. You supply the implementation.
 */
export interface OptimisticEmitter {
  emit(event: string, payload: unknown): void;
}

/** Materializer capability consumed by settlement; implementation belongs to the local layer. */
export interface LocalMutationPort {
  readonly updates: Map<string, OptimisticUpdateEntry>;
  applyCreate(model: Model, transaction: QueuedMutation): void;
  applyUpdate(model: Model, transaction: QueuedMutation): void;
  applyDelete(model: Model, transaction: QueuedMutation): void;
  rollback(transaction: QueuedMutation, reason?: string, error?: Error): Promise<void>;
}

export function createLocalMutationPort(emitter: OptimisticEmitter): LocalMutationPort {
  const updates = new Map<string, OptimisticUpdateEntry>();
  return {
    updates,
    applyCreate: (model, transaction) => applyOptimisticCreate(updates, emitter, model, transaction),
    applyUpdate: (model, transaction) => applyOptimisticUpdate(updates, emitter, model, transaction),
    applyDelete: (model, transaction) => applyOptimisticDelete(updates, emitter, model, transaction),
    rollback: (transaction, reason, error) => rollbackOptimistic(updates, emitter, transaction, reason, error),
  };
}

/**
 * Record an optimistic create and announce it. There is no prior value to
 * restore, so the rollback pre-image is `null`.
 */
export function applyOptimisticCreate(
  optimisticUpdates: Map<string, OptimisticUpdateEntry>,
  emitter: OptimisticEmitter,
  model: Model,
  transaction: QueuedMutation,
): void {
  optimisticUpdates.set(transaction.id, {
    model,
    previousState: null,
    transaction,
  });

  emitter.emit('optimistic:create', { model, transaction });
}

/**
 * Record an optimistic update and announce it, keeping the row's prior value so
 * a rollback can put it back.
 */
export function applyOptimisticUpdate(
  optimisticUpdates: Map<string, OptimisticUpdateEntry>,
  emitter: OptimisticEmitter,
  model: Model,
  transaction: QueuedMutation,
): void {
  optimisticUpdates.set(transaction.id, {
    model,
    previousState: transaction.previousData,
    transaction,
  });

  emitter.emit('optimistic:update', { model, transaction });
}

/**
 * Record an optimistic delete and announce it, keeping the deleted row so a
 * rollback can restore it.
 */
export function applyOptimisticDelete(
  optimisticUpdates: Map<string, OptimisticUpdateEntry>,
  emitter: OptimisticEmitter,
  model: Model,
  transaction: QueuedMutation,
): void {
  optimisticUpdates.set(transaction.id, {
    model,
    previousState: transaction.previousData,
    transaction,
  });

  emitter.emit('optimistic:delete', { model, transaction });
}

/**
 * Undo an optimistic mutation by its transaction id: emit `optimistic:rollback`
 * with the saved pre-image so listeners can restore the prior value, then drop
 * the ledger entry. Does nothing if the transaction was never tracked.
 */
export function rollbackOptimistic(
  optimisticUpdates: Map<string, OptimisticUpdateEntry>,
  emitter: OptimisticEmitter,
  transaction: QueuedMutation,
  reason?: string,
  error?: Error,
): Promise<void> {
  const optimistic = optimisticUpdates.get(transaction.id);
  if (!optimistic) return Promise.resolve();

  emitter.emit('optimistic:rollback', {
    model: optimistic.model,
    previousState: optimistic.previousState,
    transaction,
    reason: reason ?? 'unknown',
    error,
  });

  optimisticUpdates.delete(transaction.id);
  return Promise.resolve();
}
