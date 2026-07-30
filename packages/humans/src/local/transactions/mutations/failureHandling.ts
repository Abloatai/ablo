import type { RuntimeContext } from '../../RuntimeContext.js';
import type { MutationQueueConfig } from './MutationQueue.js';
import type { QueuedMutation } from './commitPayload.js';
import type { MutationStore } from './MutationStore.js';
import { AbloError } from '@abloatai/transaction/errors';
import { extractStatusCode } from './commitPayload.js';

export interface FailureHandlingContext {
  readonly runtime: RuntimeContext;
  readonly config: Pick<
    MutationQueueConfig,
    'enableOptimistic' | 'maxRetries' | 'retryBackoff' | 'availabilityRetryWindowMs'
  >;
  readonly store: MutationStore;
  readonly isPermanentError: (error: Error) => boolean;
  readonly rollbackOptimistic: (transaction: QueuedMutation, reason: string, error?: Error) => Promise<void>;
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

export async function handleFailure(ctx: FailureHandlingContext, transaction: QueuedMutation, error: Error): Promise<void> {
    transaction.attempts++;

    // Check whether this is a permanent error that should not be retried.
    if (ctx.isPermanentError(error)) {
      // Logged at warn: a permanent error means the server rejected the write,
      // so the developer should see the reason in the console. The typed
      // AbloError fields (`type`, `code`, `httpStatus`) are included so the
      // cause is visible — for example a foreign-key violation
      // (AbloValidationError) versus expired authentication
      // (AbloAuthenticationError).
      try {
        const abloErr = error instanceof AbloError ? error : undefined;
        const details = {
          txId: transaction.id.slice(0, 8),
          type: transaction.type,
          model: transaction.modelName,
          modelId: transaction.modelId.slice(0, 12),
          errorType: abloErr?.type ?? error?.name,
          errorCode: abloErr?.code,
          httpStatus: abloErr?.httpStatus,
          requestId: abloErr?.requestId,
          message: error?.message,
          inputKeys: transaction.data ? Object.keys(transaction.data) : undefined,
        };

        // A `create` whose id already exists is the benign idempotency case:
        // "this row is already there." It's the least alarming permanent
        // error, so it doesn't warrant a `warn` — `info` keeps it visible
        // without crying wolf. Everything else (FK violation, auth expiry,
        // server 500) stays at `warn`.
        const isBenignIdempotent =
          transaction.type === 'create' &&
          (abloErr?.code === 'unique_violation' ||
            abloErr?.type === 'AbloIdempotencyError');

        // Demote exact repeats (same write rejected for the same reason on
        // each reconnect replay) to `debug` so the loop logs once.
        const sig = `${details.type}:${details.model}:${details.modelId}:${details.errorCode ?? details.errorType}`;
        const isRepeat = sig === ctx.getLastPermanentErrorSignature();
        ctx.setLastPermanentErrorSignature(sig);

        const logger = ctx.runtime.logger;

        // Two registers from one call site, split by log level (the default
        // logger is gated at `warn`, so `debug` stays hidden unless
        // ABLO_LOG_LEVEL=debug is set to inspect the engine):
        //   - the default-visible line speaks the application developer's
        //     language: their verb (such as `update`), their model, the typed
        //     error's own message, and the wire `code` for searching. It uses
        //     no engine jargon and prints no JSON dump, which would alarm
        //     without helping.
        //   - the forensic `details` ride a companion `debug` line for anyone
        //     debugging the engine internals.
        const revertNote = ctx.config.enableOptimistic
          ? ' The local change was reverted.'
          : '';
        const reason = abloErr?.message ? ` — ${abloErr.message}` : '';
        const code = abloErr?.code ? ` (code: ${abloErr.code})` : '';
        const requestRef = abloErr?.requestId
          ? ` [request_id: ${abloErr.requestId}]`
          : '';
        // An optimistic write resolves before the server answers, so a later
        // rejection has no caller left to return to and this log is the only
        // place it appears. That reads to an application developer as their own
        // save silently failing — the write showed, then vanished — and sends
        // them into their editor instead of here. Name the subscription that
        // hands them the same typed error, so the application can say what
        // happened rather than only the console.
        const channelNote = ctx.config.enableOptimistic
          ? ' To surface this in your app, subscribe with `ablo.onMutationFailure(…)`.'
          : '';
        const headline = `Your ${transaction.type} to "${transaction.modelName}" was not saved${reason}${code}${requestRef}.${revertNote}${channelNote}`;

        if (isRepeat) {
          // Same write rejected for the same reason on each reconnect replay —
          // log the forensics once, stay quiet after.
          logger.debug('write rejected again (same reason)', details);
        } else if (isBenignIdempotent) {
          // Already-exists on a `create` is expected on replay, not a problem.
          logger.info(`Your ${transaction.type} to "${transaction.modelName}" was skipped — this row already exists.`);
          logger.debug('idempotent skip — details', details);
        } else {
          logger.warn(headline);
          logger.debug('write rejection — details', details);
        }
      } catch {}

      // Mark as failed immediately and rollback
      ctx.store.updateStatus(transaction.id, 'failed');

      if (ctx.config.enableOptimistic) {
        await ctx.rollbackOptimistic(transaction, 'permanent_error', error);
      }

      ctx.emit('transaction:failed', { transaction, error, permanent: true });
      // The id-suffixed event is what `waitForConfirmation` (the
      // `wait:'confirmed'` path) listens on — without it a permanently
      // rejected write left the caller's promise hanging forever.
      ctx.emit(`transaction:failed:${transaction.id}`, { error });
      return;
    }

    transaction.firstTransientFailureAt ??= Date.now();
    const insideAvailabilityWindow =
      Date.now() - transaction.firstTransientFailureAt < ctx.config.availabilityRetryWindowMs;

    if (transaction.attempts < ctx.config.maxRetries || insideAvailabilityWindow) {
      // Exponential backoff with full jitter on every transient retry:
      // `sleep = random(0, min(cap, base * 2^attempt))`. Throttling responses
      // (429/503) use a longer base than other transient errors. The re-enqueue
      // is scheduled rather than awaited, so one backing-off transaction cannot
      // stall unrelated commits.
      const delay = transientRetryDelayMs(error, transaction.attempts, ctx.config.retryBackoff);

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
