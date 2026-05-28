import { Model, modelAsRow } from '../Model.js';
import { AbloValidationError } from '../errors.js';
import type { Schema, InferModel, InferCreate } from '../schema/schema.js';
import type { ModelDef } from '../schema/model.js';
// Type-only — `SyncStoreContract` is the store interface; importing the type
// does not pull the React `context` module's runtime.
import type { SyncStoreContract } from '../react/context.js';

/**
 * `create` / `update` / `delete` are overloaded: pass one row or an array
 * (Drizzle/Prisma `values(rowOrRows)` shape). Every entry in an array call
 * lands in the same synchronous tick (`Promise.all`), so the microtask
 * coalescer in `TransactionQueue` collapses N pushes into one wire commit.
 *
 * This module is the React-free core of CRUD staging. The transaction system
 * (`Transaction` / `RecordingTransaction`) and `BaseSyncedStore` build on it;
 * there is no React hook here (the legacy `useMutate` hook was removed —
 * callers use `ablo.<model>.create/update/delete`).
 */
type UpdatePatch<S extends Schema, K extends keyof S['models'] & string> =
  { id: string } & Partial<InferModel<S, K>>;

export interface MutateActions<S extends Schema, K extends keyof S['models'] & string> {
  /**
   * Create one entity, or an array of entities in a single tick. ID,
   * createdAt, updatedAt, organizationId default automatically per row.
   */
  create(data: InferCreate<S, K>): Promise<InferModel<S, K>>;
  create(data: InferCreate<S, K>[]): Promise<InferModel<S, K>[]>;
  /**
   * Update one row, or an array of rows in a single tick. Each patch is
   * `{ id, ...changes }` — missing ids throw. Schema-generated models are
   * MobX-observable, so direct assignment fires reactivity.
   */
  update(patch: UpdatePatch<S, K>): Promise<InferModel<S, K>>;
  update(patches: UpdatePatch<S, K>[]): Promise<InferModel<S, K>[]>;
  /**
   * Delete one row by id, or an array of ids in a single tick. Missing ids
   * are silently ignored.
   */
  delete(id: string): Promise<void>;
  delete(ids: string[]): Promise<void>;
  /** Soft-archive by ID. */
  archive: (id: string) => Promise<void>;
  /** Restore an archived entity by ID. */
  unarchive: (id: string) => Promise<void>;
}

/** Pure factory — builds CRUD actions over a store for one model. React-free. */
export function createMutateActions<
  S extends Schema,
  K extends keyof S['models'] & string,
>(
  schema: S,
  modelKey: K,
  store: SyncStoreContract,
  organizationId: string,
): MutateActions<S, K> {
  const modelDef = (schema.models as Record<string, ModelDef>)[modelKey];
  const typename = modelDef?.typename ?? modelKey;

  // Materialise one input row into a Model and stage a save. The default
  // fields land here once so create-of-one and create-of-array share the
  // same defaulting logic.
  const buildModelForCreate = (data: InferCreate<S, K>, now: Date): Model => {
    const record = data as Record<string, unknown>;
    const fullData = {
      ...record,
      __typename: typename,
      id: (record.id as string | undefined) ?? Model.generateId(),
      organizationId:
        (record.organizationId as string | undefined) ?? organizationId,
      createdAt: (record.createdAt as Date | undefined) ?? now,
      updatedAt: (record.updatedAt as Date | undefined) ?? now,
    };
    const model = store.pool.createFromData(fullData);
    if (!model) {
      throw new AbloValidationError(
        `createMutateActions: failed to create ${typename} — no constructor in registry`,
        { code: 'mutate_create_unknown_model' },
      );
    }
    return model;
  };

  // Apply a patch onto an existing pool model. Returns the model.
  const applyPatch = (patch: UpdatePatch<S, K>, now: Date): Model => {
    const { id, ...changes } = patch;
    const model = store.pool.get(id);
    if (!model) {
      throw new AbloValidationError(
        `createMutateActions: ${typename} with id "${id}" not found in pool`,
        { code: 'mutate_update_entity_not_found' },
      );
    }
    // Schema-derived patch keys are validated at the call-site type signature
    // (`UpdatePatch<S, K>`); writes here are dynamic-class field assignments.
    // `Reflect.set` is the typed bridge — Model carries no index signature, but
    // the dynamic field installation in `createDynamicModelClass` guarantees
    // these keys resolve at runtime.
    for (const [fieldName, value] of Object.entries(changes)) {
      Reflect.set(model, fieldName, value);
    }
    Reflect.set(model, 'updatedAt', now);
    return model;
  };

  return {
    // Overloaded — runtime `Array.isArray` decides shape. Both branches stage
    // via `Promise.all` so the microtask coalescer collapses N pushes into one
    // wire commit.
    create: (async (data: InferCreate<S, K> | InferCreate<S, K>[]) => {
      const now = new Date();
      if (Array.isArray(data)) {
        if (data.length === 0) return [];
        const models = data.map((d) => buildModelForCreate(d, now));
        await Promise.all(models.map((m) => store.save(m)));
        return models.map((m) => modelAsRow<InferModel<S, K>>(m));
      }
      const model = buildModelForCreate(data, now);
      await store.save(model);
      return modelAsRow<InferModel<S, K>>(model);
    }) as MutateActions<S, K>['create'],

    update: (async (patch: UpdatePatch<S, K> | UpdatePatch<S, K>[]) => {
      const now = new Date();
      if (Array.isArray(patch)) {
        if (patch.length === 0) return [];
        const models = patch.map((p) => applyPatch(p, now));
        await Promise.all(models.map((m) => store.save(m)));
        return models.map((m) => modelAsRow<InferModel<S, K>>(m));
      }
      const model = applyPatch(patch, now);
      await store.save(model);
      return modelAsRow<InferModel<S, K>>(model);
    }) as MutateActions<S, K>['update'],

    delete: (async (idOrIds: string | string[]) => {
      if (Array.isArray(idOrIds)) {
        if (idOrIds.length === 0) return;
        const models: Model[] = [];
        for (const id of idOrIds) {
          const m = store.pool.get(id);
          if (m) models.push(m);
        }
        await Promise.all(models.map((m) => store.delete(m)));
        return;
      }
      const model = store.pool.get(idOrIds);
      if (!model) return;
      await store.delete(model);
    }) as MutateActions<S, K>['delete'],

    archive: async (id) => {
      const model = store.pool.get(id);
      if (!model) return;
      await store.archive(model);
    },

    unarchive: async (id) => {
      const model = store.pool.get(id);
      if (!model) return;
      await store.unarchive(model);
    },
  };
}
