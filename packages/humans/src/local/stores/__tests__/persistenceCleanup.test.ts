import type { DatabaseInfo } from '../DatabaseManager.js';
import { v1PersistenceDatabaseNameForDeletion } from '../v1PersistenceDeletion.js';
import { deleteIDBWithTimeout } from '../openIDBWithTimeout.js';
import { purgeIndexedDbPersistence } from '../persistenceCleanup.js';

function openDatabase(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 1);
    request.onsuccess = () => { resolve(request.result); };
    request.onerror = () => {
      reject(request.error ?? new Error(`Could not open IndexedDB database ${name}`));
    };
  });
}

const current: DatabaseInfo = {
  name: 'ablo_v3_current',
  namespaceVersion: 3,
  userId: 'Aa',
  workspaceId: 'org',
  participantKind: 'user',
  projectId: 'org',
  branchId: 'br_production',
  branchRoot: true,
  schemaHash: 'schema',
  schemaVersion: 1,
  userVersion: 1,
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe('purgeIndexedDbPersistence', () => {
  afterEach(async () => {
    await Promise.all([
      deleteIDBWithTimeout(current.name),
      deleteIDBWithTimeout(v1PersistenceDatabaseNameForDeletion('Aa', 'org', 1)),
      deleteIDBWithTimeout('ablo-sync'),
      deleteIDBWithTimeout('ablo_databases'),
    ]);
  });

  it('deletes the exact legacy identity without database enumeration', async () => {
    const v1Name = v1PersistenceDatabaseNameForDeletion('Aa', 'org', 1);
    const v1 = await openDatabase(v1Name);
    v1.close();
    const original = indexedDB.databases.bind(indexedDB);
    Object.defineProperty(indexedDB, 'databases', {
      value: undefined,
      configurable: true,
    });

    try {
      await purgeIndexedDbPersistence(current);
    } finally {
      Object.defineProperty(indexedDB, 'databases', {
        value: original,
        configurable: true,
      });
    }

    const recreated = await openDatabase(v1Name);
    expect(recreated.objectStoreNames.length).toBe(0);
    recreated.close();
  });

  it('surfaces a blocked current-database deletion', async () => {
    await expect(
      purgeIndexedDbPersistence(
        current,
        (name) => Promise.resolve(name !== current.name),
      ),
    ).rejects.toMatchObject({ code: 'db_cleanup_failed' });
  });

  it('never deletes the shared registry database', async () => {
    const deleted: string[] = [];
    await purgeIndexedDbPersistence(current, (name) => {
      deleted.push(name);
      return Promise.resolve(true);
    });

    expect(deleted).toEqual([
      current.name,
      v1PersistenceDatabaseNameForDeletion('Aa', 'org', 1),
      'ablo-sync',
    ]);
    expect(deleted).not.toContain('ablo_databases');
  });
});
