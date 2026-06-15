/**
 * THE write-options schema — one Zod schema for the write dialect every
 * door speaks (`ablo.<model>.create/update/delete`, `commits.create`, the
 * HTTP model routes). Validated once at each public boundary so a plain-JS
 * caller passing `onStale: 'rejct'` fails loudly at the call site with a
 * typed `AbloValidationError`, not silently (or 400) at the server.
 *
 * Mirrors `source/contract.ts`: the schema is the runtime twin of the
 * `MutationOptions` interface, with a compile-time drift guard at the
 * bottom so the two can never silently diverge.
 *
 * Validation-only by design: callers keep their ORIGINAL options object.
 * Zod's parse output strips unknown keys, and the `claim` slot legally
 * carries live handles (`ClaimHandle` / claim leases) whose
 * `release`/`revoke` functions must survive — so we assert, never replace.
 */

import { z } from 'zod';
import type { MutationOptions } from '../interfaces/index.js';
import { AbloValidationError } from '../errors.js';

export const onStaleModeSchema = z.enum(['reject', 'force', 'flag', 'merge']);

export const writeOptionsSchema = z.object({
  /** Server-side mutation_log cache key; `null` opts out of retry-safety. */
  idempotencyKey: z.string().min(1).max(255).nullish(),
  /** Human-readable audit tag, persisted to `mutation_log.label`. */
  label: z.string().max(255).optional(),
  /** Resolve when queued locally (default) or once the server confirms. */
  wait: z.enum(['queued', 'confirmed']).optional(),
  /** Stale guard: the sync watermark the caller's reasoning was based on. */
  readAt: z.number().int().nonnegative().nullish(),
  /** What the server does when the target moved past `readAt`. */
  onStale: onStaleModeSchema.nullish(),
  /** Claim/claim attribution — an id, or a live lease handle (loose: the
   *  handle's `release`/`revoke` functions ride along untouched). */
  claim: z.union([z.string(), z.looseObject({ id: z.string() })]).nullish(),
  /** Dormant wire-compat field; always `null` from current clients. */
  causedByTaskId: z.string().nullish(),
});

export type WriteOptionsInput = z.infer<typeof writeOptionsSchema>;

/**
 * Assert a write-options bag against THE schema. Throws a typed
 * `AbloValidationError` (`code: 'write_options_invalid'`, Stripe-style
 * `param` pointing at the offending field) and returns nothing — the
 * caller keeps its original object.
 */
export function assertWriteOptions(
  value: unknown,
  context?: string,
): void {
  if (value == null) return;
  const result = writeOptionsSchema.safeParse(value);
  if (result.success) return;
  const issue = result.error.issues[0];
  const path = issue?.path.map(String).join('.') ?? '';
  throw new AbloValidationError(
    `Invalid write options${context ? ` on \`${context}\`` : ''}${
      path ? ` at \`${path}\`` : ''
    }: ${issue?.message ?? 'failed validation'}.`,
    {
      code: 'write_options_invalid',
      ...(path ? { param: path } : {}),
    },
  );
}

// ── Drift guard ──────────────────────────────────────────────────────────────
// Compile-time proof that `writeOptionsSchema` stays assignment-compatible
// with the canonical `MutationOptions` interface. If either side changes
// shape, this stops compiling — the schema and the interface can never
// silently diverge.
type _AssertOptionsMatchSchema = MutationOptions extends WriteOptionsInput
  ? true
  : never;
type _AssertSchemaMatchesOptions = WriteOptionsInput extends MutationOptions
  ? true
  : never;
const _writeOptionsContractInSync: [
  _AssertOptionsMatchSchema,
  _AssertSchemaMatchesOptions,
] = [true, true];
void _writeOptionsContractInSync;
