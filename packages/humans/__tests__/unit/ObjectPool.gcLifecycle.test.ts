/**
 * ObjectPool GC lifecycle (T1.17) — the gc setInterval must actually stop.
 *
 * Before this fix `stopGC()` had zero callers: every discarded store retained
 * its whole pool through the interval closure and a headless Node process
 * could never exit. Pins two contracts:
 *
 *  1. `ObjectPool.stopGC()` clears the interval (fake-timer count drops).
 *  2. `BaseSyncedStore.disconnect()` calls `stopGC()` on its pool.
 */
import { BaseSyncedStore } from '../../src/local/BaseSyncedStore';
import { storeDependencies } from '../../src/local/testing/helpers/storeDependencies';
import { InstanceCache as ObjectPool } from '../../src/local/InstanceCache';
import { ModelRegistry } from '../../src/local/ModelRegistry';
import { createTestContext } from '../../src/local/testing/mocks/MockSyncContext';
import type { TestContextResult } from '../../src/local/testing/mocks/MockSyncContext';

describe('ObjectPool.stopGC', () => {
  let ctx: TestContextResult;

  beforeEach(() => {
    jest.useFakeTimers();
    ctx = createTestContext();
  });

  afterEach(() => {
    ctx.cleanup();
    jest.useRealTimers();
  });

  it('clears the gc interval armed by the constructor', () => {
    const before = jest.getTimerCount();
    const pool = new ObjectPool({}, new ModelRegistry());
    expect(jest.getTimerCount()).toBe(before + 1);

    pool.stopGC();
    expect(jest.getTimerCount()).toBe(before);

    // Idempotent — a second stop must not throw or clear foreign timers.
    pool.stopGC();
    expect(jest.getTimerCount()).toBe(before);
  });

  it('does not arm gc when the interval is disabled', () => {
    const before = jest.getTimerCount();
    const pool = new ObjectPool({ gcInterval: 0 }, new ModelRegistry());

    expect(jest.getTimerCount()).toBe(before);
    pool.stopGC();
  });
});

describe('BaseSyncedStore.disconnect stops pool GC', () => {
  let ctx: TestContextResult;

  beforeEach(() => {
    ctx = createTestContext();
  });

  afterEach(() => {
    ctx.cleanup();
  });

  it('calls objectPool.stopGC() during disconnect', async () => {
    // A real store over real collaborators; only the pool's GC stop is observed.
    const deps = storeDependencies();
    const stopGC = jest.spyOn(deps.objectPool, 'stopGC');
    const store = new BaseSyncedStore(deps);

    await store.disconnect();

    expect(stopGC).toHaveBeenCalledTimes(1);
  });
});
