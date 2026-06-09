/**
 * Duration parser — `'3m'`, `'24h'`, `500` (ms), `'15s'`, etc.
 *
 * The same TTL flavor every config-driven tool uses (Vercel's `ms`,
 * Zod's `.duration()`, a hundred CLIs). Zero deps, one regex, three
 * units that cover everything the SDK needs:
 *
 *   - `'500ms'` → 500 ms
 *   - `'30s'`   → 30 000 ms
 *   - `'3m'`    → 180 000 ms
 *   - `'24h'`   → 86 400 000 ms
 *
 * Back-compat escape hatch: plain numbers are kept as-is and
 * interpreted in the caller's existing unit (seconds for TTL APIs).
 * This lets us retrofit the string form to every `ttlSeconds` field
 * without breaking numeric callers — the wrapper below branches on
 * the input type.
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
 * Parse a duration expressed as a number-of-seconds OR a unit-suffixed
 * string. Returns milliseconds. A bare number is interpreted as
 * **seconds** (matches the existing `ttlSeconds` semantics — prevents
 * silent breakage when a caller migrates from numeric to string).
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

/** Convenience: same as `toMs` but divides out to seconds. */
export function toSeconds(input: Duration): number {
  return Math.floor(toMs(input) / 1_000);
}
