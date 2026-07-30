import type { RuntimeContext } from '../../RuntimeContext.js';
import type { ReadDependency, TrackDependency, OnStaleMode, StaleNotification } from '@abloatai/transaction/coordination/schema';
import type { MutationCommitResult } from '@abloatai/transaction/wire/commit';
import type {
  DurableCommitEnvelope,
  DurableCommitOperation,
} from '@abloatai/transaction/transactions/settlement/commitEnvelope';
import type { SealDurableCommitInput } from './commitTransport.js';
import { transientRetryDelayMs } from './failureHandling.js';

export interface CommitTransaction {
  id: string;
  kind: 'commit';
  operations: {
    type: DurableCommitOperation['type'];
    model: string;
    id: string;
    input?: Record<string, unknown>;
    transactionId?: string;
    readAt?: number | null;
    onStale?: OnStaleMode | null;
  }[];
  reads?: ReadDependency[] | null;
  track?: TrackDependency[] | null;
  status: 'pending' | 'executing' | 'awaiting_delta' | 'completed' | 'failed';
  createdAt: number;
  attempts: number;
  transientAttempts?: number;
  firstTransientFailureAt?: number;
  lastSyncId?: number;
  correlationId?: string;
  error?: Error;
  sealedAt: number;
  sequence: number;
  sealPromise?: Promise<void>;
  durableEnvelope?: DurableCommitEnvelope;
  sourceMutationIds?: string[];
}

export interface CommitLaneContext {
  readonly runtime: RuntimeContext;
  readonly config: {
    maxRetries: number;
    availabilityRetryWindowMs: number;
    retryBackoff: { baseMs: number; capMs: number };
  };
  readonly commitLane: CommitTransaction[];
  readonly commitNotifications: Map<string, StaleNotification[]>;
  readonly commitMissingIds: Map<string, string[]>;
  readonly commitProcessing: boolean;
  readonly setCommitProcessing: (value: boolean) => void;
  readonly durableReplayBlock: object | null;
  readonly sealDurableCommit: (input: SealDurableCommitInput) => Promise<DurableCommitEnvelope>;
  readonly assertEnvelopeInsideReplayWindow: (envelope: DurableCommitEnvelope) => void;
  readonly dispatchCommit: (envelope: DurableCommitEnvelope) => Promise<MutationCommitResult>;
  readonly persistDurableCommitAcceptance: (envelope: DurableCommitEnvelope, result: MutationCommitResult) => Promise<DurableCommitEnvelope>;
  readonly removeDurableCommit: (idempotencyKey: string) => Promise<void>;
  readonly queuedCommitEchoSyncId: (transaction: CommitTransaction) => number | undefined;
  readonly completeQueuedCommit: (transaction: CommitTransaction, syncId: number) => void;
  readonly scheduleReplicationLagTimeout: (transactionId: string, clientTxId: string, correlationId?: string) => void;
  readonly noteAck: (syncId: number | undefined) => void;
  readonly isDefinitiveRejection: (error: Error) => boolean;
  readonly isPermanentError: (error: Error) => boolean;
  readonly scheduleRetry: (delayMs: number) => void;
  readonly emitCommitLifecycle: (event: string, payload: object) => void;
}

export interface CommitReceiptContext {
  readonly commitStore: Map<string, CommitTransaction>;
  readonly commitNotifications: Map<string, StaleNotification[]>;
  readonly commitMissingIds: Map<string, string[]>;
  readonly replicationLagErrors: Map<string, Error>;
  readonly on: (event: string, listener: (payload: object) => void) => void;
  readonly off: (event: string, listener: (payload: object) => void) => void;
}

export function waitForCommitReceipt(
  ctx: CommitReceiptContext,
  clientTxId: string,
): Promise<{ lastSyncId: number; notifications?: StaleNotification[]; missingIds?: string[] }> {
  const drainNotifications = (): StaleNotification[] | undefined => {
    const notifications = ctx.commitNotifications.get(clientTxId);
    if (!notifications) return undefined;
    ctx.commitNotifications.delete(clientTxId);
    return notifications.length > 0 ? notifications : undefined;
  };
  const drainMissingIds = (): string[] | undefined => {
    const ids = ctx.commitMissingIds.get(clientTxId);
    if (!ids) return undefined;
    ctx.commitMissingIds.delete(clientTxId);
    return ids.length > 0 ? ids : undefined;
  };
  const receipt = (lastSyncId: number) => {
    const missingIds = drainMissingIds();
    return {
      lastSyncId,
      notifications: drainNotifications(),
      ...(missingIds ? { missingIds } : {}),
    };
  };
  return new Promise((resolve, reject) => {
    const existing = ctx.commitStore.get(clientTxId);
    if (existing?.status === 'completed') { resolve(receipt(existing.lastSyncId ?? 0)); return; }
    if (existing?.status === 'failed' && existing.error) { reject(existing.error); return; }
    const lagError = ctx.replicationLagErrors.get(clientTxId);
    if (lagError) { reject(lagError); return; }
    const onCompleted = (tx: object) => { cleanup(); resolve(receipt((tx as CommitTransaction).lastSyncId ?? 0)); };
    const onFailed = (payload: object) => { cleanup(); reject((payload as { error: Error }).error); };
    const onLagged = (payload: object) => { cleanup(); reject((payload as { error: Error }).error); };
    const cleanup = () => {
      ctx.off(`transaction:completed:${clientTxId}`, onCompleted);
      ctx.off(`transaction:failed:${clientTxId}`, onFailed);
      ctx.off(`transaction:confirmation_lagged:${clientTxId}`, onLagged);
    };
    ctx.on(`transaction:completed:${clientTxId}`, onCompleted);
    ctx.on(`transaction:failed:${clientTxId}`, onFailed);
    ctx.on(`transaction:confirmation_lagged:${clientTxId}`, onLagged);
  });
}

