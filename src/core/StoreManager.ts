/**
 * Linear Sync Engine - Store Manager
 *
 * Manages all ObjectStore instances for registered models.
 * Creates appropriate store types based on model load strategies.
 * Follows Linear's architecture with 80+ ObjectStore instances.
 */

import { ModelRegistry } from '../ModelRegistry.js';
import { ObjectStore } from '../stores/ObjectStore.js';
import { SyncActionStore } from '../stores/SyncActionStore.js';
import { LoadStrategy } from '../types/index.js';
import { AbloValidationError } from '../errors.js';

/**
 * StoreManager - Central manager for all ObjectStore instances
 *
 * Key responsibilities:
 * - Creates ObjectStore instances for each registered model
 * - Manages store lifecycle and readiness
 * - Provides unified interface for database operations
 * - Handles store-specific optimizations based on load strategies
 */
export class StoreManager {
  private stores = new Map<string, ObjectStore>();
  private syncactionStore: SyncActionStore | null = null;
  private db: IDBDatabase | null = null;
  private isInitialized = false;
  private modelRegistry: ModelRegistry;

  constructor(modelRegistry: ModelRegistry) {
    this.modelRegistry = modelRegistry;
  }

  /**
   * Initialize all stores for registered models
   */
  async initializeStores(db: IDBDatabase): Promise<void> {
    this.db = db;

    if (this.isInitialized) {
      getContext().logger.warn('StoreManager already initialized');
      return;
    }

    getContext().logger.info('Initializing ObjectStore instances for all models');
    const startTime = performance.now();

    // Get all registered models
    const allModels = this.modelRegistry.getRegisteredModelNames();

    for (const modelName of allModels) {
      await this.createStoreForModel(modelName);
    }

    // Initialize SyncactionStore
    this.syncactionStore = new SyncActionStore(this.db);
    await this.syncactionStore.initialize();

    this.isInitialized = true;
    const duration = performance.now() - startTime;

    getContext().logger.info('Initialized ObjectStores and SyncactionStore', {
      count: this.stores.size,
      ms: duration.toFixed(2),
    });

    // Log store distribution
    const storeTypes = this.getStoreTypeDistribution();
    getContext().logger.debug('Store distribution', storeTypes);
  }

  /**
   * Create ObjectStore for a specific model
   */
  private async createStoreForModel(modelName: string): Promise<void> {
    const metadata = this.modelRegistry.getMetadata(modelName);
    if (!metadata) {
      throw new AbloValidationError(`No metadata found for model: ${modelName}`, {
        code: 'store_manager_unknown_model',
      });
    }

    // Use model name directly as store name
    const storeName = modelName;

    // Create ObjectStore (MVP: simplified - use single store type for all strategies)
    const store = new ObjectStore(this.db!, modelName, storeName, metadata);

    this.stores.set(modelName, store);
  }

  /**
   * Create stores (tables) in IndexedDB
   */
  async createStores(db: IDBDatabase, transaction: IDBTransaction): Promise<void> {
    getContext().logger.info('Creating tables for all registered models');

    for (const modelName of this.modelRegistry.getRegisteredModelNames()) {
      const storeName = modelName;
      const metadata = this.modelRegistry.getMetadata(modelName);

      // Skip if store already exists
      if (db.objectStoreNames.contains(storeName)) {
        continue;
      }

      getContext().logger.debug('Creating table', { storeName, modelName });

      // Create object store with id as keyPath
      const store = db.createObjectStore(storeName, { keyPath: 'id' });

      // Create indexes for indexed properties
      const indexedProperties = this.modelRegistry.getIndexedProperties(modelName);
      for (const propName of indexedProperties) {
        try {
          store.createIndex(propName, propName, { unique: false });
          getContext().logger.debug('Created index', { store: storeName, prop: propName });
        } catch (error) {
          getContext().logger.warn('Failed to create index', { store: storeName, prop: propName, error });
        }
      }

      // For partial load strategy models, we'll create additional partial index database later
      if (metadata?.loadStrategy === LoadStrategy.partial) {
        getContext().logger.debug('Model will have additional partial index database', { modelName });
      }
    }

    // Create special tables
    this.createSpecialTables(db);
  }

