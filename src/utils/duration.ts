/**
 * Parses a duration into milliseconds. A duration is either a number of seconds
 * or a string with a unit suffix — milliseconds, seconds, minutes, or hours:
 *
 *   - `'500ms'` → 500 ms
 *   - `'30s'`   → 30 000 ms
 *   - `'3m'`    → 180 000 ms
 *   - `'24h'`   → 86 400 000 ms
 *
 * A bare number is interpreted as seconds rather than milliseconds, matching the
 * `ttlSeconds` fields used throughout the SDK, so a numeric caller and a string
 * caller can pass the same field interchangeably. {@link toMs} returns
 * milliseconds; {@link toSeconds} returns whole seconds.
 */

import { AbloValidationError } from '../errors.js';

export type Duration = number | `${number}ms` | `${number}s` | `${number}m` | `${number}h`;

const PATTERN = /^(\d+(?:\.\d+)?)(ms|s|m|h)$/;

const UNIT_MS: Record<'ms' | 's' | 'm' | 'h', number> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
};

/**
 * Parses a duration and returns the equivalent number of milliseconds. Accepts
 * either a bare number, interpreted as seconds, or a unit-suffixed string such
 * as `'500ms'`, `'30s'`, `'3m'`, or `'24h'`. Throws an
 * {@link AbloValidationError} with code `duration_invalid` when a string does
 * not match a supported unit.
 */
export function toMs(input: Duration): number {
  if (typeof input === 'number') return input * 1_000;
  const match = PATTERN.exec(input);
  if (!match) {
    throw new AbloValidationError(
      `Invalid duration "${input}" — expected number (seconds) or ` +
        `a string like "500ms" | "30s" | "3m" | "24h".`,
      { code: 'duration_invalid' },
    );
  }
  const value = Number(match[1]);
  const unit = match[2] as 'ms' | 's' | 'm' | 'h';
  return value * UNIT_MS[unit];
}

/** Parses a duration like {@link toMs} but returns whole seconds, rounding down. */
export function toSeconds(input: Duration): number {
  return Math.floor(toMs(input) / 1_000);
}