export async function processCommitLane(ctx: CommitLaneContext): Promise<void> {
  if (ctx.commitProcessing || ctx.durableReplayBlock) return;
  ctx.setCommitProcessing(true);
  try {
    while (ctx.commitLane.length > 0) {
      const tx = ctx.commitLane[0];
      if (!tx) break;
      if (tx.status !== 'pending') {
        ctx.commitLane.shift();
        continue;
      }
      tx.status = 'executing';
      tx.attempts += 1;
      let dispatchStarted = false;
      try {
        const durableEnvelope = tx.durableEnvelope ?? await ctx.sealDurableCommit({
          idempotencyKey: tx.id,
          origin: 'atomic_commit',
          operations: tx.operations,
          sourceMutationIds: tx.sourceMutationIds,
          commitOptions: {
            ...(tx.reads ? { reads: tx.reads } : {}),
            ...(tx.track ? { track: tx.track } : {}),
          },
          createdAt: tx.createdAt,
          sealedAt: tx.sealedAt,
          sequence: tx.sequence,
        });
        tx.durableEnvelope = durableEnvelope;
        ctx.assertEnvelopeInsideReplayWindow(durableEnvelope);
        dispatchStarted = true;
        const result = await ctx.dispatchCommit(durableEnvelope);
        tx.durableEnvelope = await ctx.persistDurableCommitAcceptance(durableEnvelope, result);
        tx.lastSyncId = result.lastSyncId;
        if (result.notifications?.length) ctx.commitNotifications.set(tx.id, result.notifications);
        if (result.missingIds?.length) ctx.commitMissingIds.set(tx.id, result.missingIds);
        ctx.commitLane.shift();
        if (result.status === 'queued') {
          tx.correlationId = result.correlationId;
          tx.status = 'awaiting_delta';
          const echoSyncId = ctx.queuedCommitEchoSyncId(tx);
          if (echoSyncId !== undefined) ctx.completeQueuedCommit(tx, echoSyncId);
          else ctx.scheduleReplicationLagTimeout(tx.id, tx.id, result.correlationId);
        } else {
          await ctx.removeDurableCommit(tx.id);
          ctx.noteAck(tx.lastSyncId);
          tx.status = 'completed';
          ctx.emitCommitLifecycle('transaction:completed', tx);
          ctx.emitCommitLifecycle(`transaction:completed:${tx.id}`, tx);
        }
      } catch (cause) {
        const error = cause instanceof Error ? cause : new Error(String(cause));
        if (dispatchStarted && ctx.isDefinitiveRejection(error)) await ctx.removeDurableCommit(tx.id);
        tx.transientAttempts = (tx.transientAttempts ?? 0) + 1;
        tx.firstTransientFailureAt ??= Date.now();
        const outsideAvailabilityWindow =
          Date.now() - tx.firstTransientFailureAt >= ctx.config.availabilityRetryWindowMs;
        const exhausted =
          tx.transientAttempts > ctx.config.maxRetries && outsideAvailabilityWindow;
        if (!ctx.isPermanentError(error) && !exhausted) {
          tx.status = 'pending';
          const delayMs = transientRetryDelayMs(
            error,
            tx.transientAttempts,
            ctx.config.retryBackoff,
          );
          ctx.runtime.logger.debug('[MutationQueue] commit lane transient', {
            txId: tx.id.slice(0, 12), attempts: tx.attempts,
            transientAttempts: tx.transientAttempts, delayMs, message: error.message,
          });
          ctx.scheduleRetry(delayMs);
          break;
        }
        tx.status = 'failed';
        tx.error = error;
        ctx.commitLane.shift();
        ctx.runtime.logger.debug('[MutationQueue] commit lane permanent error', {
          txId: tx.id.slice(0, 12), attempts: tx.attempts, message: error.message,
        });
        ctx.emitCommitLifecycle('transaction:failed', { transaction: tx, error, permanent: true });
        ctx.emitCommitLifecycle(`transaction:failed:${tx.id}`, { error });
      }
    }
  } finally {
    ctx.setCommitProcessing(false);
  }
}
