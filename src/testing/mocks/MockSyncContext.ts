/**
 * MockSyncContext — Creates a fully-wired SyncEngineContext for tests.
 *
 * `createTestContext()` is the primary test utility: it builds a complete
 * DI container with mock implementations, calls initSyncEngine(), and
 * returns handles to all mocks for test assertions.
 */

import type { SyncEngineContext } from '../../SyncEngineContext';
import {
  noopLogger,
  noopObservability,
  noopAnalytics,
  defaultSessionErrorDetector,
  emptyConfig,
} from '../../SyncEngineContext';
import type {
  SyncLogger,
  SyncObservabilityProvider,
  SessionErrorDetector,
  MutationDispatcher,
  SyncEngineConfig,
} from '../../interfaces';
import { initSyncEngine, resetSyncEngine } from '../../context';
import {
  ModelRegistry,
  setActiveRegistry,
  hasActiveRegistry,
  clearActiveRegistry,
} from '../../ModelRegistry';
import { registerTestModels } from '../fixtures/models';
import { MockMutationExecutor } from './MockMutationExecutor';
import { MockNetworkMonitor } from './MockNetworkMonitor';

export interface TestContextOptions {
  /** Override the logger (default: noopLogger) */
  logger?: SyncLogger;
  /** Override observability (default: noopObservability) */
  observability?: SyncObservabilityProvider;
  /** Override session error detector */
  sessionErrorDetector?: SessionErrorDetector;
  /** Override mutation executor options */
  mutationExecutorOptions?: ConstructorParameters<typeof MockMutationExecutor>[0];
  /** Override the sync engine config */
  config?: Partial<SyncEngineConfig>;
  /** Start offline (default: false) */
  startOffline?: boolean;
}

export interface TestContextResult {
  /** The full SyncEngineContext passed to initSyncEngine */
  context: SyncEngineContext;

  /** Mock handles for test assertions */
  mocks: {
    mutationExecutor: MockMutationExecutor;
    mutationDispatcher: MockMutationDispatcher;
    networkMonitor: MockNetworkMonitor;
  };

  /** Cleanup: calls resetSyncEngine() */
  cleanup: () => void;
}

/**
 * Simple mock mutation dispatcher that records dispatch calls.
 */
export class MockMutationDispatcher implements MutationDispatcher {
  readonly dispatched: Array<{ operationName: string; variables: Record<string, unknown> }> = [];
  private _shouldSucceed = true;
  private _error?: Error;

  async dispatch(operationName: string, variables: Record<string, unknown>): Promise<void> {
    this.dispatched.push({ operationName, variables });
    if (!this._shouldSucceed) {
      throw this._error ?? new Error(`Mock dispatch failed: ${operationName}`);
    }
  }

  failAll(error?: Error): void {
    this._shouldSucceed = false;
    this._error = error;
  }

  succeedAll(): void {
    this._shouldSucceed = true;
    this._error = undefined;
  }

  reset(): void {
    this.dispatched.length = 0;
    this._shouldSucceed = true;
    this._error = undefined;
  }
}

/**
 * Create a test SyncEngineContext with all mocks pre-wired.
 * Calls initSyncEngine() so the global context is set.
 *
 * Usage:
 * ```ts
 * const { context, mocks, cleanup } = createTestContext();
 * // ... run tests using mocks.mutationExecutor, mocks.networkMonitor
 * cleanup();
 * ```
 */
export function createTestContext(options: TestContextOptions = {}): TestContextResult {
  const mutationExecutor = new MockMutationExecutor(options.mutationExecutorOptions);
  const mutationDispatcher = new MockMutationDispatcher();
  const networkMonitor = new MockNetworkMonitor(!options.startOffline);

  const config: SyncEngineConfig = {
    ...emptyConfig,
    ...options.config,
    // Merge maps/sets properly if overrides provided
    modelCreatePriority:
      options.config?.modelCreatePriority ?? emptyConfig.modelCreatePriority,
    batchableModels: options.config?.batchableModels ?? emptyConfig.batchableModels,
    dedicatedDeleteModels:
      options.config?.dedicatedDeleteModels ?? emptyConfig.dedicatedDeleteModels,
    preserveCaseModels:
      options.config?.preserveCaseModels ?? emptyConfig.preserveCaseModels,
  };

  const context: SyncEngineContext = {
    logger: options.logger ?? noopLogger,
    observability: options.observability ?? noopObservability,
    analytics: noopAnalytics,
    sessionErrorDetector: options.sessionErrorDetector ?? defaultSessionErrorDetector,
    onlineStatus: networkMonitor,
    mutationExecutor,
    mutationDispatcher,
    config,
  };

  initSyncEngine(context);

  // Bootstrap a default ModelRegistry with test models if none is active.
  // Tests that manage their own registry call setActiveRegistry before this.
  const bootstrappedRegistry = !hasActiveRegistry();
  if (bootstrappedRegistry) {
    const defaultRegistry = new ModelRegistry();
    setActiveRegistry(defaultRegistry);
    registerTestModels(defaultRegistry);
  }

  return {
    context,
    mocks: {
      mutationExecutor,
      mutationDispatcher,
      networkMonitor,
    },
    cleanup: () => {
      resetSyncEngine();
      // Intentionally do NOT clear the active ModelRegistry — async callbacks
      // from in-flight transactions (e.g. fc.asyncProperty iterations) may
      // call Model.toJSON() after afterEach runs. Leaving the default
      // registry in place keeps those calls valid; the next createTestContext
      // with hasActiveRegistry()===true simply reuses it.
      mutationExecutor.reset();
      mutationDispatcher.reset();
      networkMonitor.reset();
    },
  };
}
