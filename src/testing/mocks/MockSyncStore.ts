/**
 * MockSyncStore — a SyncStoreContract implementation for testing.
 *
 * Provides an in-memory store that tests can configure, inspect, and mutate.
 * All reactive operations are synchronous and observable via Jest spies.
 */

import type { Model } from '../../Model';
import type { ModelScope } from '../../ObjectPool';
import type { SyncStoreContract } from '../../react/context';
import type { QueryView, QueryViewOptions } from '../../core/QueryView';
import { ViewRegistry } from '../../core/ViewRegistry';
import { AbloValidationError } from '../../errors';

// Minimal query options matching SyncStoreContract
interface QueryOptions<T extends Model> {
  predicate?: (model: T) => boolean;
  scope?: ModelScope;
  orderBy?: keyof T;
  order?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
}

interface QueryResult<T extends Model> {
  data: T[];
}

type ModelCtor<T extends Model> = abstract new (...args: never[]) => T;

/**
 * MockSyncStore is an in-memory implementation of SyncStoreContract.
 * Tests can seed data with `setModels()`, inspect calls via `calls`,
 * and assert behavior without needing a real sync backend.
 */
export class MockSyncStore implements SyncStoreContract {
  // Seeded data, keyed by model class
  private byClass = new Map<ModelCtor<Model>, Map<string, Model>>();

  // Call tracking for assertions
  public calls = {
    findById: [] as Array<{ modelClass: ModelCtor<Model>; id: string }>,
    query: [] as Array<{ modelClass: ModelCtor<Model>; options?: QueryOptions<Model> }>,
    save: [] as Model[],
    delete: [] as Model[],
    archive: [] as Model[],
    unarchive: [] as Model[],
  };

  /**
   * Seed the store with models of a specific class.
   *
   * @example
   * mockStore.setModels(Task, [task1, task2]);
   */
  setModels<T extends Model>(modelClass: ModelCtor<T>, models: T[]): void {
    const map = new Map<string, Model>();
    for (const m of models) {
      map.set(m.id, m);
    }
    this.byClass.set(modelClass as ModelCtor<Model>, map);
  }

  /**
   * Add a single model (upsert).
   */
  addModel<T extends Model>(modelClass: ModelCtor<T>, model: T): void {
    let map = this.byClass.get(modelClass as ModelCtor<Model>);
    if (!map) {
      map = new Map();
      this.byClass.set(modelClass as ModelCtor<Model>, map);
    }
    map.set(model.id, model);
  }

  /**
   * Remove a model by ID.
   */
  removeModel<T extends Model>(modelClass: ModelCtor<T>, id: string): void {
    this.byClass.get(modelClass as ModelCtor<Model>)?.delete(id);
  }

  /**
   * Clear all seeded data and call history.
   */
  reset(): void {
    this.byClass.clear();
    this.calls = {
      findById: [],
      query: [],
      save: [],
      delete: [],
      archive: [],
      unarchive: [],
    };
  }

  // ── SyncStoreContract implementation ──────────────────────────────────

  findById<T extends Model>(modelClass: ModelCtor<T>, id: string): T | undefined {
    this.calls.findById.push({ modelClass: modelClass as ModelCtor<Model>, id });
    return this.byClass.get(modelClass as ModelCtor<Model>)?.get(id) as T | undefined;
  }

  queryByClass<T extends Model>(
    modelClass: ModelCtor<T>,
    options?: QueryOptions<T>
  ): QueryResult<T> {
    this.calls.query.push({
      modelClass: modelClass as ModelCtor<Model>,
      options: options as QueryOptions<Model> | undefined,
    });

    const map = this.byClass.get(modelClass as ModelCtor<Model>);
    if (!map) {
      return { data: [] };
    }

    let data = Array.from(map.values()) as T[];

    // Apply predicate
    if (options?.predicate) {
      data = data.filter(options.predicate);
    }

    // Apply ordering
    if (options?.orderBy) {
      const key = options.orderBy;
      const order = options.order ?? 'asc';
      data.sort((a, b) => {
        const av = a[key];
        const bv = b[key];
        if (av === bv) return 0;
        const cmp = av < bv ? -1 : 1;
        return order === 'asc' ? cmp : -cmp;
      });
    }

    // Apply pagination
    if (options?.offset) {
      data = data.slice(options.offset);
    }
    if (options?.limit !== undefined) {
      data = data.slice(0, options.limit);
    }

    return { data };
  }

  async save(model: Model): Promise<void> {
    this.calls.save.push(model);
    // Auto-seed on save so findById returns it afterwards
    // Consumer passes a concrete class-less object; we store by constructor
    const ctor = model.constructor as ModelCtor<Model>;
    this.addModel(ctor, model);
  }

  async delete(model: Model): Promise<void> {
    this.calls.delete.push(model);
    const ctor = model.constructor as ModelCtor<Model>;
    this.removeModel(ctor, model.id);
  }

  async archive(model: Model): Promise<void> {
    this.calls.archive.push(model);
  }

  async unarchive(model: Model): Promise<void> {
    this.calls.unarchive.push(model);
  }

  // Sync-status getters default to "ready, idle". Tests that exercise
  // offline/reconnect flows can set these before rendering.
  isReady = true;
  isSyncing = false;
  isOffline = false;
  isReconnecting = false;
  isError = false;
  hasUnsyncedChanges = false;
  syncStatus = {
    state: 'idle' as const,
    progress: 100,
    pendingChanges: 0,
    isSessionError: false,
  };

  /** Mock pool for useEntity/useEntities hooks. */
  pool: SyncStoreContract['pool'] = {
    get: <T extends Model>(id: string): T | undefined => {
      for (const models of this.byClass.values()) {
        const model = models.get(id);
        if (model) return model as T;
      }
      return undefined;
    },
    getByTypeName: (_typename: string): Model[] => [],
    getByForeignKey: (): Model[] => [],
    createFromData: (): Model | null => null,
    hasForeignKeyIndex: (): boolean => false,
    createView: () => {
      throw new AbloValidationError('MockSyncStore does not support createView', {
        code: 'mock_unsupported_operation',
      });
    },
    viewRegistry: new ViewRegistry(),
  };
}

/**
 * Create a new MockSyncStore.
 * Shorthand for `new MockSyncStore()`.
 */
export function createMockSyncStore(): MockSyncStore {
  return new MockSyncStore();
}
