/**
 * Per-model resource factory.
 *
 * Mirrors Anthropic SDK's `resources/messages.ts` / `resources/models.ts`
 * pattern: each resource has its own file, the client just instantiates
 * one per model. Extracted from `Ablo.ts` so the proxy logic is
 * testable in isolation and the constructor doesn't carry it.
 *
 * Each schema model gets one `ModelOperations<T, CreateInput>` —
 * exposes `retrieve`, `list`, `count`, `create`, `update`, `delete`,
 * `edit`,
 * `subscribe`, and `load`. The factory returns a plain object; the
 * client assembles `ablo.<model>` lookup table from these.
 */

import { autorun } from 'mobx';
import { AbloStaleContextError, AbloValidationError } from '../errors.js';
import type { MutationOptions } from '../interfaces/index.js';
import { Model, modelAsRow } from '../Model.js';
import type { ModelRegistry } from '../ModelRegistry.js';
import type { ObjectPool } from '../ObjectPool.js';
import type { SyncClient } from '../SyncClient.js';
import type { HydrationCoordinator } from '../sync/HydrationCoordinator.js';
import type { LoadWhere } from '../query/types.js';
import { ModelScope } from '../types/index.js';
import type { Duration, Snapshot } from '../types/streams.js';

export interface ModelResourceMeta {
  readonly key: string;
  readonly typename: string;
}

const modelResourceMeta = new WeakMap<object, ModelResourceMeta>();

export function getModelResourceMeta(resource: unknown): ModelResourceMeta | undefined {
  if (typeof resource !== 'object' || resource === null) return undefined;
  return modelResourceMeta.get(resource);
}

export type ModelListScope = ModelScope | 'live' | 'archived' | 'all';

export interface ModelListOptions<T> {
  where?: Partial<T>;
  /** Arbitrary local predicate. Applied after `where`. */
  filter?: (entity: T) => boolean;
  orderBy?: { [K in keyof T]?: 'asc' | 'desc' };
  limit?: number;
  offset?: number;
  /** Lifecycle scope. Defaults to live rows. */
  scope?: ModelListScope;
}

export type ModelCountOptions<T> = Pick<
  ModelListOptions<T>,
  'where' | 'filter' | 'scope'
>;

export interface ModelLoadOptions<T> {
  /**
   * Filter for the lookup. Accepts:
   *   - object form: `{ name: 'foo' }` (equality, array values → `IN`)
   *   - tuple form: `[['name', 'ILIKE', '%Goldman%']]` for operators
   *
   * See `LoadWhere<T>` in `query/types.ts`. For OR semantics, run two
   * `load()` calls and union — the wire protocol is AND-only.
   */
  where?: LoadWhere<T>;
  orderBy?: { [K in keyof T]?: 'asc' | 'desc' };
  limit?: number;
  /**
   * `complete` waits for the server. `unknown` returns whatever is local
   * immediately and refreshes in the background.
   */
  type?: 'complete' | 'unknown';
  /**
   * Schema-declared relation names to hydrate alongside the primary
   * rows. The server's compiler resolves each name via the schema's
   * relation metadata (`relation.belongsTo` / `relation.hasMany`)
   * and emits the JOIN.
   */
  expand?: readonly string[];
}

export interface ModelEditOptions<T = Record<string, unknown>> {
  /**
   * Human-readable activity shown to other participants while this handle
   * is open. Examples: `editing`, `summarizing`, `rewriting`, `reviewing`.
   */
  activity?: string;
  /** Optional field-level target for UI affordances such as busy badges. */
  field?: keyof T & string;
  /** Lease duration for the visible activity. Runtime death is cleaned up by TTL. */
  ttl?: Duration;
  /** Default wait mode for `handle.update(...)`. Defaults to `confirmed`. */
  wait?: MutationOptions['wait'];
}

export interface ModelEditHandle<T> extends AsyncDisposable {
  readonly id: string;
  readonly intentId: string;
  readonly activity: string;
  readonly current: T;
  readonly signal: AbortSignal;
  update(data: Partial<T>, options?: MutationOptions): Promise<T>;
  release(): Promise<void>;
  revoke(): void;
}

export interface ModelIntentHandle {
  readonly id: string;
  release(): Promise<void>;
  revoke(): void;
}

