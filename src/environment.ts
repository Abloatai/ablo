import { z } from 'zod';

/**
 * The two environments an Ablo project runs in: `production` for live data and
 * `sandbox` for isolated test data. Every credential and every stored row
 * belongs to exactly one of them.
 */
export const ENVIRONMENTS = ['production', 'sandbox'] as const;

/**
 * How an environment is spelled inside an API-key prefix: a `live` key acts on
 * the production environment and a `test` key acts on the sandbox. Convert
 * between this spelling and {@link Environment} with
 * {@link environmentFromKeyPrefix} and {@link environmentToKeyPrefix}.
 */
export type KeyPrefixEnvironment = 'live' | 'test';

/** A Zod schema that validates a value as one of the {@link ENVIRONMENTS}. */
export const environmentSchema = z.enum(ENVIRONMENTS);

/** One of the {@link ENVIRONMENTS} — either `'production'` or `'sandbox'`. */
export type Environment = z.infer<typeof environmentSchema>;

/**
 * Coerces an untrusted value into a valid {@link Environment}, returning
 * `fallback` (which defaults to `'production'`) when the value is not a
 * recognized environment. Use it when reading an environment from configuration
 * or off the wire.
 */
export function normalizeEnvironment(value: unknown, fallback: Environment = 'production'): Environment {
  const parsed = environmentSchema.safeParse(value);
  return parsed.success ? parsed.data : fallback;
}

/**
 * Maps an API-key prefix spelling to its {@link Environment}: a `'test'` key
 * operates on the sandbox, and anything else on production.
 */
export function environmentFromKeyPrefix(value: KeyPrefixEnvironment): Environment {
  return value === 'test' ? 'sandbox' : 'production';
}

/**
 * Maps an {@link Environment} to the spelling used in an API-key prefix: the
 * sandbox is `'test'` and production is `'live'`.
 */
export function environmentToKeyPrefix(value: Environment): KeyPrefixEnvironment {
  return value === 'sandbox' ? 'test' : 'live';
}

/** Returns true when the given environment is the sandbox. */
export function isSandboxEnvironment(value: Environment): boolean {
  return value === 'sandbox';
}
