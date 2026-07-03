/**
 * MockSyncContext — Creates a fully-wired SyncEngineContext for tests.
 *
 * `createTestContext()` is the primary test utility: it builds a complete
 * DI container with mock implementations, calls initSyncEngine(), and
 * returns handles to all mocks for test assertions.
 */

import type { SyncEngineContext } from '../../SyncEngineContext.js';
import {
  noopLogger,
  noopObservability,
  noopAnalytics,
  defaultSessionErrorDetector,
  emptyConfig,
} from '../../SyncEngineContext.js';
import type {
  SyncLogger,
  SyncObservabilityProvider,
  SessionErrorDetector,
  SyncEngineConfig,
} from '../../interfaces/index.js';
import { initSyncEngine, resetSyncEngine } from '../../context.js';
import {
  ModelRegistry,
  setActiveRegistry,
  hasActiveRegistry,
  clearActiveRegistry,
} from '../../ModelRegistry.js';
import { registerTestModels } from '../fixtures/models.js';
import { MockMutationExecutor } from './MockMutationExecutor.js';
import { MockNetworkMonitor } from './MockNetworkMonitor.js';

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
    networkMonitor: MockNetworkMonitor;
  };

  /** Cleanup: calls resetSyncEngine() */
  cleanup: () => void;
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
  const networkMonitor = new MockNetworkMonitor(!options.startOffline);

  const config: SyncEngineConfig = {
    ...emptyConfig,
    ...options.config,
    // Merge maps/sets properly if overrides provided
    modelCreatePriority:
      options.config?.modelCreatePriority ?? emptyConfig.modelCreatePriority,
  };

  const context: SyncEngineContext = {
    logger: options.logger ?? noopLogger,
    observability: options.observability ?? noopObservability,
    analytics: noopAnalytics,
    sessionErrorDetector: options.sessionErrorDetector ?? defaultSessionErrorDetector,
    onlineStatus: networkMonitor,
    mutationExecutor,
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
      networkMonitor.reset();
    },
  };
}
