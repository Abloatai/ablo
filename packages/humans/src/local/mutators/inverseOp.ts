/**
 * The reversible-operation model for the undo system, expressed as Zod schemas.
 *
 * These schemas serve two roles. First, the {@link InverseOp} and
 * {@link UndoEntry} TypeScript types are derived from them with `z.infer`, so
 * the runtime shape and the static type stay in step. Second, they form a
 * validation boundary: an inverse operation is stored as a plain JSON record
 * (a model key plus row data) so the undo manager can replay it without knowing
 * your schema. {@link parseUndoEntry} validates an untrusted value at that
 * boundary — for example, an entry restored from persisted history — before it
 * re-enters the replay path.
 *
 * The operation kinds match the mutator surface one for one — single
 * (`create`, `update`, `delete`) and batch (`createMany`, `updateMany`,
 * `deleteMany`) — so a recorded entry mirrors the call that produced it.
 */

import { z } from 'zod';
import { AbloValidationError } from '@ablo/transaction/errors';

/** A row payload — JSON-shaped record used by create/createMany inverses. */
const rowDataSchema = z.record(z.string(), z.unknown());

/**
 * An update patch: an `id` plus the changed fields. Modeled as an object with
 * a required `id` and an open `catchall`, so `z.infer` yields
 * `{ id: string } & { [k: string]: unknown }` — the exact shape the recorder
 * builds and the replayer consumes.
 */
const patchSchema = z.object({ id: z.string() }).catchall(z.unknown());

/**
 * A single reversible operation. Discriminated on `kind` so a malformed op
 * fails fast with a precise path (e.g. `inverses[2].patch.id`) rather than a
 * vague union mismatch. Model keys/data are strings/records — the manager is
 * schema-agnostic; the transaction it replays through is schema-typed.
 */
export const inverseOpSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('create'), modelKey: z.string(), data: rowDataSchema }),
  z.object({ kind: z.literal('update'), modelKey: z.string(), patch: patchSchema }),
  z.object({ kind: z.literal('delete'), modelKey: z.string(), id: z.string() }),
  z.object({ kind: z.literal('createMany'), modelKey: z.string(), data: z.array(rowDataSchema) }),
  z.object({ kind: z.literal('updateMany'), modelKey: z.string(), patches: z.array(patchSchema) }),
  z.object({ kind: z.literal('deleteMany'), modelKey: z.string(), ids: z.array(z.string()) }),
]);

/** One undo entry = one mutator invocation's inverses + paired forwards. */
export const undoEntrySchema = z.object({
  /** Optional label for diagnostics / UI ("Move block", "Delete section", etc). */
  label: z.string().optional(),
  /** Applied (in array order) to reverse the invocation. */
  inverses: z.array(inverseOpSchema),
  /**
   * Paired forward ops, captured at record time so redo can replay them
   * without re-running the user's mutator (which may have non-idempotent
   * side effects like generating new IDs).
   */
  forwards: z.array(inverseOpSchema),
});

/** A single reversible operation (schema-derived). */
export type InverseOp = z.infer<typeof inverseOpSchema>;

/** One undo/redo stack entry (schema-derived). */
export type UndoEntry = z.infer<typeof undoEntrySchema>;

/**
 * Validate an untrusted value as an `UndoEntry`. Use at any boundary where an
 * entry crosses out of internal construction — deserialization from
 * persistence, or a defensive check at the recording ingestion point. Throws
 * `AbloValidationError` (code `undo_entry_invalid`) with the failing Zod path
 * in `details` so the offending op is obvious.
 */
export function parseUndoEntry(value: unknown): UndoEntry {
  const result = undoEntrySchema.safeParse(value);
  if (!result.success) {
    throw new AbloValidationError('Undo entry failed inverse-op schema validation.', {
      code: 'undo_entry_invalid',
      details: { issues: result.error.issues },
    });
  }
  return result.data;
}
