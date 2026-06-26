/**
 * Ablo Sync Engine - Database Manager
 *
 * Manages the two-tier database architecture:
 * 1. ablo_databases - Metadata about workspace databases
 * 2. ablo_(hash) - Workspace-specific data storage
 *
 * Follows Ablo's architecture for database management.
 */

import { getContext } from '../context.js';
import {
  openIDBWithTimeout,
  deleteIDBWithTimeout,
  IDBOpenTimeoutError,
} from './openIDBWithTimeout.js';
import { AbloConnectionError } from '../errors.js';
import { getActiveRegistry, hasActiveRegistry } from '../ModelRegistry.js';

export interface DatabaseInfo {
  name: string;
  userId: string;
  workspaceId: string;
  schemaHash: string;
  schemaVersion: number;
  userVersion?: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface WorkspaceMetadata {
  lastSyncId: number;
  firstSyncId: number;
  backendDatabaseVersion: number;
  subscribedSyncGroups: string[];
  updatedAt: Date;
  schemaHash?: string;
  syncGroups?: string[];
  // Optional per-entity version vector for smarter resume
  versions?: Record<string, number>;
}

/**
 * DatabaseManager - Manages Ablo's two-tier database architecture
 *
 * Key responsibilities:
 * - Manages ablo_databases (database registry)
 * - Creates workspace-specific databases (ablo_hash)
 * - Handles database migration and versioning
 * - Provides database info and metadata management
 */
export class DatabaseManager {
  private metaDb: IDBDatabase | null = null;
  private readonly metaDbName = 'ablo_databases';

  constructor() {
    // Singleton-like behavior
  }

  /**
   * Initialize the meta database (ablo_databases)
   */
  async initializeMetaDatabase(): Promise<void> {
    const open = (): Promise<IDBDatabase> =>
      openIDBWithTimeout(this.metaDbName, 1, {
        onUpgrade: (request) => {
          const db = request.result;
          if (!db.objectStoreNames.contains('databases')) {
            const store = db.createObjectStore('databases', { keyPath: 'name' });
            store.createIndex('userId', 'userId');
            store.createIndex('workspaceId', 'workspaceId');
            store.createIndex('schemaHash', 'schemaHash');
            store.createIndex('updatedAt', 'updatedAt');
          }
        },
      });

    try {
      this.metaDb = await open();
    } catch (error) {
      // Self-heal a wedged meta DB. When `ablo_databases`'s backing store gets
      // stuck (a corrupted store, or a leaked connection from a prior
      // timed-out open), every open of that name hangs with no event and the
      // app is permanently bricked until the user manually clears site data —
      // the "open did not resolve within 10000ms" dead end. The registry this
      // DB holds is rebuildable from the server on the next bootstrap, so it is
      // safe to delete and re-create. Try exactly once: delete, then re-open.
      if (!(error instanceof IDBOpenTimeoutError)) throw error;

      getContext().logger.debug(
        '[sync-engine] meta DB open timed out — attempting self-heal (delete + retry)',
        { db: this.metaDbName, reason: error.reason },
      );
      getContext().observability.captureBootstrapFailure(error, {
        type: 'meta-db-open-timeout',
      });

      const deleted = await deleteIDBWithTimeout(this.metaDbName);
      if (!deleted) {
        // The delete itself was blocked/stuck — a live connection in another
        // window or a deadlocked backing store. We cannot recover in-page;
        // rethrow so the provider surfaces the real (now actionable) error.
        throw error;
      }
      // Fresh store — this open creates `ablo_databases` from scratch.
      this.metaDb = await open();
      getContext().logger.info('[sync-engine] meta DB self-heal succeeded');
    }
  }

  /**
   * Calculate database info for a user/workspace combination
   */
  async calculateDatabaseInfo(
    userId: string,
    workspaceId: string,
    userVersion: number = 1
  ): Promise<DatabaseInfo> {
    // Get schema hash from the active ModelRegistry
    const schemaHash = hasActiveRegistry()
      ? getActiveRegistry().getSchemaHash()
      : 'no-registry-hash';

    // Generate database name from userId, workspaceId, and versions
    const dbName = this.generateDatabaseName(userId, workspaceId, userVersion);

    // Check if we need to increment schema version
    const existingInfo = await this.getDatabaseInfo(dbName);
    let schemaVersion = 1;

    if (existingInfo && existingInfo.schemaHash !== schemaHash) {
      schemaVersion = (existingInfo.schemaVersion || 1) + 1;
    } else if (existingInfo) {
      schemaVersion = existingInfo.schemaVersion || 1;
    }

    // DEBUG: Log all existing databases for this user to detect duplicates
    const allUserDatabases = await this.getDatabasesForUser(userId);
    const allIndexedDBs = (await indexedDB.databases?.()) || [];
    const abloDatabases = allIndexedDBs.filter((db: IDBDatabaseInfo) =>
      db.name?.startsWith('ablo_')
    );

    getContext().observability.breadcrumb('Database info calculated', 'sync.database', 'info', {
      dbName,
      schemaVersion,
      existingDbCount: allUserDatabases.length,
      abloDbCount: abloDatabases.length,
    });

    return {
      name: dbName,
      userId,
      workspaceId,
      schemaHash,
      schemaVersion,
      userVersion,
      createdAt: existingInfo?.createdAt || new Date(),
      updatedAt: new Date(),
    };
  }

