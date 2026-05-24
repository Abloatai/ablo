/**
 * Transaction — Zero-style typed transaction object exposed to custom mutators.
 *
 * A mutator function receives `{ tx, args }`. Through `tx.mutations.<modelKey>.*`
 * it performs writes; through `tx.read.<modelKey>.*` it takes imperative
 * snapshots of the ObjectPool.
 *
 * Semantics:
 *   - Writes dispatch eagerly via the existing `createMutateActions` / store
 *     primitives (no buffering, no rollback). Partial state is possible if
 *     a mutator throws midway. Atomic rollback is a follow-up.
 *   - Reads are synchronous snapshots via `createReaderActions`. They use the
 *     FK index fast path where available (O(1) on registered FK fields).
 *
 * The mutate surface is intentionally one-row-at-a-time
 * (`create`/`update`/`delete`). For batches, mutator authors compose
 * `Promise.all(rows.map((r) => tx.mutations.x.create(r)))` — every push
 * stages in the same synchronous tick, the await happens once, and the
 * microtask coalescer in `TransactionQueue` collapses N pushes into one
 * wire commit. Same shape Zero uses: no `insertMany`, just an array map.
 */

import type { Schema } from '../schema/schema.js';
import type { SyncStoreContract } from '../react/context.js';
import { createMutateActions, type MutateActions } from '../react/useMutate.js';
import { createReaderActions, type ReaderActions, type ReaderFindOptions } from '../react/useReader.js';
import { AbloValidationError } from '../errors.js';

/**
 * The full transaction surface. `tx.mutations.<key>.*` for writes,
 * `tx.read.<key>.*` for imperative reads. Re-exports the base read options
 * type so mutator authors can type `where` payloads without reaching into
 * the React barrel.
 *
 * The name `mutations` (not `mutate`) matches the React hook naming.
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
 * Build a Transaction for a single mutator invocation. The returned object
 * lazily instantiates per-model actions on first access so we don't pay for
 * models the mutator never touches.
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
      mutateCache.set(prop, actions as MutateActions<S, keyof S['models'] & string>);
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
      readCache.set(prop, actions as ReaderActions<S, keyof S['models'] & string>);
      return actions;
    },
  });

  return { mutations, read };
}
