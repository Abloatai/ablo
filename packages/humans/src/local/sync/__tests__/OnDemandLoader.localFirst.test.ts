import { z } from 'zod';
import { ModelRegistry, setActiveRegistry, clearActiveRegistry } from '../../ModelRegistry.js';
import { InstanceCache } from '../../InstanceCache.js';
import { Model } from '../../Model.js';
import { LoadStrategy, ModelScope } from '@abloatai/transaction/types';
import { defineSchema } from '@abloatai/transaction/schema/schema';
import { model } from '@abloatai/transaction/schema/model';
import { field } from '@abloatai/transaction/schema/field';
import { registerModelsFromSchema } from '../../client/modelRegistration.js';
import { OnDemandLoader } from '../OnDemandLoader.js';
import { ObjectStore } from '../../stores/ObjectStore.js';
import { Database } from '../../Database.js';
import { BootstrapFetcher } from '../BootstrapFetcher.js';
import { InMemoryObjectStore } from '../../adapters/inMemoryStorage.js';
import type { ObjectStoreContract } from '../../stores/ObjectStoreContract.js';
import * as queryClient from '../../query/client.js';

jest.mock('../../query/client.js', () => ({
  postQuery: jest.fn(),
}));

const postQueryMock = queryClient.postQuery as jest.MockedFunction<typeof queryClient.postQuery>;

class EntryModel extends Model {
  sessionId = '';
  position = 0;
  text = '';
  constructor(data: Partial<Model> & { sessionId?: string; position?: number; text?: string } = {}) {
    super(data);
    this.sessionId = data.sessionId ?? '';
    this.position = data.position ?? 0;
    this.text = data.text ?? '';
  }
  override getModelName(): string {
    return 'Entry';
  }
}

