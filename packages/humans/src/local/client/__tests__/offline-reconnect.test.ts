import { z } from 'zod';
import { defineSchema } from '@abloatai/transaction/schema/schema';
import { model } from '@abloatai/transaction/schema/model';
import { ModelScope } from '@abloatai/transaction/types';
import { AbloConnectionError } from '@abloatai/transaction/errors';
import { confirmedCommitAck } from '@abloatai/transaction/testing/fixtures/httpResponses';
import { Database } from '../../Database.js';
import { BootstrapFetcher } from '../../sync/BootstrapFetcher.js';
import { SyncClient } from '../../SyncClient.js';
import { createTestHarness } from '../../testing/helpers/syncEngineHarness.js';
import { MockMutationExecutor } from '../../testing/mocks/MockMutationExecutor.js';
import { registerModelsFromSchema } from '../modelRegistration.js';
import { createModelOperations } from '../createModelOperations.js';
import { deleteIDBWithTimeout } from '../../stores/openIDBWithTimeout.js';
import { persistenceDatabaseName } from '../../stores/persistenceIdentity.js';
import type { MutationOperation } from '../../interfaces/index.js';
import type { SyncDelta } from '../../sync/SyncWebSocket.js';

const identity = {
  participantId: 'offline-reconnect-user', participantKind: 'user' as const,
  organizationId: 'org', projectId: 'project', branchId: 'production', branchRoot: true,
};

async function waitForJournal(database: Database, check: (rows: Awaited<ReturnType<Database['getPersistedTransactions']>>) => boolean) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (check(await database.getPersistedTransactions())) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Journal did not reach the expected state');
}

it.each(['before', 'after'])('reconciles ten offline patches with catch-up %s the ack and retains the remote edit', async catchupTiming => {
  const harness = createTestHarness();
  const schema = defineSchema({ slideLayers: model({
    plainText: z.string(), zIndex: z.number(),
  }, { typename: 'SlideLayer', mutable: true, load: 'instant', lazyObservable: true }) });
  registerModelsFromSchema(schema, harness.registry);
  const remote = { id: 'sample-layer', plainText: 'before', zIndex: 0 };
  const echoes: SyncDelta[] = [];
  let offline = true;
  let position = 1;
  class Server extends MockMutationExecutor {
    override commit(operations: MutationOperation[]) {
      if (offline) return Promise.reject(new AbloConnectionError('Offline', { code: 'ws_not_ready' }));
      for (const operation of operations) {
        Object.assign(remote, operation.input);
        echoes.push({ id: ++position, actionType: 'U', modelName: 'SlideLayer',
          modelId: remote.id, data: { ...remote }, transactionId: operation.transactionId });
      }
      return Promise.resolve(confirmedCommitAck(position));
    }
  }
  const runtime = { ...harness.context.context, mutationExecutor: new Server() };
  const database = new Database(harness.registry, new BootstrapFetcher({ baseUrl: 'https://example.test' }));
  const sync = new SyncClient(harness.pool, database, undefined, 'default', runtime);
  const failures: unknown[] = [];
  sync.onMutationFailure(event => failures.push(event));
  try {
    await database.open(identity);
    await sync.initialize(identity.participantId, identity.organizationId);
    await database.putRecord('SlideLayer', remote.id, remote);
    const Layer = harness.registry.getModelByName('SlideLayer');
    if (!Layer) throw new Error('SlideLayer not registered');
    const layer = new Layer(remote);
    layer.markAsPersisted();
    harness.pool.add(layer, ModelScope.live);
    const layers = createModelOperations<{ id: string; plainText: string; zIndex: number }, { plainText: string }>(
      'slideLayers', 'SlideLayer', harness.pool, sync, harness.registry,
      { fetch: () => Promise.resolve([]) },
    );
    harness.networkMonitor.goOffline();
    sync.disconnect();
    for (let index = 0; index < 10; index++) {
      void layers.update({ id: remote.id, data: { plainText: `edit ${index + 1}` } })
        .catch((error: unknown) => failures.push(error));
    }
    await waitForJournal(database, rows => rows.some(row => JSON.stringify(row).includes('edit 10')));
    expect(remote.plainText).toBe('before');
    expect(layers.local.get(remote.id)?.plainText).toBe('edit 10');

    remote.zIndex = 7;
    const catchup: SyncDelta = { id: ++position, actionType: 'U', modelName: 'SlideLayer',
      modelId: remote.id, data: { ...remote }, transactionId: 'independent-http-writer' };
    const apply = async (deltas: SyncDelta[]) => {
      const result = await database.processDeltaBatch(deltas.map(delta => ({
        ...delta, syncId: delta.id,
      })));
      sync.applyDeltaBatchToPool(result.results, (_name, data) => data);
    };
    // Reconnect catch-up and commit acknowledgements arrive on independent channels.
    if (catchupTiming === 'before') {
      await apply([catchup]);
      expect(layers.local.get(remote.id)).toMatchObject({ plainText: 'edit 10', zIndex: 7 });
    }
    offline = false;
    harness.networkMonitor.goOnline();
    sync.markConnected();
    await sync.processPendingMutations();
    if (catchupTiming === 'after') await apply([catchup]);
    await apply(echoes);
    await waitForJournal(database, rows => rows.length === 0);
    expect(sync.getMutationQueue().getStats()).toMatchObject({ pending: 0, failed: 0 });
    expect(failures).toEqual([]);
    expect(remote).toMatchObject({ plainText: 'edit 10', zIndex: 7 });
    expect(layers.local.get(remote.id)).toMatchObject({ plainText: 'edit 10', zIndex: 7 });
  } finally {
    sync.dispose();
    await database.close();
    await deleteIDBWithTimeout(await persistenceDatabaseName(identity));
    await deleteIDBWithTimeout('ablo_databases');
    harness.cleanup();
  }
});
