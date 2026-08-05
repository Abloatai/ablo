import type { RuntimeContext } from '../../RuntimeContext.js';
import type { MutationExecutor } from '../../interfaces/index.js';
import type { ReadDependency, TrackDependency } from '@abloatai/transaction/coordination/schema';
import {
  AbloConnectionError,
  AbloError,
  AbloIdempotencyError,
} from '@abloatai/transaction/errors';
import {
  mutationCommitResultSchema,
  type MutationCommitResult,
} from '@abloatai/transaction/wire/commit';
import {
  createDurableCommitEnvelope,
  commitEnvelopeRecordId,
  durableCommitEnvelopeSchema,
  type CommitOutboxScope,
  type DurableCommitEnvelope,
  type DurableCommitOperation,
} from '@abloatai/transaction/transactions/confirmation/commitEnvelope';
import type { DurableWriteStore } from './durableWriteStore.js';

export interface CommitTransportContext {
  readonly runtime: RuntimeContext;
  readonly config: {
    enablePersistence: boolean;
    commitDispatchTimeoutMs: number;
  };
  readonly commitOutbox: DurableWriteStore | null;
  readonly commitOutboxScope: CommitOutboxScope | null;
  readonly mutationExecutor: MutationExecutor;
  readonly emitCommitLifecycle: (event: string, payload: object) => void;
}

export interface SealDurableCommitInput {
  idempotencyKey: string;
  origin: 'model_batch' | 'atomic_commit';
  operations: DurableCommitOperationInput[];
  sourceMutationIds?: string[];
  commitOptions?: {
    reads?: readonly ReadDependency[] | null;
    track?: readonly TrackDependency[] | null;
  };
  createdAt: number;
  sealedAt: number;
  sequence?: number;
}

export type DurableCommitOperationInput = DurableCommitOperation;

export async function sealDurableCommit(
  ctx: CommitTransportContext,
  input: SealDurableCommitInput,
  pendingMutationRecordId: (id: string) => string,
): Promise<DurableCommitEnvelope> {
  const sourceMutationIds = [...new Set(input.sourceMutationIds ?? [])];
  const envelope = createDurableCommitEnvelope({
    idempotencyKey: input.idempotencyKey,
    origin: input.origin,
    operations: [...input.operations],
    sourceMutationIds,
    commitOptions: {
      ...(input.commitOptions?.reads !== undefined
        ? { reads: input.commitOptions.reads === null ? null : [...input.commitOptions.reads] }
        : {}),
      ...(input.commitOptions?.track !== undefined
        ? { track: input.commitOptions.track === null ? null : [...input.commitOptions.track] }
        : {}),
    },
    ...(ctx.commitOutboxScope ? { scope: ctx.commitOutboxScope } : {}),
    createdAt: input.createdAt,
    sealedAt: input.sealedAt,
    sequence: input.sequence ?? input.sealedAt * 1_000,
  });

  if (ctx.config.enablePersistence && ctx.commitOutbox) {
    try {
      await ctx.commitOutbox.seal(envelope, sourceMutationIds.map(pendingMutationRecordId));
    } catch (cause) {
      if (cause instanceof AbloError) throw cause;
      throw new AbloConnectionError('Could not persist the durable write before dispatch', {
        code: 'db_not_opened',
        cause,
      });
    }
    ctx.emitCommitLifecycle('commit:envelope_persisted', {
      idempotencyKey: envelope.idempotencyKey,
      sourceMutationIds: envelope.sourceMutationIds,
    });
  }
  return envelope;
}

export async function removeDurableCommit(
  ctx: CommitTransportContext,
  idempotencyKey: string,
): Promise<void> {
  if (!ctx.config.enablePersistence || !ctx.commitOutbox) return;
  try {
    await ctx.commitOutbox.remove(commitEnvelopeRecordId(idempotencyKey));
  } catch (error) {
    ctx.runtime.logger.debug('[MutationQueue] Durable-write cleanup deferred', {
      idempotencyKey,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function persistDurableCommitAcceptance(
  ctx: CommitTransportContext,
  envelope: DurableCommitEnvelope,
  result: MutationCommitResult,
): Promise<DurableCommitEnvelope> {
  if (result.status !== 'queued') return envelope;
  const correlationId = result.correlationId;
  if (!correlationId) {
    throw new AbloConnectionError('The source accepted the commit without durable correlation evidence.', {
      code: 'commit_no_result',
    });
  }
  if (envelope.correlationId !== undefined && envelope.correlationId !== correlationId) {
    throw new AbloIdempotencyError('The same commit replay returned a different source correlation.', {
      code: 'idempotency_conflict',
    });
  }
  if (envelope.acceptedAt !== undefined) return envelope;
  const accepted = durableCommitEnvelopeSchema.parse({
    ...envelope,
    acceptedAt: Math.max(Date.now(), envelope.sealedAt),
    correlationId,
  });
  if (ctx.config.enablePersistence && ctx.commitOutbox) {
    try {
      await ctx.commitOutbox.seal(accepted, []);
    } catch (cause) {
      if (cause instanceof AbloError) throw cause;
      throw new AbloConnectionError(
        'The source accepted the commit, but that acceptance could not be persisted locally.',
        { code: 'db_not_opened', cause },
      );
    }
  }
  return accepted;
}

export function parseMutationCommitResult(
  value: Awaited<ReturnType<MutationExecutor['commit']>>,
): MutationCommitResult {
  const parsed = mutationCommitResultSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw new AbloConnectionError(
    'The mutation transport returned an invalid commit receipt; its outcome remains pending and is safe to retry.',
    { code: 'commit_no_result', cause: parsed.error },
  );
}

export function dispatchCommitBounded(
  ctx: CommitTransportContext,
  ...args: Parameters<MutationExecutor['commit']>
): ReturnType<MutationExecutor['commit']> {
  const dispatched = ctx.mutationExecutor.commit(...args);
  const timeoutMs = ctx.config.commitDispatchTimeoutMs;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return dispatched;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new AbloConnectionError(
      'The mutation transport did not acknowledge the commit in time; its outcome remains pending and is safe to retry.',
      { code: 'commit_no_result' },
    )), timeoutMs);
    dispatched.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error instanceof Error ? error : new Error(String(error))); },
    );
  });
}