describe('Client IDB indexes & local-first query correctness (S4/S5/S6, CS1/CS2/CS5)', () => {
  afterEach(() => {
    clearActiveRegistry();
    postQueryMock.mockReset();
  });

  it('S4/S5: registers field.indexed() as an IDB index and includes fields/indexes in getSchemaHash()', () => {
    const unindexedSchema = defineSchema({
      entries: model({ sessionId: z.string(), position: z.number() }, { typename: 'Entry', load: 'lazy' }),
    });
    const indexedSchema = defineSchema({
      entries: model(
        { sessionId: field.string().indexed(), position: z.number() },
        { typename: 'Entry', load: 'lazy' },
      ),
    });

    const regA = new ModelRegistry({ validateOnRegister: false, allowLateReferences: true });
    registerModelsFromSchema(unindexedSchema, regA);
    expect(regA.getIndexedProperties('Entry')).toEqual([]);

    const regB = new ModelRegistry({ validateOnRegister: false, allowLateReferences: true });
    registerModelsFromSchema(indexedSchema, regB);
    expect(regB.getIndexedProperties('Entry')).toContain('sessionId');
    expect(regB.getSchemaHash()).not.toBe(regA.getSchemaHash());
  });

  it('S6: StoreManager adds missing indexes on existing stores during version upgrade and ObjectStore rejects on missing index', async () => {
    const schemaV1 = defineSchema({
      entries: model({ sessionId: z.string(), position: z.number() }, { typename: 'Entry', load: 'lazy' }),
    });
    const schemaV2 = defineSchema({
      entries: model(
        { sessionId: field.string().indexed(), position: z.number() },
        { typename: 'Entry', load: 'lazy' },
      ),
    });

    const identity = {
      participantId: `idx-upgrade-${Date.now()}`,
      participantKind: 'user' as const,
      organizationId: 'org',
      projectId: 'project',
      branchId: 'branch',
      branchRoot: false,
    };

    const reg1 = new ModelRegistry({ validateOnRegister: false, allowLateReferences: true });
    registerModelsFromSchema(schemaV1, reg1);
    setActiveRegistry(reg1);
    const db1 = new Database(reg1, new BootstrapFetcher({ baseUrl: 'http://sync.test/api' }));
    try {
      await db1.open(identity);
      const store1 = db1.getStore('Entry') as ObjectStore;
      await store1.put({ id: 'e1', sessionId: 's1', position: 1 });
      // Missing index must reject (so OnDemandLoader falls back to scan), never silently resolve [].
      await expect(store1.getAllFromIndex('sessionId', 's1')).rejects.toThrow();
    } finally {
      await db1.close();
    }

    const reg2 = new ModelRegistry({ validateOnRegister: false, allowLateReferences: true });
    registerModelsFromSchema(schemaV2, reg2);
    setActiveRegistry(reg2);
    const db2 = new Database(reg2, new BootstrapFetcher({ baseUrl: 'http://sync.test/api' }));
    try {
      await db2.open(identity);
      const store2 = db2.getStore('Entry') as ObjectStore;
      const rows = await store2.getAllFromIndex('sessionId', 's1');
      expect(rows).toEqual([expect.objectContaining({ id: 'e1', sessionId: 's1', position: 1 })]);
    } finally {
      await db2.close();
    }
  });

  it('CS1 + CS2: readLocal merges pool over IDB (1 live row never hides cached IDB rows) and applies orderBy before limit', async () => {
    const schema = defineSchema({
      entries: model(
        { sessionId: field.string().indexed(), position: z.number(), text: z.string() },
        { typename: 'Entry', load: 'lazy' },
      ),
    });
    const registry = new ModelRegistry({ validateOnRegister: false, allowLateReferences: true });
    registerModelsFromSchema(schema, registry);
    setActiveRegistry(registry);

    const store = new InMemoryObjectStore('Entry', 'Entry');
    await store.put({ id: 'e1', sessionId: 's1', position: 1, text: 'first' });
    await store.put({ id: 'e2', sessionId: 's1', position: 2, text: 'stale-in-idb' });
    await store.put({ id: 'e3', sessionId: 's1', position: 3, text: 'third' });
    await store.put({ id: 'e4', sessionId: 's1', position: 4, text: 'fourth' });

    const pool = new InstanceCache({ maxSize: 100 }, registry);
    // Simulate 1 live delta landing in the pool before the user opens chat s1.
    const liveRow = pool.createFromData({
      __typename: 'Entry',
      id: 'e2',
      sessionId: 's1',
      position: 2,
      text: 'fresh-in-pool',
    }) as EntryModel;
    pool.add(liveRow, ModelScope.live);

    postQueryMock.mockResolvedValue({ results: [[]] });

    const loader = new OnDemandLoader({
      objectPool: pool,
      database: { getStore: () => store },
      registry,
      schema,
      baseUrl: 'http://sync.test/api',
      position: { readFloor: 10 },
    });

    const newestTwo = (await loader.fetch('entries', {
      where: { sessionId: 's1' },
      orderBy: { position: 'desc' },
      limit: 2,
    })) as EntryModel[];

    // Must return the 2 highest-position rows from IDB (positions 4 & 3), not just the 1 pool row.
    expect(newestTwo.map((r) => r.id)).toEqual(['e4', 'e3']);

    // Pool version wins over stale IDB copy when e2 is inside the window.
    const allDesc = (await loader.fetch('entries', {
      where: { sessionId: 's1' },
      orderBy: { position: 'desc' },
      limit: 4,
    })) as EntryModel[];
    expect(allDesc.map((r) => [r.id, r.text])).toEqual([
      ['e4', 'fourth'],
      ['e3', 'third'],
      ['e2', 'fresh-in-pool'],
      ['e1', 'first'],
    ]);
  });

  it('S6 fallback: scanIdb falls back to getAll() when getAllFromIndex rejects on a missing index', async () => {
    const schema = defineSchema({
      entries: model(
        { sessionId: field.string().indexed(), position: z.number(), text: z.string() },
        { typename: 'Entry', load: 'lazy' },
      ),
    });
    const registry = new ModelRegistry({ validateOnRegister: false, allowLateReferences: true });
    registerModelsFromSchema(schema, registry);
    setActiveRegistry(registry);

    const backing = new InMemoryObjectStore('Entry', 'Entry');
    await backing.put({ id: 'e1', sessionId: 's1', position: 1, text: 'from-scan' });
    const missingIndexStore: ObjectStoreContract = {
      get: (id) => backing.get(id),
      getMany: (ids) => backing.getMany(ids),
      getAll: () => backing.getAll(),
      put: (data) => backing.put(data),
      putMany: (rows) => backing.putMany(rows),
      delete: (id) => backing.delete(id),
      clear: () => backing.clear(),
      count: () => backing.count(),
      markAsClosing: () => backing.markAsClosing(),
      getAllFromIndex: jest.fn(() => Promise.reject(new DOMException('Index not found', 'NotFoundError'))),
    };

    postQueryMock.mockResolvedValue({ results: [[]] });
    const pool = new InstanceCache({ maxSize: 100 }, registry);
    const loader = new OnDemandLoader({
      objectPool: pool,
      database: { getStore: () => missingIndexStore },
      registry,
      schema,
      baseUrl: 'http://sync.test/api',
      position: { readFloor: 1 },
    });

    const rows = (await loader.fetch('entries', { where: { sessionId: 's1' } })) as EntryModel[];
    expect(missingIndexStore.getAllFromIndex).toHaveBeenCalledWith('sessionId', 's1');
    expect(rows.map((r) => r.id)).toEqual(['e1']);
  });

  it('CS5: query errors reject instead of confirming an empty result in hydratedKeys', async () => {
    const registry = new ModelRegistry({ validateOnRegister: false, allowLateReferences: true });
    registry.registerModel('Entry', EntryModel, { loadStrategy: LoadStrategy.lazy });
    setActiveRegistry(registry);

    const store = new InMemoryObjectStore('Entry', 'Entry');
    const pool = new InstanceCache({ maxSize: 100 }, registry);
    const loader = new OnDemandLoader({
      objectPool: pool,
      database: { getStore: () => store },
      registry,
      schema: defineSchema({
        entries: model(
          { sessionId: z.string(), position: z.number(), text: z.string() },
          { typename: 'Entry', load: 'lazy' },
        ),
      }),
      baseUrl: 'http://sync.test/api',
      position: { readFloor: 1 },
    });

    postQueryMock.mockResolvedValueOnce({
      results: [[]],
      errors: [{
        index: 0,
        model: 'Entry',
        type: 'AbloServerError',
        code: 'internal_error',
        message: 'temporary query failure',
        event_id: 'evt_1',
      }],
    });

    await expect(loader.fetch('entries', { where: { sessionId: 's2' } })).rejects.toThrow('temporary query failure');

    // A retry must hit the network again (the failed query was NOT cached as confirmed-empty).
    postQueryMock.mockResolvedValueOnce({
      results: [[{ id: 'e9', sessionId: 's2', position: 1, text: 'recovered' }]],
    });

    const rows = (await loader.fetch('entries', { where: { sessionId: 's2' } })) as EntryModel[];
    expect(rows.map((r) => r.id)).toEqual(['e9']);
    expect(postQueryMock).toHaveBeenCalledTimes(2);
  });
});
