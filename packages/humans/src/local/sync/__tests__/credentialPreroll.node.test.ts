/**
 * @jest-environment node
 *
 * Proactive pre-roll on a WINDOWLESS host (`proactiveInNode`).
 *
 * The pre-roll timer used to be hard-gated on `typeof window` — correct for
 * SSR/RSC module evals (whose scaffolded resolver is a relative-URL fetch
 * that can't run in Node), but it left long-lived server sockets with NO
 * pre-expiry renewal at all: their `rk_`/`ek_` aged out mid-run and the hub's
 * keepalive reaper closed the socket with 4001 `credential_expired`.
 *
 * Pins the new opt-in: `start(getToken, { proactiveInNode: true })` arms the
 * refresh timer without a `window` (the PowerSync/Ably "SDK renews on every
 * platform" model), while the DEFAULT Node posture stays reactive-only. Runs
 * under the node environment (suite default is jsdom) so `typeof window` is
 * genuinely undefined — the exact condition under test.
 */
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import {
  CredentialLifecycle,
  DEFAULT_PREROLL_INTERVAL_MS,
} from '../credentialLifecycle.js';

describe('CredentialLifecycle.start on a windowless host', () => {
  let setAuthToken: jest.Mock;
  let nudgeReconnect: jest.Mock;
  let reportSessionExpired: jest.Mock;
  let lifecycle: CredentialLifecycle;

  beforeEach(() => {
    jest.useFakeTimers();
    setAuthToken = jest.fn();
    nudgeReconnect = jest.fn();
    reportSessionExpired = jest.fn();
    lifecycle = new CredentialLifecycle({
      setAuthToken: setAuthToken,
      nudgeReconnect: nudgeReconnect,
      reportSessionExpired: reportSessionExpired,
    });
  });

  afterEach(() => {
    lifecycle.stop();
    jest.useRealTimers();
  });

  it('default posture stays reactive-only: no timer, no unsolicited mint', async () => {
    const getToken = jest.fn(() => Promise.resolve('rk_fresh'));
    lifecycle.start(getToken);

    await jest.advanceTimersByTimeAsync(DEFAULT_PREROLL_INTERVAL_MS * 3);

    // The refresher is registered (reactive path works)…
    await expect(lifecycle.refresh()).resolves.toBe('refreshed');
    // …but the elapsed time itself minted nothing: only our explicit call did.
    expect(getToken).toHaveBeenCalledTimes(1);
  });

  it('proactiveInNode arms the pre-roll: mint ahead of expiry, token pushed, reconnect nudged', async () => {
    const getToken = jest.fn(() => Promise.resolve('rk_fresh'));
    lifecycle.start(getToken, { proactiveInNode: true });

    expect(getToken).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(DEFAULT_PREROLL_INTERVAL_MS);

    expect(getToken).toHaveBeenCalledTimes(1);
    expect(setAuthToken).toHaveBeenCalledWith('rk_fresh');
    expect(nudgeReconnect).toHaveBeenCalledTimes(1);
    expect(reportSessionExpired).not.toHaveBeenCalled();
  });

  it('the pre-roll chain survives transient mint failures and keeps rolling', async () => {
    const getToken = jest
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error('mint endpoint unreachable'))
      .mockResolvedValue('rk_recovered');
    lifecycle.start(getToken, { proactiveInNode: true });

    // First tick fails (transient) — never a sign-out, chain re-arms.
    await jest.advanceTimersByTimeAsync(DEFAULT_PREROLL_INTERVAL_MS);
    expect(getToken).toHaveBeenCalledTimes(1);
    expect(reportSessionExpired).not.toHaveBeenCalled();
    expect(setAuthToken).not.toHaveBeenCalled();

    // Next tick recovers.
    await jest.advanceTimersByTimeAsync(DEFAULT_PREROLL_INTERVAL_MS);
    expect(getToken).toHaveBeenCalledTimes(2);
    expect(setAuthToken).toHaveBeenCalledWith('rk_recovered');
  });

  it('stop() disarms the timer', async () => {
    const getToken = jest.fn(() => Promise.resolve('rk_fresh'));
    lifecycle.start(getToken, { proactiveInNode: true });
    lifecycle.stop();

    await jest.advanceTimersByTimeAsync(DEFAULT_PREROLL_INTERVAL_MS * 3);
    expect(getToken).not.toHaveBeenCalled();
  });
});
