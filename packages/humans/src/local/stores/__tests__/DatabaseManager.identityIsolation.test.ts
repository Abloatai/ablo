import { Database } from '../../Database.js';
import { Model } from '../../Model.js';
import { ModelRegistry } from '../../ModelRegistry.js';
import { BootstrapFetcher } from '../../sync/BootstrapFetcher.js';
import { LoadStrategy } from '@abloatai/transaction/types';
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
    expect(aa).toMatch(/^ablo_v5_[0-9a-f]{64}$/);
    expect(bb).toMatch(/^ablo_v5_[0-9a-f]{64}$/);
  });

  it('includes every authenticated branch axis in the namespace', async () => {
    const base = identity('user');
    const names = await Promise.all([
      persistenceDatabaseName(base),
      persistenceDatabaseName({ ...base, participantKind: 'agent' }),
      persistenceDatabaseName({ ...base, syncGroups: ['account:a'] }),
      persistenceDatabaseName({ ...base, operations: ['records.read'] }),
      persistenceDatabaseName({ ...base, organizationId: 'other-org' }),
      persistenceDatabaseName({ ...base, projectId: 'other-project' }),
      persistenceDatabaseName({ ...base, branchId: 'br_feature', branchRoot: false }),
    ]);

    expect(new Set(names).size).toBe(names.length);
  });

  it('canonicalizes group and operation sets without combining different authorities', async () => {
    const base = identity('user', { syncGroups: ['a', 'b'], operations: ['read', 'write'] });
    expect(await persistenceDatabaseName(base)).toBe(await persistenceDatabaseName({
      ...base, syncGroups: ['b', 'a', 'a'], operations: ['write', 'read', 'read'],
    }));
    expect(await persistenceDatabaseName(base)).not.toBe(await persistenceDatabaseName({
      ...base, operations: ['read'],
    }));
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

class Item extends Model {
  override getModelName() { return 'Item'; }
}

it('restores the same authority but never another account group or narrower permissions', async () => {
  const registry = new ModelRegistry({ validateOnRegister: false });
  registry.registerModel('Item', Item, { loadStrategy: LoadStrategy.instant });
  const databases: Database[] = [];
  const names = new Set<string>();
  const open = async (scope: PersistenceIdentity) => {
    const database = new Database(registry, new BootstrapFetcher({ baseUrl: 'https://api.example.com' }));
    databases.push(database);
    names.add(await persistenceDatabaseName(scope));
    await database.open(scope);
    return database;
  };
  const accountA = identity('user', { syncGroups: ['account:a'], operations: ['items.read', 'items.write'] });
  try {
    const first = await open(accountA);
    await first.putRecord('Item', 'private', { id: 'private', title: 'Account A only' });
    await first.close();
    const warm = await open(accountA);
    expect(await warm.hydrateModels('Item')).toEqual([{ id: 'private', title: 'Account A only' }]);
    await warm.close();
    for (const scope of [
      { ...accountA, syncGroups: ['account:b'] },
      { ...accountA, operations: ['items.read'] },
    ]) {
      const other = await open(scope);
      expect(await other.hydrateModels('Item')).toEqual([]);
      await other.close();
    }
    const widened = await open(accountA);
    await widened.updateWorkspaceMetadata({ subscribedSyncGroups: ['account:a', 'account:b'] });
    await widened.close();
    await expect(open(accountA)).rejects.toMatchObject({ code: 'db_identity_mismatch' });
  } finally {
    await Promise.all(databases.map(database => database.close()));
    await Promise.all([...names, 'ablo_databases'].map(name => deleteIDBWithTimeout(name)));
  }
});
