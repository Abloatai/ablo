/**
 * Manages the {@link ObjectStore} instances the sync engine keeps in the
 * browser — one per registered model — alongside the single
 * {@link SyncActionStore} for pending changes. It creates each store from the
 * model's metadata, tracks readiness, and provisions the underlying IndexedDB
 * object stores. A model's load strategy — instant or lazy — decides how and
 * when its data is loaded.
 */

import { ModelRegistry } from '../ModelRegistry.js';
import { ObjectStore } from '../stores/ObjectStore.js';
import { SyncActionStore } from '../stores/SyncActionStore.js';
import { LoadStrategy } from '../transaction/types/index.js';
import { AbloValidationError } from '../transaction/errors.js';

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
  /** Strict-durability wrapper for the client write journal and commit outbox. */
  private transactionStore: ObjectStore | null = null;
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
      // Idempotent re-entry — harmless, nothing for the consumer to act on → debug.
      getContext().logger.debug('StoreManager already initialized');
      return;
    }

    getContext().logger.info('Initializing ObjectStore instances for all models');
    const startTime = performance.now();

    // Get all registered models
    const allModels = this.modelRegistry.getRegisteredModelNames();

    for (const modelName of allModels) {
      await this.createStoreForModel(modelName);
    }

    // Special stores are created during the IDB upgrade, but unlike model
    // stores they have no registry metadata and therefore need an explicit
    // runtime wrapper. Outbox acknowledgement must mean disk-backed, so this
    // store opts into strict durability rather than the cache stores' relaxed
    // mode.
    this.transactionStore = new ObjectStore(
      this.db,
      '__transactions',
      '__transactions',
      { loadStrategy: LoadStrategy.instant },
      'strict',
    );

    // Initialize SyncactionStore
    this.syncactionStore = new SyncActionStore(this.db);
    await this.syncactionStore.initialize();

    this.isInitialized = true;
    const duration = performance.now() - startTime;

    getContext().logger.info('Initialized ObjectStores and SyncactionStore', {
      count: this.stores.size,
      ms: duration.toFixed(2),
    });

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

    // Create the ObjectStore. One store type currently serves every load strategy.
    const store = new ObjectStore(this.db!, modelName, storeName, metadata);

    this.stores.set(modelName, store);
  }

  /**
   * Create stores (tables) in IndexedDB
   */
  async createStores(db: IDBDatabase): Promise<void> {
    getContext().logger.info('Creating tables for all registered models');

    for (const modelName of this.modelRegistry.getRegisteredModelNames()) {
      const storeName = modelName;

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
          // Internal IndexedDB index setup — a miss only affects local query
          // speed and isn't consumer-actionable → debug.
          getContext().logger.debug('Failed to create index', { store: storeName, prop: propName, error });
        }
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
      db.createObjectStore('__meta');
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
    if (modelName === '__transactions') {
      return this.transactionStore ?? undefined;
    }
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
   * Reports whether any data store holds at least one record. This is a
   * cache-validity check: if the stores are empty, the sync cursor
   * (`lastSyncId`) is meaningless no matter what the metadata says, because the
   * cursor and the data must travel together — no data means no cursor, which
   * forces a full bootstrap. To stay cheap it samples up to three stores rather
   * than scanning them all, and returns true as soon as one has records.
   */
  async hasAnyData(): Promise<boolean> {
    const storeEntries = Array.from(this.stores);
    // Sample a few stores — don't check all 30+ if the first one has data
    const samplesToCheck = Math.min(storeEntries.length, 3);
    for (let i = 0; i < samplesToCheck; i++) {
      const entry = storeEntries[i];
      if (!entry) break;
      const [, store] = entry;
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
    // Lifecycle chatter (logout / identity switch / reset), not a warning.
    // Logged at `debug` so it stays silent under the default `warn` threshold.
    getContext().logger.debug('Clearing all stores');

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
    this.transactionStore?.markAsClosing();

    // SyncActionStore is a standalone store that does not extend ObjectStore
    // and has no markAsClosing equivalent, so it is intentionally skipped here.
    // If closing-state coordination is ever needed for sync actions, add it
    // explicitly to SyncActionStore rather than casting to reach a method that
    // may not exist.

    getContext().logger.debug('All stores marked as closing');
  }

  /**
   * Get comprehensive statistics
   */
  async getComprehensiveStats(): Promise<{
    totalStores: number;
    readiness: { ready: number; notReady: number };
    totalRecords: number;
    storeDetails: {
      modelName: string;
      storeName: string;
      strategy: LoadStrategy;
      ready: boolean;
      count: number;
    }[];
  }> {
    const storeDetails: {
      modelName: string;
      storeName: string;
      strategy: LoadStrategy;
      ready: boolean;
      count: number;
    }[] = [];

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
