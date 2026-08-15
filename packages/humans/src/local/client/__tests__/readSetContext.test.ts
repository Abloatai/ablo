import {
  capturePointRead,
  createReadSetContext,
  consumeReadSet,
  prepareReadSet,
} from '@abloatai/transaction/internal/read-set';
import { LoadStrategy, ModelScope } from '@abloatai/transaction/types';
import { InstanceCache } from '../../InstanceCache.js';
import { Model } from '../../Model.js';
import { ModelRegistry } from '../../ModelRegistry.js';
import type { SyncClient } from '../../SyncClient.js';
import type { OnDemandLoader } from '../../sync/OnDemandLoader.js';
import {
  createModelProxy,
  type ModelCollaboration,
} from '../createModelProxy.js';
import { createSnapshot } from '../../sync/createSnapshot.js';
import { createDefaultMutationExecutor } from '../wsMutationExecutor.js';
import type { CommitRecord } from '@abloatai/transaction/wire/commit';
import { EFFECTIVE_AUTHORITY_FIXTURE } from '@abloatai/transaction/testing/fixtures/httpResponses';

interface ItemRow {
  id: string;
  title: string;
  status: string;
}

class ItemModel extends Model {
  constructor(data?: Record<string, unknown>) {
    super(data);
    Object.assign(this, data);
  }

  override getModelName(): string {
    return 'Item';
  }
}

