import { computePrerollDelayMs, DEFAULT_PREROLL_INTERVAL_MS, MIN_PREROLL_DELAY_MS } from '../lifecycle';

describe('computePrerollDelayMs', () => {
  const now = 1_000_000;
  const fiveMinutes = now + 300_000;

  it('renews between one-half and two-thirds of the remaining lifetime', () => {
    expect(computePrerollDelayMs(fiveMinutes, now, () => 0)).toBe(200_000);
    expect(computePrerollDelayMs(fiveMinutes, now, () => 1)).toBe(150_000);
  });

  it('spreads clients that were minted in the same instant', () => {
    const delays = Array.from({ length: 20 }, (_, n) => computePrerollDelayMs(fiveMinutes, now, () => n / 20));
    expect(new Set(delays).size).toBe(20);
    expect(Math.max(...delays) - Math.min(...delays)).toBeGreaterThan(45_000);
  });

  it('always renews before expiry and never hot-loops', () => {
    for (const lifetime of [1, 20_000, 45_000, 300_000, 3_600_000]) {
      for (const spread of [0, 0.5, 1]) {
        const delay = computePrerollDelayMs(now + lifetime, now, () => spread);
        expect(delay).toBeGreaterThanOrEqual(MIN_PREROLL_DELAY_MS);
        expect(delay).toBeLessThanOrEqual(DEFAULT_PREROLL_INTERVAL_MS);
        if (lifetime > MIN_PREROLL_DELAY_MS * 2) expect(delay).toBeLessThan(lifetime);
      }
    }
    expect(computePrerollDelayMs(now - 1, now)).toBe(MIN_PREROLL_DELAY_MS);
    expect(computePrerollDelayMs(null, now)).toBe(DEFAULT_PREROLL_INTERVAL_MS);
  });
});
