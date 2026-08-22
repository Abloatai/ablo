/**
 * The HTTP commit as a VALUE: what it is keyed by, the operations it carries,
 * the exact bytes it is replayed as, and the error when its echo never lands.
 *
 * None of this touches the transport's state. It was written inside
 * `createHttpTransport` because that is where it was first needed, which made a
 * two-thousand-line closure the only place the shape of a commit was stated.
 * Read together here, the four say one thing: a commit is identified by its
 * idempotency key, normalized once so every operation carries the same
 * defaults, replayed byte for byte, and abandoned only when the source accepted
 * it and the replication echo did not arrive.
 */

import { AbloConnectionError, AbloValidationError } from '../errors.js';
import type { BatchFence } from '../coordination/locator.js';
import { claimIdFor, fenceTokenFor } from '../coordination/locator.js';
import type { Claim } from '../types/streams.js';
import type { CommitCreateOptions, CommitOperationInput } from '../resources/httpResources.js';
import type { CommitReceiptWire } from '../wire/commit.js';
import type { DurableHttpCommitMethod } from '../transactions/confirmation/httpCommitEnvelope.js';

/**
 * One commit, exactly as it will be sent and re-sent. A replay that changed any
 * of these would be a different request wearing the same idempotency key.
 */
export interface ExactHttpCommitRequest {
  readonly idempotencyKey: string;
  readonly method: DurableHttpCommitMethod;
  readonly path: string;
  readonly body: string;
  readonly sealedProtocolVersion?: number;
}

/**
 * The key a commit is replayed under. A caller's idempotency key wins, because
 * it is the caller's statement that two attempts are the same write.
 */
export function createClientTxId(idempotencyKey?: string | null): string {
  if (idempotencyKey && idempotencyKey.length > 0) return idempotencyKey;
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `tx_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

/** One operation with the batch's defaults resolved onto it. */
export function normalizeCommitOperation(
  op: CommitOperationInput,
  defaults: Pick<CommitCreateOptions, 'readAt' | 'onStale'>,
  fence: BatchFence | null,
  claim: Claim | null,
): CommitOperationInput {
  return {
    action: op.action,
    model: op.model,
    id: op.id ?? null,
    data: op.data ?? null,
    where: op.where ?? null,
    transactionId: op.transactionId ?? null,
    claimId: op.claimId ?? claimIdFor(claim?.target, claim?.id, op.model, op.id ?? null),
    readAt: op.readAt ?? defaults.readAt ?? null,
    onStale: op.onStale ?? defaults.onStale ?? null,
    fenceToken: op.fenceToken ?? fenceTokenFor(fence, op.model, op.id ?? null),
  };
}

/** Every operation in a batch, normalized against the batch's own options. */
export function normalizeCommitOperations(
  commitOptions: CommitCreateOptions,
  fence: BatchFence | null,
): readonly CommitOperationInput[] {
  if (commitOptions.operations.length === 0) {
    throw new AbloValidationError('Commit requires a non-empty `operations` array.', {
      code: 'commit_operation_required',
    });
  }
  return commitOptions.operations.map((op) =>
    normalizeCommitOperation(op, commitOptions, fence, commitOptions.claim ?? null),
  );
}

/**
 * The source accepted the write and its replication echo did not arrive in
 * time. `accepted: true` is the load-bearing detail: the row may well be
 * written, so this is a confirmation timeout and never a reason to write again.
 */
export function replicationLagTimeout(
  request: ExactHttpCommitRequest,
  response: CommitReceiptWire,
  requestTimeoutMs: number,
): AbloConnectionError {
  return new AbloConnectionError(
    `The source accepted commit ${request.idempotencyKey}, but its replication echo did not arrive within ${requestTimeoutMs}ms.`,
    {
      code: 'replication_lag_timeout',
      httpStatus: 504,
      details: {
        clientTxId: request.idempotencyKey,
        ...(response.correlationId ? { correlationId: response.correlationId } : {}),
        timeoutMs: requestTimeoutMs,
        accepted: true,
      },
    },
  );
}
