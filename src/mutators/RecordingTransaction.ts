/**
 * RecordingTransaction — wraps a base `Transaction` and captures inverse ops
 * for the undo system. Each write is observed BEFORE it runs (to snapshot
 * pre-state) and AFTER (to capture the forward op for redo).
 *
 * The wrapped mutator sees the exact same `Transaction<S>` shape; recording
 * is invisible. When the mutator returns, the caller reads `getEntry()` and
 * pushes it into the active `UndoScope`.
 *
 * Why snapshots live here (not in the UndoScope):
 *   - Update inverse requires `prev` field values — must be captured before
 *     the write lands in the pool.
 *   - Delete inverse requires the full model data — same reason.
 *   - Create inverse is simpler (delete by id) but the id must be known
 *     post-creation (schema generates UUIDs if caller omitted one).
 */

import type { Schema, InferModel, InferCreate } from '../schema/schema';
import type { SyncStoreContract } from '../react/context';
import type { Transaction, TransactionMutate } from './Transaction';
import { createTransaction } from './Transaction';
import type { InverseOp, UndoEntry } from './UndoManager';

export interface RecordingTransaction<S extends Schema> {
  /** The wrapped transaction — pass this into the mutator. */
  tx: Transaction<S>;
  /**
   * Finalize the recording. Returns the captured entry or `null` if the
   * mutator made no reversible writes (skip the push to save memory).
   */
  getEntry: (label?: string) => UndoEntry | null;
}

/**
 * Build a transaction that records inverses + forwards as it runs.
 * Consumers use this only when they want the invocation to be undoable;
 * read-only or side-effect-only mutators should use `createTransaction`
 * directly to avoid the bookkeeping overhead.
 */
export function createRecordingTransaction<S extends Schema>(
  schema: S,
  store: SyncStoreContract,
  organizationId: string,
): RecordingTransaction<S> {
  const inverses: InverseOp[] = [];
  const forwards: InverseOp[] = [];
  const inner = createTransaction(schema, store, organizationId);

  // Wrap mutations with a Proxy that intercepts each model key's
  // methods. We keep `inner.read` as-is — reads don't need recording.
  const mutateProxy = new Proxy({} as Transaction<S>['mutations'], {
    get(_target, prop: string | symbol) {
      if (typeof prop !== 'string') return undefined;
      const innerMutate = inner.mutations[prop as keyof typeof inner.mutations] as
        | TransactionMutate<S, keyof S['models'] & string>
        | undefined;
      if (!innerMutate) return innerMutate;
      return wrapMutateForKey(prop, innerMutate, store, inverses, forwards);
    },
  });

  return {
    tx: { mutations: mutateProxy, read: inner.read },
    getEntry: (label?: string) => {
      if (inverses.length === 0) return null;
      // Undo applies inverses in REVERSE order of how the forward writes ran.
      // Redo applies forwards in the ORIGINAL order.
      return { label, inverses: [...inverses].reverse(), forwards: [...forwards] };
    },
  };
}

// ── Per-key wrapper ────────────────────────────────────────────────────────

