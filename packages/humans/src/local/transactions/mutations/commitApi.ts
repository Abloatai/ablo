import { AbloIdempotencyError } from '@abloatai/transaction/errors';
import type { ReadDependency, TrackDependency } from '@abloatai/transaction/coordination/schema';
import { stableStringify } from '@abloatai/transaction/utils/json';
import type { DurableCommitEnvelope } from '@abloatai/transaction/transactions/settlement/commitEnvelope';
import type { CommitTransaction } from './commitLane.js';
import type { SealDurableCommitInput } from './commitTransport.js';

export interface CommitApiContext {
  readonly assertDurableReplayOpen: () => void;
  readonly commitStore: Map<string, CommitTransaction>;
  readonly commitLane: CommitTransaction[];
  readonly replicationLagErrors: Map<string, Error>;
  readonly clearReplicationLagState: (transactionId: string) => void;
  readonly nextCommitSequence: () => number;
  readonly sealDurableCommit: (input: SealDurableCommitInput) => Promise<DurableCommitEnvelope>;
  readonly processCommitLane: () => Promise<void>;
  readonly emitCommitLifecycle: (event: string, payload: object) => void;
}

export async function enqueueCommit(
  ctx: CommitApiContext,
  clientTxId: string,
  operations: CommitTransaction['operations'],
  options: { reads?: ReadDependency[] | null; track?: TrackDependency[] | null } = {},
): Promise<void> {
  ctx.assertDurableReplayOpen();
  const existing = ctx.commitStore.get(clientTxId);
  if (existing) {
    await existing.sealPromise;
    const existingIntent = stableStringify({
      operations: existing.operations,
      reads: existing.reads ?? null,
      track: existing.track ?? null,
    });
    const incomingIntent = stableStringify({
      operations,
      reads: options.reads ?? null,
      track: options.track ?? null,
    });
    if (existingIntent !== incomingIntent) {
      throw new AbloIdempotencyError(
        'Idempotency key reused with a different atomic commit request',
        { code: 'idempotency_conflict' },
      );
    }
    if (existing.status === 'awaiting_delta' && ctx.replicationLagErrors.has(existing.id)) {
      ctx.clearReplicationLagState(existing.id);
      existing.status = 'pending';
      ctx.commitLane.push(existing);
    }
    if (existing.status === 'pending') void ctx.processCommitLane();
    return;
  }

  ctx.emitCommitLifecycle('commit:staging', { clientTxId, operations });
  const now = Date.now();
  const tx: CommitTransaction = {
    id: clientTxId,
    kind: 'commit',
    operations: [...operations],
    ...(options.reads ? { reads: options.reads } : {}),
    ...(options.track ? { track: options.track } : {}),
    status: 'pending',
    createdAt: now,
    attempts: 0,
    sealedAt: now,
    sequence: ctx.nextCommitSequence(),
  };
  ctx.commitStore.set(clientTxId, tx);
  tx.sealPromise = ctx.sealDurableCommit({
    idempotencyKey: tx.id,
    origin: 'atomic_commit',
    operations: tx.operations,
    commitOptions: {
      ...(tx.reads ? { reads: tx.reads } : {}),
      ...(tx.track ? { track: tx.track } : {}),
    },
    createdAt: tx.createdAt,
    sealedAt: tx.sealedAt,
    sequence: tx.sequence,
  }).then((envelope) => {
    tx.durableEnvelope = envelope;
    tx.operations = envelope.operations.map((operation) => ({ ...operation }));
  });
  try {
    await tx.sealPromise;
  } catch (error) {
    ctx.commitStore.delete(clientTxId);
    ctx.emitCommitLifecycle('commit:seal_failed', { clientTxId });
    throw error;
  } finally {
    tx.sealPromise = undefined;
  }
  ctx.commitLane.push(tx);
  ctx.emitCommitLifecycle('commit:created', { clientTxId, operations: tx.operations });
  void ctx.processCommitLane();
}
