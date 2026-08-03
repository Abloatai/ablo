import { ModelScope, LoadStrategy } from '@abloatai/transaction/types';
import { InstanceCache } from '../../InstanceCache.js';
import { Model } from '../../Model.js';
import { ModelRegistry, setActiveRegistry } from '../../ModelRegistry.js';
import type { SyncClient } from '../../SyncClient.js';
import type { OnDemandLoader } from '../../sync/OnDemandLoader.js';
import { createModelProxy } from '../createModelProxy.js';

interface TaskRow {
  id: string;
  title: string;
}

class TaskModel extends Model {
  constructor(data?: Record<string, unknown>) {
    super(data);
    Object.assign(this, data);
  }

  override getModelName(): string {
    return 'Task';
  }
}

describe('schema model write confirmation', () => {
  it('applies locally immediately and settles its promise only after confirmation', async () => {
    const registry = new ModelRegistry({
      validateOnRegister: false,
      allowLateReferences: true,
    });
    registry.registerModel('Task', TaskModel, {
      loadStrategy: LoadStrategy.instant,
    });
    registry.registerProperty('Task', 'title', {
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
      delete() {},
      getMutationQueue() {
        throw new Error('not used by this test');
      },
      getOrganizationId() {
        return undefined;
      },
      syncNow() {
        return syncGate;
      },
      update() {},
      waitForConfirmation() {
        confirmationChecks += 1;
        return Promise.resolve();
      },
    };
    const hydration: Pick<OnDemandLoader, 'fetch'> = {
      fetch: async () => [],
    };
    const tasks = createModelProxy<TaskRow, Omit<TaskRow, 'id'>>(
      'tasks',
      'Task',
      pool,
      syncClient,
      registry,
      hydration,
    );

    let settled = false;
    const confirmation = tasks.create({
      id: 'task-1',
      data: { title: 'Optimistic immediately' },
    });
    void confirmation.then(() => {
      settled = true;
    });

    expect(tasks.local.get('task-1')?.title).toBe('Optimistic immediately');
    expect(settled).toBe(false);

    releaseSync();
    await expect(confirmation).resolves.toMatchObject({
      id: 'task-1',
      title: 'Optimistic immediately',
    });
    expect(confirmationChecks).toBe(1);
    expect(settled).toBe(true);
    pool.stopGC();
  });
});
