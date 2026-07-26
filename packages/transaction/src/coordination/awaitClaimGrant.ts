/**
 * Waits for a queued claim to reach the head of the line — the client side of
 * the fair-queue handover. When a claim is contended, the server puts it in a
 * queue and replies that it is queued (HTTP 202 on `/v1/claims`, or a
 * `claim_queued` frame over the WebSocket). The grant is delivered later, when
 * the claim reaches the head, as a `claim_granted` frame. This resolves once
 * that frame arrives for the given `claimId`, so the caller's `claim` promise
 * stays pending — event-driven, with no polling — until it is actually the
 * caller's turn. It rejects if the claim is lost (`claim_lost`: taken away by a
 * TTL lapse on disconnect, or revoked) or if an optional timeout elapses.
 *
 * It needs only a minimal `{ subscribe }` transport, so it can be tested
 * against a fake; the duplex `WsTransport` satisfies it.
 */

import {
  AbloClaimedError,
  AbloValidationError,
  CapabilityError,
  formatClaimedErrorMessage,
  claimTargetLabel,
} from '../errors.js';
import type { ClaimRejection } from './schema.js';
import { modelTarget } from './locator.js';
import { noopLogger, type Logger } from '../logger.js';

export interface GrantTransport {
  subscribe(
    event:
      | 'claim_acquired'
      | 'claim_granted'
      | 'claim_lost'
      | 'claim_queued'
      | 'claim_rejected',
    handler: (payload: Record<string, unknown>) => void,
  ): () => void;
}

export interface ClaimGrantInfo {
  /**
   * True when the grant arrived as `claim_granted` — the target was held when
   * the caller asked, and the caller waited in the FIFO line behind the holder.
   * False for the immediate `claim_acquired`, where the target was free.
   *
   * Callers read this to know the row may have changed while they queued. Claim
   * visibility is scoped to the entity, so a broad, organization-wide
   * subscription receives no presence or claim fan-out, and the local
   * coordination snapshot cannot be trusted to tell whether the caller waited.
   * The grant frame itself is the authoritative signal.
   */
  readonly waited: boolean;
  /**
   * The fencing token the server minted for this grant (Option B), read off the
   * grant frame — the authoritative source, since the token is server-stamped.
   * `undefined` when the server does not fence (no minter wired).
   */
  readonly fenceToken?: number;
  /** Authoritative branch watermark captured when the lease was granted. */
  readonly readAt?: number;
}

/** Read the server-stamped fencing token off a grant frame, if present. */
function readFenceToken(p: Record<string, unknown>): number | undefined {
  return typeof p.fenceToken === 'number' ? p.fenceToken : undefined;
}

function readWatermark(p: Record<string, unknown>): number | undefined {
  return typeof p.readAt === 'number' ? p.readAt : undefined;
}

