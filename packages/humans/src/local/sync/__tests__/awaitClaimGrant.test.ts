import {
  awaitClaimGrant,
  type GrantTransport,
} from '@abloatai/transaction/coordination/awaitClaimGrant';
import { AbloClaimedError } from '@abloatai/transaction/errors';

/** Fake transport: records handlers, lets the test push frames. */
function fakeTransport() {
  const handlers: Record<string, ((p: Record<string, unknown>) => void)[]> = {};
  const t: GrantTransport & {
    emit(e: string, p: Record<string, unknown>): void;
    count(e: string): number;
  } = {
    subscribe(event, handler) {
      (handlers[event] ??= []).push(handler);
      return () => {
        handlers[event] = (handlers[event] ?? []).filter((h) => h !== handler);
      };
    },
    emit(event, payload) {
      for (const h of [...(handlers[event] ?? [])]) h(payload);
    },
    count(event) {
      return (handlers[event] ?? []).length;
    },
  };
  return t;
}

describe('awaitClaimGrant', () => {
  it('resolves when claim_granted arrives for the matching id', async () => {
    const t = fakeTransport();
    const p = awaitClaimGrant(t, 'i1');
    t.emit('claim_granted', { claimId: 'i1' });
    await expect(p).resolves.toEqual({ waited: true });
  });

  it('resolves on claim_acquired (immediate, uncontended grant)', async () => {
    const t = fakeTransport();
    const p = awaitClaimGrant(t, 'i1');
    t.emit('claim_acquired', { claimId: 'i1' });
    await expect(p).resolves.toEqual({ waited: false });
  });

  it('ignores grants for other claims, resolves on the matching one', async () => {
    const t = fakeTransport();
    const p = awaitClaimGrant(t, 'i1');
    t.emit('claim_granted', { claimId: 'other' }); // not ours
    let settled = false;
    void p.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    t.emit('claim_granted', { claimId: 'i1' });
    await expect(p).resolves.toEqual({ waited: true });
  });

  it('rejects with AbloClaimedError(claim_lost) when the claim is lost', async () => {
    const t = fakeTransport();
    const p = awaitClaimGrant(t, 'i1');
    t.emit('claim_lost', { claimId: 'i1' });
    await expect(p).rejects.toMatchObject({ code: 'claim_lost' });
  });

  it('rejects with queue_too_deep when position >= maxQueueDepth', async () => {
    const t = fakeTransport();
    const p = awaitClaimGrant(t, 'i1', { maxQueueDepth: 5 });
    t.emit('claim_queued', { claimId: 'i1', position: 5 });
    await expect(p).rejects.toMatchObject({ code: 'queue_too_deep' });
  });

  it('claim_rejected with heldByClaim → claim_conflict carrying typed claims + contextual message', async () => {
    const t = fakeTransport();
    const p = awaitClaimGrant(t, 'i1');
    t.emit('claim_rejected', {
      claimId: 'i1',
      reason: 'conflict',
      target: { entityType: 'Item', entityId: 't1' },
      heldBy: 'agent:writer',
      heldByClaimId: 'i0',
      heldByExpiresAt: Date.now() + 120_000,
      heldByClaim: {
        claimId: 'i0',
        declaredAt: Date.now(),
        expiresAt: Date.now() + 120_000,
        entityType: 'Item',
        entityId: 't1',
        // No explicit description — the work rides in `meta.description`, and the
        // message must resolve it from there.
        meta: { description: 'pricing table, about two minutes' },
      },
      policyReason: 'single-writer policy on pricing rows',
    });
    const err = await p.then(
      () => {
        throw new Error('expected rejection');
      },
      (e: unknown) => e as AbloClaimedError,
    );
    expect(err).toBeInstanceOf(AbloClaimedError);
    expect(err).toMatchObject({
      code: 'claim_conflict',
      claims: [{ claimId: 'i0' }],
    });
    expect(err.message).toMatch(
      /agent:writer.*pricing table.*expires in \d+s.*single-writer policy/s,
    );
  });

  it('claim_rejected without heldByClaim (legacy frame) → fallback message, no claims', async () => {
    const t = fakeTransport();
    const p = awaitClaimGrant(t, 'i1');
    t.emit('claim_rejected', {
      claimId: 'i1',
      reason: 'conflict',
      target: { entityType: 'Item', entityId: 't1' },
    });
    const err = await p.then(
      () => {
        throw new Error('expected rejection');
      },
      (e: unknown) => e as AbloClaimedError,
    );
    expect(err).toBeInstanceOf(AbloClaimedError);
    expect(err.code).toBe('claim_conflict');
    expect(err.claims).toBeUndefined();
    expect(err.message).toBe('Claim rejected for Item/t1.');
  });

  it('keeps waiting when position is within maxQueueDepth, then resolves on grant', async () => {
    const t = fakeTransport();
    const p = awaitClaimGrant(t, 'i1', { maxQueueDepth: 5 });
    t.emit('claim_queued', { claimId: 'i1', position: 2 }); // 2 < 5 → stay
    let settled = false;
    void p.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    t.emit('claim_granted', { claimId: 'i1' });
    await expect(p).resolves.toEqual({ waited: true });
  });

  it('reports queued then granted through request-scoped structured hooks', async () => {
    const t = fakeTransport();
    const onQueued = jest.fn();
    const onGranted = jest.fn();
    const p = awaitClaimGrant(t, 'i1', { onQueued, onGranted });

    t.emit('claim_queued', { claimId: 'i1', position: 2 });
    t.emit('claim_granted', { claimId: 'i1', fenceToken: 7 });

    await expect(p).resolves.toEqual({ waited: true, fenceToken: 7 });
    expect(onQueued).toHaveBeenCalledWith({ claimId: 'i1', position: 2 });
    expect(onGranted).toHaveBeenCalledWith({
      claimId: 'i1',
      waited: true,
      fenceToken: 7,
    });
  });

  it('reports the same typed failure the promise rejects with', async () => {
    const t = fakeTransport();
    const onFailed = jest.fn();
    const p = awaitClaimGrant(t, 'i1', { onFailed });

    t.emit('claim_rejected', {
      claimId: 'i1',
      reason: 'conflict',
      target: { entityType: 'Item', entityId: 't1' },
    });

    const error = await p.catch((caught: unknown) => caught);
    expect(onFailed).toHaveBeenCalledWith(error);
    expect(error).toMatchObject({ code: 'claim_conflict' });
  });

  it('isolates observer callback failures from admission', async () => {
    const t = fakeTransport();
    const p = awaitClaimGrant(t, 'i1', {
      onGranted: () => {
        throw new Error('UI callback failed');
      },
    });

    t.emit('claim_acquired', { claimId: 'i1' });
    await expect(p).resolves.toEqual({ waited: false });
  });

  it('ignores queue depth for other claims', async () => {
    const t = fakeTransport();
    const p = awaitClaimGrant(t, 'i1', { maxQueueDepth: 1 });
    t.emit('claim_queued', { claimId: 'other', position: 9 }); // not ours
    t.emit('claim_granted', { claimId: 'i1' });
    await expect(p).resolves.toEqual({ waited: true });
  });

  it('rejects on timeout', async () => {
    jest.useFakeTimers();
    const t = fakeTransport();
    const p = awaitClaimGrant(t, 'i1', { timeoutMs: 1_000 });
    const assertion = expect(p).rejects.toMatchObject({ code: 'grant_timeout' });
    await jest.advanceTimersByTimeAsync(1_001);
    await assertion;
    jest.useRealTimers();
  });

  it('unsubscribes after settling (no leak, no late fire)', async () => {
    const t = fakeTransport();
    const p = awaitClaimGrant(t, 'i1');
    expect(t.count('claim_acquired')).toBe(1);
    expect(t.count('claim_granted')).toBe(1);
    t.emit('claim_granted', { claimId: 'i1' });
    await p;
    expect(t.count('claim_acquired')).toBe(0);
    expect(t.count('claim_granted')).toBe(0);
    expect(t.count('claim_lost')).toBe(0);
  });

  it('rejects with claim_wait_aborted when the signal fires mid-wait', async () => {
    const t = fakeTransport();
    const controller = new AbortController();
    const p = awaitClaimGrant(t, 'i1', { signal: controller.signal });
    controller.abort();
    await expect(p).rejects.toMatchObject({ code: 'claim_wait_aborted' });
    // The abort settled the wait — every subscription is gone, so a late
    // grant frame has nothing to fire into.
    expect(t.count('claim_granted')).toBe(0);
  });

  it('rejects immediately on an already-aborted signal', async () => {
    const t = fakeTransport();
    const p = awaitClaimGrant(t, 'i1', { signal: AbortSignal.abort() });
    await expect(p).rejects.toMatchObject({ code: 'claim_wait_aborted' });
  });

  it('ignores a late abort — the grant already settled the wait', async () => {
    const t = fakeTransport();
    const controller = new AbortController();
    const p = awaitClaimGrant(t, 'i1', { signal: controller.signal });
    t.emit('claim_granted', { claimId: 'i1' });
    await expect(p).resolves.toEqual({ waited: true });
    controller.abort(); // after the grant: no rejection, nothing to tear down
  });
});
