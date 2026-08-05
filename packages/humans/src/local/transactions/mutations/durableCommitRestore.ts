import { AbloIdempotencyError, AbloValidationError } from '@abloatai/transaction/errors';
import type { RuntimeContext } from '../../RuntimeContext.js';
import type { CommitTransaction } from './commitLane.js';
import type { DurableCommitEnvelope, CommitOutboxScope } from '@abloatai/transaction/transactions/confirmation/commitEnvelope';
import type { DurableWriteStore } from './durableWriteStore.js';
import { durableCommitEnvelopeSchema } from '@abloatai/transaction/transactions/confirmation/commitEnvelope';

export interface DurableCommitRestoreContext {
  readonly config: { enablePersistence: boolean };
  readonly commitOutbox: DurableWriteStore | null;
  readonly commitOutboxScope: CommitOutboxScope | null;
  readonly commitStore: Map<string, CommitTransaction>;
  readonly commitLane: CommitTransaction[];
  readonly runtime: RuntimeContext;
  readonly processCommitLane: () => Promise<void>;
  readonly durableReplayWindowMs: number;
}

export async function restoreDurableCommits(ctx: DurableCommitRestoreContext): Promise<Set<string>> {
    if (!ctx.config.enablePersistence) return new Set();

    const sourceMutationIds = new Set<string>();
    try {
      if (!ctx.commitOutbox) return sourceMutationIds;
      const rows = await ctx.commitOutbox.list();
      const envelopes: DurableCommitEnvelope[] = [];
      for (const row of rows) {
        if (
          typeof row !== 'object' ||
          row === null ||
          (row as { type?: unknown }).type !== 'commit_envelope'
        ) continue;
        const parsed = durableCommitEnvelopeSchema.safeParse(row);
        if (parsed.success) {
          envelopes.push(parsed.data);
        } else {
          ctx.runtime.logger.warn('A saved local write is unreadable and was held for review.');
          ctx.runtime.observability.captureMutationFailure({
            context: 'restore-commit-envelope',
            error: parsed.error,
          });
          throw new AbloValidationError(
            'A saved commit envelope is unreadable; replay stopped before newer writes were sent.',
            { code: 'write_options_invalid', cause: parsed.error },
          );
        }
      }
      envelopes.sort(
        (a, b) =>
          (a.sequence ?? a.sealedAt * 1_000) -
            (b.sequence ?? b.sealedAt * 1_000) ||
          a.id.localeCompare(b.id),
      );

      for (const envelope of envelopes) {
        for (const mutationId of envelope.sourceMutationIds) {
          sourceMutationIds.add(mutationId);
        }
        if (
          envelope.acceptedAt === undefined &&
          Date.now() - envelope.sealedAt >=
          ctx.durableReplayWindowMs
        ) {
          ctx.runtime.logger.warn(
            'A saved local write is too old to retry safely and was held for review.',
          );
          ctx.runtime.observability.captureMutationFailure({
            context: 'quarantine-expired-commit-envelope',
            error: `Envelope ${envelope.idempotencyKey} is too old to replay safely`,
          });
          throw new AbloIdempotencyError(
            'A saved commit is older than the server idempotency window and cannot be replayed safely.',
            { code: 'idempotency_conflict' },
          );
        }
        if (
          ctx.commitOutboxScope &&
          (
            !envelope.scope || // eslint-disable-line @typescript-eslint/prefer-optional-chain -- missing scope must quarantine
            envelope.scope.organizationId !== ctx.commitOutboxScope.organizationId ||
            envelope.scope.participantId !== ctx.commitOutboxScope.participantId ||
            envelope.scope.namespace !== ctx.commitOutboxScope.namespace
          )
        ) {
          ctx.runtime.logger.warn(
            'A saved local write belongs to a different account or server and was held for review.',
          );
          continue;
        }
        if (ctx.commitStore.has(envelope.idempotencyKey)) continue;
        const transaction: CommitTransaction = {
          id: envelope.idempotencyKey,
          kind: 'commit',
          operations: envelope.operations.map((operation) => ({ ...operation })),
          ...(envelope.commitOptions.reads
            ? { reads: [...envelope.commitOptions.reads] }
            : {}),
          ...(envelope.commitOptions.track
            ? { track: [...envelope.commitOptions.track] }
            : {}),
          status: 'pending',
          createdAt: envelope.createdAt,
          sealedAt: envelope.sealedAt,
          sequence: envelope.sequence ?? envelope.sealedAt * 1_000,
          attempts: 0,
          ...(envelope.correlationId
            ? { correlationId: envelope.correlationId }
            : {}),
          sourceMutationIds: [...envelope.sourceMutationIds],
          durableEnvelope: envelope,
        };
        ctx.commitStore.set(transaction.id, transaction);
        ctx.commitLane.push(transaction);
      }

      if (ctx.commitLane.length > 0) void ctx.processCommitLane();
    } catch (error) {
      ctx.runtime.logger.debug('[MutationQueue] Failed to restore durable writes', {
        error: error instanceof Error ? error.message : String(error),
      });
      ctx.runtime.observability.captureMutationFailure({
        context: 'restore-commit-envelopes',
        error: error instanceof Error ? error : String(error),
      });
      throw error;
    }
    return sourceMutationIds;
}
