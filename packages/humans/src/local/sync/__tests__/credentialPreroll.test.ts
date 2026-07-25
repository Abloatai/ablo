/**
 * Credential pre-roll derives from the minted credential's ACTUAL expiry
 * (T1.36) — not a hardcoded 10-minute guess against the server's 15m default.
 *
 * Contract: refresh at ~2/3 of the remaining TTL, with the historical
 * 10-minute value as ceiling AND fallback (string-form resolvers report no
 * expiry), floored so short TTLs can't hot-loop the mint endpoint.
 */
import {
  CredentialLifecycle,
  computePrerollDelayMs,
  DEFAULT_PREROLL_INTERVAL_MS,
  MIN_PREROLL_DELAY_MS,
} from '../credentialLifecycle.js';
import { createTestContext } from '../../testing/mocks/MockSyncContext.js';
import type { TestContextResult } from '../../testing/mocks/MockSyncContext.js';

const MINUTE = 60_000;

describe('computePrerollDelayMs', () => {
  it('unknown expiry → the historical 10-minute fallback', () => {
    expect(computePrerollDelayMs(null, 0)).toBe(DEFAULT_PREROLL_INTERVAL_MS);
  });

  it('15m TTL → 10m (exactly the historical cadence, now derived)', () => {
    expect(computePrerollDelayMs(15 * MINUTE, 0)).toBe(10 * MINUTE);
  });

  it('short TTL schedules INSIDE the credential lifetime (the bug this fixes)', () => {
    // A 6-minute ek_ used to outlive the fixed 10-minute pre-roll entirely.
    expect(computePrerollDelayMs(6 * MINUTE, 0)).toBe(4 * MINUTE);
  });

  it('long TTL is capped at the 10-minute ceiling', () => {
    expect(computePrerollDelayMs(24 * 60 * MINUTE, 0)).toBe(DEFAULT_PREROLL_INTERVAL_MS);
  });

  it('already-expired / tiny TTLs are floored (no mint hot-loop)', () => {
    expect(computePrerollDelayMs(-5 * MINUTE, 0)).toBe(MIN_PREROLL_DELAY_MS);
    expect(computePrerollDelayMs(10_000, 0)).toBe(MIN_PREROLL_DELAY_MS);
  });
});

describe('CredentialLifecycle pre-roll scheduling', () => {
  let ctx: TestContextResult;

  beforeEach(() => {
    jest.useFakeTimers();
    ctx = createTestContext();
  });

  afterEach(() => {
    ctx.cleanup();
    jest.useRealTimers();
  });

  function makeLifecycle() {
    return new CredentialLifecycle({
      setAuthToken: jest.fn(),
      nudgeReconnect: jest.fn(),
      reportSessionExpired: jest.fn(),
    });
  }

  it('schedules off the reported expiresAt: a 6-minute credential pre-rolls at ~4m, not 10m', async () => {
    const mint = jest.fn(async () => ({
      token: 'ek_short',
      expiresAt: new Date(Date.now() + 6 * MINUTE).toISOString(),
      credentialKind: 'ephemeral' as const,
    }));
    const lifecycle = makeLifecycle();
    lifecycle.start(mint);

    // Initial (reactive) mint anchors the schedule to the real expiry.
    await lifecycle.refresh();
    expect(mint).toHaveBeenCalledTimes(1);

    // Before the derived 4-minute mark: nothing proactive fires.
    await jest.advanceTimersByTimeAsync(4 * MINUTE - 1_000);
    expect(mint).toHaveBeenCalledTimes(1);

    // At ~2/3 of the 6-minute TTL the pre-roll mints again — well INSIDE
    // the lifetime the old fixed 10-minute timer would have slept through.
    await jest.advanceTimersByTimeAsync(2_000);
    expect(mint).toHaveBeenCalledTimes(2);

    lifecycle.stop();
  });

  it('falls back to the 10-minute cadence for string-form resolvers (no expiry reported)', async () => {
    const mint = jest.fn(async () => 'ek_opaque');
    const lifecycle = makeLifecycle();
    lifecycle.start(mint);

    await jest.advanceTimersByTimeAsync(DEFAULT_PREROLL_INTERVAL_MS - 1_000);
    expect(mint).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(2_000);
    expect(mint).toHaveBeenCalledTimes(1);

    lifecycle.stop();
  });

  it('stop() disarms the pre-roll timer', async () => {
    const mint = jest.fn(async () => 'ek_opaque');
    const lifecycle = makeLifecycle();
    lifecycle.start(mint);
    lifecycle.stop();

    await jest.advanceTimersByTimeAsync(60 * MINUTE);
    expect(mint).not.toHaveBeenCalled();
  });
});
