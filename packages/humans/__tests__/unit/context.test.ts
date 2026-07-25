/**
 * Tests for the sync engine DI context (context.ts).
 *
 * Verifies: initRuntime, getContext fallback, resetRuntime,
 * isRuntimeInitialized — the foundation all other tests depend on.
 */

import { initRuntime, getContext, resetRuntime, isRuntimeInitialized } from '../../src/local/context.js';
import { noopLogger, noopObservability, emptyConfig } from '../../src/local/RuntimeContext.js';
import { createTestContext } from '../../src/local/testing';

describe('SyncEngine Context', () => {
  afterEach(() => {
    resetRuntime();
  });

  describe('getContext()', () => {
    it('should return fallback context when not initialized', () => {
      const ctx = getContext();

      expect(ctx).toBeDefined();
      expect(ctx.logger).toBeDefined();
      expect(ctx.observability).toBeDefined();
      expect(ctx.mutationExecutor).toBeDefined();
    });

    it('should return fallback mutationExecutor that resolves as confirmed at lastSyncId: 0', async () => {
      const ctx = getContext();
      const result = await ctx.mutationExecutor.commit([]);

      expect(result).toEqual({ lastSyncId: 0, status: 'confirmed' });
    });
  });

  describe('initRuntime()', () => {
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

  describe('isRuntimeInitialized()', () => {
    it('should return false before initialization', () => {
      expect(isRuntimeInitialized()).toBe(false);
    });

    it('should return true after initialization', () => {
      createTestContext();
      expect(isRuntimeInitialized()).toBe(true);
    });

    it('should return false after reset', () => {
      createTestContext();
      resetRuntime();
      expect(isRuntimeInitialized()).toBe(false);
    });
  });

  describe('resetRuntime()', () => {
    it('should clear the context back to fallback', () => {
      const { context } = createTestContext();
      expect(getContext()).toBe(context);

      resetRuntime();

      // After reset, getContext returns fallback (not the same object)
      expect(getContext()).not.toBe(context);
      expect(isRuntimeInitialized()).toBe(false);
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
    expect(isRuntimeInitialized()).toBe(true);

    cleanup();
    expect(isRuntimeInitialized()).toBe(false);
  });
});
