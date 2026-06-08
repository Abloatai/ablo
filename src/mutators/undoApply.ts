/**
 * undoApply.ts — conflict-aware resolution of undo/redo ops (per-user undo).
 *
 * The undo stack is already per-client (only local mutator invocations call
 * `UndoScope.record`; a collaborator's edits arrive as inbound sync deltas and
 * never land here). What this module adds is the second half of "undo per
 * user": when replaying a recorded op, only touch a field whose CURRENT value
 * still equals what THIS op established — so undo reverts your own change only
 * where it still stands, and never clobbers a field a collaborator changed
 * after you (the Yjs/CRDT "selective undo" principle, adapted to our
 * field-level last-writer-wins model).
 *
 * `resolveOps(apply, paired, store, policy)`:
 *   - `apply`  — the ops we're about to replay (inverses on undo, forwards on redo).
 *   - `paired` — their counterparts, carrying the value this op established
 *     (forwards on undo = "what I set"; inverses on redo = "what undo restored").
 *   - For `update`/`updateMany` ops it drops fields whose live value no longer
 *     matches the established value. `create`/`delete` families are structural
 *     and applied unconditionally (undoing your create removes the row you
 *     added; undoing your delete restores it).
 *
 * With no collaborator, the live value always equals what you set, so nothing
 * is dropped — single-user undo is byte-for-byte unchanged.
 */

import type { SyncStoreContract } from '../react/context.js';
import type { InverseOp } from './inverseOp.js';

/**
 * How undo/redo handles a field a collaborator changed after your op:
 *   - `skip-stale` (default): leave it — your change is already superseded, so
 *     reverting it would clobber theirs. This is the per-user guarantee.
 *   - `last-writer-wins`: apply the op verbatim (legacy behavior). Your undo
 *     overwrites their change.
 */
export type UndoConflictPolicy = 'skip-stale' | 'last-writer-wins';

export const DEFAULT_UNDO_CONFLICT_POLICY: UndoConflictPolicy = 'skip-stale';

/** Structural equality for JSON-shaped values (scalars, arrays, plain objects). */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') {
    return false;
  }
  const aArr = Array.isArray(a);
  if (aArr !== Array.isArray(b)) return false;
  if (aArr) {
    const av = a as unknown[];
    const bv = b as unknown[];
    if (av.length !== bv.length) return false;
    for (let i = 0; i < av.length; i++) {
      if (!deepEqual(av[i], bv[i])) return false;
    }
    return true;
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const ak = Object.keys(ao);
  const bk = Object.keys(bo);
  if (ak.length !== bk.length) return false;
  for (const k of ak) {
    if (!Object.prototype.hasOwnProperty.call(bo, k)) return false;
    if (!deepEqual(ao[k], bo[k])) return false;
  }
  return true;
}

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
      // Apply only if the field still holds the value WE established — i.e. no
      // collaborator overwrote it since. Otherwise skip (don't clobber them).
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
