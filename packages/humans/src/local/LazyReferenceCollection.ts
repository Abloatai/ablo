/**
 * LazyReferenceCollection implements a lazy-loaded one-to-many relationship.
 * It loads related rows on demand, caches them, and batches lookups so that
 * reading a parent's children does not trigger a query per parent.
 */

import {
  makeObservable,
  observable,
  action,
  computed,
  onBecomeObserved,
  onBecomeUnobserved,
} from 'mobx';
import type { Model } from './Model.js';
import { Database } from './Database.js';
import { InstanceCache } from './InstanceCache.js';
import { getActiveRegistry } from './ModelRegistry.js';
import { AbloValidationError } from '@abloatai/transaction/errors';

/**
 * Options for LazyReferenceCollection behavior
 */
export interface LazyCollectionOptions {
  /** Skip network hydration if local data exists */
  canSkipNetworkHydration?: () => boolean;

  /** Custom filter for loaded items */
  filter?: (item: any) => boolean;

  /** Custom sort function */
  sort?: (a: any, b: any) => number;

  /** Maximum items to load */
  limit?: number;

  /** Enable automatic refresh on parent changes */
  autoRefresh?: boolean;
}

/**
 * A lazy-loaded one-to-many relationship between a parent {@link Model} and
 * its children. It reads from the local store first and falls back to the
 * network, batches lookups to avoid one query per parent, and is observable so
 * a React component re-renders when the set of children changes. Loaded items
 * can be filtered, sorted, and limited through {@link LazyCollectionOptions}.
 */
export class LazyReferenceCollection<T extends Model> {
  /** Static dependencies - shared across all instances */
  private static _database: Database | null = null;
  private static _objectPool: InstanceCache | null = null;

  /**
   * Set global dependencies for all LazyReferenceCollection instances
   * Called once during SyncedStore initialization
   */
  static setDependencies(database: Database, objectPool: InstanceCache): void {
    LazyReferenceCollection._database = database;
    LazyReferenceCollection._objectPool = objectPool;
    getContext().logger.debug('LazyReferenceCollection dependencies set');
  }

  /**
   * Clear dependencies (e.g., on logout/store disposal)
   */
  static clearDependencies(): void {
    LazyReferenceCollection._database = null;
    LazyReferenceCollection._objectPool = null;
  }

  /** Loaded items (null = not loaded, [] = loaded but empty) */
  items: T[] | null = null;

  /** Loading state */
  isLoading = false;

  /** Error state */
  loadError: Error | null = null;

  /**
   * MobX observation tracking - prevents GC while React is observing this collection
   * Following MobX best practice: https://mobx.js.org/lazy-observables.html
   */
  _isBeingObserved = false;

  /** Promise for ongoing hydration */
  private hydrationPromise: Promise<void> | null = null;

  /** Disposer for observation lifecycle hooks */
  private observationDisposer: (() => void) | null = null;

  /** Get database from static dependencies */
  private get database(): Database | null {
    return LazyReferenceCollection._database;
  }

  /** Get objectPool from static dependencies */
  private get objectPool(): InstanceCache | null {
    return LazyReferenceCollection._objectPool;
  }

  constructor(
    private modelName: string,
    private parent: Model,
    private foreignKey: string,
    private customQuery?: any,
    private options: LazyCollectionOptions = {}
  ) {
    makeObservable(this, {
      items: observable,
      isLoading: observable,
      loadError: observable,
      _isBeingObserved: observable,
      hydrate: action,
      refresh: action,
      value: computed,
      loaded: computed,
      empty: computed,
      loading: computed,
      error: computed,
      isBeingObserved: computed,
    });

    // Set up MobX observation lifecycle hooks
    // This follows the official MobX pattern for lazy observables
    // See: https://mobx.js.org/lazy-observables.html
    this._setupObservationTracking();
  }

  /**
   * Set up MobX observation lifecycle hooks
   * When React components observe this collection, we prevent GC of the parent model
   */
  private _setupObservationTracking(): void {
    // Track when 'items' becomes observed (React component is rendering)
    const disposeOnObserved = onBecomeObserved(this, 'items', () => {
      this._isBeingObserved = true;

      // Touch parent model to prevent GC while we're being observed
      if (this.objectPool && this.parent?.id) {
        this.objectPool.touch(this.parent.id);
      }

      // Register this collection with parent for observation tracking
      if (this.parent) {
        this.parent._registerObservedCollection(this);
      }
    });

    // Track when 'items' stops being observed (component unmounted)
    const disposeOnUnobserved = onBecomeUnobserved(this, 'items', () => {
      this._isBeingObserved = false;

      // Unregister from parent
      if (this.parent) {
        this.parent._unregisterObservedCollection(this);
      }
    });

    // Store combined disposer for cleanup
    this.observationDisposer = () => {
      disposeOnObserved();
      disposeOnUnobserved();
    };
  }

