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

import { z } from 'zod';
import { AbloValidationError } from '../errors.js';

export type Duration = number | `${number}ms` | `${number}s` | `${number}m` | `${number}h`;

const PATTERN = /^(\d+(?:\.\d+)?)(ms|s|m|h)$/;

/**
 * The same grammar as a boundary schema, so a duration crossing the wire is
 * checked against the parser that will read it rather than against a second
 * description of it.
 *
 * The regex is shared with {@link toMs} deliberately: `z.toJSONSchema` emits it
 * as a `pattern`, which is how a non-TypeScript caller learns the grammar at
 * all. A union of `number | string` — which is what this used to be on the
 * claim bodies — publishes as "some number or some string" and leaves the units
 * to be guessed.
 */
export const durationSchema = z.union([
  z.number().positive(),
  z.string().regex(PATTERN, {
    message: 'expected a duration such as "500ms", "30s", "3m" or "24h"',
  }),
]);

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
 *
 * Two doors, one implementation. {@link toMs} takes the narrow {@link Duration}
 * template type, so an SDK caller writing a literal gets the unit checked at
 * compile time. {@link parseDurationMs} takes the widened `string | number` that
 * {@link durationSchema} infers — the shape a value has after it crossed the
 * wire and was validated at the boundary. Neither is a cast of the other, and
 * neither carries its own copy of the grammar.
 */
export function toMs(input: Duration): number {
  return parseDurationMs(input);
}

/**
 * {@link toMs} for a value that arrived over the wire, where the type system
 * knows only `string | number` because that is what the boundary schema infers.
 */
export function parseDurationMs(input: string | number): number {
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
