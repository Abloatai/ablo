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
    // Bypass the heavy constructor — disconnect() only touches the fields
    // stubbed here (same pattern as BaseSyncedStore.bootstrap-mode.test.ts).
    const stopGC = jest.fn();
    const stub = Object.create(BaseSyncedStore.prototype) as BaseSyncedStore;
    const w = stub as unknown as Record<string, unknown>;
    w.credentialLifecycle = { stop: jest.fn() };
    w.batchTimer = null;
    w.pendingDeltas = [];
    w.disposers = [];
    w.connectionManager = null;
    // The connection is a constructor dependency now; disconnect() closes it.
    w.syncWebSocket = { disconnect: jest.fn(), getLastSyncId: () => 0 };
    w.database = { updateWorkspaceMetadata: jest.fn() };
    w.syncClient = { disconnect: jest.fn() };
    w.queryProcessor = { clearCache: jest.fn() };
    w.objectPool = { stopGC };
    w.updateSyncStatus = jest.fn();

    await stub.disconnect();

    expect(stopGC).toHaveBeenCalledTimes(1);
  });
});
