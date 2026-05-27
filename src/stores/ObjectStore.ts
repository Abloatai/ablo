/**
 * Linear Sync Engine - Object Store Base Class
 *
 * Abstract base class for all store implementations.
 * Provides the interface for storing and retrieving models from IndexedDB.
 * Uses native IndexedDB for maximum performance (no wrapper overhead).
 */

import { ModelMetadata } from '../types/index.js';
import type { ObjectStoreContract } from './ObjectStoreContract.js';

/**
 * IDB transaction options type (TypeScript's lib.dom.d.ts may be outdated)
 * durability: 'relaxed' provides ~16x write performance improvement
 * by not requiring fsync on each transaction commit.
 * Safe for optimistic sync engines that can recover from server state.
 */
interface IDBTransactionOptionsWithDurability {
  durability?: 'default' | 'relaxed' | 'strict';
}

/**
 * ObjectStore - IDB-backed model storage.
 *
 * Implements {@link ObjectStoreContract}, the shared surface that
 * `InMemoryObjectStore` also satisfies. Centralizing the contract
 * means callers can hold either implementation behind one type and
 * a future drift between the two trips a typecheck error here.
 *
 * Uses native IndexedDB API for Linear-level performance.
 */
export class ObjectStore implements ObjectStoreContract {
  private isClosing = false;

  constructor(
    protected db: IDBDatabase,
    protected modelName: string,
    protected storeName: string,
    protected metadata: ModelMetadata
  ) {}

  /**
   * Mark this store as closing to prevent new operations
   */
  markAsClosing(): void {
    this.isClosing = true;
  }

  /**
   * Check if database is available for operations
   */
  private checkDatabaseAvailable(): boolean {
    if (this.isClosing) {
      return false;
    }

    // Check if the database connection is still open
    // In IndexedDB, there's no direct way to check if a connection is open,
    // but we can check if the database object is still valid
    try {
      // Accessing objectStoreNames will throw if the database is closed
      const _ = this.db.objectStoreNames;
      return true;
    } catch (error) {
      return false;
    }
  }

