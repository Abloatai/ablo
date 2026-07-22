/**
 * Assembles a ready-to-use {@link RuntimeContext} for tests. The context
 * bundles every dependency the engine needs — logger, network monitor,
 * mutation executor, and configuration — so a test can start the engine
 * without a real backend. {@link createTestContext} is the entry point: it
 * wires the mocks, installs the context globally through {@link initRuntime},
 * and returns handles to each mock for assertions.
 */

import type { RuntimeContext } from '../../RuntimeContext.js';
import {
  noopLogger,
  noopObservability,
  noopAnalytics,
  defaultSessionErrorDetector,
  emptyConfig,
} from '../../RuntimeContext.js';
import type {
  Logger,
  ObservabilityProvider,
  SessionErrorDetector,
  RuntimeConfig,
} from '../../interfaces/index.js';
import { initRuntime, resetRuntime } from '../../context.js';
import {
  ModelRegistry,
  getActiveRegistry,
  setActiveRegistry,
  hasActiveRegistry,
  clearActiveRegistry,
} from '../../ModelRegistry.js';
import { registerTestModels } from '../fixtures/models.js';
import { MockMutationExecutor } from './MockMutationExecutor.js';
import { MockNetworkMonitor } from './MockNetworkMonitor.js';

export interface TestContextOptions {
  /** Replaces the default no-op logger. */
  logger?: Logger;
  /** Replaces the default no-op observability provider. */
  observability?: ObservabilityProvider;
  /** Replaces the detector that decides whether an error means the session has expired. */
  sessionErrorDetector?: SessionErrorDetector;
  /** Options forwarded to the {@link MockMutationExecutor} that the context creates. */
  mutationExecutorOptions?: ConstructorParameters<typeof MockMutationExecutor>[0];
  /** A partial {@link RuntimeConfig} merged over the defaults. */
  config?: Partial<RuntimeConfig>;
  /** Starts the network monitor offline. Defaults to online. */
  startOffline?: boolean;
}

export interface TestContextResult {
  /** The assembled context that {@link createTestContext} installed globally. */
  context: RuntimeContext;

  /** Handles to the underlying mocks, so tests can drive them and assert on them. */
  mocks: {
    mutationExecutor: MockMutationExecutor;
    networkMonitor: MockNetworkMonitor;
  };

  /** Tears the test down by resetting the engine and the mocks. Call it when the test finishes. */
  cleanup: () => void;
}

/**
 * Builds a {@link RuntimeContext} with every mock pre-wired and installs it
 * globally through {@link initRuntime}, so code under test reaches the engine
 * the same way it would in production. Returns the context, the mock handles,
 * and a cleanup function to call when the test finishes.
 *
 * @example
 * ```ts
 * const { context, mocks, cleanup } = createTestContext();
 * // ... run tests using mocks.mutationExecutor, mocks.networkMonitor
 * cleanup();
 * ```
 */
export function createTestContext(options: TestContextOptions = {}): TestContextResult {
  const mutationExecutor = new MockMutationExecutor(options.mutationExecutorOptions);
  const networkMonitor = new MockNetworkMonitor(!options.startOffline);

  const config: RuntimeConfig = {
    ...emptyConfig,
    ...options.config,
    // Merge maps/sets properly if overrides provided
    modelCreatePriority:
      options.config?.modelCreatePriority ?? emptyConfig.modelCreatePriority,
  };

  const context: RuntimeContext = {
    getModelMetadata: (name) => (hasActiveRegistry() ? getActiveRegistry().getMetadata(name) : undefined),
    logger: options.logger ?? noopLogger,
    observability: options.observability ?? noopObservability,
    analytics: noopAnalytics,
    sessionErrorDetector: options.sessionErrorDetector ?? defaultSessionErrorDetector,
    onlineStatus: networkMonitor,
    mutationExecutor,
    config,
  };

  initRuntime(context);

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
      resetRuntime();
      // Leave the active ModelRegistry in place on purpose. Async callbacks
      // from in-flight transactions can call Model.toJSON() after a test's
      // teardown has run; keeping the default registry available keeps those
      // late calls valid, and the next createTestContext simply reuses it.
      mutationExecutor.reset();
      networkMonitor.reset();
    },
  };
}
