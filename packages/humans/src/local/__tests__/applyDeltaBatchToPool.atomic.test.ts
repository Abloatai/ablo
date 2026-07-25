/**
 * `SyncClient.applyDeltaBatchToPool` must reveal a whole delta frame as a
 * SINGLE MobX action — Replicache's "atomically reveal the new state".
 *
 * Background: the pool mutations (`addBatch` / `upsertBatch` / `removeBatch` /
 * `updateScope`) are each independently `action`-wrapped, so calling them
 * sequentially flushed reactions at EVERY action boundary. A catch-up frame
 * that added + updated + removed fired every dependent reaction (the decks
 * gallery, each open editor) 3-4× in a row — the "deltas apply one in a row
 * and it looks horrible" jank. The fix wraps the mutations + the
 * `models:changed` emit in one outer `runInAction`.
 *
 * These tests pin the contract by counting how many times a membership
 * `reaction` over the pool runs for one mixed frame: exactly ONCE with the
 * wrap, and (the regression we're guarding) more than once without it.
 */

import { reaction, runInAction } from 'mobx';
import { ModelRegistry, setActiveRegistry, clearActiveRegistry } from '../ModelRegistry.js';
import { InstanceCache } from '../InstanceCache.js';
import { Model } from '../Model.js';
import { ModelScope, LoadStrategy } from '@abloatai/transaction/types';
import { SyncClient } from '../SyncClient.js';
import type { Database } from '../Database.js';

class TaskModel extends Model {
  override getModelName(): string {
    return 'Task';
  }
}

type DeltaResult = Parameters<SyncClient['applyDeltaBatchToPool']>[0][number];

const identityEnrich = (_name: string, data: Record<string, unknown>) => data;

function setup() {
  const registry = new ModelRegistry({
    validateOnRegister: false,
    allowLateReferences: true,
  });
  registry.registerModel('Task', TaskModel, { loadStrategy: LoadStrategy.instant });
  // Model snapshotting (markAsPersisted / resolveConflicts) reads the
  // process-global active registry.
  setActiveRegistry(registry);
  const pool = new InstanceCache({ maxSize: 100 }, registry);
  // applyDeltaBatchToPool never touches `database`; the constructor only
  // stores it. Cast a stub, mirroring the existing client test harness.
  const client = new SyncClient(pool, {} as Database);
  return { registry, pool, client };
}

function seed(pool: InstanceCache, id: string): void {
  const model = Object.assign(new TaskModel({ id }), { title: `seed-${id}` });
  model.markAsPersisted();
  pool.add(model, ModelScope.live);
}

/** A frame that adds 2, updates 1, removes 1 — every op-kind in one batch. */
function mixedFrame(): DeltaResult[] {
  return [
    { action: 'add', modelName: 'Task', modelId: 'add-a', data: { id: 'add-a', title: 'A' } },
    { action: 'add', modelName: 'Task', modelId: 'add-b', data: { id: 'add-b', title: 'B' } },
    { action: 'update', modelName: 'Task', modelId: 'keep', data: { id: 'keep', title: 'updated' } },
    { action: 'remove', modelName: 'Task', modelId: 'gone', data: null },
  ];
}

describe('SyncClient.applyDeltaBatchToPool — atomic reveal', () => {
  afterEach(() => {
    clearActiveRegistry();
  });


  it('fires a pool-membership reaction exactly once for a mixed add/update/remove frame', () => {
    const { pool, client } = setup();
    seed(pool, 'keep');
    seed(pool, 'gone');

    let fires = 0;
    const dispose = reaction(
      () => pool.getAllIds().slice().sort().join(','),
      () => {
        fires += 1;
      },
    );

    client.applyDeltaBatchToPool(mixedFrame(), identityEnrich);

    expect(fires).toBe(1);

    // Final state is correct — the frame was applied, not just coalesced.
    const ids = new Set(pool.getAllIds());
    expect(ids.has('add-a')).toBe(true);
    expect(ids.has('add-b')).toBe(true);
    expect(ids.has('keep')).toBe(true);
    expect(ids.has('gone')).toBe(false);

    dispose();
  });

  it('emits models:changed exactly once for the frame', () => {
    const { pool, client } = setup();
    seed(pool, 'keep');
    seed(pool, 'gone');

    let emits = 0;
    client.on('models:changed', () => {
      emits += 1;
    });

    client.applyDeltaBatchToPool(mixedFrame(), identityEnrich);

    expect(emits).toBe(1);
  });

  it('control: applying the same ops as SEPARATE actions fires the reaction more than once', () => {
    // This is the pre-fix behaviour — proves the reaction is sensitive to
    // action boundaries, so the `toBe(1)` assertion above is meaningful and
    // would catch a regression that removed the `runInAction` wrap.
    const { pool, registry } = setup();
    void registry;
    seed(pool, 'gone');

    let fires = 0;
    const dispose = reaction(
      () => pool.getAllIds().slice().sort().join(','),
      () => {
        fires += 1;
      },
    );

    // Two separate top-level actions (what sequential *Batch calls produce
    // when NOT wrapped in a single outer action).
    const newModel = Object.assign(new TaskModel({ id: 'add-a' }), { title: 'A' });
    newModel.markAsPersisted();
    runInAction(() => pool.addBatch([newModel], ModelScope.live));
    runInAction(() => pool.removeBatch(['gone']));

    expect(fires).toBe(2);

    dispose();
  });
});
