'use client';

import { useMemo } from 'react';
import { Model, modelAsRow } from '../Model.js';
import { AbloValidationError } from '../errors.js';
import type { Schema, InferModel, InferCreate } from '../schema/schema.js';
import type { ModelDef } from '../schema/model.js';
import type { ResolveSchema } from '../types/global.js';
import type { SyncStoreContract } from './context.js';
import { useSyncContext } from './context.js';

// Global-augmented narrowing: same pattern as useQuery — lets consumers
// who've declared `interface AbloSync { Schema: typeof schema }` drop the
// schema arg at every call site.
type GlobalMutateKey = ResolveSchema extends { models: infer M }
  ? keyof M & string
  : string;

type GlobalMutateActions<K extends string> = ResolveSchema extends Schema
  ? K extends keyof ResolveSchema['models'] & string
    ? MutateActions<ResolveSchema, K>
    : MutateActions<Schema, string>
  : MutateActions<Schema, string>;

/**
 * Compatibility mutation hook. Returns CRUD methods for a single model type.
 *
 * Prefer `useAblo()` and call `ablo.<model>.create/update/delete` inside
 * callbacks for new integrations. This hook remains for older string-keyed code.
 *
 * @example
 * import { schema } from '@ablo/schema';
 * import { useMutate } from '@ablo/sync-engine/react';
 *
 * const tasks = useMutate(schema, 'tasks');
 *
 * // Create — fields are type-checked against the schema's Zod shape
 * await tasks.create({ title: 'Fix bug', status: 'todo', projectId });
 *
 * // Update — id + partial changes, no need to hold a model instance
 * await tasks.update({ id: task.id, status: 'done', completedAt: new Date() });
 *
 * // Delete / archive / unarchive — by id
 * await tasks.delete(task.id);
 * await tasks.archive(task.id);
 *
 * Mirrors the Zero pattern: `zero.mutate.task.update({ id, status: 'done' })`.
 */

/**
 * `create` / `update` / `delete` are overloaded: pass one row or an
 * array. Drizzle and Prisma use the same shape (`db.insert(table).values(rowOrRows)`).
 * Avoids the `*Many` suffix while keeping the semantics: every entry in
 * an array call lands in the same synchronous tick (Promise.all under
 * the hood), so the microtask coalescer in `TransactionQueue` collapses
 * N pushes into one wire commit with one `batchIndex` — structurally
 * identical to Zero's mutator-boundary commit.
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
   * `{ id, ...changes }` — missing ids throw. Schema-generated models
   * are MobX-observable, so direct assignment fires reactivity.
   */
  update(patch: UpdatePatch<S, K>): Promise<InferModel<S, K>>;
  update(patches: UpdatePatch<S, K>[]): Promise<InferModel<S, K>[]>;
  /**
   * Delete one row by id, or an array of ids in a single tick. Missing
   * ids are silently ignored.
   */
  delete(id: string): Promise<void>;
  delete(ids: string[]): Promise<void>;
  /** Soft-archive by ID. */
  archive: (id: string) => Promise<void>;
  /** Restore an archived entity by ID. */
  unarchive: (id: string) => Promise<void>;
}

/**
 * Pure factory — testable without React. The hook just wraps this in
 * useMemo with the React context.
 */
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
        `useMutate: failed to create ${typename} — no constructor in registry`,
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
        `useMutate: ${typename} with id "${id}" not found in pool`,
        { code: 'mutate_update_entity_not_found' },
      );
    }
    // Schema-derived patch keys are validated at the call-site type
    // signature (`UpdatePatch<S, K>`); writes here are dynamic-class
    // field assignments. `Reflect.set` is the typed bridge — Model
    // doesn't carry an index signature for arbitrary string keys, but
    // the dynamic field installation in `createDynamicModelClass`
    // guarantees these keys resolve at runtime.
    for (const [fieldName, value] of Object.entries(changes)) {
      Reflect.set(model, fieldName, value);
    }
    Reflect.set(model, 'updatedAt', now);
    return model;
  };

  return {
    // Overloaded — runtime check on `Array.isArray` decides shape. Both
    // branches stage via `Promise.all` so the microtask coalescer in
    // `TransactionQueue` collapses N pushes into one wire commit.
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

    update: (async (
      patch: UpdatePatch<S, K> | UpdatePatch<S, K>[],
    ) => {
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

/** @deprecated Prefer `useAblo()` plus `ablo.<model>.create/update/delete`. */
export function useMutate<
  S extends Schema,
  K extends keyof S['models'] & string,
>(schema: S, modelKey: K): MutateActions<S, K>;

/** Typed CRUD via the `AbloSync` global augmentation. The schema is
 * resolved from the `SyncProvider`'s context — consumer doesn't pass it
 * at the call site.
 *
 * @deprecated Prefer `useAblo()` plus `ablo.<model>.create/update/delete`.
 */
export function useMutate<K extends GlobalMutateKey>(
  modelKey: K,
): GlobalMutateActions<K>;

export function useMutate(
  schemaOrKey: Schema | string,
  maybeKey?: string,
): MutateActions<Schema, string> {
  const { store, organizationId, schema: ctxSchema } = useSyncContext();
  const resolvedSchema = typeof schemaOrKey === 'string' ? ctxSchema : schemaOrKey;
  const resolvedKey = typeof schemaOrKey === 'string' ? schemaOrKey : (maybeKey as string);
  if (!resolvedSchema) {
    throw new AbloValidationError(
      'useMutate: no schema available. Pass the schema as the first arg ' +
        'or wire SyncProvider with a `schema` prop when using the zero-arg overload.',
      { code: 'mutate_schema_missing' },
    );
  }
  return useMemo(
    () => createMutateActions(resolvedSchema, resolvedKey, store, organizationId),
    [store, organizationId, resolvedSchema, resolvedKey],
  );
}