export function awaitClaimGrant(
  transport: GrantTransport,
  claimId: string,
  options?: {
    timeoutMs?: number;
    /**
     * Backpressure: reject instead of waiting if, when we join the line, the
     * server reports `position >= maxQueueDepth` (i.e. that many claims are
     * already ahead of us). Omit to wait however deep the queue is.
     */
    maxQueueDepth?: number;
    /**
     * Abort the wait from outside — the same signal that cancels everything
     * else in the program. Rejects with `claim_wait_aborted`; once the grant
     * has arrived the signal is ignored, so a held lease is never torn down
     * by a late abort.
     */
    signal?: AbortSignal;
    /** Where grant transitions are logged. Defaults to silent. */
    logger?: Logger;
  },
): Promise<ClaimGrantInfo> {
  const logger = options?.logger ?? noopLogger;
  return new Promise<ClaimGrantInfo>((resolve, reject) => {
    const unsubs: (() => void)[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settle = (fn: () => void): void => {
      if (timer) clearTimeout(timer);
      for (const u of unsubs) u();
      fn();
    };

    // The target was free → `claim_acquired` (immediate); it was contended,
    // we waited in line, and reached the head → `claim_granted`. Either frame
    // means the lease is now ours; `waited` records which path it was.
    unsubs.push(
      transport.subscribe('claim_acquired', (p) => {
        if (p?.claimId === claimId) {
          logger.debug(`claim: acquired ${claimId} (target was free)`);
          const fenceToken = readFenceToken(p);
          const readAt = readWatermark(p);
          settle(() => {
            resolve({
              waited: false,
              ...(fenceToken !== undefined ? { fenceToken } : {}),
              ...(readAt !== undefined ? { readAt } : {}),
            });
          });
        }
      }),
    );
    unsubs.push(
      transport.subscribe('claim_granted', (p) => {
        if (p?.claimId === claimId) {
          // Promoted to the head of the line — the creator's "it's the agent's
          // turn now" moment after waiting behind a holder.
          logger.info(`claim: granted ${claimId} — your turn (waited in queue)`);
          const fenceToken = readFenceToken(p);
          const readAt = readWatermark(p);
          settle(() => {
            resolve({
              waited: true,
              ...(fenceToken !== undefined ? { fenceToken } : {}),
              ...(readAt !== undefined ? { readAt } : {}),
            });
          });
        }
      }),
    );
    if (options?.maxQueueDepth !== undefined) {
      const max = options.maxQueueDepth;
      unsubs.push(
        transport.subscribe('claim_queued', (p) => {
          if (p?.claimId !== claimId) return;
          const position = typeof p.position === 'number' ? p.position : 0;
          if (position >= max) {
            settle(() =>
              { reject(
                new AbloClaimedError(
                  `Claim queue for ${claimId} is ${position} deep (max ${max}).`,
                  { code: 'queue_too_deep' },
                ),
              ); },
            );
          }
        }),
      );
    }
    unsubs.push(
      transport.subscribe('claim_rejected', (p) => {
        const rejection = p as ClaimRejection;
        if (rejection.claimId !== claimId) return;
        const target = rejection.target
          ? claimTargetLabel({
              ...modelTarget(rejection.target),
              field: rejection.target.field,
            })
          : claimId;
        if (rejection.reason === 'capability_denied') {
          settle(() => {
            reject(
              new CapabilityError(
                'capability_scope_denied',
                rejection.policyReason ??
                  `This credential may not claim ${target}.`,
              ),
            );
          });
          return;
        }
        if (rejection.reason === 'invalid_target') {
          settle(() => {
            reject(
              new AbloValidationError(
                rejection.policyReason ?? `Invalid claim target ${target}.`,
                { code: 'invalid_body' },
              ),
            );
          });
          return;
        }
        settle(() =>
          { reject(
            new AbloClaimedError(
              formatClaimedErrorMessage({
                targetLabel: target,
                heldBy: rejection.heldBy,
                claim: rejection.heldByClaim,
                policyReason: rejection.policyReason,
                fallback: `Claim rejected for ${target}.`,
              }),
              {
                code: rejection.reason === 'conflict'
                  ? 'claim_conflict'
                  : 'claim_lease_unavailable',
                claims: rejection.heldByClaim ? [rejection.heldByClaim] : undefined,
              },
            ),
          ); },
        );
      }),
    );
    unsubs.push(
      transport.subscribe('claim_lost', (p) => {
        if (p?.claimId === claimId) {
          settle(() =>
            { reject(
              new AbloClaimedError(`Claim lost while queued for ${claimId}.`, {
                code: 'claim_lost',
              }),
            ); },
          );
        }
      }),
    );

    if (options?.signal) {
      const signal = options.signal;
      const abort = (): void =>
        settle(() => {
          reject(
            new AbloClaimedError(
              `The wait for claim ${claimId} was aborted before the grant arrived.`,
              { code: 'claim_wait_aborted' },
            ),
          );
        });
      if (signal.aborted) {
        abort();
        return;
      }
      signal.addEventListener('abort', abort, { once: true });
      unsubs.push(() => { signal.removeEventListener('abort', abort); });
    }

    if (options?.timeoutMs && options.timeoutMs > 0) {
      timer = setTimeout(() => {
        settle(() =>
          { reject(
            new AbloClaimedError(
              `Timed out waiting for the queue grant on claim ${claimId}.`,
              { code: 'grant_timeout' },
            ),
          ); },
        );
      }, options.timeoutMs);
    }
  });
}
