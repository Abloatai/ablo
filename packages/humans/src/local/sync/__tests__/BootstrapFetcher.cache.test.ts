import { BootstrapFetcher, type BootstrapData } from '../BootstrapFetcher.js';
import { Database } from '../../Database.js';
import { ModelRegistry } from '../../ModelRegistry.js';
import { registerTestModels } from '../../testing/index.js';

const full: BootstrapData = {
  type: 'full', lastSyncId: 100, timestamp: 1,
  models: { Item: [{ id: 'sample-item', title: 'yesterday' }, { id: 'deleted-item', title: 'deleted today' }] },
};
const partial: BootstrapData = { type: 'partial', lastSyncId: 101, timestamp: 2, deltas: [] };
const requirements = (lastSyncId: number) => ({
  type: 'full' as const, lastSyncId, modelsToLoad: ['Item'], syncGroups: [],
});

function response(data: BootstrapData): Response {
  return {
    ok: true, status: 200, headers: { get: () => null },
    json: () => Promise.resolve(data), text: () => Promise.resolve(JSON.stringify(data)),
  } as Response;
}

describe('bootstrap response cache and durable replica', () => {
  beforeEach(() => {
    localStorage.clear();
    globalThis.fetch = jest.fn().mockResolvedValue(response(full));
  });
  afterEach(() => {
    Object.defineProperty(navigator, 'onLine', { value: true });
    localStorage.clear();
    jest.restoreAllMocks();
  });

  function fetcher() {
    return new BootstrapFetcher({ baseUrl: 'https://example.test/api', cacheScope: 'sample', maxRetries: 1 });
  }

  it.each(['offline', 'network failure'] as const)('keeps a full snapshot available for a cold start after %s', async failure => {
    const helper = fetcher();
    await helper.fetchBootstrap();
    if (failure === 'offline') Object.defineProperty(navigator, 'onLine', { value: false });
    else jest.mocked(globalThis.fetch).mockRejectedValue(new TypeError('Network unavailable'));
    await expect(helper.fetchBootstrap(0)).resolves.toEqual(full);
  });

  it.each([99, 100, 101])('never substitutes the response cache for a warm replica at %s', async cursor => {
    const helper = fetcher();
    await helper.fetchBootstrap();
    jest.mocked(globalThis.fetch).mockRejectedValue(new TypeError('Network unavailable'));
    await expect(helper.fetchBootstrap(cursor)).rejects.toThrow();
    Object.defineProperty(navigator, 'onLine', { value: false });
    await expect(helper.fetchBootstrap(cursor)).rejects.toMatchObject({ code: 'bootstrap_offline_no_cache' });
  });

  it('does not replace a cached full snapshot with a partial response', async () => {
    const helper = fetcher();
    await helper.fetchBootstrap();
    jest.mocked(globalThis.fetch).mockResolvedValue(response(partial));
    await expect(helper.fetchBootstrap(100)).resolves.toEqual(partial);
    Object.defineProperty(navigator, 'onLine', { value: false });
    await expect(helper.fetchBootstrap()).resolves.toEqual(full);
  });

  it('does not restore legacy cached partial responses as a cold snapshot', async () => {
    const helper = fetcher();
    await helper.fetchBootstrap();
    const key = localStorage.key(0);
    if (!key) throw new Error('Missing bootstrap cache');
    localStorage.setItem(key, JSON.stringify(partial));
    Object.defineProperty(navigator, 'onLine', { value: false });
    await expect(helper.fetchBootstrap()).rejects.toMatchObject({ code: 'bootstrap_offline_no_cache' });
  });

  it('preserves a live update, a deletion, cursor and pending journal through a failed refresh and reopen', async () => {
    const registry = new ModelRegistry();
    registerTestModels(registry);
    const identity = {
      participantId: 'bootstrap-cache-user', participantKind: 'user' as const,
      organizationId: 'org', projectId: 'project', branchId: 'branch', branchRoot: false,
    };
    const create = () => new Database(registry, fetcher());
    let db = create();
    try {
      await db.open(identity);
      await db.bootstrapFromServer(requirements(0), []);
      // The journal shares the workspace but must survive snapshot refreshes.
      const store = db.getStore('Item');
      if (!store) throw new Error('Missing item store');
      await store.put({ id: 'deleted-item', title: 'removed today' });
      await db.processDeltaBatch([
        { syncId: 101, actionType: 'U', modelName: 'Item', modelId: 'sample-item', data: { title: 'today' } },
        { syncId: 102, actionType: 'D', modelName: 'Item', modelId: 'deleted-item' },
      ]);
      await db.saveTransaction({
        id: 'sample-pending-write', type: 'update', timestamp: 1,
        mutations: [{ type: 'update', modelName: 'Item', modelData: { id: 'sample-item', title: 'pending edit' }, timestamp: '2026-10-25T00:00:00Z' }],
      });
      const beforeJournal = await db.getPersistedTransactions();
      expect(beforeJournal).toHaveLength(1);
      jest.mocked(globalThis.fetch).mockRejectedValue(new TypeError('Network unavailable'));
      await expect(db.bootstrapFromServer(requirements(102), [])).rejects.toThrow();
      await db.close();
      db = create();
      await db.open(identity);
      expect(await db.getStore('Item')?.get('sample-item')).toMatchObject({ title: 'today' });
      expect(await db.getStore('Item')?.get('deleted-item')).toBeUndefined();
      expect(await db.getLastSyncId()).toBe(102);
      expect(await db.getPersistedTransactions()).toEqual(beforeJournal);
    } finally {
      await db.close();
    }
  });

  it.each(['full', 'partial'] as const)('rejects a delayed %s response behind the persisted cursor', async type => {
    const registry = new ModelRegistry();
    registerTestModels(registry);
    const helper = fetcher();
    const db = new Database(registry, helper, { inMemory: true });
    try {
      await db.open({ participantId: 'user', organizationId: 'org' });
      await db.getStore('Item')?.put({ id: 'sample-item', title: 'today' });
      await db.updateWorkspaceMetadata({ lastSyncId: 101 });
      jest.spyOn(helper, 'fetchBootstrap').mockResolvedValue({ ...full, type });
      await expect(db.bootstrapFromServer(requirements(100), [])).rejects.toMatchObject({ code: 'bootstrap_response_invalid' });
      expect(await db.getStore('Item')?.get('sample-item')).toMatchObject({ title: 'today' });
      expect(await db.getLastSyncId()).toBe(101);
    } finally {
      await db.close();
    }
  });
});
