import { z } from 'zod';
import { defineSchema } from '@abloatai/transaction/schema/schema';
import { model } from '@abloatai/transaction/schema/model';
import { ModelScope } from '@abloatai/transaction/types';
import { AbloConnectionError } from '@abloatai/transaction/errors';
import { durableCommitEnvelopeSchema } from '@abloatai/transaction/commit';
import { confirmedCommitAck } from '@abloatai/transaction/testing/fixtures/httpResponses';
import { Database } from '../../Database.js';
import { BootstrapFetcher } from '../../sync/BootstrapFetcher.js';
import { SyncClient } from '../../SyncClient.js';
import { createTestHarness } from '../../testing/helpers/syncEngineHarness.js';
import { waitFor } from '../../testing/helpers/wait.js';
import { registerModelsFromSchema } from '../modelRegistration.js';
import { createModelOperations } from '../createModelOperations.js';
import { deleteIDBWithTimeout } from '../../stores/openIDBWithTimeout.js';
import { persistenceDatabaseName } from '../../stores/persistenceIdentity.js';

const identity = {
  participantId: 'offline-journal-user', participantKind: 'user' as const,
  organizationId: 'org', projectId: 'project', branchId: 'production', branchRoot: true,
};

it.each([false, true])('offline fixed patch reports journal failure=%s', async rejectJournal => {
  const harness = createTestHarness();
  const schema = defineSchema({ slideLayers: model({
    plainText: z.string().nullish(), zIndex: z.number().default(0),
    position: z.object({ x: z.number(), y: z.number() }),
  }, { typename: 'SlideLayer', mutable: true, load: 'instant', lazyObservable: true }) });
  registerModelsFromSchema(schema, harness.registry);
  const database = new Database(harness.registry, new BootstrapFetcher({ baseUrl: 'https://example.test' }));
  const sync = new SyncClient(harness.pool, database);
  try {
    await database.open(identity);
    await sync.initialize(identity.participantId, identity.organizationId);
    const Layer = harness.registry.getModelByName('SlideLayer');
    if (!Layer) throw new Error('SlideLayer not registered');
    const layer = new Layer({ id: 'sample-layer', plainText: 'before', zIndex: 0, position: { x: 0, y: 0 } });
    layer.markAsPersisted();
    layer.clearChanges();
    harness.pool.add(layer, ModelScope.live);
    const layers = createModelOperations<{ id: string; plainText: string }, { plainText: string }>(
      'slideLayers', 'SlideLayer', harness.pool, sync, harness.registry,
      { fetch: () => Promise.resolve([]) },
    );
    harness.networkMonitor.goOffline();
    sync.disconnect();
    const dispatch = jest.spyOn(harness.mutationExecutor, 'commit').mockRejectedValue(
      new AbloConnectionError('WebSocket not connected', { code: 'ws_not_ready' }),
    );
    if (rejectJournal) {
      jest.spyOn(database, 'saveTransaction').mockRejectedValue(new DOMException('Journal quota exhausted', 'QuotaExceededError'));
    }
    const failures: unknown[] = [];
    sync.onMutationFailure(event => failures.push(event));
    const confirmation = layers.update({ id: layer.id, data: { plainText: 'offline edit' } });
    if (rejectJournal) {
      await expect(confirmation).rejects.toMatchObject({ message: 'Journal quota exhausted' });
      expect(await database.getPersistedTransactions()).toEqual([]);
      expect(dispatch).not.toHaveBeenCalled();
      expect(failures).toHaveLength(1);
      expect(sync.getMutationQueue().getStats()).toMatchObject({ pending: 0, failed: 1 });
      expect(layers.local.get(layer.id)?.plainText).toBe('before');
      return;
    }
    let settled = false;
    void confirmation.then(() => { settled = true; }, () => { settled = true; });
    expect(layers.local.get(layer.id)?.plainText).toBe('offline edit');
    await sync.syncNow();
    let rows = await database.getPersistedTransactions();
    for (let attempt = 0; rows.length === 0 && attempt < 30; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 10));
      rows = await database.getPersistedTransactions();
    }
    expect(rows.some(row => JSON.stringify(row).includes('sample-layer') && JSON.stringify(row).includes('offline edit'))).toBe(true);
    const envelope = durableCommitEnvelopeSchema.parse(rows.find(row => row.type === 'commit_envelope'));
    expect(envelope.operations[0]?.input).toEqual({ plainText: 'offline edit' });
    expect(settled).toBe(false);
    sync.dispose();
    await database.close();
    const reopened = new Database(harness.registry, new BootstrapFetcher({ baseUrl: 'https://example.test' }));
    const replay = new SyncClient(harness.pool, reopened);
    try {
      await reopened.open(identity);
      expect(await reopened.getPersistedTransactions()).toEqual(rows);
      const remote = { plainText: 'before', zIndex: 7 };
      dispatch.mockImplementation(operations => {
        const patch = operations.find(operation => operation.id === layer.id)?.input;
        if (patch) Object.assign(remote, patch);
        return Promise.resolve(confirmedCommitAck(42));
      });
      harness.networkMonitor.goOnline();
      await replay.initialize(identity.participantId, identity.organizationId);
      await waitFor(() => remote.plainText === 'offline edit');
      expect(remote.zIndex).toBe(7);
    } finally {
      replay.dispose();
      await reopened.close();
    }
  } finally {
    jest.restoreAllMocks();
    sync.dispose();
    await database.close();
    await deleteIDBWithTimeout(await persistenceDatabaseName(identity));
    await deleteIDBWithTimeout('ablo_databases');
    harness.cleanup();
  }
});
