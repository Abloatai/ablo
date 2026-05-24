/**
 * Linear Sync Engine - Sync Action Store
 *
 * Stores and manages sync actions received from the server.
 * Critical for delta sync and maintaining sync state consistency.
 */

// Uses native IndexedDB for maximum performance
import { SyncAction } from '../types/index.js';

/**
 * SyncActionStore - Manages sync actions (deltas)
 *
 * Features:
 * - Stores sync actions by ID for replay
 * - Tracks applied vs pending actions
 * - Enables rewind/replay for conflict resolution
 * - Maintains sync watermark
 */
export class SyncActionStore {
  private db: IDBDatabase;
  private storeName = 'sync_action_table';
  private lastAppliedSyncId: number = 0;
  private pendingActions: Map<number, SyncAction> = new Map();

  constructor(db: IDBDatabase) {
    this.db = db;
  }

  /**
   * Initialize store (create if needed)
   */
  async initialize(): Promise<void> {
    // Store is created during database migration
    // Load last applied sync ID from metadata
    const metadata = await this.getMetadata();
    if (metadata) {
      this.lastAppliedSyncId = metadata.lastSyncId || 0;
    }
  }

  /**
   * Store a sync action
   */
  async storeSyncAction(action: SyncAction): Promise<void> {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction([this.storeName], 'readwrite');
      const store = tx.objectStore(this.storeName);

      const request = store.put({
        ...action,
        storedAt: Date.now(),
        applied: false,
      });

      tx.oncomplete = () => {
        // Add to pending if not yet applied
        if (action.id > this.lastAppliedSyncId) {
          this.pendingActions.set(action.id, action);
        }
        resolve();
      };

      tx.onerror = () => reject(tx.error);
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Store multiple sync actions
   */
  async storeSyncActions(actions: SyncAction[]): Promise<void> {
    if (actions.length === 0) return;

    return new Promise((resolve, reject) => {
      const tx = this.db.transaction([this.storeName], 'readwrite');
      const store = tx.objectStore(this.storeName);
      let completed = 0;
      const total = actions.length;

      for (const action of actions) {
        const request = store.put({
          ...action,
          storedAt: Date.now(),
          applied: false,
        });

        request.onsuccess = () => {
          completed++;
          if (completed === total) {
            // Add to pending
            for (const action of actions) {
              if (action.id > this.lastAppliedSyncId) {
                this.pendingActions.set(action.id, action);
              }
            }
          }
        };
        request.onerror = () => reject(request.error);
      }

      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  /**
   * Get sync action by ID
   */
  async getSyncAction(id: number): Promise<SyncAction | undefined> {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction([this.storeName], 'readonly');
      const store = tx.objectStore(this.storeName);
      const request = store.get(id);

      request.onsuccess = () => {
        const data = request.result;

        if (!data) {
          resolve(undefined);
          return;
        }

        const { storedAt, applied, ...action } = data;
        resolve(action as SyncAction);
      };

      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Get sync actions in range
   */
  async getSyncActionsInRange(startId: number, endId: number): Promise<SyncAction[]> {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction([this.storeName], 'readonly');
      const store = tx.objectStore(this.storeName);
      const index = store.index('syncId');
      const range = IDBKeyRange.bound(startId, endId);
      const request = index.getAll(range);

      request.onsuccess = () => {
        const allData = request.result;
        const actions = allData.map(
          ({ storedAt, applied, ...action }: any) => action as SyncAction
        );
        resolve(actions);
      };

      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Get pending sync actions (not yet applied)
   */
  async getPendingSyncActions(): Promise<SyncAction[]> {
    if (this.pendingActions.size === 0) {
      return [];
    }

    // Return sorted by sync ID
    const sorted = Array.from(this.pendingActions.values()).sort((a, b) => a.id - b.id);

    return sorted;
  }

  /**
   * Mark sync action as applied
   */
  async markAsApplied(syncId: number): Promise<void> {
    return new Promise(async (resolve, reject) => {
      const tx = this.db.transaction([this.storeName], 'readwrite');
      const store = tx.objectStore(this.storeName);

      const getRequest = store.get(syncId);
      getRequest.onsuccess = () => {
        const existing = getRequest.result;
        if (existing) {
          existing.applied = true;
          existing.appliedAt = Date.now();
          const putRequest = store.put(existing);
          putRequest.onerror = () => reject(putRequest.error);
        }
      };
      getRequest.onerror = () => reject(getRequest.error);

      tx.oncomplete = async () => {
        // Update tracking
        if (syncId > this.lastAppliedSyncId) {
          this.lastAppliedSyncId = syncId;
        }

        // Remove from pending
        this.pendingActions.delete(syncId);

        // Update metadata
        try {
          await this.updateLastSyncId(syncId);
          resolve();
        } catch (error) {
          reject(error);
        }
      };

      tx.onerror = () => reject(tx.error);
    });
  }

  /**
   * Mark multiple actions as applied
   */
  async markManyAsApplied(syncIds: number[]): Promise<void> {
    if (syncIds.length === 0) return;

    return new Promise(async (resolve, reject) => {
      const tx = this.db.transaction([this.storeName], 'readwrite');
      const store = tx.objectStore(this.storeName);
      let processed = 0;
      const total = syncIds.length;

      for (const syncId of syncIds) {
        const getRequest = store.get(syncId);
        getRequest.onsuccess = () => {
          const existing = getRequest.result;
          if (existing) {
            existing.applied = true;
            existing.appliedAt = Date.now();
            const putRequest = store.put(existing);
            putRequest.onsuccess = () => {
              processed++;
              // Remove from pending
              this.pendingActions.delete(syncId);

              if (processed === total) {
                // All processed, update last applied ID
                const maxId = Math.max(...syncIds);
                if (maxId > this.lastAppliedSyncId) {
                  this.lastAppliedSyncId = maxId;
                }
              }
            };
            putRequest.onerror = () => reject(putRequest.error);
          } else {
            processed++;
            this.pendingActions.delete(syncId);
          }
        };
        getRequest.onerror = () => reject(getRequest.error);
      }

      tx.oncomplete = async () => {
        // Update metadata with the highest sync ID
        const maxId = Math.max(...syncIds);
        if (maxId > this.lastAppliedSyncId) {
          try {
            await this.updateLastSyncId(maxId);
            resolve();
          } catch (error) {
            reject(error);
          }
        } else {
          resolve();
        }
      };

      tx.onerror = () => reject(tx.error);
    });
  }

  /**
   * Get last applied sync ID
   */
  getLastAppliedSyncId(): number {
    return this.lastAppliedSyncId;
  }

  /**
   * Check if we have a gap in sync IDs
   */
  async hasGap(fromId: number, toId: number): Promise<boolean> {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction([this.storeName], 'readonly');
      const store = tx.objectStore(this.storeName);
      const index = store.index('syncId');
      let currentId = fromId;
      let hasGap = false;

      const checkNext = () => {
        if (currentId > toId) {
          resolve(hasGap);
          return;
        }

        const request = index.get(currentId);
        request.onsuccess = () => {
          if (!request.result) {
            hasGap = true;
            resolve(true);
            return;
          }
          currentId++;
          checkNext();
        };
        request.onerror = () => reject(request.error);
      };

      checkNext();
    });
  }

  /**
   * Get missing sync IDs in range
   */
  async getMissingSyncIds(fromId: number, toId: number): Promise<number[]> {
    return new Promise((resolve, reject) => {
      const missing: number[] = [];
      const tx = this.db.transaction([this.storeName], 'readonly');
      const store = tx.objectStore(this.storeName);
      const index = store.index('syncId');
      let currentId = fromId;

      const checkNext = () => {
        if (currentId > toId) {
          resolve(missing);
          return;
        }

        const request = index.get(currentId);
        request.onsuccess = () => {
          if (!request.result) {
            missing.push(currentId);
          }
          currentId++;
          checkNext();
        };
        request.onerror = () => reject(request.error);
      };

      checkNext();
    });
  }

  /**
   * Clean up old sync actions
   */
  async cleanup(keepDays: number = 7): Promise<number> {
    return new Promise((resolve, reject) => {
      const cutoff = Date.now() - keepDays * 24 * 60 * 60 * 1000;
      const tx = this.db.transaction([this.storeName], 'readwrite');
      const store = tx.objectStore(this.storeName);
      const request = store.openCursor();
      let cleaned = 0;

      request.onsuccess = (event) => {
        const cursor = (event.target as IDBRequest).result;
        if (cursor) {
          if (cursor.value.applied && cursor.value.appliedAt < cutoff) {
            const deleteRequest = cursor.delete();
            deleteRequest.onsuccess = () => {
              cleaned++;
              cursor.continue();
            };
            deleteRequest.onerror = () => reject(deleteRequest.error);
          } else {
            cursor.continue();
          }
        } else {
          // Cursor finished
          resolve(cleaned);
        }
      };

      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Clear all sync actions
   */
  async clear(): Promise<void> {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction([this.storeName], 'readwrite');
      const store = tx.objectStore(this.storeName);
      const request = store.clear();

      tx.oncomplete = () => {
        this.pendingActions.clear();
        this.lastAppliedSyncId = 0;
        resolve();
      };

      tx.onerror = () => reject(tx.error);
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Get statistics
   */
  async getStats(): Promise<{
    total: number;
    applied: number;
    pending: number;
    lastAppliedId: number;
    oldestAction: Date | null;
    newestAction: Date | null;
  }> {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction([this.storeName], 'readonly');
      const store = tx.objectStore(this.storeName);
      const request = store.getAll();

      request.onsuccess = () => {
        const allActions = request.result;

        const applied = allActions.filter((a: any) => a.applied).length;
        const pending = allActions.filter((a: any) => !a.applied).length;

        const timestamps = allActions
          .map((a: any) => a.storedAt)
          .filter(Boolean)
          .sort();

        resolve({
          total: allActions.length,
          applied,
          pending,
          lastAppliedId: this.lastAppliedSyncId,
          oldestAction: timestamps.length > 0 ? new Date(timestamps[0]) : null,
          newestAction: timestamps.length > 0 ? new Date(timestamps[timestamps.length - 1]) : null,
        });
      };

      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Update last sync ID in metadata
   */
  private async updateLastSyncId(syncId: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(['__meta'], 'readwrite');
      const store = tx.objectStore('__meta');

      const getRequest = store.get('metadata');
      getRequest.onsuccess = () => {
        const metadata = getRequest.result || {};

        metadata.lastSyncId = syncId;
        metadata.updatedAt = new Date();

        const putRequest = store.put(metadata, 'metadata');
        putRequest.onerror = () => reject(putRequest.error);
      };
      getRequest.onerror = () => reject(getRequest.error);

      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  /**
   * Get metadata. Shape mirrors what's written by the database manager
   * — currently only `lastSyncId` is consumed here (in `initialize`),
   * so the return type is narrowed to that read surface. Returns
   * `undefined` when the row hasn't been written yet (fresh DB).
   */
  private async getMetadata(): Promise<{ lastSyncId?: number } | undefined> {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(['__meta'], 'readonly');
      const store = tx.objectStore('__meta');
      const request = store.get('metadata');

      request.onsuccess = () => {
        const raw = request.result as unknown;
        if (raw && typeof raw === 'object' && 'lastSyncId' in raw) {
          resolve(raw as { lastSyncId?: number });
        } else {
          resolve(undefined);
        }
      };
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Rewind to a specific sync ID (for conflict resolution)
   */
  async rewindTo(syncId: number): Promise<SyncAction[]> {
    return new Promise(async (resolve, reject) => {
      // Get all actions after this sync ID
      const tx = this.db.transaction([this.storeName], 'readonly');
      const store = tx.objectStore(this.storeName);
      const index = store.index('syncId');
      const range = IDBKeyRange.lowerBound(syncId, false);
      const request = index.getAll(range);

      request.onsuccess = async () => {
        const actionsToRewind = request.result;

        // Mark them as not applied
        const writeTx = this.db.transaction([this.storeName], 'readwrite');
        const writeStore = writeTx.objectStore(this.storeName);
        let processed = 0;
        const total = actionsToRewind.length;

        if (total === 0) {
          this.lastAppliedSyncId = syncId - 1;
          try {
            await this.updateLastSyncId(this.lastAppliedSyncId);
            resolve([]);
          } catch (error) {
            reject(error);
          }
          return;
        }

        for (const action of actionsToRewind) {
          action.applied = false;
          delete action.appliedAt;

          const putRequest = writeStore.put(action);
          putRequest.onsuccess = () => {
            processed++;
            // Add back to pending
            this.pendingActions.set(action.id, action);

            if (processed === total) {
              // All processed
              this.lastAppliedSyncId = syncId - 1;
            }
          };
          putRequest.onerror = () => reject(putRequest.error);
        }

        writeTx.oncomplete = async () => {
          try {
            await this.updateLastSyncId(this.lastAppliedSyncId);
            const result = actionsToRewind.map(
              ({ storedAt, applied, ...action }: any) => action as SyncAction
            );
            resolve(result);
          } catch (error) {
            reject(error);
          }
        };

        writeTx.onerror = () => reject(writeTx.error);
      };

      request.onerror = () => reject(request.error);
    });
  }
}
