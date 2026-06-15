/**
 * `awaitClaimGrant` — the client side of the fair-queue handover.
 *
 * When a `claim` is contended, the server enqueues it and replies `queued`
 * (HTTP 202 on `/v1/claims`, or `claim_queued` over WS). The grant is then
 * PUSHED later over the WS as `claim_granted` when the claim reaches the head.
 * This resolves once that frame arrives for our `claimId` — so the caller's
 * `claim` promise stays pending (event-driven; no poll, no race) until it's
 * actually our turn. Rejects on `claim_lost` (surfaced as `claim_lost`: the claim was taken away — TTL
 * lapse on disconnect, revoke) or an optional timeout.
 *
 * Takes only a minimal `{ subscribe }` transport so it unit-tests against a
 * fake; `SyncWebSocket` satisfies it structurally.
 */

import {
  AbloClaimedError,
  formatClaimedErrorMessage,
  claimTargetLabel,
} from '../errors.js';
import type { ClaimRejection } from '../coordination/schema.js';

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
   * True when the grant arrived as `claim_granted` — i.e. the target was
   * HELD when we asked and we waited in the FIFO line behind the holder.
   * False for the immediate `claim_acquired` (target was free).
   *
   * Callers use this to know the row may have changed while we queued:
   * claim VISIBILITY is entity-scoped (org-wide subscriptions receive no
   * presence/claim fan-out — see Hub.broadcastPresenceChange), so the
   * local coordination snapshot cannot be trusted to detect "we waited".
   * The grant frame itself is the authoritative signal.
   */
  readonly waited: boolean;
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
  },
): Promise<ClaimGrantInfo> {
  return new Promise<ClaimGrantInfo>((resolve, reject) => {
    const unsubs: Array<() => void> = [];
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
        if (p?.claimId === claimId) settle(() => resolve({ waited: false }));
      }),
    );
    unsubs.push(
      transport.subscribe('claim_granted', (p) => {
        if (p?.claimId === claimId) settle(() => resolve({ waited: true }));
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
              reject(
                new AbloClaimedError(
                  `Claim queue for ${claimId} is ${position} deep (max ${max}).`,
                  { code: 'queue_too_deep' },
                ),
              ),
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
              model: rejection.target.entityType,
              id: rejection.target.entityId,
              field: rejection.target.field,
            })
          : claimId;
        settle(() =>
          reject(
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
          ),
        );
      }),
    );
    unsubs.push(
      transport.subscribe('claim_lost', (p) => {
        if (p?.claimId === claimId) {
          settle(() =>
            reject(
              new AbloClaimedError(`Claim lost while queued for ${claimId}.`, {
                code: 'claim_lost',
              }),
            ),
          );
        }
      }),
    );

    if (options?.timeoutMs && options.timeoutMs > 0) {
      timer = setTimeout(() => {
        settle(() =>
          reject(
            new AbloClaimedError(
              `Timed out waiting for the queue grant on claim ${claimId}.`,
              { code: 'grant_timeout' },
            ),
          ),
        );
      }, options.timeoutMs);
    }
  });
}
