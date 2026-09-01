import { ModelScope, LoadStrategy } from '@abloatai/transaction/types';
import { InstanceCache } from '../../InstanceCache.js';
import { Model } from '../../Model.js';
import { ModelRegistry, setActiveRegistry } from '../../ModelRegistry.js';
import type { SyncClient } from '../../SyncClient.js';
import type { OnDemandLoader } from '../../sync/OnDemandLoader.js';
import { createModelOperations } from '../createModelOperations.js';
import { AbloStaleContextError } from '@abloatai/transaction/errors';

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

type ModelWriteSyncClient = Pick<
  SyncClient,
  | 'add'
  | 'delete'
  | 'getMutationQueue'
  | 'getOrganizationId'
  | 'syncNow'
  | 'update'
  | 'waitForConfirmation'
>;

function createItemsClient(
  overrides: Partial<ModelWriteSyncClient> = {},
): {
  items: ReturnType<
    typeof createModelOperations<ItemRow, Omit<ItemRow, 'id'>>
  >;
  pool: InstanceCache;
} {
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
  const syncClient: ModelWriteSyncClient = {
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
      return Promise.resolve();
    },
    update() {
      return undefined;
    },
    waitForConfirmation() {
      return Promise.resolve();
    },
    ...overrides,
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
  return { items, pool };
}

describe('schema model write confirmation', () => {
  it('applies locally immediately and settles its promise only after confirmation', async () => {
    let releaseSync!: () => void;
    const syncGate = new Promise<void>((resolve) => {
      releaseSync = resolve;
    });
    let confirmationChecks = 0;
    const { items, pool } = createItemsClient({
      syncNow() {
        return syncGate;
      },
      waitForConfirmation() {
        confirmationChecks += 1;
        return Promise.resolve();
      },
    });

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

  it('observes an intentionally ignored rejected write without hiding rejection from awaited callers', async () => {
    const stale = new AbloStaleContextError('changed elsewhere', {
      code: 'stale_context',
    });
    const { items, pool } = createItemsClient({
      waitForConfirmation: () => Promise.reject(stale),
    });
    await items.create({ id: 'item-ignored', data: { title: 'original' } }).catch(
      () => undefined,
    );

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      void items.update({ id: 'item-ignored', data: { title: 'ignored' } });
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(unhandled).toHaveLength(0);

      await expect(
        items.update({ id: 'item-ignored', data: { title: 'awaited' } }),
      ).rejects.toBe(stale);
    } finally {
      process.off('unhandledRejection', onUnhandled);
      pool.stopGC();
    }
  });

  it('awaits the exact staged transaction when it fails before model lookup', async () => {
    const stale = new AbloStaleContextError('changed elsewhere', {
      code: 'stale_context',
    });
    let lookupCalls = 0;
    const { items, pool } = createItemsClient({
      update() {
        return Promise.reject(stale);
      },
      waitForConfirmation() {
        lookupCalls += 1;
        return Promise.resolve();
      },
    });

    await items.create({ id: 'item-race', data: { title: 'original' } });
    lookupCalls = 0;

    await expect(items.update({
      id: 'item-race',
      data: { title: 'rejected' },
    })).rejects.toBe(stale);
    expect(lookupCalls).toBe(0);
    pool.stopGC();
  });
});
