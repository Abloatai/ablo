import { AbloError } from '@abloatai/transaction/errors';
import type { RuntimeContext } from '../../RuntimeContext.js';
import type { QueuedMutation } from './commitPayload.js';

const EXPECTED_COORDINATION_CODES = new Set([
  'stale_context',
  'claim_conflict',
  'claim_queued',
  'claim_lost',
  'entity_claimed',
  'model_claimed',
]);

export interface PermanentFailureReportingContext {
  readonly runtime: RuntimeContext;
  readonly enableOptimistic: boolean;
  readonly getLastPermanentErrorSignature: () => string | undefined;
  readonly setLastPermanentErrorSignature: (signature: string) => void;
}

/** Report a terminal rejection at a severity that matches its meaning. */
export function reportPermanentMutationFailure(
  ctx: PermanentFailureReportingContext,
  transaction: QueuedMutation,
  error: Error,
): void {
  try {
    const abloError = error instanceof AbloError ? error : undefined;
    const details = {
      txId: transaction.id.slice(0, 8),
      type: transaction.type,
      model: transaction.modelName,
      modelId: transaction.modelId.slice(0, 12),
      errorType: abloError?.type ?? error.name,
      errorCode: abloError?.code,
      httpStatus: abloError?.httpStatus,
      requestId: abloError?.requestId,
      message: error.message,
      inputKeys: transaction.data ? Object.keys(transaction.data) : undefined,
    };
    const signature = `${details.type}:${details.model}:${details.modelId}:${details.errorCode ?? details.errorType}`;
    const isRepeat = signature === ctx.getLastPermanentErrorSignature();
    ctx.setLastPermanentErrorSignature(signature);

    const logger = ctx.runtime.logger;
    if (isRepeat) {
      logger.debug('write rejected again (same reason)', details);
      return;
    }

    const isBenignIdempotent =
      transaction.type === 'create' &&
      (abloError?.code === 'unique_violation' ||
        abloError?.type === 'AbloIdempotencyError');
    if (isBenignIdempotent) {
      logger.info(
        `Your ${transaction.type} to "${transaction.modelName}" was skipped — this row already exists.`,
      );
      logger.debug('idempotent skip — details', details);
      return;
    }

    if (abloError?.code && EXPECTED_COORDINATION_CODES.has(abloError.code)) {
      const reverted = ctx.enableOptimistic
        ? ' The local edit was reverted.'
        : '';
      const explanation =
        abloError.code === 'stale_context'
          ? 'it changed elsewhere before this save completed'
          : 'another participant currently owns the conflicting work';
      logger.info(
        `Your ${transaction.type} to "${transaction.modelName}" was not saved because ${explanation}.${reverted}`,
      );
      logger.debug('coordination rejection — details', details);
      return;
    }

    const reason = abloError?.message ? ` — ${abloError.message}` : '';
    const code = abloError?.code ? ` (code: ${abloError.code})` : '';
    const requestReference = abloError?.requestId
      ? ` [request_id: ${abloError.requestId}]`
      : '';
    const reverted = ctx.enableOptimistic
      ? ' The local change was reverted.'
      : '';
    logger.warn(
      `Your ${transaction.type} to "${transaction.modelName}" was not saved${reason}${code}${requestReference}.${reverted}`,
    );
    logger.debug('write rejection — details', details);
  } catch {
    // Diagnostics must never interfere with rollback and promise settlement.
  }
}
