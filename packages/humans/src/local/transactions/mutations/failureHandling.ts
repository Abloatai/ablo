import type { RuntimeContext } from '../../RuntimeContext.js';
import type { MutationQueueConfig } from './MutationQueue.js';
import type { QueuedMutation } from './commitPayload.js';
import type { MutationStore } from './MutationStore.js';
import { extractStatusCode } from './commitPayload.js';
import { reportPermanentMutationFailure } from './failureReporting.js';

export interface FailureHandlingContext {
  readonly runtime: RuntimeContext;
  readonly config: Pick<
    MutationQueueConfig,
    'enableOptimistic' | 'maxRetries' | 'retryBackoff' | 'availabilityRetryWindowMs'
  >;
  readonly store: MutationStore;
  readonly isPermanentError: (error: Error) => boolean;
  readonly rollbackOptimistic: (
    transaction: QueuedMutation,
    reason: string,
    error?: Error,
  ) => Promise<void>;
  readonly enqueue: (transaction: QueuedMutation) => void;
  readonly getLastPermanentErrorSignature: () => string | undefined;
  readonly setLastPermanentErrorSignature: (signature: string) => void;
  readonly emit: (event: string, payload: object) => boolean;
}

export function transientRetryDelayMs(
  error: Error,
  attempt: number,
  retryBackoff: MutationQueueConfig['retryBackoff'],
): number {
  const { baseMs, capMs } = retryBackoff;
  let base = baseMs;
  try {
    const status = extractStatusCode(error);
    if (status === 429 || status === 503) base = Math.max(baseMs, 1_000);
  } catch {}
  const ceiling = Math.min(capMs, base * Math.pow(2, Math.max(0, attempt - 1)));
  return Math.floor(Math.random() * ceiling);
}

export async function handleFailure(
  ctx: FailureHandlingContext,
  transaction: QueuedMutation,
  error: Error,
): Promise<void> {
  // The dispatch owner may lose its acknowledgement while an authoritative
  // delta concurrently completes the same transaction. Completion is
  // terminal: a late catch path must not turn that row back into `pending`
  // and schedule a second seal after its durable sources were cleaned up.
  if (
    transaction.status === 'completed' ||
    transaction.status === 'failed' ||
    transaction.status === 'rolled_back' ||
    transaction.status === 'awaiting_delta'
  ) return;
  transaction.attempts++;

  // Check whether this is a permanent error that should not be retried.
  if (ctx.isPermanentError(error)) {
    reportPermanentMutationFailure(
      {
        runtime: ctx.runtime,
        enableOptimistic: ctx.config.enableOptimistic,
        getLastPermanentErrorSignature: ctx.getLastPermanentErrorSignature,
        setLastPermanentErrorSignature: ctx.setLastPermanentErrorSignature,
      },
      transaction,
      error,
    );

    // Mark as failed immediately and rollback
    ctx.store.updateStatus(transaction.id, 'failed');

    if (ctx.config.enableOptimistic) {
      await ctx.rollbackOptimistic(transaction, 'permanent_error', error);
    }

    ctx.emit('transaction:failed', { transaction, error, permanent: true });
    // The id-suffixed event is what the awaited model-write promise listens
    // on through `waitForConfirmation` — without it a permanently
    // rejected write left the caller's promise hanging forever.
    ctx.emit(`transaction:failed:${transaction.id}`, { error });
    return;
  }

  transaction.firstTransientFailureAt ??= Date.now();
  const insideAvailabilityWindow =
    Date.now() - transaction.firstTransientFailureAt <
    ctx.config.availabilityRetryWindowMs;

  if (transaction.attempts < ctx.config.maxRetries || insideAvailabilityWindow) {
    // Exponential backoff with full jitter on every transient retry:
    // `sleep = random(0, min(cap, base * 2^attempt))`. Throttling responses
    // (429/503) use a longer base than other transient errors. The re-enqueue
    // is scheduled rather than awaited, so one backing-off transaction cannot
    // stall unrelated commits.
    const delay = transientRetryDelayMs(
      error,
      transaction.attempts,
      ctx.config.retryBackoff,
    );

    ctx.store.updateStatus(transaction.id, 'pending');
    setTimeout(() => {
      // The queue may have shut down or the tx may have been settled
      // (e.g. delta-confirmed) while we backed off.
      if (ctx.store.get(transaction.id)?.status !== 'pending') return;
      ctx.enqueue(transaction);
    }, delay);
  } else {
    // Mark as failed and rollback
    ctx.store.updateStatus(transaction.id, 'failed');

    if (ctx.config.enableOptimistic) {
      await ctx.rollbackOptimistic(transaction, 'max_retries_exhausted', error);
    }

    ctx.emit('transaction:failed', { transaction, error });
    // Settle `waitForConfirmation` waiters (see the permanent branch above).
    ctx.emit(`transaction:failed:${transaction.id}`, { error });
  }
}
