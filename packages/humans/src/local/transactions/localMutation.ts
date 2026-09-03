import type { LocalModel } from '../localModelContract.js';
import type {
  LocalMutationPort,
  OptimisticUpdateEntry,
} from './mutations/localMutation.js';
import type { QueuedMutation } from './mutations/commitPayload.js';

type EmitLocalMutation = (event: string, payload: unknown) => void;

/**
 * Human-side optimistic-write adapter.
 *
 * Confirmation retains ordering and receipts; this adapter owns the local
 * pre-image ledger and announces apply/rollback work to the materialiser.
 */
export function createLocalMutationPort(
  emit: EmitLocalMutation,
): LocalMutationPort {
  const updates = new Map<string, OptimisticUpdateEntry>();

  const track = (
    event: 'optimistic:create' | 'optimistic:update' | 'optimistic:delete',
    model: LocalModel,
    transaction: QueuedMutation,
  ): void => {
    updates.set(transaction.id, {
      model,
      previousState:
        event === 'optimistic:create' ? null : transaction.previousData,
      transaction,
    });
    emit(event, { model, transaction });
  };

  return {
    updates,
    applyCreate: (model, transaction) =>
      { track('optimistic:create', model, transaction); },
    applyUpdate: (model, transaction) =>
      { track('optimistic:update', model, transaction); },
    applyDelete: (model, transaction) =>
      { track('optimistic:delete', model, transaction); },
    rollback: (transaction, reason, error) => {
      const optimistic = updates.get(transaction.id);
      if (!optimistic) return Promise.resolve();

      emit('optimistic:rollback', {
        model: optimistic.model,
        previousState: optimistic.previousState,
        transaction,
        reason: reason ?? 'unknown',
        error,
      });
      updates.delete(transaction.id);
      return Promise.resolve();
    },
  };
}