  /**
   * Check if this collection is currently being observed by React/MobX
   */
  get isBeingObserved(): boolean {
    return this._isBeingObserved;
  }

  /**
   * Get the collection value (triggers hydration if needed).
   *
   * Filters out items whose id is no longer in the InstanceCache. The
   * local `items` array isn't auto-synced with `pool.remove()` — a
   * deleted entity would linger here until hydrate() re-runs on
   * reload. Reading `pool.has(item.id)` inside this computed getter
   * makes MobX track both `this.items` AND the pool's entries map,
   * so any pool.remove invalidates the computed and re-renders the
   * consumer with the deleted item gone.
   *
   * Without this, deleting a block would pool.remove() cleanly
   * but the view — which reads `section.blocks.value` — would keep
   * showing the deleted block until a full reload rebuilt the
   * collection.
   */
  get value(): T[] {
    // Touch parent model to prevent GC during active collection usage
    if (this.objectPool && this.parent?.id) {
      this.objectPool.touch(this.parent.id);
    }

    if (this.items === null && !this.isLoading) {
      // Auto-hydrate on first access
      this.hydrate().catch((error) => {
        getContext().observability.breadcrumb('Auto-hydration failed', 'sync.database', 'warning', {
          error: error instanceof Error ? error.message : String(error),
        });
      });
      return []; // Return empty array while loading
    }

    const raw = this.items || [];
    const pool = this.objectPool;
    if (!pool || raw.length === 0) return raw;
    // Filter items still present in the pool. `pool.has(id)` reads the
    // observable `entries` map — MobX tracks the dependency, so a
    // subsequent `pool.remove(id)` re-runs this computed.
    return raw.filter((item) => pool.has(item.id));
  }

  /**
   * Check if collection has been loaded
   */
  get loaded(): boolean {
    return this.items !== null;
  }

  /**
   * Check if collection is empty (only meaningful after loading)
   */
  get empty(): boolean {
    return this.loaded && this.items!.length === 0;
  }

  /**
   * Check if currently loading
   */
  get loading(): boolean {
    return this.isLoading;
  }

  /**
   * Get load error if any
   */
  get error(): Error | null {
    return this.loadError;
  }

  /**
   * Get collection size
   */
  get size(): number {
    // Touch parent model when accessing collection size
    if (this.objectPool && this.parent?.id) {
      this.objectPool.touch(this.parent.id);
    }

    return this.items?.length || 0;
  }

  /**
   * Hydrate the collection from local storage and/or network
   */
  async hydrate(): Promise<void> {
    // Return existing hydration promise if already in progress
    if (this.hydrationPromise) {
      return this.hydrationPromise;
    }

    // Skip if already loaded
    if (this.items !== null) {
      return;
    }

    this.hydrationPromise = this._performHydration();

    try {
      await this.hydrationPromise;
    } finally {
      this.hydrationPromise = null;
    }
  }

