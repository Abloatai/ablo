import type { Schema, InferModel } from '../schema/schema.js';
import type { ModelDef } from '../schema/model.js';
// Type-only — see the note in `mutateActions.ts`.
import type { SyncStoreContract } from '../react/context.js';

/**
 * React-free imperative reads over a store: one-off `retrieve`/`list`/`count`
 * snapshots that do NOT subscribe to changes. Used by the transaction system
 * and `BaseSyncedStore`. For reactive reads in components use
 * `useAblo((ablo) => ablo.<model>.retrieve({ id }) / .list(opts))`.
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

/** Pure factory — builds imperative read actions over a store for one model. */
export function createReaderActions<
  S extends Schema,
  K extends keyof S['models'] & string,
>(schema: S, modelKey: K, store: SyncStoreContract): ReaderActions<S, K> {
  const modelDef = (schema.models as Record<string, ModelDef>)[modelKey];
  const typename = modelDef?.typename ?? modelKey;

  function read(options?: ReaderFindOptions<InferModel<S, K>>): InferModel<S, K>[] {
    // FK index fast path: single-field `where` on a registered FK index → O(1).
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
