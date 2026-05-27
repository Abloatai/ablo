/**
 * `awaitIntentGrant` — the client side of the fair-queue handover.
 *
 * When a `claim` is contended, the server enqueues it and replies `queued`
 * (HTTP 202 on `/v1/intents`, or `intent_queued` over WS). The grant is then
 * PUSHED later over the WS as `intent_granted` when the claim reaches the head.
 * This resolves once that frame arrives for our `intentId` — so the caller's
 * `claim` promise stays pending (event-driven; no poll, no race) until it's
 * actually our turn. Rejects on `intent_lost` (surfaced as `claim_lost`: the claim was taken away — TTL
 * lapse on disconnect, revoke) or an optional timeout.
 *
 * Takes only a minimal `{ subscribe }` transport so it unit-tests against a
 * fake; `SyncWebSocket` satisfies it structurally.
 */

import { AbloClaimedError } from '../errors.js';

export interface GrantTransport {
  subscribe(
    event: 'intent_acquired' | 'intent_granted' | 'intent_lost' | 'intent_queued',
    handler: (payload: Record<string, unknown>) => void,
  ): () => void;
}

export function awaitIntentGrant(
  transport: GrantTransport,
  intentId: string,
  options?: {
    timeoutMs?: number;
    /**
     * Backpressure: reject instead of waiting if, when we join the line, the
     * server reports `position >= maxQueueDepth` (i.e. that many claims are
     * already ahead of us). Omit to wait however deep the queue is.
     */
    maxQueueDepth?: number;
  },
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const unsubs: Array<() => void> = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settle = (fn: () => void): void => {
      if (timer) clearTimeout(timer);
      for (const u of unsubs) u();
      fn();
    };

    const onGrant = (p: Record<string, unknown>): void => {
      if (p?.intentId === intentId) settle(resolve);
    };
    // The target was free → `intent_acquired` (immediate); it was contended,
    // we waited in line, and reached the head → `intent_granted`. Either frame
    // means the lease is now ours, so one await covers both grant paths.
    unsubs.push(transport.subscribe('intent_acquired', onGrant));
    unsubs.push(transport.subscribe('intent_granted', onGrant));
    if (options?.maxQueueDepth !== undefined) {
      const max = options.maxQueueDepth;
      unsubs.push(
        transport.subscribe('intent_queued', (p) => {
          if (p?.intentId !== intentId) return;
          const position = typeof p.position === 'number' ? p.position : 0;
          if (position >= max) {
            settle(() =>
              reject(
                new AbloClaimedError(
                  `Claim queue for ${intentId} is ${position} deep (max ${max}).`,
                  { code: 'queue_too_deep' },
                ),
              ),
            );
          }
        }),
      );
    }
    unsubs.push(
      transport.subscribe('intent_lost', (p) => {
        if (p?.intentId === intentId) {
          settle(() =>
            reject(
              new AbloClaimedError(`Claim lost while queued for ${intentId}.`, {
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
              `Timed out waiting for the queue grant on claim ${intentId}.`,
              { code: 'grant_timeout' },
            ),
          ),
        );
      }, options.timeoutMs);
    }
  });
}
