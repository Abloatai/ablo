/**
 * The typed transaction object passed to a custom mutator. A mutator receives
 * `{ tx, args }` and uses `tx.mutations.<modelKey>.*` to write and
 * `tx.read.<modelKey>.*` to take synchronous snapshots of the current data.
 *
 * Writes are applied eagerly as they are called, with no buffering: if a mutator
 * throws partway through, the writes it already made stand. Reads are synchronous
 * snapshots and use a fast index lookup where one is available for the field.
 *
 * The write surface deliberately works one row at a time. To write a batch,
 * compose the calls yourself — `Promise.all(rows.map((r) => tx.mutations.x.create(r)))`.
 * Every call stages its write in the same synchronous tick and the engine
 * coalesces them into a single commit on the wire, so there is no separate
 * bulk-insert method to learn.
 */

import type { Schema } from '../schema/schema.js';
import type { SyncStoreContract } from '../react/context.js';
import { createMutateActions, type MutateActions } from './mutateActions.js';
import { createReaderActions, type ReaderActions, type ReaderFindOptions } from './readerActions.js';
import { AbloValidationError } from '../errors.js';

/**
 * The full transaction surface: `tx.mutations.<key>.*` for writes and
 * `tx.read.<key>.*` for reads. It also re-exports the read-options type so a
 * mutator author can type a `where` payload without importing it separately. The
 * property is named `mutations` to match the corresponding React hook.
 */
export interface Transaction<S extends Schema> {
  mutations: {
    [K in keyof S['models'] & string]: MutateActions<S, K>;
  };
  read: {
    [K in keyof S['models'] & string]: ReaderActions<S, K>;
  };
}

export type { ReaderFindOptions };

/**
 * Builds a {@link Transaction} for a single mutator invocation. The returned
 * object creates each model's actions lazily on first access, so a mutator pays
 * nothing for the models it never touches.
 */
export function createTransaction<S extends Schema>(
  schema: S,
  store: SyncStoreContract,
  organizationId: string,
): Transaction<S> {
  const mutateCache = new Map<string, MutateActions<S, keyof S['models'] & string>>();
  const readCache = new Map<string, ReaderActions<S, keyof S['models'] & string>>();

  const mutations = new Proxy({} as Transaction<S>['mutations'], {
    get(_target, prop: string | symbol) {
      if (typeof prop !== 'string') return undefined;
      const cached = mutateCache.get(prop);
      if (cached) return cached;
      if (!(prop in schema.models)) {
        throw new AbloValidationError(
          `Transaction.mutations: unknown model key "${prop}". Known keys: ${Object.keys(schema.models).join(', ')}`,
          { code: 'transaction_mutate_unknown_model' },
        );
      }
      const actions = createMutateActions(
        schema,
        prop as keyof S['models'] & string,
        store,
        organizationId,
      );
      mutateCache.set(prop, actions);
      return actions;
    },
  });

  const read = new Proxy({} as Transaction<S>['read'], {
    get(_target, prop: string | symbol) {
      if (typeof prop !== 'string') return undefined;
      const cached = readCache.get(prop);
      if (cached) return cached;
      if (!(prop in schema.models)) {
        throw new AbloValidationError(
          `Transaction.read: unknown model key "${prop}". Known keys: ${Object.keys(schema.models).join(', ')}`,
          { code: 'transaction_read_unknown_model' },
        );
      }
      const actions = createReaderActions(
        schema,
        prop as keyof S['models'] & string,
        store,
      );
      readCache.set(prop, actions);
      return actions;
    },
  });

  return { mutations, read };
}
