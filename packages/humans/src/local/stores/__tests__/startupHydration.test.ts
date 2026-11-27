import { z } from 'zod';
import { isObservableObject } from 'mobx';
import { ModelRegistry, setActiveRegistry, clearActiveRegistry } from '../../ModelRegistry.js';
import { registerModelsFromSchema } from '../../client/modelRegistration.js';
import { Database } from '../../Database.js';
import { BootstrapFetcher } from '../../sync/BootstrapFetcher.js';
import { InstanceCache } from '../../InstanceCache.js';
import { SyncClient } from '../../SyncClient.js';
import { defineSchema } from '@abloatai/transaction/schema/schema';
import { model } from '@abloatai/transaction/schema/model';
import { deleteIDBWithTimeout } from '../openIDBWithTimeout.js';

describe('Startup hydration & bootstrap batching (S7/S8/S9)', () => {
  afterEach(async () => {
    clearActiveRegistry();
    await deleteIDBWithTimeout('ablo_databases');
  });

  it('S7/S8/S9: batches full bootstrap with putMany, detects data past store #3, and hydrates instant models in one batch with deferred observability', async () => {
    const schema = defineSchema({
      a: model({ title: z.string() }, { typename: 'ModelA', load: 'instant' }),
      b: model({ title: z.string() }, { typename: 'ModelB', load: 'instant' }),
      c: model({ title: z.string() }, { typename: 'ModelC', load: 'instant' }),
      d: model({ title: z.string() }, { typename: 'ModelD', load: 'instant' }),
    });

    const registry = new ModelRegistry({ validateOnRegister: false, allowLateReferences: true });
    registerModelsFromSchema(schema, registry);
    setActiveRegistry(registry);

    const fetcher = new BootstrapFetcher({ baseUrl: 'http://sync.test/api' });
    jest.spyOn(fetcher, 'fetchBootstrap').mockResolvedValue({
      type: 'full',
      lastSyncId: 50,
      timestamp: Date.now(),
      models: {
        // Leave the first 3 stores empty; populate only the 4th store to verify S8.
        ModelA: [],
        ModelB: [],
        ModelC: [],
        ModelD: Array.from({ length: 25 }, (_, i) => ({ id: `d-${i}`, title: `Row ${i}` })),
      },
    });

    const identity = {
      participantId: `startup-opt-${Date.now()}`,
      participantKind: 'user' as const,
      organizationId: 'org',
      projectId: 'project',
      branchId: 'branch',
      branchRoot: true,
    };

    const db = new Database(registry, fetcher);
    try {
      await db.open(identity);
      const putManySpy = jest.spyOn(db.getStore('ModelD')!, 'putMany');
      await db.bootstrapFromServer(
        { type: 'full', lastSyncId: 0, modelsToLoad: ['ModelA', 'ModelB', 'ModelC', 'ModelD'], syncGroups: [] },
        [],
      );
      // S9: full bootstrap writes all 25 rows via one putMany transaction instead of 25 puts.
      expect(putManySpy).toHaveBeenCalledTimes(1);

      // S8: requiredBootstrap recognizes data in the 4th store (past the old 3-store sample).
      const req = await db.requiredBootstrap();
      expect(req.lastSyncId).toBe(50);

      // S7: hydrateModelBatch reads all 4 stores in one readonly transaction.
      const batch = await db.hydrateModelBatch(['ModelA', 'ModelB', 'ModelC', 'ModelD']);
      expect(batch.get('ModelD')).toHaveLength(25);

      // S7: SyncClient hydrates cold models (deferred observability) until read.
      const pool = new InstanceCache({ maxSize: 1000 }, registry);
      const syncClient = new SyncClient(pool, db);
      await syncClient.hydrateFromDatabase();
      expect(pool.size).toBe(25);
      // Reading through pool.get activates observability on demand.
      const activated = pool.get('d-0');
      expect(activated).toBeDefined();
      expect(isObservableObject(activated)).toBe(true);
    } finally {
      await db.close();
    }
  });
});
