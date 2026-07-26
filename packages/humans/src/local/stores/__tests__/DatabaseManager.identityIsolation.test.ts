import {
  DatabaseManager,
  type DatabaseInfo,
} from '../DatabaseManager.js';
import {
  PERSISTENCE_NAMESPACE_VERSION,
  persistenceDatabaseName,
  type PersistenceIdentity,
} from '../persistenceIdentity.js';
import { deleteIDBWithTimeout } from '../openIDBWithTimeout.js';

const identity = (
  participantId: string,
  overrides: Partial<PersistenceIdentity> = {},
): PersistenceIdentity => ({
  participantId,
  participantKind: 'user',
  organizationId: 'org',
  projectId: 'project',
  branchId: 'br_production',
  branchRoot: true,
  ...overrides,
});

describe('DatabaseManager authenticated-plane isolation', () => {
  afterEach(async () => {
    await deleteIDBWithTimeout('ablo_databases');
  });

  it('separates the known Java string-hash collision Aa / BB', async () => {
    const aa = await persistenceDatabaseName(identity('Aa'));
    const bb = await persistenceDatabaseName(identity('BB'));

    expect(aa).not.toBe(bb);
    expect(aa).toMatch(/^ablo_v4_[0-9a-f]{64}$/);
    expect(bb).toMatch(/^ablo_v4_[0-9a-f]{64}$/);
  });

  it('includes every authenticated branch axis in the namespace', async () => {
    const base = identity('user');
    const names = await Promise.all([
      persistenceDatabaseName(base),
      persistenceDatabaseName({ ...base, participantKind: 'agent' }),
      persistenceDatabaseName({ ...base, organizationId: 'other-org' }),
      persistenceDatabaseName({ ...base, projectId: 'other-project' }),
      persistenceDatabaseName({ ...base, branchId: 'br_feature', branchRoot: false }),
    ]);

    expect(new Set(names).size).toBe(names.length);
  });

  it('refuses registry metadata owned by a different identity', async () => {
    const manager = new DatabaseManager();
    await manager.initializeMetaDatabase();
    const expected = identity('expected');
    const name = await persistenceDatabaseName(expected);
    const poisoned: DatabaseInfo = {
      name,
      namespaceVersion: PERSISTENCE_NAMESPACE_VERSION,
      userId: 'different-user',
      workspaceId: expected.organizationId,
      participantKind: expected.participantKind,
      projectId: expected.projectId,
      branchId: expected.branchId,
      branchRoot: expected.branchRoot,
      schemaHash: 'schema',
      schemaVersion: 1,
      userVersion: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    await manager.registerDatabase(poisoned);

    await expect(manager.calculateDatabaseInfo(expected)).rejects.toMatchObject({
      code: 'db_identity_mismatch',
    });
    await manager.close();
  });

  it('removes only named ownership records during logout cleanup', async () => {
    const manager = new DatabaseManager();
    await manager.initializeMetaDatabase();
    const first = await manager.calculateDatabaseInfo(identity('first'));
    const second = await manager.calculateDatabaseInfo(identity('second'));
    await manager.registerDatabase(first);
    await manager.registerDatabase(second);

    await manager.unregisterDatabases([first.name]);

    expect(await manager.getDatabaseInfo(first.name)).toBeNull();
    expect(await manager.getDatabaseInfo(second.name)).toEqual(second);
    await manager.close();
  });
});
