'use client';

import { useMemo } from 'react';
import type { Schema, InferModel } from '../schema/schema.js';
import type { ModelDef } from '../schema/model.js';
import type { ResolveSchema } from '../types/global.js';
import type { SyncStoreContract } from './context.js';
import { useSyncContext } from './context.js';
import { AbloValidationError } from '../errors.js';

type GlobalReaderKey = ResolveSchema extends { models: infer M }
  ? keyof M & string
  : string;

type GlobalReaderActions<K extends string> = ResolveSchema extends Schema
  ? K extends keyof ResolveSchema['models'] & string
    ? ReaderActions<ResolveSchema, K>
    : ReaderActions<Schema, string>
  : ReaderActions<Schema, string>;

/**
 * Compatibility schema-typed imperative reader. Returns functions for one-off lookups
 * without subscribing the component to collection changes.
 *
 * Prefer `useAblo()` and call `ablo.<model>.retrieve/list` inside callbacks and
 * effects in new integrations. This hook remains for older string-keyed code.
 *
 * Use this inside event handlers, mutation callbacks, or effects where you
 * need a current snapshot of the pool but don't want to trigger re-renders
 * on every entity change.
 *
 * For reactive reads, use selector reads through
 * `useAblo((ablo) => ablo.<model>.retrieve(id))`.
 *
 * @example
 * import { schema } from '@ablo/schema';
 * import { useReader } from '@ablo/sync-engine/react';
 *
 * function useTaskMutations() {
 *   const read = useReader(schema, 'tasks');
 *
 *   return {
 *     create: async (data) => {
 *       // Imperative read — uses FK index when available (O(1))
 *       const existing = read.findMany({ where: { projectId: data.projectId } });
 *       const order = existing.reduce((m, t) => Math.max(m, t.order ?? 0), 0) + 1;
 *       // ...
 *     },
 *   };
 * }
 */

export interface ReaderFindOptions<T> {
  /** Equality filter — uses FK index when the field is registered. */
  where?: Partial<T>;
  /** Predicate applied AFTER `where` filtering. */
  filter?: (entity: T) => boolean;
  /** Sort field. */
  orderBy?: keyof T & string;
  /** Sort direction. Default: 'asc'. */
  order?: 'asc' | 'desc';
  /** Max results. */
  limit?: number;
  /** Skip N results. */
  offset?: number;
}

export interface ReaderActions<S extends Schema, K extends keyof S['models'] & string> {
  /** Get a single entity by id. Returns undefined if not in pool. */
  retrieve: (id: string) => InferModel<S, K> | undefined;
  /** Read a collection with optional filters. Snapshot — not reactive. */
  list: (options?: ReaderFindOptions<InferModel<S, K>>) => InferModel<S, K>[];
  /** Count entities matching the options. */
  count: (options?: ReaderFindOptions<InferModel<S, K>>) => number;
}

/**
 * Pure factory — testable without React. `useReader` wraps this in useMemo.
 */
export function createReaderActions<
  S extends Schema,
  K extends keyof S['models'] & string,
>(schema: S, modelKey: K, store: SyncStoreContract): ReaderActions<S, K> {
  const modelDef = (schema.models as Record<string, ModelDef>)[modelKey];
  const typename = modelDef?.typename ?? modelKey;

  function read(options?: ReaderFindOptions<InferModel<S, K>>): InferModel<S, K>[] {
    // FK index fast path: single-field `where` on a registered FK index → O(1) lookup.
    let candidates: unknown[];
    const whereEntries = options?.where ? Object.entries(options.where) : [];
    const singleWhere = whereEntries.length === 1 ? whereEntries[0] : undefined;

    if (
      singleWhere &&
      typeof singleWhere[1] === 'string' &&
      store.pool.hasForeignKeyIndex(typename, singleWhere[0])
    ) {
      candidates = store.pool.getByForeignKey(typename, singleWhere[0], singleWhere[1]);
    } else {
      candidates = store.pool.getByTypeName(typename);
      if (options?.where) {
        candidates = (candidates as Record<string, unknown>[]).filter((entity) => {
          for (const [field, value] of whereEntries) {
            if (entity[field] !== value) return false;
          }
          return true;
        });
      }
    }

    let results = candidates as InferModel<S, K>[];

    if (options?.filter) {
      results = results.filter(options.filter);
    }

    if (options?.orderBy) {
      const field = options.orderBy;
      const dir = options.order === 'desc' ? -1 : 1;
      results = [...results].sort((a, b) => {
        const av = (a as Record<string, unknown>)[field];
        const bv = (b as Record<string, unknown>)[field];
        if (av === bv) return 0;
        if (av == null) return 1;
        if (bv == null) return -1;
        return av < bv ? -dir : dir;
      });
    }

    if (options?.offset) results = results.slice(options.offset);
    if (options?.limit !== undefined) results = results.slice(0, options.limit);

    return results;
  }

  return {
    retrieve: (id) => store.pool.get(id) as InferModel<S, K> | undefined,
    list: (options) => read(options),
    count: (options) => read(options).length,
  };
}

/** @deprecated Prefer `useAblo()` plus `ablo.<model>.retrieve/list` in callbacks/effects. */
export function useReader<
  S extends Schema,
  K extends keyof S['models'] & string,
>(schema: S, modelKey: K): ReaderActions<S, K>;

/** @deprecated Prefer `useAblo()` plus `ablo.<model>.retrieve/list` in callbacks/effects. */
export function useReader<K extends GlobalReaderKey>(
  modelKey: K,
): GlobalReaderActions<K>;

export function useReader(
  schemaOrKey: Schema | string,
  maybeKey?: string,
): ReaderActions<Schema, string> {
  const { store, schema: ctxSchema } = useSyncContext();
  const resolvedSchema = typeof schemaOrKey === 'string' ? ctxSchema : schemaOrKey;
  const resolvedKey = typeof schemaOrKey === 'string' ? schemaOrKey : (maybeKey as string);
  if (!resolvedSchema) {
    throw new AbloValidationError(
      'useReader: no schema available. Pass the schema as the first arg ' +
        'or wire SyncProvider with a `schema` prop when using the zero-arg overload.',
      { code: 'reader_schema_missing' },
    );
  }
  return useMemo(
    () => createReaderActions(resolvedSchema, resolvedKey, store),
    [store, resolvedSchema, resolvedKey],
  );
}