  /**
   * Store a model in IndexedDB.
   * Matches the {@link InMemoryObjectStore.put} signature so both
   * stores satisfy the same caller-visible contract.
   */
  async put(data: Record<string, unknown>): Promise<void> {
    if (!this.checkDatabaseAvailable()) {
      // Surface an explicit error so upstream does not assume success
      return Promise.reject(new Error('IndexedDB not available (closing or invalid)'));
    }

    return new Promise((resolve, reject) => {
      try {
        // Use relaxed durability for ~16x write performance (safe with optimistic sync)
        const tx = this.db.transaction([this.storeName], 'readwrite', {
          durability: 'relaxed',
        } as IDBTransactionOptionsWithDurability);
        const store = tx.objectStore(this.storeName);
        const request = store.put(data);

        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error || new Error('IndexedDB transaction error'));
        request.onerror = () => reject(request.error || new Error('IndexedDB request error'));
      } catch (error) {
        // Propagate failure so callers do not continue with inconsistent state
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  /**
   * Get a model by ID
   */
  async get(id: string): Promise<Record<string, unknown> | undefined> {
    if (!this.checkDatabaseAvailable()) {
      return Promise.resolve(undefined);
    }

    return new Promise((resolve, reject) => {
      try {
        const tx = this.db.transaction([this.storeName], 'readonly');
        const store = tx.objectStore(this.storeName);
        const request = store.get(id);

        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      } catch (error) {
        resolve(undefined);
      }
    });
  }

  /**
   * Batch get multiple models by IDs in a single IDB transaction.
   * Much faster than N sequential get() calls (1 transaction vs N).
   */
  async getMany(ids: string[]): Promise<Map<string, Record<string, unknown>>> {
    const results = new Map<string, Record<string, unknown>>();
    if (ids.length === 0 || !this.checkDatabaseAvailable()) {
      return results;
    }

    return new Promise((resolve, reject) => {
      try {
        const tx = this.db.transaction([this.storeName], 'readonly');
        const store = tx.objectStore(this.storeName);
        let completed = 0;

        for (const id of ids) {
          const request = store.get(id);
          request.onsuccess = () => {
            if (request.result) {
              results.set(id, request.result);
            }
            completed++;
            if (completed === ids.length) {
              resolve(results);
            }
          };
          request.onerror = () => {
            completed++;
            if (completed === ids.length) {
              resolve(results);
            }
          };
        }

        tx.onerror = () => reject(tx.error);
      } catch (error) {
        resolve(results);
      }
    });
  }

  /**
   * Get all models
   */
  async getAll(): Promise<Record<string, unknown>[]> {
    if (!this.checkDatabaseAvailable()) {
      return Promise.resolve([]);
    }

    return new Promise((resolve, reject) => {
      try {
        const tx = this.db.transaction([this.storeName], 'readonly');
        const store = tx.objectStore(this.storeName);
        const request = store.getAll();

        request.onsuccess = () => resolve(request.result || []);
        request.onerror = () => reject(request.error);
      } catch (error) {
        resolve([]);
      }
    });
  }

  /**
   * Delete a model by ID
   */
  async delete(id: string): Promise<void> {
    if (!this.checkDatabaseAvailable()) {
      return Promise.reject(new Error('IndexedDB not available (closing or invalid)'));
    }

    return new Promise((resolve, reject) => {
      try {
        // Use relaxed durability for ~16x write performance (safe with optimistic sync)
        const tx = this.db.transaction([this.storeName], 'readwrite', {
          durability: 'relaxed',
        } as IDBTransactionOptionsWithDurability);
        const store = tx.objectStore(this.storeName);
        const request = store.delete(id);

        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error || new Error('IndexedDB transaction error'));
        request.onerror = () => reject(request.error || new Error('IndexedDB request error'));
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  /**
   * Check if store is ready (has data)
   */
  async checkIsReady(): Promise<boolean> {
    try {
      await this.count();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Clear all data in store
   */
  async clear(): Promise<void> {
    if (!this.checkDatabaseAvailable()) {
      return Promise.reject(new Error('IndexedDB not available (closing or invalid)'));
    }

    return new Promise((resolve, reject) => {
      try {
        // Use relaxed durability for ~16x write performance (safe with optimistic sync)
        const tx = this.db.transaction([this.storeName], 'readwrite', {
          durability: 'relaxed',
        } as IDBTransactionOptionsWithDurability);
        const store = tx.objectStore(this.storeName);
        const request = store.clear();

        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error || new Error('IndexedDB transaction error'));
        request.onerror = () => reject(request.error || new Error('IndexedDB request error'));
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  /**
   * Get count of models in store
   */
  async count(): Promise<number> {
    if (!this.checkDatabaseAvailable()) {
      return Promise.resolve(0);
    }

    return new Promise((resolve, reject) => {
      try {
        const tx = this.db.transaction([this.storeName], 'readonly');
        const store = tx.objectStore(this.storeName);
        const request = store.count();

        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      } catch (error) {
        resolve(0);
      }
    });
  }

  /**
   * Get models by indexed property
   */
  async getAllFromIndex(
    indexName: string,
    value: IDBValidKey,
  ): Promise<Record<string, unknown>[]> {
    if (!this.checkDatabaseAvailable()) {
      return Promise.resolve([]);
    }

    return new Promise((resolve, reject) => {
      try {
        const tx = this.db.transaction([this.storeName], 'readonly');
        const store = tx.objectStore(this.storeName);
        const index = store.index(indexName);
        const request = index.getAll(value);

        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      } catch (error) {
        resolve([]);
      }
    });
  }

  /**
   * Get models by indexed key (supports compound keys)
   */
  async getAllForIndexedKey(
    indexedKey: string,
    keyValue: IDBValidKey,
  ): Promise<Record<string, unknown>[]> {
    if (!this.checkDatabaseAvailable()) {
      return Promise.resolve([]);
    }

    // For simple index
    if (!indexedKey.includes('.')) {
      return this.getAllFromIndex(indexedKey, keyValue);
    }

    // For compound index (e.g., "teamId.status")
    return new Promise((resolve, reject) => {
      try {
        const tx = this.db.transaction([this.storeName], 'readonly');
        const store = tx.objectStore(this.storeName);
        const request = store.getAll();

        request.onsuccess = () => {
          const allRecords = request.result;
          // Filter in memory for compound keys
          const keyParts = indexedKey.split('.');
          const filtered = allRecords.filter((record) => {
            let value = record;
            for (const part of keyParts) {
              value = value?.[part];
              if (value === undefined) return false;
            }
            return value === keyValue;
          });
          resolve(filtered);
        };

        request.onerror = () => reject(request.error);
      } catch (error) {
        resolve([]);
      }
    });
  }

  /**
   * Get first model matching index
   */
  async getFromIndex(
    indexName: string,
    value: IDBValidKey,
  ): Promise<Record<string, unknown> | undefined> {
    if (!this.checkDatabaseAvailable()) {
      return Promise.resolve(undefined);
    }

    return new Promise((resolve, reject) => {
      try {
        const tx = this.db.transaction([this.storeName], 'readonly');
        const store = tx.objectStore(this.storeName);
        const index = store.index(indexName);
        const request = index.get(value);

        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      } catch (error) {
        resolve(undefined);
      }
    });
  }

  /**
   * Get count from index
   */
  async countFromIndex(indexName: string, value: IDBValidKey): Promise<number> {
    if (!this.checkDatabaseAvailable()) {
      return Promise.resolve(0);
    }

    return new Promise((resolve, reject) => {
      try {
        const tx = this.db.transaction([this.storeName], 'readonly');
        const store = tx.objectStore(this.storeName);
        const index = store.index(indexName);
        const request = index.count(value);

        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      } catch (error) {
        resolve(0);
      }
    });
  }

  /**
   * Check if any models exist for index value
   */
  async hasModelsForIndex(indexName: string, value: IDBValidKey): Promise<boolean> {
    const count = await this.countFromIndex(indexName, value);
    return count > 0;
  }

  /**
   * Get store statistics
   */
  async getStats(): Promise<{
    count: number;
    ready: boolean;
    loadStrategy: string;
    indexes: string[];
  }> {
    const tx = this.db.transaction([this.storeName], 'readonly');
    const store = tx.objectStore(this.storeName);

    return {
      count: await this.count(),
      ready: await this.checkIsReady(),
      loadStrategy: this.metadata.loadStrategy,
      indexes: store.indexNames ? Array.from(store.indexNames) : [],
    };
  }

  /**
   * Perform maintenance (override in subclasses for specific needs)
   */
  async performMaintenance(): Promise<void> {
    // Default: no maintenance needed
    // Subclasses can override for compaction, cleanup, etc.
  }
}
