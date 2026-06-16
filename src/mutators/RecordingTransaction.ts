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

import type { Schema, InferModel, InferCreate } from '../schema/schema.js';
import type { SyncStoreContract } from '../react/context.js';
import type { MutateActions } from './mutateActions.js';
import type { Transaction } from './Transaction.js';
import { createTransaction } from './Transaction.js';
import type { InverseOp, UndoEntry } from './UndoManager.js';

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
      // Undo applies inverses in REVERSE order of how the forward writes ran.
      // Redo applies forwards in the ORIGINAL order.
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
    // Model.toJSON produces a plain object suitable for re-create. We need
    // ALL fields when generating a delete→create inverse, so toJSON's
    // wider shape is exactly right.
    return model.toJSON();
  };

  // Before-image for the undo inverse. Delegates to `Model.capturePreviousValues`
  // — the SINGLE shared implementation (the stream path's
  // `TransactionQueue.extractPreviousData` calls the same method). `fallbackToLive`
  // is ON here: the manual-record path wants the live value as a last resort for
  // a field that was neither pre-mutated nor in the original snapshot. (The
  // stream path passes `false` so it can omit-and-drop instead — that flag is
  // the one intentional difference between the two callers.)
  const snapshotFields = (id: string, fieldNames: string[]): Record<string, unknown> | null => {
    const model = store.pool.get(id);
    if (!model) return null;
    return model.capturePreviousValues(fieldNames, { fallbackToLive: true });
  };

  // After a mutator's `base.update` succeeds, drop the `modifiedProperties`
  // entries we snapshotted from so the next mutator call sees THIS update's
  // result as its baseline, not the pre-session old value. The transaction
  // queue already captured its frozen copy synchronously inside `store.save`,
  // so this clear is safe for server rollback. Shared with the stream path via
  // `Model.consumeModifiedFields`.
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
        // Snapshot all previous values BEFORE applying — later patches
        // in the same list would corrupt the inverse state of earlier
        // ones if we snapshotted lazily.
        const prevPatches: Array<{ id: string } & Record<string, unknown>> = [];
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
    }) as MutateActions<S, K>['delete'],

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
