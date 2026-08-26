/**
 * The auto-heartbeat loop behind `claim({ id, heartbeat: true })`.
 *
 * Failure semantics under test (the lease-system convention):
 *   - beats fire on the cadence and stop cleanly on release;
 *   - a transient failure (connection blip) does NOT stop the loop — the
 *     next tick is the retry;
 *   - a definitive loss (AbloClaimedError) stops the loop and surfaces once
 *     through `onLost` — the failed beat is the loss notification;
 *   - overlapping beats are skipped, never stacked;
 *   - `heartbeatCadenceMs` defaults to a third of the TTL, floored at 1s.
 */

import {
  heartbeatCadenceMs,
  resolveHeartbeatPlan,
  startClaimHeartbeatLoop,
} from '@abloatai/transaction/claims';
import { AbloClaimedError, AbloConnectionError } from '@abloatai/transaction/errors';

describe('heartbeatCadenceMs', () => {
  it('defaults to a third of the TTL', () => {
    expect(heartbeatCadenceMs(60_000, true)).toBe(20_000);
  });

  it('floors the default cadence at 1s', () => {
    expect(heartbeatCadenceMs(1_500, true)).toBe(1_000);
  });

  it('honors an explicit duration over the default', () => {
    expect(heartbeatCadenceMs(60_000, '2m')).toBe(120_000);
  });
});

describe('startClaimHeartbeatLoop', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('beats on the cadence and stops on release', async () => {
    const beat = jest.fn(() =>
      Promise.resolve({ expiresAt: Date.now() + 60_000 }),
    );
    const stop = startClaimHeartbeatLoop({ beat, intervalMs: 1_000 });

    await jest.advanceTimersByTimeAsync(3_100);
    expect(beat).toHaveBeenCalledTimes(3);

    stop();
    await jest.advanceTimersByTimeAsync(5_000);
    expect(beat).toHaveBeenCalledTimes(3);
  });

  it('keeps beating through a transient failure', async () => {
    const beat = jest
      .fn<Promise<{ expiresAt: number }>, []>()
      .mockRejectedValueOnce(new AbloConnectionError('the connection blipped'))
      .mockResolvedValue({ expiresAt: Date.now() + 60_000 });
    const onLost = jest.fn();
    const stop = startClaimHeartbeatLoop({ beat, intervalMs: 1_000, onLost });

    await jest.advanceTimersByTimeAsync(2_100);
    expect(beat).toHaveBeenCalledTimes(2);
    expect(onLost).not.toHaveBeenCalled();
    stop();
  });

  it('stops and surfaces a definitive loss exactly once', async () => {
    const loss = new AbloClaimedError('the lease is no longer held', {
      code: 'claim_lost',
    });
    const beat = jest.fn(() => Promise.reject(loss));
    const onLost = jest.fn();
    startClaimHeartbeatLoop({ beat, intervalMs: 1_000, onLost });

    await jest.advanceTimersByTimeAsync(4_100);
    expect(beat).toHaveBeenCalledTimes(1);
    expect(onLost).toHaveBeenCalledTimes(1);
    expect(onLost).toHaveBeenCalledWith(loss);
  });

  it('skips a tick while the previous beat is still in flight', async () => {
    let resolveBeat: ((value: { expiresAt: number }) => void) | undefined;
    const beat = jest.fn(
      () =>
        new Promise<{ expiresAt: number }>((resolve) => {
          resolveBeat = resolve;
        }),
    );
    const stop = startClaimHeartbeatLoop({ beat, intervalMs: 1_000 });

    // Three ticks pass while the first beat hangs — no stacking.
    await jest.advanceTimersByTimeAsync(3_100);
    expect(beat).toHaveBeenCalledTimes(1);

    resolveBeat?.({ expiresAt: Date.now() + 60_000 });
    await jest.advanceTimersByTimeAsync(1_100);
    expect(beat).toHaveBeenCalledTimes(2);
    stop();
  });
});

describe('resolveHeartbeatPlan', () => {
  const onBeat = (): void => { /* identity-compared stub; not invoked in this test */ };
  const onLost = (): void => { /* identity-compared stub; not invoked in this test */ };

  it('reads the structured plan — cadence and both callbacks in one place', () => {
    expect(
      resolveHeartbeatPlan({ heartbeat: { every: '2m', onBeat, onLost } }),
    ).toEqual({ loop: true, cadence: '2m', onBeat, onLost });
  });

  it('keeps the shorthands: true and a bare Duration', () => {
    expect(resolveHeartbeatPlan({ heartbeat: true })).toEqual({
      loop: true,
      cadence: true,
    });
    expect(resolveHeartbeatPlan({ heartbeat: '30s' })).toEqual({
      loop: true,
      cadence: '30s',
    });
  });

  it('an empty plan means the TTL-derived default cadence', () => {
    expect(resolveHeartbeatPlan({ heartbeat: {} })).toEqual({
      loop: true,
      cadence: true,
    });
  });

  it('no heartbeat option: no loop, default cadence feed', () => {
    expect(resolveHeartbeatPlan({})).toEqual({ loop: false, cadence: true });
  });
});
