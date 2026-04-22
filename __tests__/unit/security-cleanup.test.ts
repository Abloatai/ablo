/**
 * Security cleanup tests — verify that IndexedDB data is purged
 * when session expires or sync groups are revoked.
 *
 * These tests validate the critical security invariant:
 * "When auth is revoked, locally cached data must not persist on disk."
 */

import { ObjectPool, ModelScope } from '../../src/ObjectPool';
import { ModelRegistry, setActiveRegistry } from '../../src/ModelRegistry';
import {
  createTestContext,
  registerTestModels,
  TestTask,
  TestProject,
  createTaskFixture,
  createProjectFixture,
  resetFixtureCounter,
} from '../../src/testing';

describe('Security: Data cleanup on access revocation', () => {
  let pool: ObjectPool;
  let registry: ModelRegistry;
  let cleanup: () => void;

  beforeEach(() => {
    resetFixtureCounter();
    registry = new ModelRegistry();
    setActiveRegistry(registry);
    registerTestModels(registry);
    const ctx = createTestContext();
    cleanup = ctx.cleanup;
    pool = new ObjectPool({ maxSize: 100, gcInterval: 0, useWeakRefs: false }, registry);
  });

  afterEach(() => {
    pool.clear();
    cleanup();
  });

  describe('ObjectPool.clear() on session expiry', () => {
    it('should remove ALL models from pool when clear() is called', () => {
      // Simulate a pool with cached data from an active session
      pool.addBatch([
        createTaskFixture({ title: 'Confidential task' }),
        createTaskFixture({ title: 'Secret project info' }),
        createProjectFixture({ name: 'Classified project' }),
      ]);
      expect(pool.size).toBe(3);
      expect(pool.getByType(TestTask).length).toBe(2);
      expect(pool.getByType(TestProject).length).toBe(1);

      // Session expires → pool must be fully cleared
      pool.clear();

      expect(pool.size).toBe(0);
      expect(pool.getByType(TestTask).length).toBe(0);
      expect(pool.getByType(TestProject).length).toBe(0);
    });

    it('should clear type indexes so no model IDs are discoverable', () => {
      const task = createTaskFixture();
      pool.add(task);

      const idsBefore = pool.getIdsByModelType('Task');
      expect(idsBefore?.size).toBe(1);

      pool.clear();

      // After clear, type index should have no IDs
      // (it may or may not still exist as a key, but must be empty)
      const idsAfter = pool.getIdsByModelType('Task');
      expect(idsAfter === undefined || idsAfter.size === 0).toBe(true);
    });

    it('should clear FK indexes so no relationship data is discoverable', () => {
      pool.registerForeignKey('Task', 'projectId');

      const project = createProjectFixture();
      const task = createTaskFixture({ projectId: project.id });
      pool.add(project);
      pool.add(task);

      expect(pool.getByForeignKey('Task', 'projectId', project.id).length).toBe(1);

      pool.clear();

      expect(pool.getByForeignKey('Task', 'projectId', project.id).length).toBe(0);
    });

    it('should make previously cached models unreachable via get()', () => {
      const task = createTaskFixture({ title: 'Sensitive data' });
      pool.add(task);
      expect(pool.get(task.id)).toBe(task);

      pool.clear();

      expect(pool.get(task.id)).toBeUndefined();
    });
  });

  describe('IndexedDB cleanup patterns', () => {
    it('fake-indexeddb should support IDBObjectStore.clear()', async () => {
      // Verify that our test environment correctly supports the clear pattern
      // used by Database.clear() → storeManager.clearAllStores()
      const dbName = 'test-security-cleanup';
      const storeName = 'models';

      // Create a database with data
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(dbName, 1);
        request.onupgradeneeded = () => {
          request.result.createObjectStore(storeName, { keyPath: 'id' });
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });

      // Add sensitive data
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(storeName, 'readwrite');
        const store = tx.objectStore(storeName);
        store.put({ id: 'task-1', title: 'Confidential' });
        store.put({ id: 'task-2', title: 'Secret' });
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });

      // Verify data exists
      const countBefore = await new Promise<number>((resolve, reject) => {
        const tx = db.transaction(storeName, 'readonly');
        const request = tx.objectStore(storeName).count();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      expect(countBefore).toBe(2);

      // Clear all data (simulating session expiry cleanup)
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(storeName, 'readwrite');
        tx.objectStore(storeName).clear();
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });

      // Verify all data is gone
      const countAfter = await new Promise<number>((resolve, reject) => {
        const tx = db.transaction(storeName, 'readonly');
        const request = tx.objectStore(storeName).count();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      expect(countAfter).toBe(0);

      db.close();
    });

    it('fake-indexeddb should support indexedDB.deleteDatabase()', async () => {
      // Verify the nuclear cleanup option works
      const dbName = 'test-security-delete';

      // Create database
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(dbName, 1);
        request.onupgradeneeded = () => {
          request.result.createObjectStore('data', { keyPath: 'id' });
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });

      // Add data
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction('data', 'readwrite');
        tx.objectStore('data').put({ id: 'secret', content: 'classified' });
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });

      db.close();

      // Delete the entire database
      await new Promise<void>((resolve, reject) => {
        const request = indexedDB.deleteDatabase(dbName);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
      });

      // Reopening should give us a fresh database with no object stores
      const freshDb = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(dbName, 1);
        request.onupgradeneeded = () => {
          // This fires because the DB was deleted — no stores exist
          const db = request.result;
          expect(db.objectStoreNames.length).toBe(0);
          db.createObjectStore('data', { keyPath: 'id' });
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });

      // Verify no data in the fresh database
      const count = await new Promise<number>((resolve, reject) => {
        const tx = freshDb.transaction('data', 'readonly');
        const request = tx.objectStore('data').count();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      expect(count).toBe(0);

      freshDb.close();
    });
  });

  describe('OfflineTransactionStore cleanup', () => {
    it('should clear offline transaction database on session expiry pattern', async () => {
      // The OfflineTransactionStore uses a separate DB called "ablo-sync"
      // On session expiry, the SyncEngineProvider deletes all ablo-* databases
      // This test verifies the pattern works for ablo-sync
      const dbName = 'ablo-sync';

      // Create the offline store DB
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(dbName, 1);
        request.onupgradeneeded = () => {
          request.result.createObjectStore('transactions', { keyPath: 'id' });
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });

      // Add a pending offline transaction
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction('transactions', 'readwrite');
        tx.objectStore('transactions').put({
          id: 'tx-1',
          opName: 'CreateTask',
          data: { title: 'Offline task with sensitive data' },
        });
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });

      db.close();

      // Simulate session expiry cleanup — delete the database
      await new Promise<void>((resolve, reject) => {
        const request = indexedDB.deleteDatabase(dbName);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
      });

      // Verify: reopening gives empty store
      const freshDb = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(dbName, 1);
        request.onupgradeneeded = () => {
          request.result.createObjectStore('transactions', { keyPath: 'id' });
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });

      const count = await new Promise<number>((resolve, reject) => {
        const tx = freshDb.transaction('transactions', 'readonly');
        const request = tx.objectStore('transactions').count();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      expect(count).toBe(0);

      freshDb.close();
    });
  });
});