  /**
   * Create special tables (sync_action_table, model_table, model_table_partial, __meta, __transactions)
   */
  private createSpecialTables(db: IDBDatabase): void {
    // Create sync_action_table for sync actions (delta packets)
    if (!db.objectStoreNames.contains('sync_action_table')) {
      const syncActionStore = db.createObjectStore('sync_action_table', { keyPath: 'id' });
      syncActionStore.createIndex('syncId', 'id');
      getContext().logger.debug('Created sync_action_table');
    }

    // Create __meta table for model persistence state and database metadata
    if (!db.objectStoreNames.contains('__meta')) {
      const metaStore = db.createObjectStore('__meta');
      getContext().logger.debug('Created __meta table');
    }

    // Create __transactions table for unsent transactions
    if (!db.objectStoreNames.contains('__transactions')) {
      const transactionStore = db.createObjectStore('__transactions', {
        keyPath: 'id',
        autoIncrement: false,
      });

      // Create indexes for transaction queries
      transactionStore.createIndex('timestamp', 'timestamp');
      transactionStore.createIndex('status', 'status');

      getContext().logger.debug('Created __transactions table');
    }
  }

  /**
   * Get ObjectStore for a model
   */
  getStore(modelName: string): ObjectStore | undefined {
    return this.stores.get(modelName);
  }

  /**
   * Get SyncactionStore instance
   */
  getSyncactionStore(): SyncActionStore | null {
    return this.syncactionStore;
  }

  /**
   * Get all stores
   */
  getAllStores(): Map<string, ObjectStore> {
    return new Map(this.stores);
  }

  /**
   * Check readiness of all stores
   */
  async checkReadinessOfStores(): Promise<{
    ready: boolean;
    readyStores: string[];
    notReadyStores: string[];
    totalStores: number;
  }> {
    const readyStores: string[] = [];
    const notReadyStores: string[] = [];

    for (const [modelName, store] of Array.from(this.stores)) {
      const isReady = await store.checkIsReady();

      if (isReady) {
        readyStores.push(modelName);
      } else {
        notReadyStores.push(modelName);
      }
    }

    const allReady = notReadyStores.length === 0;

    getContext().logger.debug('Store readiness', {
      ready: readyStores.length,
      total: this.stores.size,
      notReady: notReadyStores,
    });

    return {
      ready: allReady,
      readyStores,
      notReadyStores,
      totalStores: this.stores.size,
    };
  }

  /**
   * Check if ANY data store has at least one record.
   *
   * This is the Zero-style cache-validity check: if the stores are empty,
   * the sync cursor (lastSyncId) is invalid regardless of what the metadata
   * says. The cursor and the data must be co-located — no data means no
   * cursor, which means full bootstrap.
   *
   * Samples up to 3 stores to avoid a full scan. If any store has records,
   * returns true (we have cached data worth preserving).
   */
  async hasAnyData(): Promise<boolean> {
    const storeEntries = Array.from(this.stores);
    // Sample a few stores — don't check all 30+ if the first one has data
    const samplesToCheck = Math.min(storeEntries.length, 3);
    for (let i = 0; i < samplesToCheck; i++) {
      const [, store] = storeEntries[i];
      try {
        const count = await store.count();
        if (count > 0) return true;
      } catch {
        // Store not accessible — treat as empty
      }
    }
    return false;
  }

  /**
   * Get store type distribution for debugging
   */
  getStoreTypeDistribution(): { full: number; partial: number } {
    let full = 0;
    let partial = 0;

    for (const [modelName] of Array.from(this.stores)) {
      const metadata = this.modelRegistry.getMetadata(modelName);
      if (metadata?.loadStrategy === LoadStrategy.partial) {
        partial++;
      } else {
        full++;
      }
    }

    return { full, partial };
  }

