import { Database } from '../../Database.js';
import { Model } from '../../Model.js';
import { ModelRegistry, setActiveRegistry } from '../../ModelRegistry.js';
import { BootstrapFetcher } from '../../sync/BootstrapFetcher.js';
import { LoadStrategy } from '@abloatai/transaction/types';
import { deleteIDBWithTimeout } from '../openIDBWithTimeout.js';
import {
  persistenceDatabaseName,
  type PersistenceIdentity,
} from '../persistenceIdentity.js';

class Note extends Model {
  override getModelName() {
    return 'Note';
  }
}

const makeIdentity = (
  participantId: string,
  overrides: Partial<PersistenceIdentity> = {},
): PersistenceIdentity => ({
  participantId,
  participantKind: 'user',
  organizationId: 'org-1',
  projectId: 'proj-1',
  branchId: 'br_main',
  branchRoot: true,
  syncGroups: ['org:org-1', `user:${participantId}`],
  operations: ['notes.read', 'notes.write'],
  ...overrides,
});

describe('Optimistic pre-auth database open (ready-before-mint)', () => {
  const createdDbNames = new Set<string>();
  const openDbs: Database[] = [];

  afterEach(async () => {
    await Promise.all(openDbs.map((db) => db.close()));
    openDbs.length = 0;
    await Promise.all(
      [...createdDbNames, 'ablo_databases'].map((name) => deleteIDBWithTimeout(name)),
    );
    createdDbNames.clear();
  });

  function setupRegistry(): ModelRegistry {
    const registry = new ModelRegistry({ validateOnRegister: false });
    registry.registerModel('Note', Note, { loadStrategy: LoadStrategy.instant });
    setActiveRegistry(registry);
    return registry;
  }

  it('opens the unique single-owner local replica optimistically and promotes it on matching identity', async () => {
    const registry = setupRegistry();
    const userA = makeIdentity('user-a');
    createdDbNames.add(await persistenceDatabaseName(userA));

    const first = new Database(registry, new BootstrapFetcher({ baseUrl: 'https://api.example.test' }));
    openDbs.push(first);
    await first.open(userA);
    await first.putRecord('Note', 'n1', { id: 'n1', body: 'cached before auth' });
    await first.close();

    const warm = new Database(registry, new BootstrapFetcher({ baseUrl: 'https://api.example.test' }));
    openDbs.push(warm);
    await warm.warmMetaDatabase();

    const candidate = await warm.openOptimistic({
      projectId: 'proj-1',
      branchId: 'br_main',
      participantKind: 'user',
    });
    expect(candidate?.userId).toBe('user-a');
    expect(warm.isOptimisticOpen()).toBe(true);
    expect(warm.matchesOptimisticIdentity(userA)).toBe(true);
    expect(await warm.hydrateModels('Note')).toEqual([{ id: 'n1', body: 'cached before auth' }]);

    // Promote on matching verified identity without reopening
    await warm.open(userA);
    expect(warm.isOptimisticOpen()).toBe(false);
    expect(warm.isOpen()).toBe(true);
    expect(await warm.hydrateModels('Note')).toEqual([{ id: 'n1', body: 'cached before auth' }]);
  });

  it('replaces the optimistic replica when verified identity belongs to a different user', async () => {
    const registry = setupRegistry();
    const userA = makeIdentity('user-a');
    const userB = makeIdentity('user-b');
    createdDbNames.add(await persistenceDatabaseName(userA));
    createdDbNames.add(await persistenceDatabaseName(userB));

    const first = new Database(registry, new BootstrapFetcher({ baseUrl: 'https://api.example.test' }));
    openDbs.push(first);
    await first.open(userA);
    await first.putRecord('Note', 'a-secret', { id: 'a-secret', body: 'User A private' });
    await first.close();

    const next = new Database(registry, new BootstrapFetcher({ baseUrl: 'https://api.example.test' }));
    openDbs.push(next);
    const candidate = await next.openOptimistic({
      projectId: 'proj-1',
      branchId: 'br_main',
      participantKind: 'user',
    });
    expect(candidate?.userId).toBe('user-a');
    expect(next.matchesOptimisticIdentity(userB)).toBe(false);

    // Verified identity is User B: must close User A's optimistic DB and open User B's empty plane
    await next.open(userB);
    expect(next.isOptimisticOpen()).toBe(false);
    expect(await next.hydrateModels('Note')).toEqual([]);
  });

  it('refuses to open optimistically when multiple users share the same browser profile for the scope', async () => {
    const registry = setupRegistry();
    const userA = makeIdentity('user-a');
    const userB = makeIdentity('user-b');
    createdDbNames.add(await persistenceDatabaseName(userA));
    createdDbNames.add(await persistenceDatabaseName(userB));

    for (const scope of [userA, userB]) {
      const db = new Database(registry, new BootstrapFetcher({ baseUrl: 'https://api.example.test' }));
      openDbs.push(db);
      await db.open(scope);
      await db.close();
    }

    const probe = new Database(registry, new BootstrapFetcher({ baseUrl: 'https://api.example.test' }));
    openDbs.push(probe);
    const candidate = await probe.openOptimistic({
      projectId: 'proj-1',
      branchId: 'br_main',
      participantKind: 'user',
    });
    expect(candidate).toBeNull();
    expect(probe.isOptimisticOpen()).toBe(false);
  });

  it('still rejects widened persisted syncGroups during optimistic promotion', async () => {
    const registry = setupRegistry();
    const userA = makeIdentity('user-a', { syncGroups: ['org:org-1'] });
    createdDbNames.add(await persistenceDatabaseName(userA));

    const first = new Database(registry, new BootstrapFetcher({ baseUrl: 'https://api.example.test' }));
    openDbs.push(first);
    await first.open(userA);
    await first.updateWorkspaceMetadata({ subscribedSyncGroups: ['org:org-1', 'org:revoked'] });
    await first.close();

    const warm = new Database(registry, new BootstrapFetcher({ baseUrl: 'https://api.example.test' }));
    openDbs.push(warm);
    expect(await warm.openOptimistic({ projectId: 'proj-1', branchId: 'br_main', participantKind: 'user' })).not.toBeNull();

    await expect(warm.open(userA)).rejects.toMatchObject({ code: 'db_identity_mismatch' });
    expect(warm.isOpen()).toBe(false);
    expect(warm.isOptimisticOpen()).toBe(false);
  });
});
