/**
 * Conflict-aware replay of undo and redo operations, so undo reverts only your
 * own changes.
 *
 * The undo stack is already per-client: only your local mutator calls record
 * onto it through `UndoScope.record`, and a collaborator's edits arrive as
 * inbound sync deltas that never enter it. This module adds the other half of
 * per-user undo. When replaying a recorded operation, it touches a field only
 * if that field's current value still equals the value this operation
 * established. Undo therefore reverts your change where it still stands and
 * leaves alone any field a collaborator has since overwritten — selective undo
 * applied to a field-level, last-writer-wins model.
 *
 * {@link resolveOps} does the filtering. It takes the operations about to be
 * replayed (`apply` — the inverses on undo, the forwards on redo) and their
 * counterparts (`paired`), which carry the value each operation established: on
 * undo the forwards say what you set, and on redo the inverses say what undo
 * restored. For `update` and `updateMany` operations it drops any field whose
 * live value no longer matches that established value. The `create` and
 * `delete` families are structural and always applied — undoing a create
 * removes the row you added, and undoing a delete restores it.
 *
 * When no collaborator is involved, the live value always equals what you set,
 * so nothing is dropped and single-user undo behaves exactly as before.
 */

import type { SyncStoreContract } from '../react/context.js';
import type { InverseOp } from './inverseOp.js';
import { deepEqual } from '../transaction/utils/json.js';

/**
 * How undo and redo treat a field that a collaborator changed after your
 * operation.
 *
 *   - `skip-stale` (the default): leave the field alone. Your change has
 *     already been superseded, so reverting it would overwrite the
 *     collaborator's value. This is what keeps undo scoped to your own edits.
 *   - `last-writer-wins`: apply the operation verbatim, so your undo overwrites
 *     the collaborator's change.
 */
export type UndoConflictPolicy = 'skip-stale' | 'last-writer-wins';

export const DEFAULT_UNDO_CONFLICT_POLICY: UndoConflictPolicy = 'skip-stale';

/**
 * Structural equality for JSON-shaped values — scalars, arrays, and plain
 * objects — ignoring object key order. Re-exported from the package's shared
 * JSON helper so the undo path and your own code can share one implementation.
 */
export { deepEqual };

/**
 * Map `id → { field: establishedValue }` from the paired ops. Only update-family
 * ops carry per-field values worth comparing.
 */
function buildEstablished(paired: InverseOp[]): Map<string, Record<string, unknown>> {
  const map = new Map<string, Record<string, unknown>>();
  for (const op of paired) {
    if (op.kind === 'update') {
      map.set(op.patch.id, op.patch);
    } else if (op.kind === 'updateMany') {
      for (const p of op.patches) map.set(p.id, p);
    }
  }
  return map;
}

/** Read the live value of a field from the store's pool, or `undefined`. */
function readCurrentField(store: SyncStoreContract, id: string, field: string): unknown {
  const model = store.pool.get(id);
  if (!model) return undefined;
  const json = (model as { toJSON?: () => Record<string, unknown> }).toJSON?.();
  return json ? json[field] : undefined;
}

type Patch = { id: string } & Record<string, unknown>;

/**
 * Keep only the fields whose live value still equals what this op established
 * (`established[field]`). Returns `null` if nothing survives (the whole op is a
 * no-op — every field was superseded by a collaborator).
 */
function filterStalePatch(
  store: SyncStoreContract,
  patch: Patch,
  established: Record<string, unknown> | undefined,
): Patch | null {
  const out: Record<string, unknown> = { id: patch.id };
  let kept = 0;
  for (const field of Object.keys(patch)) {
    if (field === 'id') continue;
    if (established && field in established) {
      // Apply only if the field still holds the value we established, meaning no
      // collaborator has overwritten it since. Otherwise skip it, so the
      // collaborator's change is left intact.
      if (deepEqual(readCurrentField(store, patch.id, field), established[field])) {
        out[field] = patch[field];
        kept++;
      }
    } else {
      // No paired value to compare against. The recorder always pairs fields,
      // so this is theoretical; apply to preserve undo functionality.
      out[field] = patch[field];
      kept++;
    }
  }
  return kept > 0 ? (out as Patch) : null;
}

/**
 * Filter the ops to apply so they don't clobber concurrent collaborator edits.
 * See the module docblock. `last-writer-wins` returns the ops unchanged.
 */
export function resolveOps(
  apply: InverseOp[],
  paired: InverseOp[],
  store: SyncStoreContract,
  policy: UndoConflictPolicy,
): InverseOp[] {
  if (policy === 'last-writer-wins') return apply;

  const established = buildEstablished(paired);
  const out: InverseOp[] = [];
  for (const op of apply) {
    if (op.kind === 'update') {
      const filtered = filterStalePatch(store, op.patch, established.get(op.patch.id));
      if (filtered) out.push({ kind: 'update', modelKey: op.modelKey, patch: filtered });
    } else if (op.kind === 'updateMany') {
      const patches = op.patches
        .map((p) => filterStalePatch(store, p, established.get(p.id)))
        .filter((p): p is Patch => p !== null);
      if (patches.length > 0) {
        out.push({ kind: 'updateMany', modelKey: op.modelKey, patches });
      }
    } else {
      // create / createMany / delete / deleteMany — structural, applied as-is.
      out.push(op);
    }
  }
  return out;
}
