/**
 * The Zod schema for write options — the settings accepted by every write
 * entry point, including `ablo.<model>.create/update/delete`, `commits.create`,
 * and the HTTP write routes. Each of those boundaries validates against this
 * one schema, so a caller who passes, say, `onStale: 'rejct'` fails right away
 * with a typed {@link AbloValidationError} at the call site instead of silently
 * or with a 400 from the server.
 *
 * The schema is the runtime counterpart of the {@link MutationOptions}
 * interface. A compile-time check at the bottom of this file asserts that the
 * two describe the same shape, so they cannot drift apart.
 *
 * Validation only inspects; it never transforms. Callers keep the exact options
 * object they passed in. This matters because the `claim` field can hold a live
 * claim handle whose `release` and `revoke` functions must survive, so the code
 * asserts the shape rather than replacing the value with a parsed copy.
 */

import { z } from 'zod';
import { logPositionSchema } from '../syncLog/contract.js';
import type { MutationOptions } from '../resources/mutationOptions.js';
import { AbloValidationError } from '../errors.js';
import { commitWaitSchema } from '../wire/commit.js';
import {
  onStaleModeSchema,
  MAX_READ_SET_ENTRIES,
  readDependencyListSchema,
  readSetProjectionEntryCount,
  trackDependencyListSchema,
} from '../coordination/schema.js';
import type { AssertExact } from '../types/assertExact.js';

// Re-exported, not redeclared. `coordination/schema.ts` owns this enum — it is
// what the wire schemas and the server validate against — while the published
// SDK barrel exports the name from this module. Declaring it twice put a second
// object behind the public export that agreed with the canonical one only by
// both happening to list the same three strings.
export { onStaleModeSchema };

export const writeOptionsSchema = z.object({
  /** Idempotency key the server records in `mutation_log` to make retries
   *  safe; `null` opts out of that protection. */
  idempotencyKey: z.string().min(1).max(255).nullish(),
  /** Human-readable audit tag, persisted to `mutation_log.label`. */
  label: z.string().max(255).optional(),
  /** Resolve when queued locally (default) or once the server confirms. */
  wait: commitWaitSchema.optional(),
  /** Stale guard: the sync watermark the caller's reasoning was based on. */
  readAt: logPositionSchema.nullish(),
  /** What the server does when the target moved past `readAt`. */
  onStale: onStaleModeSchema.nullish(),
  /** The held claim's fencing token (Option B), sourced from the claim handle
   *  rather than set by hand; the server validates it against the entity's
   *  high-water. Kept in the schema so it stays aligned with `MutationOptions`
   *  (the drift guard below) and a malformed token is rejected at the boundary. */
  fenceToken: z.number().nullish(),
  /** The claim this write belongs to — either a claim id, or a live claim
   *  handle whose `release`/`revoke` functions are preserved untouched. */
  claim: z.union([z.string(), z.looseObject({ id: z.string() })]).nullish(),
  /** Low-level claim identity carried after a live handle is normalized. */
  claimRef: z.union([z.string(), z.object({ id: z.string() })]).nullish(),
  /** Commit-lifetime entries in the write's ReadSet. */
  reads: readDependencyListSchema.nullish(),
  /** Persisted entries projected from the write's ReadSet. */
  track: trackDependencyListSchema.nullish(),
}).refine((value) => readSetProjectionEntryCount(value) <= MAX_READ_SET_ENTRIES, {
  path: ['reads'],
  message: `reads and track may contain at most ${MAX_READ_SET_ENTRIES} entries combined`,
});

export type WriteOptionsInput = z.infer<typeof writeOptionsSchema>;

/**
 * Validates a write-options object against {@link writeOptionsSchema}. On
 * failure it throws a typed {@link AbloValidationError} — with
 * `code: 'write_options_invalid'` and a `param` pointing at the offending
 * field — and on success returns nothing, leaving the caller's original object
 * untouched. A `null` or `undefined` value passes.
 */
export function assertWriteOptions(value: unknown, context?: string): void {
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
    }
  );
}

// ── Drift guard ──────────────────────────────────────────────────────────────
// `claim` is the one high-level handle normalized before MutationOptions. Every
// other key is the canonical interface itself. Compare keys exactly: mutual
// assignment between all-optional objects is vacuous and failed to catch three
// missing members in this schema.
type WriteOptionsContract = MutationOptions & {
  readonly claim?: string | { readonly id: string } | null;
};
const _writeOptionsContractInSync: AssertExact<
  keyof WriteOptionsInput,
  keyof WriteOptionsContract
> = true;
void _writeOptionsContractInSync;

/**
 * Refuse a per-model write that does not name its row.
 *
 * `update` and `delete` address the row through the URL, so an absent `id`
 * used to be spelled into the path by `encodeURIComponent` as the literal
 * string `"undefined"`. The request was well-formed, it matched no row, and it
 * came back as an ordinary receipt: `delete({ where: { id } })` reported
 * success and deleted nothing. `{ where }` is the shape the commit protocol
 * takes one layer down, so reaching for it here is an easy and quiet mistake.
 *
 * The typed surface already rejects it at compile time. This is the same
 * refusal for callers who reach the transport without those types.
 */
export function assertWriteTarget(
  action: 'update' | 'delete',
  modelName: string,
  id: unknown,
): void {
  if (typeof id === 'string' && id.length > 0) return;
  const namedAFilter =
    typeof id === 'object' && id !== null && 'where' in (id as Record<string, unknown>);
  throw new AbloValidationError(
    `A ${modelName} ${action} has to name the row it acts on: ${action}({ id })` +
      (namedAFilter ? ', not a `where` filter.' : '.'),
    { code: 'invalid_body', param: 'id' },
  );
}
