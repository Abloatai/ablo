import { describe, expect, it, jest } from '@jest/globals';

import { AbloClaimedError } from '../../../errors.js';
import type { ClaimQueuedResponse } from '../../../claims/contract.js';
import type { HttpClaimsResource } from '../../../client/resources/httpResources.js';
import { awaitClaimGrantOverHttp } from '../claimWait.js';

const queued: ClaimQueuedResponse = {
  id: 'claim-waiter',
  object: 'claim',
  status: 'queued',
  position: 0,
};

describe('HTTP claim grant handoff', () => {
  it('keeps a server-acknowledged ticket through the promotion visibility gap', async () => {
    jest.useFakeTimers();
    try {
      const heartbeat = jest
        .fn<HttpClaimsResource['heartbeat']>()
        .mockResolvedValue({
          object: 'claim_heartbeat',
          claimId: queued.id,
          status: 'held',
          expiresAt: Date.now() + 60_000,
          queueDepth: 0,
        });
      const claims = {
        heartbeat,
        retrieve: jest
          .fn<HttpClaimsResource['retrieve']>()
          .mockResolvedValueOnce({
            object: 'claim',
            id: queued.id,
            status: 'queued',
            position: 0,
          })
          .mockRejectedValueOnce(Object.assign(new Error('promotion gap'), {
            code: 'claim_not_found',
          }))
          .mockResolvedValue({
            object: 'claim',
            id: queued.id,
            status: 'active',
            fenceToken: 17,
          }),
        release: jest.fn<HttpClaimsResource['release']>().mockResolvedValue(undefined),
      } satisfies Pick<HttpClaimsResource, 'heartbeat' | 'retrieve' | 'release'>;

      const granted = awaitClaimGrantOverHttp(claims, 'items/item-1', queued, {
        wait: true,
      }, 3_000);
      await jest.advanceTimersByTimeAsync(2_000);

      await expect(granted).resolves.toEqual({ id: queued.id, fenceToken: 17 });
      expect(heartbeat).toHaveBeenCalledTimes(1);
      expect(claims.retrieve).toHaveBeenCalledTimes(3);
      expect(claims.release).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('abandons a genuinely lost queued ticket once', async () => {
    jest.useFakeTimers();
    try {
      const claims = {
        heartbeat: jest.fn<HttpClaimsResource['heartbeat']>().mockRejectedValue(
          new AbloClaimedError('gone', { code: 'claim_lost' }),
        ),
        retrieve: jest.fn<HttpClaimsResource['retrieve']>().mockResolvedValue({
          object: 'claim',
          id: queued.id,
          status: 'expired',
        }),
        release: jest.fn<HttpClaimsResource['release']>().mockResolvedValue(undefined),
      } satisfies Pick<HttpClaimsResource, 'heartbeat' | 'retrieve' | 'release'>;

      const waiting = awaitClaimGrantOverHttp(
        claims,
        'items/item-1',
        queued,
        { wait: true },
        1_000,
      );
      const rejected = expect(waiting).rejects.toMatchObject({ code: 'claim_lost' });
      await jest.advanceTimersByTimeAsync(1_250);

      await rejected;
      expect(claims.heartbeat).not.toHaveBeenCalled();
      expect(claims.release).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });
});
