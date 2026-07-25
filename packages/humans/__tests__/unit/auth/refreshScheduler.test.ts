/**
 * Unit tests for createRefreshScheduler.
 *
 * Uses Jest fake timers + an injected `now` source so the test runs in
 * deterministic logical time without real waits. The scheduler's I/O
 * is also injected (the `refresh` callback), which keeps the policy
 * code separately testable from the actual `exchangeApiKey` HTTP call.
 */

import { createRefreshScheduler } from '@ablo/transaction/auth';

describe('createRefreshScheduler', () => {
  let logicalNow = 0;
  const now = () => logicalNow;
  const advance = (ms: number): void => {
    logicalNow += ms;
    jest.advanceTimersByTime(ms);
  };

  beforeEach(() => {
    logicalNow = 1_000_000;
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('refreshes once at (expiresAt - bufferMs)', async () => {
    const refresh = jest.fn().mockResolvedValue({
      expiresAtMs: logicalNow + 7_200_000, // next window 2h out
    });

    const scheduler = createRefreshScheduler({
      initialExpiresAtMs: logicalNow + 3_600_000, // 1h
      bufferMs: 300_000, // 5min
      refresh,
      now,
      attachVisibilityListener: false,
    });

    advance(3_300_000 - 1); // 1ms before fire
    expect(refresh).not.toHaveBeenCalled();

    advance(2); // cross the boundary
    await Promise.resolve(); // let the inFlight promise settle
    expect(refresh).toHaveBeenCalledTimes(1);

    scheduler.dispose();
  });

  it('reschedules using the new expiresAtMs after each refresh', async () => {
    // Each refresh hands back a token expiring 1h after the call
    // moment. The scheduler should fire again ~5min before that.
    const refresh = jest.fn(() =>
      Promise.resolve({ expiresAtMs: logicalNow + 3_600_000 }),
    );

    const scheduler = createRefreshScheduler({
      initialExpiresAtMs: logicalNow + 3_600_000,
      bufferMs: 300_000,
      refresh,
      now,
      attachVisibilityListener: false,
    });

    // First fire: at expiry - buffer = 3_300_000 from start.
    advance(3_300_001);
    await Promise.resolve();
    expect(refresh).toHaveBeenCalledTimes(1);

    // After success, new expiresAt = logicalNow + 3_600_000.
    // Next fire window starts 3_300_000 later.
    advance(3_300_001);
    await Promise.resolve();
    expect(refresh).toHaveBeenCalledTimes(2);

    scheduler.dispose();
  });

  it('single-flights concurrent refreshNow() calls', async () => {
    let resolveRefresh: ((v: { expiresAtMs: number }) => void) | null = null;
    const refresh = jest.fn(
      () =>
        new Promise<{ expiresAtMs: number }>((res) => {
          resolveRefresh = res;
        }),
    );

    const scheduler = createRefreshScheduler({
      initialExpiresAtMs: logicalNow + 3_600_000,
      bufferMs: 300_000,
      refresh,
      now,
      attachVisibilityListener: false,
    });

    const p1 = scheduler.refreshNow();
    const p2 = scheduler.refreshNow();
    const p3 = scheduler.refreshNow();

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(p1).toBe(p2);
    expect(p2).toBe(p3);

    resolveRefresh!({ expiresAtMs: logicalNow + 7_200_000 });
    const result = await p1;
    expect(result.expiresAtMs).toBe(logicalNow + 7_200_000);

    scheduler.dispose();
  });

  it('reports failure via onError and reschedules to retry', async () => {
    const onError = jest.fn();
    const refresh = jest
      .fn()
      .mockRejectedValueOnce(new Error('network blip'))
      .mockResolvedValueOnce({ expiresAtMs: logicalNow + 7_200_000 });

    const scheduler = createRefreshScheduler({
      initialExpiresAtMs: logicalNow + 3_600_000,
      bufferMs: 300_000,
      refresh,
      onError,
      now,
      attachVisibilityListener: false,
    });

    advance(3_300_001);
    await Promise.resolve();
    await Promise.resolve(); // settle the rejected promise + reschedule
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0].message).toBe('network blip');

    // After failure the scheduler reschedules at "now" (token already
    // past buffer). Drain microtasks to let the next timer fire.
    await Promise.resolve();
    advance(0);
    await Promise.resolve();
    expect(refresh).toHaveBeenCalledTimes(2);

    scheduler.dispose();
  });

  it('dispose() cancels the pending timer', async () => {
    const refresh = jest.fn().mockResolvedValue({ expiresAtMs: 0 });

    const scheduler = createRefreshScheduler({
      initialExpiresAtMs: logicalNow + 3_600_000,
      bufferMs: 300_000,
      refresh,
      now,
      attachVisibilityListener: false,
    });

    scheduler.dispose();
    advance(3_600_000);
    expect(refresh).not.toHaveBeenCalled();
  });

  it('dispose() is idempotent', () => {
    const scheduler = createRefreshScheduler({
      initialExpiresAtMs: logicalNow + 3_600_000,
      bufferMs: 300_000,
      refresh: jest.fn().mockResolvedValue({ expiresAtMs: 0 }),
      now,
      attachVisibilityListener: false,
    });

    scheduler.dispose();
    expect(() => { scheduler.dispose(); }).not.toThrow();
  });

  it('expiresAtMs reflects the latest successful refresh', async () => {
    const refresh = jest
      .fn()
      .mockResolvedValue({ expiresAtMs: logicalNow + 9_999_999 });

    const scheduler = createRefreshScheduler({
      initialExpiresAtMs: logicalNow + 3_600_000,
      bufferMs: 300_000,
      refresh,
      now,
      attachVisibilityListener: false,
    });

    expect(scheduler.expiresAtMs).toBe(logicalNow + 3_600_000);

    await scheduler.refreshNow();
    expect(scheduler.expiresAtMs).toBe(logicalNow + 9_999_999);

    scheduler.dispose();
  });

  it('default buffer scales with TTL — max(60s, ttl/10)', async () => {
    const refresh = jest.fn().mockResolvedValue({
      expiresAtMs: logicalNow + 3_600_000 + 3_600_000,
    });

    // TTL = 1h → buffer = 360_000 (6min)
    const scheduler = createRefreshScheduler({
      initialExpiresAtMs: logicalNow + 3_600_000,
      refresh,
      now,
      attachVisibilityListener: false,
    });

    advance(3_240_000 - 1); // 6min - 1ms before expiry
    expect(refresh).not.toHaveBeenCalled();

    advance(2);
    await Promise.resolve();
    expect(refresh).toHaveBeenCalledTimes(1);

    scheduler.dispose();
  });

  it('default buffer floors at 60s for short TTLs', async () => {
    const refresh = jest.fn().mockResolvedValue({
      expiresAtMs: logicalNow + 600_000,
    });

    // TTL = 5min → ttl/10 = 30s, but floor is 60s → buffer = 60s
    const scheduler = createRefreshScheduler({
      initialExpiresAtMs: logicalNow + 300_000,
      refresh,
      now,
      attachVisibilityListener: false,
    });

    advance(240_000 - 1); // 1ms before fire
    expect(refresh).not.toHaveBeenCalled();

    advance(2);
    await Promise.resolve();
    expect(refresh).toHaveBeenCalledTimes(1);

    scheduler.dispose();
  });
});
