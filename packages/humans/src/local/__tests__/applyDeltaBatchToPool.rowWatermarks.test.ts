/**
 * `SyncClient.applyDeltaBatchToPool` records, per row, the log position each
 * delta carries — the evidence a later snapshot is judged against
 * ({@link RowWatermarks}). It records before echo detection: an echo of this
 * client's own write is a position the row has reached even though its fields
 * are not re-applied.
 */

import { ModelRegistry, setActiveRegistry, clearActiveRegistry } from '../ModelRegistry.js';
import { InstanceCache } from '../InstanceCache.js';
import { Model } from '../Model.js';
import { ModelScope, LoadStrategy } from '@abloatai/transaction/types';
import { makeObservable, observable, reaction } from 'mobx';
import { SyncClient } from '../SyncClient.js';
import { globalRuntime } from '../context.js';
import type { Database } from '../Database.js';

class ItemModel extends Model {
  title: string | undefined;
  order = 0;
  constructor(data: Partial<Model> & { title?: string } = {}) {
    super(data);
    this.title = data.title;
  }
  override getModelName(): string {
    return 'Item';
  }
}

const identityEnrich = (_name: string, data: Record<string, unknown>) => data;

function setup(counter = false) {
  const registry = new ModelRegistry({ validateOnRegister: false, allowLateReferences: true });
  registry.registerModel('Item', ItemModel, { loadStrategy: LoadStrategy.instant });
  setActiveRegistry(registry);
  const pool = new InstanceCache({ maxSize: 100 }, registry);
  const client = new SyncClient(pool, { removeTransaction: async () => {}, getPersistedTransactions: async () => [] } as Database, undefined, 'default', {
    ...globalRuntime,
    getModelMetadata: counter
      ? () => ({ loadStrategy: LoadStrategy.instant, fields: { order: { type: 'number', merge: 'counter' } } })
      : globalRuntime.getModelMetadata,
  });
  return { pool, client };
}

describe('SyncClient.applyDeltaBatchToPool — row positions', () => {
  afterEach(() => {
    clearActiveRegistry();
  });

  it('advances an added row and an updated row to the delta position each carried', () => {
    const { pool, client } = setup();
    const resident = new ItemModel({ id: 'keep', title: 'before' });
    resident.markAsPersisted();
    pool.add(resident, ModelScope.live);

    client.applyDeltaBatchToPool(
      [
        { action: 'add', modelName: 'Item', modelId: 'new', data: { id: 'new', title: 'A' }, syncId: 41 },
        { action: 'update', modelName: 'Item', modelId: 'keep', data: { id: 'keep', title: 'after' }, syncId: 42 },
      ],
      identityEnrich,
    );

    const added = pool.get('new');
    expect(added).toBeDefined();
    expect(added && pool.watermarks.of(added)).toBe(41);
    expect(pool.watermarks.of(resident)).toBe(42);
    expect(pool.get<ItemModel>('keep')?.title).toBe('after');
  });

  it('applies an update to a row created earlier in the same batch', () => {
    const { pool, client } = setup();

    client.applyDeltaBatchToPool(
      [
        { action: 'add', modelName: 'Item', modelId: 'new', data: { id: 'new', title: 'created' }, syncId: 1 },
        { action: 'update', modelName: 'Item', modelId: 'new', data: { id: 'new', title: 'updated' }, syncId: 2 },
      ],
      identityEnrich,
    );

    const row = pool.get<ItemModel>('new');
    expect(row?.title).toBe('updated');
    expect(row && pool.watermarks.of(row)).toBe(2);
  });

  it('never moves a row backwards and ignores a delta with no position', () => {
    const { pool, client } = setup();
    const resident = new ItemModel({ id: 'keep', title: 'v1' });
    resident.markAsPersisted();
    pool.add(resident, ModelScope.live);
    pool.watermarks.advance(resident, 50);

    client.applyDeltaBatchToPool(
      [
        { action: 'update', modelName: 'Item', modelId: 'keep', data: { id: 'keep', title: 'v2' }, syncId: 49 },
        { action: 'update', modelName: 'Item', modelId: 'keep', data: { id: 'keep', title: 'v3' } },
      ],
      identityEnrich,
    );

    expect(pool.watermarks.of(resident)).toBe(50);
  });

  it('re-baselines dirty fields confirmed by an own echo', () => {
    const { pool, client } = setup();
    const resident = new ItemModel({ id: 'keep', title: 'before' });
    resident.markAsPersisted();
    pool.add(resident, ModelScope.live);
    pool.get('keep');
    resident.applyChanges({ title: 'mine' });
    client.markTransactionPending('tx-own');

    client.applyDeltaBatchToPool(
      [{
        action: 'update',
        modelName: 'Item',
        modelId: 'keep',
        data: { id: 'keep', title: 'mine' },
        syncId: 51,
        transactionId: 'tx-own',
      }],
      identityEnrich,
    );

    expect(resident.title).toBe('mine');
    expect(resident.hasChanges).toBe(false);
  });

  it('keeps a newer local edit dirty when an older own echo arrives', () => {
    const { pool, client } = setup();
    const resident = new ItemModel({ id: 'keep', title: 'before' });
    resident.markAsPersisted();
    pool.add(resident, ModelScope.live);
    pool.get('keep');
    resident.applyChanges({ title: 'newer local edit' });
    client.markTransactionPending('tx-own');

    client.applyDeltaBatchToPool(
      [{
        action: 'update',
        modelName: 'Item',
        modelId: 'keep',
        data: { id: 'keep', title: 'older committed edit' },
        syncId: 52,
        transactionId: 'tx-own',
      }],
      identityEnrich,
    );

    expect(resident.title).toBe('newer local edit');
    expect(resident.getChanges()).toEqual({ title: 'newer local edit' });
  });
});


