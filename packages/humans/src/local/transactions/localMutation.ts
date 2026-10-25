import type { LocalModel } from '../localModelContract.js';
import type {
  LocalMutationPort,
  OptimisticUpdateEntry,
} from './mutations/localMutation.js';
import type { QueuedMutation, UserContext } from './mutations/commitPayload.js';
import type { MutationQueue } from './mutations/MutationQueue.js';

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

/** All local write doors feed the primary mutation stream with their provenance. */
export function subscribeLocalTransactions(
  queue: Pick<MutationQueue, 'on' | 'off'>,
  readSnapshot: (id: string) => Record<string, unknown> | undefined,
  context: () => UserContext,
  listener: (tx: QueuedMutation) => void,
): () => void {
  queue.on('transaction:created', listener);
  interface CommitEventOperation {
    type: string;
    model: string;
    id: string;
    input?: Record<string, unknown>;
  }
  const snapshotsByCommit = new Map<
    string,
    readonly (Record<string, unknown> | undefined)[]
  >();
  const onCommitStaging = (payload: {
    clientTxId: string;
    operations: readonly CommitEventOperation[];
  }): void => {
    snapshotsByCommit.set(
      payload.clientTxId,
      payload.operations.map((operation) => {
        if (operation.type === 'CREATE') return undefined;
        return readSnapshot(operation.id);
      }),
    );
  };
  const onCommitSealFailed = (payload: { clientTxId: string }): void => {
    snapshotsByCommit.delete(payload.clientTxId);
  };
  // Commit-lane writes (`ablo.commits.create` — the agent/atomic door) ride
  // their own `commit:created` event: they have no optimistic pool apply,
  // so they must not feed the echo tracker's `transaction:created` path.
  // Enrich each operation with previous state captured from the pool HERE
  // (the queue is pool-free) and hand the synthesized transaction to the
  // same listener, so undo observes every write door — one stream.
  const onCommitCreated = (payload: {
    clientTxId: string;
    operations: readonly CommitEventOperation[];
  }): void => {
    const stagedSnapshots = snapshotsByCommit.get(payload.clientTxId);
    snapshotsByCommit.delete(payload.clientTxId);
    const TYPE_BY_WIRE: Record<
      string,
      QueuedMutation['type']
    > = {
      CREATE: 'create',
      UPDATE: 'update',
      DELETE: 'delete',
      ARCHIVE: 'archive',
      UNARCHIVE: 'unarchive',
    };
    payload.operations.forEach((op, index) => {
      const type = TYPE_BY_WIRE[op.type];
      if (!type || !op.id) return;
      const snapshot =
        type === 'create'
          ? undefined
          : stagedSnapshots
            ? stagedSnapshots[index]
            : readSnapshot(op.id);
      // A DELETE of a row the local graph never saw is not invertible —
      // recording it would make undo "restore" an empty husk. Skip it.
      if (type === 'delete' && !snapshot) return;
      // UPDATE inverse must only revert the fields this op actually wrote;
      // handing undo the FULL row would clobber concurrent edits to
      // unrelated fields on revert.
      const previousData =
        type === 'update' && snapshot && op.input
          ? Object.fromEntries(
              Object.keys(op.input).map((key) => [key, snapshot[key]]),
            )
          : snapshot ?? null;
      listener({
        id: `${payload.clientTxId}_op${index}`,
        type,
        modelName: op.model,
        modelId: op.id,
        modelKey: op.model,
        data: op.input ?? undefined,
        previousData,
        context: {
          userId: context().userId,
          organizationId: context().organizationId,
        },
        status: 'pending',
        createdAt: Date.now(),
        attempts: 0,
        priority: 'normal',
        priorityScore: 0,
      });
    });
  };
  queue.on('commit:staging', onCommitStaging);
  queue.on('commit:seal_failed', onCommitSealFailed);
  queue.on('commit:created', onCommitCreated);
  return () => {
    queue.off('transaction:created', listener);
    queue.off('commit:staging', onCommitStaging);
    queue.off('commit:seal_failed', onCommitSealFailed);
    queue.off('commit:created', onCommitCreated);
    snapshotsByCommit.clear();
  };
}
