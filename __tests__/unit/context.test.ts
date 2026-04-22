/**
 * Tests for the sync engine DI context (context.ts).
 *
 * Verifies: initSyncEngine, getContext fallback, resetSyncEngine,
 * isSyncEngineInitialized — the foundation all other tests depend on.
 */

import { initSyncEngine, getContext, resetSyncEngine, isSyncEngineInitialized } from '../../src/context';
import { noopLogger, noopObservability, emptyConfig } from '../../src/SyncEngineContext';
import { createTestContext } from '../../src/testing';

describe('SyncEngine Context', () => {
  afterEach(() => {
    resetSyncEngine();
  });

  describe('getContext()', () => {
    it('should return fallback context when not initialized', () => {
      const ctx = getContext();

      expect(ctx).toBeDefined();
      expect(ctx.logger).toBeDefined();
      expect(ctx.observability).toBeDefined();
      expect(ctx.mutationExecutor).toBeDefined();
      expect(ctx.mutationDispatcher).toBeDefined();
    });

    it('should return fallback mutationExecutor that resolves with lastSyncId: 0', async () => {
      const ctx = getContext();
      const result = await ctx.mutationExecutor.commit([]);

      expect(result).toEqual({ lastSyncId: 0 });
    });

    it('should return fallback mutationDispatcher that resolves', async () => {
      const ctx = getContext();
      await expect(ctx.mutationDispatcher.dispatch('test', {})).resolves.toBeUndefined();
    });
  });

  describe('initSyncEngine()', () => {
    it('should set the context and make it retrievable', () => {
      const { context } = createTestContext();

      const retrieved = getContext();
      expect(retrieved).toBe(context);
    });

    it('should override the fallback context', () => {
      const { context, mocks } = createTestContext();

      const retrieved = getContext();
      expect(retrieved.onlineStatus).toBe(mocks.networkMonitor);
      expect(retrieved.mutationExecutor).toBe(mocks.mutationExecutor);
    });
  });

  describe('isSyncEngineInitialized()', () => {
    it('should return false before initialization', () => {
      expect(isSyncEngineInitialized()).toBe(false);
    });

    it('should return true after initialization', () => {
      createTestContext();
      expect(isSyncEngineInitialized()).toBe(true);
    });

    it('should return false after reset', () => {
      createTestContext();
      resetSyncEngine();
      expect(isSyncEngineInitialized()).toBe(false);
    });
  });

  describe('resetSyncEngine()', () => {
    it('should clear the context back to fallback', () => {
      const { context } = createTestContext();
      expect(getContext()).toBe(context);

      resetSyncEngine();

      // After reset, getContext returns fallback (not the same object)
      expect(getContext()).not.toBe(context);
      expect(isSyncEngineInitialized()).toBe(false);
    });
  });
});

describe('createTestContext()', () => {
  it('should create a fully-wired context with mock handles', () => {
    const { context, mocks, cleanup } = createTestContext();

    expect(context.logger).toBeDefined();
    expect(context.observability).toBeDefined();
    expect(context.mutationExecutor).toBe(mocks.mutationExecutor);
    expect(context.onlineStatus).toBe(mocks.networkMonitor);
    expect(mocks.mutationDispatcher).toBeDefined();

    cleanup();
  });

  it('should start online by default', () => {
    const { mocks, cleanup } = createTestContext();
    expect(mocks.networkMonitor.isOnline()).toBe(true);
    cleanup();
  });

  it('should support startOffline option', () => {
    const { mocks, cleanup } = createTestContext({ startOffline: true });
    expect(mocks.networkMonitor.isOnline()).toBe(false);
    cleanup();
  });

  it('should support custom config overrides', () => {
    const customPriority = new Map([['CustomModel', 5]]);
    const { context, cleanup } = createTestContext({
      config: { modelCreatePriority: customPriority },
    });

    expect(context.config.modelCreatePriority.get('CustomModel')).toBe(5);
    cleanup();
  });

  it('cleanup should reset sync engine', () => {
    const { cleanup } = createTestContext();
    expect(isSyncEngineInitialized()).toBe(true);

    cleanup();
    expect(isSyncEngineInitialized()).toBe(false);
  });
});
