/**
 * Full sync engine test harness.
 *
 * Creates a complete stack (ModelRegistry, ObjectPool, TransactionQueue, etc.)
 * with real implementations backed by mocked I/O for integration tests.
 */

import { ModelRegistry, setActiveRegistry } from '../../ModelRegistry';
import { ObjectPool } from '../../ObjectPool';
import { MockMutationExecutor } from '../mocks/MockMutationExecutor';
import { MockNetworkMonitor } from '../mocks/MockNetworkMonitor';
import { MockWebSocket } from '../mocks/MockWebSocket';
import { MockMutationDispatcher, createTestContext } from '../mocks/MockSyncContext';
import type { TestContextResult } from '../mocks/MockSyncContext';
import {
  registerTestModels,
  createTestConfig,
  resetFixtureCounter,
} from '../fixtures/models';
import { resetDeltaCounter } from '../fixtures/deltas';

export interface TestHarness {
  /** Pre-registered ModelRegistry with test models */
  registry: ModelRegistry;

  /** Real ObjectPool with FK indexes configured */
  pool: ObjectPool;

  /** Mock WebSocket for delta injection */
  webSocket: MockWebSocket;

  /** DI context with all mocks */
  context: TestContextResult;

  /** Shorthand: mock mutation executor */
  mutationExecutor: MockMutationExecutor;

  /** Shorthand: mock network monitor */
  networkMonitor: MockNetworkMonitor;

  /** Shorthand: mock mutation dispatcher */
  mutationDispatcher: MockMutationDispatcher;

  /** Cleanup everything */
  cleanup: () => void;
}

export interface TestHarnessOptions {
  /** Start offline (default: false) */
  startOffline?: boolean;
  /** Initial sync ID for mutation executor */
  initialSyncId?: number;
  /** ObjectPool config overrides */
  poolConfig?: {
    maxSize?: number;
    maxAge?: number;
    gcInterval?: number;
    useWeakRefs?: boolean;
  };
}

/**
 * Create a full test harness with real sync engine components + mocked I/O.
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

  // Create DI context with test config
  const testConfig = createTestConfig();
  const context = createTestContext({
    config: testConfig,
    startOffline: options.startOffline,
    mutationExecutorOptions: {
      initialSyncId: options.initialSyncId ?? 1,
    },
  });

  // Create real ObjectPool with FK indexes
  const pool = new ObjectPool(
    {
      maxSize: options.poolConfig?.maxSize ?? 10000,
      maxAge: options.poolConfig?.maxAge ?? 5 * 60 * 1000,
      gcInterval: options.poolConfig?.gcInterval ?? 0, // Disable auto-GC in tests
      useWeakRefs: options.poolConfig?.useWeakRefs ?? false, // Disable WeakRefs for predictable tests
    },
    registry
  );

  // Register FK indexes for test models
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
    mutationDispatcher: context.mocks.mutationDispatcher,
    cleanup: () => {
      pool.clear();
      webSocket.reset();
      context.cleanup();
      resetFixtureCounter();
      resetDeltaCounter();
    },
  };
}
