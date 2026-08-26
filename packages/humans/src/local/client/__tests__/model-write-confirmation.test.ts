import { ModelScope, LoadStrategy } from '@abloatai/transaction/types';
import { InstanceCache } from '../../InstanceCache.js';
import { Model } from '../../Model.js';
import { ModelRegistry, setActiveRegistry } from '../../ModelRegistry.js';
import type { SyncClient } from '../../SyncClient.js';
import type { OnDemandLoader } from '../../sync/OnDemandLoader.js';
import { createModelOperations } from '../createModelOperations.js';

interface ItemRow {
  id: string;
  title: string;
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

describe('schema model write confirmation', () => {
  it('applies locally immediately and settles its promise only after confirmation', async () => {
    const registry = new ModelRegistry({
      validateOnRegister: false,
      allowLateReferences: true,
    });
    registry.registerModel('Item', ItemModel, {
      loadStrategy: LoadStrategy.instant,
    });
    registry.registerProperty('Item', 'title', {
      type: 'property' as never,
      indexed: false,
      optional: false,
    });
    setActiveRegistry(registry);
    const pool = new InstanceCache({ maxSize: 100 }, registry);

    let releaseSync!: () => void;
    const syncGate = new Promise<void>((resolve) => {
      releaseSync = resolve;
    });
    let confirmationChecks = 0;
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
      add(model) {
        pool.add(model, ModelScope.live);
      },
      delete() {
        return undefined;
      },
      getMutationQueue() {
        throw new Error('not used by this test');
      },
      getOrganizationId() {
        return undefined;
      },
      syncNow() {
        return syncGate;
      },
      update() {
        return undefined;
      },
      waitForConfirmation() {
        confirmationChecks += 1;
        return Promise.resolve();
      },
    };
    const hydration: Pick<OnDemandLoader, 'fetch'> = {
      fetch: () => Promise.resolve([]),
    };
    const items = createModelOperations<ItemRow, Omit<ItemRow, 'id'>>(
      'items',
      'Item',
      pool,
      syncClient,
      registry,
      hydration,
    );

    let settled = false;
    const confirmation = items.create({
      id: 'item-1',
      data: { title: 'Optimistic immediately' },
    });
    void confirmation.then(() => {
      settled = true;
    });

    expect(items.local.get('item-1')?.title).toBe('Optimistic immediately');
    expect(settled).toBe(false);

    releaseSync();
    await expect(confirmation).resolves.toMatchObject({
      id: 'item-1',
      title: 'Optimistic immediately',
    });
    expect(confirmationChecks).toBe(1);
    expect(settled).toBe(true);
    pool.stopGC();
  });
});