function wrapMutateForKey<S extends Schema, K extends keyof S['models'] & string>(
  modelKey: string,
  mutate: TransactionMutate<S, K>,
  store: SyncStoreContract,
  inverses: InverseOp[],
  forwards: InverseOp[],
): TransactionMutate<S, K> {
  const snapshot = (id: string): Record<string, unknown> | null => {
    const model = store.pool.get(id);
    if (!model) return null;
    // Model.toJSON produces a plain object suitable for re-create. We avoid
    // the narrower `Partial<InferModel>` type because we need ALL fields when
    // generating a delete→create inverse.
    const json = (model as unknown as { toJSON?: () => Record<string, unknown> }).toJSON;
    if (typeof json === 'function') return json.call(model);
    return { ...(model as unknown as Record<string, unknown>) };
  };

  const snapshotFields = (id: string, fieldNames: string[]): Record<string, unknown> | null => {
    const model = store.pool.get(id);
    if (!model) return null;
    const out: Record<string, unknown> = {};
    const source = model as unknown as Record<string, unknown>;
    for (const f of fieldNames) {
      if (f === 'id') continue;
      out[f] = source[f];
    }
    return out;
  };

  return {
    create: async (data: InferCreate<S, K>): Promise<InferModel<S, K>> => {
      const created = await mutate.create(data);
      const id = (created as unknown as { id: string }).id;
      // Forward: re-create with same data (caller-provided shape is ample).
      forwards.push({
        kind: 'create',
        modelKey,
        data: { ...(data as Record<string, unknown>), id },
      });
      // Inverse: delete the just-created entity.
      inverses.push({ kind: 'delete', modelKey, id });
      return created;
    },

    update: async (patch) => {
      const id = (patch as { id: string }).id;
      const fields = Object.keys(patch).filter((k) => k !== 'id');
      const prev = snapshotFields(id, fields);
      const updated = await mutate.update(patch);
      const patchCopy: { id: string } & Record<string, unknown> = {
        id,
        ...(patch as Record<string, unknown>),
      };
      forwards.push({ kind: 'update', modelKey, patch: patchCopy });
      if (prev) {
        inverses.push({ kind: 'update', modelKey, patch: { id, ...prev } });
      }
      return updated;
    },

    delete: async (id: string): Promise<void> => {
      const prev = snapshot(id);
      await mutate.delete(id);
      forwards.push({ kind: 'delete', modelKey, id });
      if (prev) {
        inverses.push({ kind: 'create', modelKey, data: prev });
      }
    },

    archive: async (id: string): Promise<void> => {
      await mutate.archive(id);
      forwards.push({
        kind: 'update',
        modelKey,
        patch: { id, archivedAt: new Date() },
      });
      // Inverse of archive is unarchive, modeled here as a "restore" update.
      inverses.push({ kind: 'update', modelKey, patch: { id, archivedAt: null } });
    },

    unarchive: async (id: string): Promise<void> => {
      await mutate.unarchive(id);
      forwards.push({ kind: 'update', modelKey, patch: { id, archivedAt: null } });
      inverses.push({
        kind: 'update',
        modelKey,
        patch: { id, archivedAt: new Date() },
      });
    },

    createMany: async (dataArray) => {
      const created = await mutate.createMany(dataArray);
      const withIds = created.map((m, i) => ({
        ...(dataArray[i] as Record<string, unknown>),
        id: (m as unknown as { id: string }).id,
      }));
      const ids = created.map((m) => (m as unknown as { id: string }).id);
      forwards.push({ kind: 'createMany', modelKey, data: withIds });
      inverses.push({ kind: 'deleteMany', modelKey, ids });
      return created;
    },

    updateMany: async (patches): Promise<void> => {
      // Snapshot all previous values BEFORE applying — otherwise later patches
      // in the list would corrupt the inverse state of earlier ones.
      const prevPatches: Array<{ id: string } & Record<string, unknown>> = [];
      for (const p of patches) {
        const fields = Object.keys(p).filter((k) => k !== 'id');
        const prev = snapshotFields((p as { id: string }).id, fields);
        if (prev) prevPatches.push({ id: (p as { id: string }).id, ...prev });
      }
      await mutate.updateMany(patches);
      forwards.push({
        kind: 'updateMany',
        modelKey,
        patches: patches.map((p) => {
          const rec = p as { id: string } & Record<string, unknown>;
          return { ...rec };
        }),
      });
      if (prevPatches.length > 0) {
        inverses.push({ kind: 'updateMany', modelKey, patches: prevPatches });
      }
    },

    deleteMany: async (ids): Promise<void> => {
      const prevs = ids.map((id) => snapshot(id)).filter((d): d is Record<string, unknown> => d !== null);
      await mutate.deleteMany(ids);
      forwards.push({ kind: 'deleteMany', modelKey, ids: [...ids] });
      if (prevs.length > 0) {
        inverses.push({ kind: 'createMany', modelKey, data: prevs });
      }
    },
  };
}
