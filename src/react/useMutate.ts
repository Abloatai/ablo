'use client';

import { useMemo } from 'react';
import { Model } from '../Model';
import { AbloValidationError } from '../errors';
import type { Schema, InferModel, InferCreate } from '../schema/schema';
import type { ModelDef } from '../schema/model';
import type { ResolveSchema } from '../types/global';
import type { SyncStoreContract } from './context';
import { useSyncContext } from './context';

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
 * Structural feature detection for stores that implement a batch save. We
 * cannot widen `SyncStoreContract` without breaking third-party implementors,
 * so we sniff at runtime and fall back to sequential `store.save` when the
 * optional method is absent.
 */
interface SaveManyCapable {
  saveMany(models: Model[]): Promise<void>;
}

function hasSaveMany(store: SyncStoreContract): store is SyncStoreContract & SaveManyCapable {
  const candidate = (store as unknown as { saveMany?: unknown }).saveMany;
  return typeof candidate === 'function';
}

interface DeleteManyCapable {
  deleteMany<T extends Model>(models: T[]): Promise<void>;
}

function hasDeleteMany(store: SyncStoreContract): store is SyncStoreContract & DeleteManyCapable {
  const candidate = (store as unknown as { deleteMany?: unknown }).deleteMany;
  return typeof candidate === 'function';
}

/**
 * Schema-typed mutation hook. Returns CRUD methods for a single model type,
 * with full type inference from the schema — no class imports, no generics
 * at the call site.
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

export interface MutateActions<S extends Schema, K extends keyof S['models'] & string> {
  /** Create a new entity. ID, createdAt, updatedAt, organizationId default automatically. */
  create: (data: InferCreate<S, K>) => Promise<InferModel<S, K>>;
  /** Update by ID + partial changes. Looks up the model in the pool and applies changes reactively. */
  update: (patch: { id: string } & Partial<InferModel<S, K>>) => Promise<InferModel<S, K>>;
  /** Delete by ID. */
  delete: (id: string) => Promise<void>;
  /** Create multiple entities in a single batched save. Returns the created models in input order. */
  createMany: (data: InferCreate<S, K>[]) => Promise<InferModel<S, K>[]>;
  /** Apply multiple id-based patches. Missing ids throw. */
  updateMany: (patches: Array<{ id: string } & Partial<InferModel<S, K>>>) => Promise<void>;
  /** Delete multiple entities by id in a single batched delete. Missing ids are silently ignored. */
  deleteMany: (ids: string[]) => Promise<void>;
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

  return {
    create: async (data) => {
      const now = new Date();
      const fullData = {
        ...(data as Record<string, unknown>),
        __typename: typename,
        id: ((data as { id?: string }).id) ?? Model.generateId(),
        organizationId:
          ((data as { organizationId?: string }).organizationId) ?? organizationId,
        createdAt: ((data as { createdAt?: Date }).createdAt) ?? now,
        updatedAt: ((data as { updatedAt?: Date }).updatedAt) ?? now,
      };

      const model = store.pool.createFromData(fullData);
      if (!model) {
        throw new AbloValidationError(
          `useMutate: failed to create ${typename} — no constructor in registry`,
          { code: 'mutate_create_unknown_model' },
        );
      }

      await store.save(model);
      return model as unknown as InferModel<S, K>;
    },

    update: async (patch) => {
      const { id, ...changes } = patch;
      const model = store.pool.get(id);
      if (!model) {
        throw new AbloValidationError(
          `useMutate: ${typename} with id "${id}" not found in pool`,
          { code: 'mutate_update_entity_not_found' },
        );
      }

      // Apply each field via direct assignment — schema-generated models
      // declare these as MobX observables, so reactivity fires automatically.
      const target = model as unknown as Record<string, unknown>;
      for (const [fieldName, value] of Object.entries(changes)) {
        target[fieldName] = value;
      }
      target.updatedAt = new Date();

      await store.save(model);
      return model as unknown as InferModel<S, K>;
    },

    delete: async (id) => {
      const model = store.pool.get(id);
      if (!model) return;
      await store.delete(model);
    },

    createMany: async (dataArray) => {
      if (dataArray.length === 0) return [];

      const now = new Date();
      const models: Model[] = [];

      for (const data of dataArray) {
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
            `useMutate.createMany: failed to create ${typename} — no constructor in registry`,
            { code: 'mutate_create_many_unknown_model' },
          );
        }
        models.push(model);
      }

      if (hasSaveMany(store)) {
        await store.saveMany(models);
      } else {
        for (const model of models) await store.save(model);
      }

      return models as unknown as InferModel<S, K>[];
    },

    updateMany: async (patches) => {
      if (patches.length === 0) return;

      const now = new Date();
      const models: Model[] = [];

      for (const patch of patches) {
        const { id, ...changes } = patch;
        const model = store.pool.get(id);
        if (!model) {
          throw new AbloValidationError(
            `useMutate.updateMany: ${typename} with id "${id}" not found in pool`,
            { code: 'mutate_update_many_entity_not_found' },
          );
        }
        const target = model as unknown as Record<string, unknown>;
        for (const [fieldName, value] of Object.entries(changes)) {
          target[fieldName] = value;
        }
        target.updatedAt = now;
        models.push(model);
      }

      if (hasSaveMany(store)) {
        await store.saveMany(models);
      } else {
        for (const model of models) await store.save(model);
      }
    },

    deleteMany: async (ids) => {
      if (ids.length === 0) return;

      const models: Model[] = [];
      for (const id of ids) {
        const model = store.pool.get(id);
        if (model) models.push(model);
      }
      if (models.length === 0) return;

      if (hasDeleteMany(store)) {
        await store.deleteMany(models);
      } else {
        for (const model of models) await store.delete(model);
      }
    },

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

/** Typed CRUD (explicit schema arg). */
export function useMutate<
  S extends Schema,
  K extends keyof S['models'] & string,
>(schema: S, modelKey: K): MutateActions<S, K>;

/** Typed CRUD via the `AbloSync` global augmentation. The schema is
 * resolved from the `SyncProvider`'s context — consumer doesn't pass it
 * at the call site. */
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
