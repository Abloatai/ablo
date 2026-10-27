/**
 * The collaborators a `BaseSyncedStore` is constructed from, all real: an
 * in-memory database, a pool, a sync client and an unconnected socket. A test
 * spies on the calls it cares about instead of building a store shell around
 * the constructor and writing its private fields.
 */

import { Database } from '../../Database.js';
import { InstanceCache } from '../../InstanceCache.js';
import { ModelRegistry } from '../../ModelRegistry.js';
import { SyncClient } from '../../SyncClient.js';
import { BootstrapFetcher } from '../../sync/BootstrapFetcher.js';
import { SyncWebSocket } from '../../sync/SyncWebSocket.js';

export function storeDependencies(url = 'http://sync.test') {
  const modelRegistry = new ModelRegistry();
  const objectPool = new InstanceCache({ maxSize: 100, gcInterval: 0, useWeakRefs: false }, modelRegistry);
  const database = new Database(modelRegistry, new BootstrapFetcher({ baseUrl: `${url}/api` }), { inMemory: true });
  const syncClient = new SyncClient(objectPool, database);
  const syncWebSocket = new SyncWebSocket({ baseUrl: url, userId: 'u', organizationId: 'org_1', syncGroups: [] });
  return { modelRegistry, objectPool, database, syncClient, syncWebSocket, url };
}