export interface ModelCollaboration<T> {
  createIntent(options: {
    target: {
      resource: string;
      id: string;
      field?: string;
    };
    action: string;
    ttl?: Duration;
  }): Promise<ModelIntentHandle>;
  createSnapshot(modelKey: string, id: string): Snapshot;
}

export interface ModelOperations<T, CreateInput> {
  /**
   * Retrieve a single entity by id from the local pool. Synchronous.
   * Returns `undefined` when the entity isn't loaded yet — use
   * `load({where: {id}})` if you want to lazy-hydrate from storage/network.
   *
   * Mirrors `stripe.customers.retrieve(id)`.
   */
  retrieve(id: string): T | undefined;

  /**
   * List entities matching a filter from the local pool. Synchronous.
   * No network round-trip — use `load()` for hydration.
   *
   * Mirrors `stripe.customers.list({...})`.
   */
  list(options?: ModelListOptions<T>): T[];

  /** Count entities matching a filter (synchronous, from local pool). */
  count(options?: ModelCountOptions<T>): number;

  /**
   * Create a new entity — **optimistic, offline-first**. Resolves once
   * the mutation is queued locally, not when the server confirms.
   * Server rejection rolls back automatically; watch `sync.syncStatus`.
   */
  create(data: CreateInput, options?: MutationOptions): Promise<T>;

  /** Update an entity by id — optimistic, offline-first (see `create`). */
  update(id: string, data: Partial<T>, options?: MutationOptions): Promise<T>;

  /** Delete an entity by id — optimistic, offline-first (see `create`). */
  delete(id: string, options?: MutationOptions): Promise<void>;

  /**
   * Start a model-scoped activity lease for long-running AI or background work.
   * Other participants can see the activity until `update`, `release`, or TTL.
   */
  edit(id: string, options?: ModelEditOptions<T>): Promise<ModelEditHandle<T>>;

  /** Subscribe to changes (callback called on every change). */
  subscribe(
    callback: (entities: T[]) => void,
    options?: ModelListOptions<T>,
  ): () => void;

  /**
   * Load matching rows into the local graph if they are not already
   * present. Single-flight: concurrent calls with the same args share
   * one in-flight request. Default `type: 'complete'` waits for the
   * server; `type: 'unknown'` returns local + refreshes async.
   */
  load(options?: ModelLoadOptions<T>): Promise<T[]>;
}

