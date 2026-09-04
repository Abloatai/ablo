import { normalizeClaimConflict } from '../../claims/conflict.js';
import type { ClaimQueuedResponse } from '../../claims/contract.js';
import { heartbeatCadenceMs } from '../../claims/heartbeat.js';
import type { HttpClaimsResource } from '../../client/resources/httpResources.js';
import {
  emitClaimStatus,
  type ResolvedClaimContentionOptions,
} from '../../client/resources/modelOperations.js';
import { AbloClaimedError } from '../../errors.js';

const GRANT_POLL_FIRST_MS = 250;
const GRANT_POLL_INTERVAL_MS = 1_000;
const ignoreBestEffortClaimReleaseFailure = (): undefined => undefined;

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
}

/** Wait for a queued HTTP claim while keeping its server-side slot alive. */
export async function awaitClaimGrantOverHttp(
  claims: Pick<HttpClaimsResource, 'heartbeat' | 'retrieve' | 'release'>,
  targetLabel: string,
  queued: ClaimQueuedResponse,
  options: ResolvedClaimContentionOptions,
  leaseWindowMs: number,
): Promise<{ id: string; fenceToken?: number }> {
  const claimId = queued.id;
  const { signal } = options;
  const conflict = normalizeClaimConflict({
    ...(queued.heldBy !== undefined ? { heldBy: queued.heldBy } : {}),
    ...(queued.heldByKind !== undefined ? { heldByKind: queued.heldByKind } : {}),
    ...(queued.heldByClaimId !== undefined ? { heldByClaimId: queued.heldByClaimId } : {}),
    ...(queued.expiresAt !== undefined ? { heldByExpiresAt: queued.expiresAt } : {}),
    ...(queued.heldByClaim !== undefined ? { heldByClaim: queued.heldByClaim } : {}),
  });
  const waitingError = (
    message: string,
    code: 'queue_too_deep' | 'claim_wait_aborted' | 'grant_timeout' | 'claim_lost',
  ): AbloClaimedError => new AbloClaimedError(message, {
    code,
    claims: queued.heldByClaim ? [queued.heldByClaim] : undefined,
    conflict,
  });
  const rejectAndLeave = async (error: AbloClaimedError): Promise<never> => {
    await claims.release({ claimId }).catch(ignoreBestEffortClaimReleaseFailure);
    throw error;
  };

  emitClaimStatus(options.onStatus, {
    type: 'queued',
    claimId,
    position: queued.position,
    ahead: queued.position + 1,
  });
  if (options.maxDepth !== undefined && queued.position >= options.maxDepth) {
    return rejectAndLeave(waitingError(
      `Claim queue for ${targetLabel} is ${queued.position} deep (max ${options.maxDepth}).`,
      'queue_too_deep',
    ));
  }

  const deadline = options.timeoutMs !== undefined ? Date.now() + options.timeoutMs : undefined;
  let delay = GRANT_POLL_FIRST_MS;
  // Enqueue itself acknowledged that this ticket is live for its requested
  // lease window. Each successful queued heartbeat renews the same promise.
  // Promotion mints a fence between removing the queue row and publishing the
  // holder row, so lookup may briefly see neither; that cannot be expiry while
  // the server's last liveness acknowledgement is still in force.
  let acknowledgedAliveUntil = Date.now() + leaseWindowMs;
  const heartbeatIntervalMs = heartbeatCadenceMs(leaseWindowMs, true);
  let nextHeartbeatAt = Date.now() + heartbeatIntervalMs;
  for (;;) {
    if (signal?.aborted) {
      return rejectAndLeave(waitingError(
        `The wait for the claim on ${targetLabel} was aborted before the grant arrived.`,
        'claim_wait_aborted',
      ));
    }
    if (deadline !== undefined && Date.now() >= deadline) {
      return rejectAndLeave(waitingError(
        `Timed out after ${options.timeoutMs}ms waiting for the queue grant on ${targetLabel}.`,
        'grant_timeout',
      ));
    }
    await sleep(
      deadline !== undefined ? Math.min(delay, Math.max(0, deadline - Date.now())) : delay,
      signal,
    );
    if (signal?.aborted) {
      return rejectAndLeave(waitingError(
        `The wait for the claim on ${targetLabel} was aborted before the grant arrived.`,
        'claim_wait_aborted',
      ));
    }
    delay = GRANT_POLL_INTERVAL_MS * (0.85 + Math.random() * 0.3);
    let state: Awaited<ReturnType<HttpClaimsResource['retrieve']>> | undefined;
    try {
      state = await claims.retrieve({ claimId });
    } catch (error) {
      if (!hasErrorCode(error, 'claim_not_found') || Date.now() >= acknowledgedAliveUntil) {
        throw error;
      }
      // Promotion removes the queue record before publishing the holder. A
      // lookup inside that gap can briefly 404 even though the server already
      // acknowledged this ticket through `acknowledgedAliveUntil`.
      delay = GRANT_POLL_FIRST_MS;
    }
    if (state?.status === 'active') {
      emitClaimStatus(options.onStatus, { type: 'granted', claimId, waited: true });
      return state.fenceToken !== undefined
        ? { id: claimId, fenceToken: state.fenceToken }
        : { id: claimId };
    }
    if (state && state.status !== 'queued') {
      if (Date.now() < acknowledgedAliveUntil) {
        delay = GRANT_POLL_FIRST_MS;
        continue;
      }
      return rejectAndLeave(waitingError(
        `Claim lost while queued for ${targetLabel}.`,
        'claim_lost',
      ));
    }
    if (Date.now() < nextHeartbeatAt) {
      continue;
    }

    let beat: Awaited<ReturnType<HttpClaimsResource['heartbeat']>>;
    try {
      beat = await claims.heartbeat({ claimId });
    } catch (error) {
      if (!(error instanceof AbloClaimedError) || error.code !== 'claim_lost') throw error;
      if (Date.now() < acknowledgedAliveUntil) {
        delay = GRANT_POLL_FIRST_MS;
        continue;
      }
      return rejectAndLeave(waitingError(
        `Claim lost while queued for ${targetLabel}.`,
        'claim_lost',
      ));
    }
    acknowledgedAliveUntil = Date.now() + leaseWindowMs;
    nextHeartbeatAt = Date.now() + heartbeatIntervalMs;
    if (beat.status === 'held') delay = GRANT_POLL_FIRST_MS;
  }
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { readonly code?: unknown }).code === code
  );
}
