/**
 * Transaction — Zero-style typed transaction object exposed to custom mutators.
 *
 * A mutator function receives `{ tx, args }`. Through `tx.mutate.<modelKey>.*`
 * it performs writes; through `tx.read.<modelKey>.*` it takes imperative
 * snapshots of the ObjectPool.
 *
 * V1 semantics:
 *   - Writes dispatch eagerly via the existing `createMutateActions` / store
 *     primitives (no buffering, no rollback). This matches the behaviour of
 *     `saveManyOptimized` — partial state is possible if a mutator throws
 *     midway. True atomic rollback is a V2 concern.
 *   - Reads are synchronous snapshots via `createReaderActions`. They use the
 *     FK index fast path where available (O(1) on registered FK fields).
 */

import { Model } from '../Model';
import { AbloValidationError } from '../errors';
import type { Schema, InferModel, InferCreate } from '../schema/schema';
import type { ModelDef } from '../schema/model';
import type { SyncStoreContract } from '../react/context';
import { createMutateActions, type MutateActions } from '../react/useMutate';
import { createReaderActions, type ReaderActions, type ReaderFindOptions } from '../react/useReader';

// ── Types ──────────────────────────────────────────────────────────────────

/**
 * The set of write operations available per model on a transaction.
 * Extends the React hook's `MutateActions` with batch variants.
 */
export interface TransactionMutate<S extends Schema, K extends keyof S['models'] & string>
  extends MutateActions<S, K> {
  /** Create multiple entities. Returns the created models in input order. */
  createMany: (data: InferCreate<S, K>[]) => Promise<InferModel<S, K>[]>;
  /** Apply multiple id-based patches. Missing ids throw. */
  updateMany: (patches: Array<{ id: string } & Partial<InferModel<S, K>>>) => Promise<void>;
  /** Delete multiple entities by id. Missing ids are silently ignored. */
  deleteMany: (ids: string[]) => Promise<void>;
}

/**
 * The full transaction surface. `tx.mutations.<key>.*` for writes,
 * `tx.read.<key>.*` for imperative reads. Re-exports the base read options
 * type so mutator authors can type `where` payloads without reaching into
 * the React barrel.
 *
 * The name `mutations` (not `mutate`) matches `participant.mutations.*`
 * on the mesh surface and the `useMutations()` React hook. One name
 * across all three access paths.
 */
export interface Transaction<S extends Schema> {
  mutations: {
    [K in keyof S['models'] & string]: TransactionMutate<S, K>;
  };
  read: {
    [K in keyof S['models'] & string]: ReaderActions<S, K>;
  };
}

export type { ReaderFindOptions };

// ── Internal helpers ──────────────────────────────────────────────────────

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

// ── Per-model transaction mutate builder ──────────────────────────────────

function createTransactionMutate<
  S extends Schema,
  K extends keyof S['models'] & string,
>(
  schema: S,
  modelKey: K,
  store: SyncStoreContract,
  organizationId: string,
): TransactionMutate<S, K> {
  const base = createMutateActions(schema, modelKey, store, organizationId);
  const modelDef = (schema.models as Record<string, ModelDef>)[modelKey];
  const typename = modelDef?.typename ?? modelKey;

  const createMany = async (dataArray: InferCreate<S, K>[]): Promise<InferModel<S, K>[]> => {
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
          `Transaction.createMany: failed to create ${typename} — no constructor in registry`,
          { code: 'transaction_create_unknown_model' },
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
  };

  const updateMany = async (
    patches: Array<{ id: string } & Partial<InferModel<S, K>>>,
  ): Promise<void> => {
    for (const patch of patches) {
      await base.update(patch);
    }
  };

  const deleteMany = async (ids: string[]): Promise<void> => {
    for (const id of ids) {
      await base.delete(id);
    }
  };

  return {
    ...base,
    createMany,
    updateMany,
    deleteMany,
  };
}

// ── Transaction factory ────────────────────────────────────────────────────

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
  const mutateCache = new Map<string, TransactionMutate<S, keyof S['models'] & string>>();
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
      const actions = createTransactionMutate(
        schema,
        prop as keyof S['models'] & string,
        store,
        organizationId,
      );
      mutateCache.set(prop, actions as TransactionMutate<S, keyof S['models'] & string>);
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
