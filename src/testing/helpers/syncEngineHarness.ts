/**
 * An integration-test harness that assembles a full sync engine stack —
 * the model registry, object pool, transaction queue, and related parts —
 * from the real implementations, but with mocked input and output. It lets
 * tests exercise the engine end to end without a network or a live server.
 */

import { ModelRegistry, setActiveRegistry } from '../../ModelRegistry.js';
import { InstanceCache } from '../../InstanceCache.js';
import { MockMutationExecutor } from '../mocks/MockMutationExecutor.js';
import { MockNetworkMonitor } from '../mocks/MockNetworkMonitor.js';
import { MockWebSocket } from '../mocks/MockWebSocket.js';
import { createTestContext } from '../mocks/MockSyncContext.js';
import type { TestContextResult } from '../mocks/MockSyncContext.js';
import {
  registerTestModels,
  createTestConfig,
  resetFixtureCounter,
} from '../fixtures/models.js';
import { resetDeltaCounter } from '../fixtures/deltas.js';

export interface TestHarness {
  /** A model registry pre-loaded with the test models. */
  registry: ModelRegistry;

  /** A real object pool with the test foreign-key indexes configured. */
  pool: InstanceCache;

  /** A mock WebSocket for injecting deltas into the engine. */
  webSocket: MockWebSocket;

  /** The dependency-injection context holding every mock. */
  context: TestContextResult;

  /** Shorthand for the mock mutation executor on {@link context}. */
  mutationExecutor: MockMutationExecutor;

  /** Shorthand for the mock network monitor on {@link context}. */
  networkMonitor: MockNetworkMonitor;

  /** Tears down the harness and resets its counters. */
  cleanup: () => void;
}

export interface TestHarnessOptions {
  /** Start offline (default: false) */
  startOffline?: boolean;
  /** Initial sync ID for mutation executor */
  initialSyncId?: number;
  /** InstanceCache config overrides */
  poolConfig?: {
    maxSize?: number;
    maxAge?: number;
    gcInterval?: number;
    useWeakRefs?: boolean;
  };
}

/**
 * Builds a full test harness: real sync engine components wired to mocked
 * input and output. Reset the counters and tear everything down through the
 * returned {@link TestHarness.cleanup}.
 *
 * Usage:
 * ```ts
 * let harness: TestHarness;
 * beforeEach(() => { harness = createTestHarness(); });
 * afterEach(() => { harness.cleanup(); });
 * ```
 */
export function createTestHarness(options: TestHarnessOptions = {}): TestHarness {
  // Reset counters for deterministic tests
  resetFixtureCounter();
  resetDeltaCounter();

  // Create and register test models
  const registry = new ModelRegistry();
  setActiveRegistry(registry);
  registerTestModels(registry);

  // Create the dependency-injection context with the test config
  const testConfig = createTestConfig();
  const context = createTestContext({
    config: testConfig,
    startOffline: options.startOffline,
    mutationExecutorOptions: {
      initialSyncId: options.initialSyncId ?? 1,
    },
  });

  // Create the real object pool with foreign-key indexes
  const pool = new InstanceCache(
    {
      maxSize: options.poolConfig?.maxSize ?? 10000,
      maxAge: options.poolConfig?.maxAge ?? 5 * 60 * 1000,
      gcInterval: options.poolConfig?.gcInterval ?? 0, // Disable auto-GC in tests
      useWeakRefs: options.poolConfig?.useWeakRefs ?? false, // Disable WeakRefs for predictable tests
    },
    registry
  );

  // Register foreign-key indexes for the test models
  pool.registerForeignKey('Task', 'projectId');
  pool.registerForeignKey('Comment', 'taskId');
  pool.registerForeignKey('Slide', 'deckId');
  pool.registerForeignKey('SlideLayer', 'slideId');

  // Create mock WebSocket
  const webSocket = new MockWebSocket();

  return {
    registry,
    pool,
    webSocket,
    context,
    mutationExecutor: context.mocks.mutationExecutor,
    networkMonitor: context.mocks.networkMonitor,
    cleanup: () => {
      pool.clear();
      webSocket.reset();
      context.cleanup();
      resetFixtureCounter();
      resetDeltaCounter();
    },
  };
}