  /**
   * Get stores by load strategy
   */
  getStoresByStrategy(strategy: LoadStrategy): ObjectStore[] {
    const stores: ObjectStore[] = [];

    for (const [modelName, store] of Array.from(this.stores)) {
      const metadata = this.modelRegistry.getMetadata(modelName);
      if (metadata?.loadStrategy === strategy) {
        stores.push(store);
      }
    }

    return stores;
  }

  /**
   * Get models to load for bootstrapping
   */
  getModelsToLoad(): {
    instant: string[];
    lazy: string[];
    partial: string[];
  } {
    const instant: string[] = [];
    const lazy: string[] = [];
    const partial: string[] = [];

    for (const [modelName] of Array.from(this.stores)) {
      const metadata = this.modelRegistry.getMetadata(modelName);

      switch (metadata?.loadStrategy) {
        case LoadStrategy.instant:
          instant.push(modelName);
          break;
        case LoadStrategy.lazy:
          lazy.push(modelName);
          break;
        case LoadStrategy.partial:
          partial.push(modelName);
          break;
        // Skip explicitlyRequested and local
      }
    }

    return { instant, lazy, partial };
  }

  /**
   * Perform maintenance on all stores
   */
  async performMaintenance(): Promise<void> {
    getContext().logger.info('Performing maintenance on all stores');

    const promises = Array.from(this.stores.values()).map((store) => store.performMaintenance());

    await Promise.all(promises);

    getContext().logger.info('Store maintenance completed');
  }

  /**
   * Clear all stores
   */
  async clearAllStores(): Promise<void> {
    getContext().logger.warn('Clearing all stores');

    const promises = Array.from(this.stores.values()).map((store) => store.clear());

    await Promise.all(promises);

    getContext().logger.info('All stores cleared');
  }

  /**
   * Mark all stores as closing to prevent new operations
   * Called before database connection is closed
   */
  markAllStoresAsClosing(): void {
    getContext().logger.debug('Marking all stores as closing');

    for (const store of this.stores.values()) {
      store.markAsClosing();
    }

    // SyncActionStore is a standalone store (does NOT extend ObjectStore)
    // and has no markAsClosing equivalent. The previous `(syncactionStore
    // as any).markAsClosing?.()` was a silent no-op disguised as a real
    // call — the optional chain swallowed the missing method. If
    // closing-state coordination is needed for sync actions, add it
    // explicitly to SyncActionStore rather than reintroducing the cast.

    getContext().logger.debug('All stores marked as closing');
  }

  /**
   * Get comprehensive statistics
   */
  async getComprehensiveStats(): Promise<{
    totalStores: number;
    storeTypes: { full: number; partial: number };
    readiness: { ready: number; notReady: number };
    totalRecords: number;
    storeDetails: Array<{
      modelName: string;
      storeName: string;
      strategy: LoadStrategy;
      ready: boolean;
      count: number;
    }>;
  }> {
    const storeDetails: Array<{
      modelName: string;
      storeName: string;
      strategy: LoadStrategy;
      ready: boolean;
      count: number;
    }> = [];

    let totalRecords = 0;
    let readyCount = 0;

    for (const [modelName, store] of Array.from(this.stores)) {
      const metadata = this.modelRegistry.getMetadata(modelName)!;
      const storeName = modelName;
      const ready = await store.checkIsReady();
      const count = await store.count();

      if (ready) readyCount++;
      totalRecords += count;

      storeDetails.push({
        modelName,
        storeName,
        strategy: metadata.loadStrategy,
        ready,
        count,
      });
    }

    return {
      totalStores: this.stores.size,
      storeTypes: this.getStoreTypeDistribution(),
      readiness: {
        ready: readyCount,
        notReady: this.stores.size - readyCount,
      },
      totalRecords,
      storeDetails,
    };
  }
}
import { getContext } from '../context.js';
