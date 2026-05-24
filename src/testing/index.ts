/**
 * @ablo/sync-engine/testing — Public test utilities for SDK consumers.
 *
 * Provides mock implementations, fixture factories, and test harnesses
 * for writing integration tests against the sync engine.
 */

// ─────────────────────────────────────────────
// Mocks
// ─────────────────────────────────────────────

export { MockMutationExecutor } from './mocks/MockMutationExecutor.js';
export type { CapturedMutation, MockMutationExecutorOptions } from './mocks/MockMutationExecutor.js';

export { MockNetworkMonitor } from './mocks/MockNetworkMonitor.js';

export { MockWebSocket } from './mocks/MockWebSocket.js';
export type { MockDelta, MockBootstrapHint } from './mocks/MockWebSocket.js';

export {
  createTestContext,
  MockMutationDispatcher,
} from './mocks/MockSyncContext.js';
export type { TestContextOptions, TestContextResult } from './mocks/MockSyncContext.js';

// ─────────────────────────────────────────────
// Fixtures: Models
// ─────────────────────────────────────────────

export {
  TestProject,
  TestTask,
  TestComment,
  TestSlideDeck,
  TestSlide,
  TestSlideLayer,
  TEST_MODEL_PRIORITIES,
  registerTestModels,
  createTestConfig,
  resetFixtureCounter,
  createProjectFixture,
  createTaskFixture,
  createCommentFixture,
  createSlideDeckFixture,
  createSlideFixture,
  createSlideLayerFixture,
} from './fixtures/models.js';

// ─────────────────────────────────────────────
// Fixtures: Deltas
// ─────────────────────────────────────────────

export {
  createDelta,
  createInsertDelta,
  createUpdateDelta,
  createDeleteDelta,
  createArchiveDelta,
  createUnarchiveDelta,
  createCoveringDelta,
  createGroupAddedDelta,
  createLegacyGroupChangeDelta,
  createGroupRemovedDelta,
  createDeltaBatch,
  createConfirmationDelta,
  resetDeltaCounter,
} from './fixtures/deltas.js';

// ─────────────────────────────────────────────
// Fixtures: Bootstrap
// ─────────────────────────────────────────────

export {
  createFullBootstrapResponse,
  createPartialBootstrapResponse,
  createTestBootstrapResponse,
} from './fixtures/bootstrap.js';
export type { BootstrapModelData, BootstrapResponse } from './fixtures/bootstrap.js';

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

export {
  createTestHarness,
} from './helpers/sync-engine-harness.js';
export type { TestHarness, TestHarnessOptions } from './helpers/sync-engine-harness.js';

export {
  flushMicrotasks,
  waitFor,
  delay,
  afterMicrotasks,
} from './helpers/wait.js';

// React testing helpers
export {
  createReactTestWrapper,
  renderSyncHook,
  MockSyncStore,
  createMockSyncStore,
  type TestWrapperOptions,
} from './helpers/react-wrapper.js';
