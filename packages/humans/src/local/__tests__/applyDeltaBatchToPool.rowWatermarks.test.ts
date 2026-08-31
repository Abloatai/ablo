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
import { SyncClient } from '../SyncClient.js';
import type { Database } from '../Database.js';

class ItemModel extends Model {
  title: string | undefined;
  constructor(data: Partial<Model> & { title?: string } = {}) {
    super(data);
    this.title = data.title;
  }
  override getModelName(): string {
    return 'Item';
  }
}

const identityEnrich = (_name: string, data: Record<string, unknown>) => data;

function setup() {
  const registry = new ModelRegistry({ validateOnRegister: false, allowLateReferences: true });
  registry.registerModel('Item', ItemModel, { loadStrategy: LoadStrategy.instant });
  setActiveRegistry(registry);
  const pool = new InstanceCache({ maxSize: 100 }, registry);
  const client = new SyncClient(pool, {} as Database);
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
