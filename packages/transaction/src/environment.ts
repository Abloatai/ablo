import { z } from 'zod';

/**
 * Two axes live in this module, and they are NOT the same axis. They stay
 * together because they convert into each other; they stay distinct because
 * conflating them is how credentials acquire a mode nobody chose.
 *
 *  - The PLANE axis ({@link Environment}) — which isolated plane a row, schema
 *    artifact, or data source belongs to. Open-ended: `production` is the root
 *    plane and any number of others may exist beside it.
 *  - The CREDENTIAL axis ({@link KeyEnvironment}) — the mode a key was minted
 *    in. Binary, and fixed by the key format: a prefix spells exactly one of
 *    `live` or `test`, so a third value is not representable in a key at all.
 *
 * These were one type until this split, which is the shape behind two
 * incidents: an `sk_test_` exchange that minted an `ek_live_` and landed
 * sandbox commits in another tenant's tables, and a rotation that handed back
 * an `rk_live_` in place of an `rk_test_`. Widening the plane axis while the
 * credential axis aliased it would reopen that door one plane name wider, so
 * the split comes first and the conversions below are deliberately narrow.
 */

/**
 * The plane names every deployment has: the root, plus the plane every project
 * starts with beside it. This is the well-known set, not the permitted set —
 * {@link environmentSchema} decides what is valid.
 */
export const ENVIRONMENTS = ['production', 'sandbox'] as const;

/** The root plane — the one every other plane is defined relative to. */
export const ROOT_ENVIRONMENT = 'production';

/**
 * The modes a credential can be minted in. Deliberately its own list rather
 * than a view of {@link ENVIRONMENTS}: this one is fixed by the key format,
 * which has exactly two prefix spellings, and must not grow when planes do.
 */
export const KEY_ENVIRONMENTS = ['production', 'sandbox'] as const;

/**
 * How a credential's mode is spelled inside an API-key prefix: a `live` key
 * acts on production and a `test` key acts on the sandbox. Convert between this
 * spelling and {@link KeyEnvironment} with {@link environmentFromKeyPrefix} and
 * {@link environmentToKeyPrefix}.
 */
export const KEY_PREFIX_ENVIRONMENTS = ['live', 'test'] as const;
export type KeyPrefixEnvironment = (typeof KEY_PREFIX_ENVIRONMENTS)[number];

/**
 * Validates a value as a plane name — a lowercase slug that may not lead or
 * trail with a hyphen.
 *
 * The character set is load-bearing rather than cosmetic. A plane name is
 * interpolated into two delimited identifiers: the sync-group prefix
 * (`sandbox:<org>:<slug>`, colon separated) and the tenant secret scope
 * (`<org>/<env>/<project>/<sandbox>`, slash separated). Admitting `:` or `/`
 * would let one plane's name parse as two segments and so collide with a
 * different plane's identity, which is why the pattern excludes every delimiter
 * either format relies on.
 */
export const environmentSchema = z
  .string()
  .regex(/^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/, 'must be a lowercase slug');

/** A plane name. `production` is the root; any other slug is a plane beside it. */
export type Environment = z.infer<typeof environmentSchema>;

/** Validates a value as one of the {@link KEY_ENVIRONMENTS}. */
export const keyEnvironmentSchema = z.enum(KEY_ENVIRONMENTS);

/**
 * The mode a credential was minted in — `'production'` or `'sandbox'`, never
 * anything else. Not an alias of {@link Environment}: a key's mode is a trust
 * boundary, and a plane name must never be able to answer it.
 */
export type KeyEnvironment = z.infer<typeof keyEnvironmentSchema>;

/**
 * Coerces an untrusted value into a valid {@link Environment}, returning
 * `fallback` (which defaults to the root plane) when the value is not a
 * well-formed plane name. Use it when reading a plane from configuration or off
 * the wire.
 */
export function normalizeEnvironment(value: unknown, fallback: Environment = ROOT_ENVIRONMENT): Environment {
  const parsed = environmentSchema.safeParse(value);
  return parsed.success ? parsed.data : fallback;
}

/** True when the given plane is the root plane. */
export function isRootEnvironment(value: Environment): boolean {
  return value === ROOT_ENVIRONMENT;
}

/**
 * The mode a credential acting on the given plane must be minted in.
 *
 * This is the ONE narrowing from the open plane axis to the binary credential
 * axis, and it is deliberately asymmetric: only the root plane yields a
 * production-mode key, and every other plane — named, numbered, or newly forked
 * — yields a sandbox-mode one. A plane cannot acquire live authority by being
 * spelled a particular way, which is the property that keeps adding planes from
 * widening what any credential is allowed to touch.
 */
export function keyEnvironmentForPlane(value: Environment): KeyEnvironment {
  return isRootEnvironment(value) ? 'production' : 'sandbox';
}

/**
 * Maps an API-key prefix spelling to the mode it denotes: a `'test'` key was
 * minted in the sandbox, and anything else in production.
 */
export function environmentFromKeyPrefix(value: KeyPrefixEnvironment): KeyEnvironment {
  return value === 'test' ? 'sandbox' : 'production';
}

/**
 * Maps a credential's mode to the spelling used in its key prefix.
 *
 * Takes a {@link KeyEnvironment} rather than an {@link Environment} on purpose.
 * Planes outside the well-known two have no prefix spelling, and a signature
 * that accepted one would silently answer `'live'` for them — minting a
 * production-mode credential for a plane that is not production. That is the
 * 2026-06-10 incident with a new cause, so the type refuses the input instead.
 */
export function environmentToKeyPrefix(value: KeyEnvironment): KeyPrefixEnvironment {
  return value === 'sandbox' ? 'test' : 'live';
}

/** Returns true when the given environment is the sandbox. */
export function isSandboxEnvironment(value: Environment): boolean {
  return value === 'sandbox';
}
