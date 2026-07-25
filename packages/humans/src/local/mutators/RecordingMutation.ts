/**
 * Wraps a {@link Transaction} and records the inverse of every write so the
 * change can be undone. Each write is observed just before it runs, to snapshot
 * the previous state, and just after, to record the forward operation for redo.
 *
 * The mutator sees an ordinary `Transaction<S>` and is unaware it is being
 * recorded. When the mutator returns, the caller reads
 * {@link RecordingMutation.getEntry} and pushes the result onto the active
 * {@link UndoScope}.
 *
 * The snapshots are taken here rather than in the undo scope because they must
 * exist before the write lands: the inverse of an update needs the field's
 * previous values, and the inverse of a delete needs the full row. The inverse
 * of a create is just a delete by id, but that id is known only after creation,
 * since the schema generates one when the caller omits it.
 */

import type { Schema, InferModel, InferCreate } from '@ablo/transaction/schema/schema';
import type { SyncStoreContract } from '../storeContract.js';
import type { MutateActions } from './mutateActions.js';
import type { Transaction } from './Transaction.js';
import { createTransaction } from './Transaction.js';
import type { InverseOp, UndoEntry } from './UndoManager.js';

export interface RecordingMutation<S extends Schema> {
  /** The wrapped transaction — pass this into the mutator. */
  tx: Transaction<S>;
  /**
   * Finalize the recording. Returns the captured entry or `null` if the
   * mutator made no reversible writes (skip the push to save memory).
   */
  getEntry: (label?: string) => UndoEntry | null;
}

/**
 * Builds a transaction that records the forward and inverse of each write as it
 * runs. Use this only when the mutator should be undoable; a read-only or
 * side-effect-only mutator should call {@link createTransaction} directly to skip
 * the bookkeeping.
 */
export function createRecordingMutation<S extends Schema>(
  schema: S,
  store: SyncStoreContract,
  organizationId: string,
): RecordingMutation<S> {
  const inverses: InverseOp[] = [];
  const forwards: InverseOp[] = [];
  const inner = createTransaction(schema, store, organizationId);

  // Wrap mutations with a Proxy that intercepts each model key's
  // methods. We keep `inner.read` as-is — reads don't need recording.
  const mutateProxy = new Proxy({} as Transaction<S>['mutations'], {
    get(_target, prop: string | symbol) {
      if (typeof prop !== 'string') return undefined;
      const innerMutate = inner.mutations[prop as keyof typeof inner.mutations] as
        | MutateActions<S, keyof S['models'] & string>
        | undefined;
      if (!innerMutate) return innerMutate;
      return wrapMutateForKey(prop, innerMutate, store, inverses, forwards);
    },
  });

  return {
    tx: { mutations: mutateProxy, read: inner.read },
    getEntry: (label?: string) => {
      if (inverses.length === 0) return null;
      // Undo applies the inverses in reverse order of the forward writes; redo
      // applies the forwards in their original order.
      return { label, inverses: [...inverses].reverse(), forwards: [...forwards] };
    },
  };
}

// ── Per-key wrapper ────────────────────────────────────────────────────────