it('keeps acknowledged fields through older catch-up and echoes without dropping peer fields', () => {
  const { pool, client } = setup();
  const row = new ItemModel({ id: 'keep', title: 'mine' });
  makeObservable(row, { title: observable });
  row.markAsPersisted();
  pool.add(row, ModelScope.live);
  pool.get(row.id);
  client.getMutationQueue().emit('transaction:completed', {
    id: 'latest', modelId: row.id, syncIdNeededForCompletion: 20, data: { title: 'mine' },
  });
  client.markTransactionPending('old');
  const observed: string[] = [];
  const dispose = reaction(() => row.title, value => { observed.push(value!); });
  try {
    client.applyDeltaBatchToPool([{ action: 'update', modelName: 'Item', modelId: row.id,
      syncId: 10, transactionId: 'old', data: { title: 'before', order: 7 } }], identityEnrich);
    expect(row.title).toBe('mine');
    expect(row.order).toBe(7);
    expect(observed).toEqual([]);
    // Later peer edits to the same field must still take effect.
    client.applyDeltaBatchToPool([{ action: 'update', modelName: 'Item', modelId: row.id,
      syncId: 30, data: { title: 'peer', order: 8 } }], identityEnrich);
    expect(row.title).toBe('peer');
    client.applyDeltaBatchToPool([{ action: 'update', modelName: 'Item', modelId: row.id,
      syncId: 15, data: { title: 'old echo' } }], identityEnrich);
    expect(row.title).toBe('peer');
    expect(observed).toEqual(['peer']);
  } finally { dispose(); client.dispose(); pool.clear(); clearActiveRegistry(); }
});

it('tracks confirmed fields for every row of an explicit commit', () => {
  const { pool, client } = setup();
  const rows = ['a', 'b'].map(id => {
    const row = new ItemModel({ id, title: 'mine-' + id });
    row.markAsPersisted(); pool.add(row, ModelScope.live); return row;
  });
  client.getMutationQueue().emit('transaction:completed', {
    id: 'batch', lastSyncId: 20,
    operations: rows.map(row => ({ type: 'UPDATE', model: 'Item', id: row.id, input: { title: row.title } })),
  });
  client.applyDeltaBatchToPool(rows.map(row => ({ action: 'update' as const, modelName: 'Item', modelId: row.id,
    syncId: 10, data: { title: 'before', order: 7 } })), identityEnrich);
  expect(rows.map(row => [row.title, row.order])).toEqual([['mine-a', 7], ['mine-b', 7]]);
  client.dispose(); pool.clear(); clearActiveRegistry();
});

it.each([{ deletedAt: '2026-01-01T00:00:00Z' }, { archivedAt: '2026-01-01T00:00:00Z' }, { isActive: false }])(
  'does not mask lifecycle authority with confirmed local fields: %j', lifecycle => {
    const { pool, client } = setup();
    const row = new ItemModel({ id: 'keep', title: 'mine' });
    row.markAsPersisted(); pool.add(row, ModelScope.live);
    client.getMutationQueue().emit('transaction:completed', {
      id: 'latest', modelId: row.id, syncIdNeededForCompletion: 20, data: { title: 'mine' },
    });
    client.applyDeltaBatchToPool([{ action: 'update', modelName: 'Item', modelId: row.id,
      syncId: 10, data: { title: 'server', ...lifecycle } }], identityEnrich);
    expect(row.title).toBe('server');
    client.dispose(); pool.clear(); clearActiveRegistry();
  },
);


it('does not treat a relative counter operation as a confirmed numeric value', () => {
  const { pool, client } = setup(true);
  const row = new ItemModel({ id: 'keep', title: 'mine' });
  row.order = 5; row.markAsPersisted(); pool.add(row, ModelScope.live);
  client.getMutationQueue().emit('transaction:completed', {
    id: 'increment', modelId: row.id, syncIdNeededForCompletion: 20,
    data: { order: { $increment: { id: 'increment', epoch: 'counter', baseVersion: 0, operation: 2 } } },
  });
  client.applyDeltaBatchToPool([{ action: 'update', modelName: 'Item', modelId: row.id,
    syncId: 10, data: { order: 7 } }], identityEnrich);
  expect(row.order).toBe(7);
  client.dispose(); pool.clear(); clearActiveRegistry();
});

it('keeps a newer received value when an older acknowledgement arrives late', () => {
  const { pool, client } = setup();
  const row = new ItemModel({ id: 'keep', title: 'peer' });
  row.markAsPersisted(); pool.add(row, ModelScope.live);
  pool.watermarks.advance(row, 30);
  client.getMutationQueue().emit('transaction:completed', {
    id: 'late-ack', modelId: row.id, syncIdNeededForCompletion: 20, data: { title: 'mine' },
  });
  client.applyDeltaBatchToPool([{ action: 'update', modelName: 'Item', modelId: row.id,
    syncId: 10, data: { title: 'before', order: 7 } }], identityEnrich);
  expect(row.title).toBe('peer');
  expect(row.order).toBe(7);
  client.dispose(); pool.clear(); clearActiveRegistry();
});