export function createModelProxy<T, C>(
  schemaKey: string,
  registeredModelName: string,
  objectPool: ObjectPool,
  syncClient: SyncClient,
  registry: ModelRegistry,
  hydration: HydrationCoordinator,
  collaboration?: ModelCollaboration<T>,
): ModelOperations<T, C> {
  const ModelClass = registry.getModelByName(registeredModelName);
  if (!ModelClass) {
    throw new AbloValidationError(
      `Ablo: schema model "${schemaKey}" resolved to "${registeredModelName}", ` +
        'but no matching constructor was registered.',
      { code: 'model_not_registered' },
    );
  }

  const load = async (options?: ModelLoadOptions<T>): Promise<T[]> => {
    const rows = await hydration.fetch<T>(schemaKey, options);
    // The coordinator returns Model instances. ModelOperations is
    // typed against the schema-inferred row shape (`T`), which is
    // structurally what the model exposes through its property
    // accessors — cast at the boundary.
    return rows as unknown as T[];
  };

  const waitForMutation = async (
    model: Model,
    options?: MutationOptions,
  ): Promise<void> => {
    if (options?.wait !== 'confirmed') return;
    await syncClient.syncNow();
    await syncClient.waitForConfirmation(model.getModelName(), model.id);
  };

  const operations: ModelOperations<T, C> = {
    retrieve(id: string): T | undefined {
      return objectPool.get(id) as T | undefined;
    },

    list(options): T[] {
      const all = objectPool.getByType(
        ModelClass,
        (options?.scope ?? ModelScope.live) as ModelScope,
      ) as T[];
      let result = all;

      if (options?.where) {
        const where = options.where as Record<string, unknown>;
        result = result.filter((item) => {
          for (const [key, value] of Object.entries(where)) {
            if ((item as Record<string, unknown>)[key] !== value) return false;
          }
          return true;
        });
      }

      if (options?.filter) {
        result = result.filter(options.filter);
      }

      if (options?.orderBy) {
        const [field, dir] = Object.entries(options.orderBy)[0];
        result = [...result].sort((a, b) => {
          const av = (a as Record<string, unknown>)[field];
          const bv = (b as Record<string, unknown>)[field];
          if (av == null || bv == null) return 0;
          const cmp = av < bv ? -1 : av > bv ? 1 : 0;
          return dir === 'desc' ? -cmp : cmp;
        });
      }

      if (options?.offset) result = result.slice(options.offset);
      if (options?.limit) result = result.slice(0, options.limit);

      return result;
    },

    count(options): number {
      return this.list(options).length;
    },

    async create(data: C, options?: MutationOptions): Promise<T> {
      // TODO(options-persistence): stash `options` alongside the
      // queued transaction so idempotencyKey survives offline flush.
      const model = new ModelClass({
        id: Model.generateId(),
        ...(data as Record<string, unknown>),
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      syncClient.add(model, options);
      await waitForMutation(model, options);
      return modelAsRow<T>(model);
    },

    async update(
      id: string,
      data: Partial<T>,
      options?: MutationOptions,
    ): Promise<T> {
      const model = objectPool.get(id);
      if (!model)
        throw new AbloValidationError(
          `Entity not found: ${registeredModelName}/${id}`,
          { code: 'entity_not_found' },
        );
      model.updateFromData(data as Record<string, unknown>);
      syncClient.update(model, options);
      await waitForMutation(model, options);
      return modelAsRow<T>(model);
    },

    async delete(id: string, options?: MutationOptions): Promise<void> {
      const model = objectPool.get(id);
      if (!model)
        throw new AbloValidationError(
          `Entity not found: ${registeredModelName}/${id}`,
          { code: 'entity_not_found' },
        );
      syncClient.delete(model, options);
      await waitForMutation(model, options);
    },

    async edit(id: string, options?: ModelEditOptions<T>): Promise<ModelEditHandle<T>> {
      if (!collaboration) {
        throw new AbloValidationError(
          `Model "${schemaKey}" cannot start edit activity without collaboration wiring.`,
          { code: 'model_edit_not_configured' },
        );
      }

      let model = objectPool.get(id);
      if (!model) {
        await load({ where: { id } as unknown as LoadWhere<T> });
        model = objectPool.get(id);
      }

      if (!model) {
        throw new AbloValidationError(
          `Entity not found: ${registeredModelName}/${id}`,
          { code: 'entity_not_found' },
        );
      }

      const activity = options?.activity ?? 'editing';
      const snapshot = collaboration.createSnapshot(schemaKey, id);
      const intent = await collaboration.createIntent({
        target: {
          resource: schemaKey,
          id,
          ...(options?.field ? { field: options.field } : {}),
        },
        action: activity,
        ttl: options?.ttl,
      });

      let released = false;
      const revoke = (): void => {
        if (released) return;
        released = true;
        snapshot.signal.removeEventListener('abort', revoke);
        intent.revoke();
      };
      const release = async (): Promise<void> => {
        if (released) return;
        released = true;
        snapshot.signal.removeEventListener('abort', revoke);
        await intent.release();
      };

      snapshot.signal.addEventListener('abort', revoke, { once: true });

      const handle: ModelEditHandle<T> = {
        id,
        intentId: intent.id,
        activity,
        current: modelAsRow<T>(model),
        signal: snapshot.signal,
        async update(data: Partial<T>, updateOptions?: MutationOptions): Promise<T> {
          if (snapshot.signal.aborted) {
            throw new AbloStaleContextError(
              `Edit context is stale for ${schemaKey}/${id}. Re-read the row and retry.`,
              {
                code: 'edit_context_stale',
                readAt: snapshot.stamp,
                cause: snapshot.signal.reason,
              },
            );
          }

          try {
            return await operations.update(id, data, {
              wait: options?.wait ?? 'confirmed',
              readAt: snapshot.stamp,
              onStale: 'reject',
              ...updateOptions,
              intent,
            });
          } finally {
            await release();
          }
        },
        release,
        revoke,
        [Symbol.asyncDispose]: release,
      };

      return handle;
    },

    subscribe(callback, options): () => void {
      return autorun(() => {
        const entities = this.list(options);
        callback(entities);
      });
    },

    load,
  };

  modelResourceMeta.set(operations, {
    key: schemaKey,
    typename: registeredModelName,
  });

  return operations;
}