describe('reactive/WebSocket ReadSet context', () => {
  it('correlates an exact WebSocket request and receipt as one commit record', async () => {
    const records: CommitRecord[] = [];
    const context = createReadSetContext({
      onCommitRecord: (record) => records.push(record),
    });
    const sendCommitReceipt = jest.fn((
      _operations: unknown,
      clientTxId: string,
    ) => Promise.resolve({
      object: 'commit_receipt' as const,
      clientTxId,
      serverTxId: 'server-ws-record',
      createdAt: '2026-08-05T10:00:00.000Z',
      success: true as const,
      authority: EFFECTIVE_AUTHORITY_FIXTURE,
      status: 'confirmed' as const,
      statusAt: '2026-08-05T10:00:00.058Z',
      correlationId: 'corr-ws-record',
      lastSyncId: 55,
      ops: 1,
    }));
    const executor = createDefaultMutationExecutor(
      () => ({ sendCommit: jest.fn(), sendCommitReceipt }),
      context,
    );

    const identity = {};
    capturePointRead(context, identity, 'items', 'item-1', { id: 'item-1' }, 54);
    const prepared = prepareReadSet(
      context,
      identity,
      undefined,
      'reject',
      undefined,
      undefined,
    );
    await executor.commit([{
      type: 'UPDATE', model: 'items', id: 'item-1',
      input: { status: 'done' }, readAt: 54, onStale: 'reject',
    }], {
      idempotencyKey: 'attempt-ws-record',
      reads: [{ model: 'runs', id: 'run-1', readAt: 53 }],
    });
    consumeReadSet(context, identity, prepared.consumed, prepared.automaticCommit);

    expect(records).toEqual([expect.objectContaining({
      id: 'attempt-ws-record',
      attempts: [expect.objectContaining({
        id: 'attempt-ws-record',
        kind: 'execution',
        transport: 'websocket',
      }) as CommitRecord['attempts'][number]],
      status: 'confirmed',
      correlationId: 'corr-ws-record',
      lastSyncId: 55,
      operations: [expect.objectContaining({
        action: 'update', model: 'items', id: 'item-1', readAt: 54,
      }) as CommitRecord['operations'][number]],
      readSet: expect.arrayContaining([
        expect.objectContaining({ watermark: 53 }) as CommitRecord['readSet'][number],
        expect.objectContaining({ watermark: 54 }) as CommitRecord['readSet'][number],
      ]) as CommitRecord['readSet'],
    })]);
  });

  it('carries explicitly supplied row evidence into the mutation queue', async () => {
    const registry = new ModelRegistry({
      validateOnRegister: false,
      allowLateReferences: true,
    });
    registry.registerModel('Item', ItemModel, { loadStrategy: LoadStrategy.instant });
    for (const property of ['title', 'status']) {
      registry.registerProperty('Item', property, {
        type: 'property' as never,
        indexed: false,
        optional: false,
      });
    }
    const pool = new InstanceCache({ maxSize: 100 }, registry);
    const model = new ItemModel({ id: 'item-1', title: 'Queued', status: 'todo' });
    pool.add(model, ModelScope.live);

    let updateOptions: Record<string, unknown> | undefined;
    const syncClient: Pick<
      SyncClient,
      | 'add'
      | 'delete'
      | 'getMutationQueue'
      | 'getOrganizationId'
      | 'syncNow'
      | 'update'
      | 'waitForConfirmation'
    > = {
      add: jest.fn(),
      delete: jest.fn(),
      getMutationQueue: jest.fn(() => { throw new Error('not used'); }),
      getOrganizationId: jest.fn(() => undefined),
      syncNow: jest.fn(() => Promise.resolve(undefined)),
      update: jest.fn((_model, options) => { updateOptions = options; }),
      waitForConfirmation: jest.fn(() => Promise.resolve(undefined)),
    };
    const hydration: Pick<OnDemandLoader, 'fetch' | 'getReadEvidence'> = {
      fetch: jest.fn(() => Promise.resolve([model])),
      getReadEvidence: jest.fn(() => 42),
    };
    const collaboration: ModelCollaboration = {
      readPoint: jest.fn((_model: string, id: string) => Promise.resolve(id === 'item-2'
        ? {
            data: { id: 'item-2', title: 'Run dependency', status: 'ready' },
            stamp: 43,
          }
        : {
            data: { id: 'item-1', title: 'Authoritative', status: 'todo' },
            stamp: 44,
          })),
      createClaim: jest.fn(() => Promise.reject(new Error('not used'))),
      createSnapshot: () =>
        createSnapshot({
          pool,
          transport: null,
          getLastSyncId: () => 0,
          entities: {},
        }),
      state: jest.fn(() => null),
      holders: jest.fn(() => []),
      queue: jest.fn(() => []),
      reorder: jest.fn(),
      waitFor: jest.fn(() => Promise.resolve(undefined)),
      selfParticipantId: 'user-1',
    };
    const context = createReadSetContext();
    const items = createModelProxy<ItemRow, Omit<ItemRow, 'id'>>(
      'items',
      'Item',
      pool,
      syncClient,
      registry,
      hydration,
      collaboration,
      context,
    );

    const [item] = await items.list({ where: { status: 'todo' } });
    if (!item) throw new Error('expected listed item');
    expect(collaboration.readPoint).not.toHaveBeenCalled();
    await items.update({
      id: 'item-1', data: { status: 'done' },
      reads: [item], idempotencyKey: 'turn:item-1',
    });

    expect(updateOptions).toMatchObject({
      reads: [{ model: 'item', id: 'item-1', readAt: 42 }],
      idempotencyKey: 'turn:item-1',
    });

    updateOptions = undefined;
    const dependency = await items.get({ id: 'item-2' });
    if (!dependency) throw new Error('expected cross-target dependency');
    await items.update('item-1', (current) => ({
      ...current,
      status: 'review',
    }), { reads: [dependency] });
    expect(updateOptions).toMatchObject({
      readAt: 44,
      onStale: 'reject',
      reads: [{ model: 'item', id: 'item-2', readAt: 43 }],
    });
    updateOptions = undefined;
    await items.update({
      id: 'item-1',
      data: { status: 'archived' },
      idempotencyKey: 'after-functional',
      reads: [dependency],
    });
    expect(updateOptions).toMatchObject({
      reads: [{ model: 'item', id: 'item-2', readAt: 43 }],
      idempotencyKey: 'after-functional',
    });
    pool.stopGC();
  });
});