  /**
   * Generate deterministic database name
   */
  private generateDatabaseName(
    userId: string,
    workspaceId: string,
    userVersion: number = 1
  ): string {
    // Combine userId, workspaceId, and userVersion for unique database
    const combined = `${userId}:${workspaceId}:${userVersion}`;

    // Generate hash similar to Linear's approach
    let hash = 0;
    for (let i = 0; i < combined.length; i++) {
      hash = (hash << 5) - hash + combined.charCodeAt(i);
      hash = hash & hash; // Convert to 32bit integer
    }

    // Convert to hex and create Ablo-style name
    const hexHash = Math.abs(hash).toString(16).padStart(8, '0');
    return `ablo_${hexHash}`;
  }

  /**
   * Register database info in ablo_databases
   */
  async registerDatabase(info: DatabaseInfo): Promise<void> {
    if (!this.metaDb) {
      throw new AbloConnectionError('Meta database not initialized', {
        code: 'meta_db_not_initialized',
      });
    }

    return new Promise((resolve, reject) => {
      const tx = this.metaDb!.transaction(['databases'], 'readwrite');
      const store = tx.objectStore('databases');

      const request = store.put(info);

      tx.oncomplete = () => {
        resolve();
      };

      tx.onerror = () => reject(tx.error);
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Get database info by name
   */
  async getDatabaseInfo(name: string): Promise<DatabaseInfo | null> {
    if (!this.metaDb) return null;

    return new Promise((resolve, reject) => {
      const tx = this.metaDb!.transaction(['databases'], 'readonly');
      const store = tx.objectStore('databases');
      const request = store.get(name);

      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Get all databases for a user
   */
  async getDatabasesForUser(userId: string): Promise<DatabaseInfo[]> {
    if (!this.metaDb) return [];

    return new Promise((resolve, reject) => {
      const tx = this.metaDb!.transaction(['databases'], 'readonly');
      const store = tx.objectStore('databases');
      const index = store.index('userId');
      const request = index.getAll(userId);

      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Open workspace-specific database
   */
  async openWorkspaceDatabase(
    dbInfo: DatabaseInfo,
    createStoresFn?: (db: IDBDatabase, tx: IDBTransaction) => Promise<void>
  ): Promise<IDBDatabase> {
    try {
      return await openIDBWithTimeout(dbInfo.name, dbInfo.schemaVersion, {
        onUpgrade: (request, event) => {
          const db = request.result;
          const tx = (event.target as IDBOpenDBRequest).transaction;
          // Per jakearchibald/idb's "Transaction Lifetime Management":
          // only IDB-request awaits keep an upgrade transaction alive; any
          // non-IDB await (fetch, timer, etc.) commits it prematurely and
          // later ops throw `TransactionInactiveError`. StoreManager.createStores
          // (src/core/StoreManager.ts:93) is only synchronous createObjectStore
          // / createIndex calls wrapped in an `async` keyword, so firing it
          // without awaiting is safe and matches the VCS-slot semantics.
          if (createStoresFn && tx) {
            try {
              void createStoresFn(db, tx).catch((err) => {
                getContext().observability.captureBootstrapFailure(err, {
                  type: 'store-creation',
                });
              });
            } catch (err) {
              getContext().observability.captureBootstrapFailure(err, {
                type: 'store-creation',
              });
            }
          }
        },
      });
    } catch (error) {
      getContext().observability.captureBootstrapFailure(error, {
        type: 'database-open',
      });
      throw error;
    }
  }

  /**
   * Read workspace metadata from __meta table
   */
  async getWorkspaceMetadata(db: IDBDatabase): Promise<WorkspaceMetadata | null> {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(['__meta'], 'readonly');
      const store = tx.objectStore('__meta');
      const request = store.get('metadata');

      request.onsuccess = () => {
        const data = request.result;
        if (!data) {
          resolve(null);
          return;
        }

        const meta = {
          lastSyncId: data.lastSyncId || 0,
          firstSyncId: data.firstSyncId || 0,
          backendDatabaseVersion: data.backendDatabaseVersion || 1,
          subscribedSyncGroups: data.subscribedSyncGroups || [],
          updatedAt: data.updatedAt ? new Date(data.updatedAt) : new Date(),
          schemaHash: data.schemaHash,
          syncGroups: data.syncGroups,
          versions: data.versions || undefined,
        } as WorkspaceMetadata;
        resolve(meta);
      };

      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Write workspace metadata to __meta table
   */
  async setWorkspaceMetadata(db: IDBDatabase, metadata: WorkspaceMetadata): Promise<void> {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(['__meta'], 'readwrite');
      const store = tx.objectStore('__meta');
      const request = store.put(metadata, 'metadata');

      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Check if a model is persisted (all instances loaded)
   */
  async isModelPersisted(db: IDBDatabase, modelName: string): Promise<boolean> {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(['__meta'], 'readonly');
      const store = tx.objectStore('__meta');
      const request = store.get(modelName);

      request.onsuccess = () => {
        const data = request.result;
        resolve(data?.persisted === true);
      };

      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Mark a model as persisted
   */
  async setModelPersisted(db: IDBDatabase, modelName: string, persisted: boolean): Promise<void> {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(['__meta'], 'readwrite');
      const store = tx.objectStore('__meta');

      const persistenceData = {
        persisted,
        modelName,
        timestamp: Date.now(),
        updatedAt: new Date().toISOString(),
      };

      const request = store.put(persistenceData, modelName);

      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Get all model persistence states
   */
  async getAllModelPersistenceStates(db: IDBDatabase): Promise<Record<string, boolean>> {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(['__meta'], 'readonly');
      const store = tx.objectStore('__meta');
      const request = store.getAll();

      request.onsuccess = () => {
        const states: Record<string, boolean> = {};

        for (const item of request.result) {
          // Skip metadata entry
          if (item.key === 'metadata') continue;

          if (item.modelName) {
            states[item.modelName] = item.persisted === true;
          }
        }

        resolve(states);
      };

      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Delete a workspace database
   */
  async deleteWorkspaceDatabase(dbInfo: DatabaseInfo): Promise<void> {
    return new Promise((resolve, reject) => {
      const deleteRequest = indexedDB.deleteDatabase(dbInfo.name);

      deleteRequest.onsuccess = async () => {
        // Remove from registry
        if (this.metaDb) {
          const tx = this.metaDb.transaction(['databases'], 'readwrite');
          const store = tx.objectStore('databases');
          store.delete(dbInfo.name);
        }

        resolve();
      };

      deleteRequest.onerror = () => {
        getContext().observability.breadcrumb(
          `Failed to delete workspace database: ${dbInfo.name}`,
          'sync.database',
          'error'
        );
        reject(deleteRequest.error);
      };

      deleteRequest.onblocked = () => {
        getContext().observability.breadcrumb(
          `Database deletion blocked: ${dbInfo.name}`,
          'sync.database',
          'warning'
        );
        // Could implement retry logic or user notification
      };
    });
  }

  /**
   * Get comprehensive database statistics
   */
  async getDatabaseStatistics(): Promise<{
    metaDatabaseSize: number;
    totalWorkspaceDatabases: number;
    databasesByUser: Record<string, number>;
    schemaVersions: Record<string, number>;
  }> {
    if (!this.metaDb) {
      return {
        metaDatabaseSize: 0,
        totalWorkspaceDatabases: 0,
        databasesByUser: {},
        schemaVersions: {},
      };
    }

    return new Promise((resolve, reject) => {
      const tx = this.metaDb!.transaction(['databases'], 'readonly');
      const store = tx.objectStore('databases');
      const request = store.getAll();

      request.onsuccess = () => {
        const databases = request.result;

        const databasesByUser: Record<string, number> = {};
        const schemaVersions: Record<string, number> = {};

        for (const db of databases) {
          // Count by user
          databasesByUser[db.userId] = (databasesByUser[db.userId] || 0) + 1;

          // Count schema versions
          const versionKey = `v${db.schemaVersion}`;
          schemaVersions[versionKey] = (schemaVersions[versionKey] || 0) + 1;
        }

        resolve({
          metaDatabaseSize: databases.length,
          totalWorkspaceDatabases: databases.length,
          databasesByUser,
          schemaVersions,
        });
      };

      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Close all database connections
   */
  async close(): Promise<void> {
    if (this.metaDb) {
      this.metaDb.close();
      this.metaDb = null;
    }
  }
}