  /**
   * Internal hydration implementation
   */
  private async _performHydration(): Promise<void> {
    this._setLoading(true);
    this._setError(null);

    try {
      // Step 1: Try loading from IndexedDB
      const localData = await this._loadFromLocal();

      if (localData.length > 0) {
        this._setItems(localData);

        // Check if we can skip network hydration
        if (this.options.canSkipNetworkHydration?.()) {
          this._setLoading(false);
          return;
        }
      }
    } catch (error) {
      this._setError(error as Error);
      getContext().observability.breadcrumb('Failed to hydrate collection', 'sync.database', 'warning', {
        parent: this.parent.getModelName(),
        parentId: this.parent.id,
        foreignKey: this.foreignKey,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this._setLoading(false);
    }
  }

  /**
   * Load items from IndexedDB
   */
  private async _loadFromLocal(): Promise<T[]> {
    try {
      if (!this.database) {
        throw new AbloValidationError(
          `Database dependency not provided to LazyReferenceCollection for ${this.modelName}`,
          { code: 'lazy_ref_db_missing' },
        );
      }

      if (!this.objectPool) {
        throw new AbloValidationError(
          `InstanceCache dependency not provided to LazyReferenceCollection for ${this.modelName}`,
          { code: 'lazy_ref_pool_missing' },
        );
      }

      const store = this.database.getStore(this.modelName);
      const rawData = store ? await store.getAllFromIndex(this.foreignKey, this.parent.id) : [];

      // Get model class from registry
      const ModelClass = getActiveRegistry().getModelByName(this.modelName);
      if (!ModelClass) {
        getContext().observability.breadcrumb(
          `Model '${this.modelName}' not found in registry`,
          'sync.database',
          'error'
        );
        return [];
      }

      // Convert raw data to model instances
      const models: T[] = [];

      for (const data of rawData) {
        const id = data.id;
        // Skip malformed rows. Records from IDB are typed as
        // `Record<string, unknown>` (the centralized
        // `ObjectStoreContract` shape) so the `id` field is
        // narrow-checked here rather than assumed.
        if (typeof id !== 'string') continue;

        // Check if already in InstanceCache
        let model = this.objectPool.get(id);

        if (!model) {
          // Create new model instance
          model = new ModelClass();
          model.updateFromData(data);
          this.objectPool.add(model);
        }

        if (model) {
          // The by-name registry lookup types instances as the base
          // `Model`; this collection's `modelName` IS `T`'s registered
          // name (fixed at construction), so the instance is a `T`.
          models.push(model as T);
        }
      }

      // Apply filtering if specified
      let filteredModels = models;
      if (this.options.filter) {
        filteredModels = models.filter(this.options.filter);
      }

      // Apply sorting if specified
      if (this.options.sort) {
        filteredModels.sort(this.options.sort);
      }

      // Apply limit if specified
      if (this.options.limit) {
        filteredModels = filteredModels.slice(0, this.options.limit);
      }

      getContext().logger.debug('Loaded local items for collection', {
        count: filteredModels.length,
        parent: this.parent.getModelName(),
        id: this.parent.id,
        fk: this.foreignKey,
      });

      return filteredModels;
    } catch (error) {
      getContext().observability.breadcrumb('Failed to load from local', 'sync.database', 'warning', {
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  /**
   * Refresh the collection (reload from network)
   */
  async refresh(): Promise<void> {
    this.items = null;
    this.hydrationPromise = null;
    await this.hydrate();

    getContext().logger.debug('Refreshed collection', {
      parent: this.parent.getModelName(),
      id: this.parent.id,
      fk: this.foreignKey,
    });
  }

  /**
   * Add an item to the collection
   */
  add(item: T): void {
    if (this.items === null) {
      this.items = [];
    }

    // Check if item already exists
    const existingIndex = this.items.findIndex((existing) => existing.id === item.id);

    if (existingIndex >= 0) {
      // Replace existing item
      this.items[existingIndex] = item;
    } else {
      // Add new item
      this.items.push(item);

      // Apply sorting if specified
      if (this.options.sort) {
        this.items.sort(this.options.sort);
      }
    }

    getContext().logger.debug('Added item to collection', { model: item.getModelName(), id: item.id });
  }

  /**
   * Remove an item from the collection
   */
  remove(itemOrId: T | string): boolean {
    if (this.items === null) return false;

    const id = typeof itemOrId === 'string' ? itemOrId : itemOrId.id;
    const index = this.items.findIndex((item) => item.id === id);

    if (index >= 0) {
      this.items.splice(index, 1);

      getContext().logger.debug('Removed item from collection', { id });

      return true;
    }

    return false;
  }

  /**
   * Find an item in the collection
   */
  find(predicate: (item: T) => boolean): T | undefined {
    // Touch parent model when searching collection
    if (this.objectPool && this.parent?.id) {
      this.objectPool.touch(this.parent.id);
    }

    if (this.items === null) return undefined;
    return this.items.find(predicate);
  }

  /**
   * Filter items in the collection
   */
  filter(predicate: (item: T) => boolean): T[] {
    // Touch parent model when filtering collection
    if (this.objectPool && this.parent?.id) {
      this.objectPool.touch(this.parent.id);
    }

    if (this.items === null) return [];
    return this.items.filter(predicate);
  }

  /**
   * Check if collection contains an item
   */
  contains(itemOrId: T | string): boolean {
    if (this.items === null) return false;

    const id = typeof itemOrId === 'string' ? itemOrId : itemOrId.id;
    return this.items.some((item) => item.id === id);
  }

  /**
   * Convert to array (triggers hydration)
   */
  toArray(): T[] {
    return this.value;
  }

  /**
   * Set items directly (internal use)
   */
  private _setItems(items: T[]): void {
    this.items = items;
  }

  /**
   * Set loading state (internal use)
   */
  private _setLoading(loading: boolean): void {
    this.isLoading = loading;
  }

  /**
   * Set error state (internal use)
   */
  private _setError(error: Error | null): void {
    this.loadError = error;
  }

  /**
   * Clear the collection
   */
  clear(): void {
    this.items = [];
    this.loadError = null;
  }

  /**
   * Dispose of the collection (cleanup)
   * Following MobX best practice: always clean up observation hooks
   * See: https://github.com/mobxjs/mobx/issues/2047
   */
  dispose(): void {
    // Clean up MobX observation hooks first
    if (this.observationDisposer) {
      this.observationDisposer();
      this.observationDisposer = null;
    }

    // Unregister from parent if still registered
    if (this._isBeingObserved && this.parent) {
      this.parent._unregisterObservedCollection(this);
    }

    this._isBeingObserved = false;
    this.items = null;
    this.hydrationPromise = null;
    this.loadError = null;
    this.isLoading = false;
  }
}
import { getContext } from './context.js';