function wrapMutateForKey<S extends Schema, K extends keyof S['models'] & string>(
  modelKey: string,
  mutate: MutateActions<S, K>,
  store: SyncStoreContract,
  inverses: InverseOp[],
  forwards: InverseOp[],
): MutateActions<S, K> {
  const snapshot = (id: string): Record<string, unknown> | null => {
    const model = store.pool.get(id);
    if (!model) return null;
    // toJSON produces a plain object suitable for re-creating the row. The
    // delete→create inverse needs every field, which is exactly what it returns.
    return model.toJSON();
  };

  // Captures the before-image for an undo inverse, delegating to the model's
  // shared `capturePreviousValues`. `fallbackToLive` is enabled here so that a
  // field that was neither pre-mutated nor present in the original snapshot falls
  // back to its current value as a last resort.
  const snapshotFields = (id: string, fieldNames: string[]): Record<string, unknown> | null => {
    const model = store.pool.get(id);
    if (!model) return null;
    return model.capturePreviousValues(fieldNames, { fallbackToLive: true });
  };

  // After an update succeeds, clear the modified-field markers it was snapshotted
  // from, so the next write to the same row sees this update's result as its
  // baseline rather than the older pre-update value. The queue has already taken
  // its own frozen copy, so clearing here is safe.
  const consumeModifiedFields = (id: string, fieldNames: string[]): void => {
    store.pool.get(id)?.consumeModifiedFields(fieldNames);
  };

  type Patch = { id: string } & Partial<InferModel<S, K>>;

  return {
    // Overloaded — single row or array. The recorder dispatches the
    // matching forward/inverse op shape (`create`/`createMany`,
    // `update`/`updateMany`, `delete`/`deleteMany`) so the persisted
    // undo entry is symmetric with what was originally invoked.
    create: (async (
      data: InferCreate<S, K> | InferCreate<S, K>[],
    ) => {
      if (Array.isArray(data)) {
        const created = await mutate.create(data);
        const withIds = created.map((m, i) => ({
          ...(data[i] as Record<string, unknown>),
          id: m.id,
        }));
        const ids = created.map((m) => m.id);
        forwards.push({ kind: 'createMany', modelKey, data: withIds });
        inverses.push({ kind: 'deleteMany', modelKey, ids });
        return created;
      }
      const created = await mutate.create(data);
      const id = created.id;
      forwards.push({
        kind: 'create',
        modelKey,
        data: { ...(data as Record<string, unknown>), id },
      });
      inverses.push({ kind: 'delete', modelKey, id });
      return created;
    }) as MutateActions<S, K>['create'],

    update: (async (patch: Patch | Patch[]) => {
      if (Array.isArray(patch)) {
        // Snapshot every row's previous values before applying any patch: later
        // patches in the same list would corrupt an earlier one's inverse if the
        // snapshots were taken lazily.
        const prevPatches: ({ id: string } & Record<string, unknown>)[] = [];
        for (const p of patch) {
          const fields = Object.keys(p).filter((k) => k !== 'id');
          const prev = snapshotFields((p as { id: string }).id, fields);
          if (prev) prevPatches.push({ id: (p as { id: string }).id, ...prev });
        }
        const updated = await mutate.update(patch);
        const forwardPatches = patch.map(
          (p) => ({ ...(p as { id: string } & Record<string, unknown>) }),
        );
        for (const p of forwardPatches) {
          consumeModifiedFields(p.id, Object.keys(p).filter((k) => k !== 'id'));
        }
        forwards.push({ kind: 'updateMany', modelKey, patches: forwardPatches });
        if (prevPatches.length > 0) {
          inverses.push({ kind: 'updateMany', modelKey, patches: prevPatches });
        }
        return updated;
      }
      const id = (patch as { id: string }).id;
      const fields = Object.keys(patch).filter((k) => k !== 'id');
      const prev = snapshotFields(id, fields);
      const updated = await mutate.update(patch);
      const patchCopy: { id: string } & Record<string, unknown> = {
        id,
        ...(patch as Record<string, unknown>),
      };
      consumeModifiedFields(id, fields);
      forwards.push({ kind: 'update', modelKey, patch: patchCopy });
      if (prev) {
        inverses.push({ kind: 'update', modelKey, patch: { id, ...prev } });
      }
      return updated;
    }) as MutateActions<S, K>['update'],

    delete: (async (idOrIds: string | string[]): Promise<void> => {
      if (Array.isArray(idOrIds)) {
        const prevs = idOrIds
          .map((id) => snapshot(id))
          .filter((d): d is Record<string, unknown> => d !== null);
        await mutate.delete(idOrIds);
        forwards.push({ kind: 'deleteMany', modelKey, ids: [...idOrIds] });
        if (prevs.length > 0) {
          inverses.push({ kind: 'createMany', modelKey, data: prevs });
        }
        return;
      }
      const prev = snapshot(idOrIds);
      await mutate.delete(idOrIds);
      forwards.push({ kind: 'delete', modelKey, id: idOrIds });
      if (prev) {
        inverses.push({ kind: 'create', modelKey, data: prev });
      }
    }),

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
  };
}
