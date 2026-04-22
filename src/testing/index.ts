/**
 * @ablo/sync-engine/testing — Public test utilities for SDK consumers.
 *
 * Provides mock implementations, fixture factories, and test harnesses
 * for writing integration tests against the sync engine.
 */

// ─────────────────────────────────────────────
// Mocks
// ─────────────────────────────────────────────

export { MockMutationExecutor } from './mocks/MockMutationExecutor';
export type { CapturedMutation, MockMutationExecutorOptions } from './mocks/MockMutationExecutor';

export { MockNetworkMonitor } from './mocks/MockNetworkMonitor';

export { MockWebSocket } from './mocks/MockWebSocket';
export type { MockDelta, MockBootstrapHint } from './mocks/MockWebSocket';

export {
  createTestContext,
  MockMutationDispatcher,
} from './mocks/MockSyncContext';
export type { TestContextOptions, TestContextResult } from './mocks/MockSyncContext';

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
} from './fixtures/models';

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
} from './fixtures/deltas';

// ─────────────────────────────────────────────
// Fixtures: Bootstrap
// ─────────────────────────────────────────────

export {
  createFullBootstrapResponse,
  createPartialBootstrapResponse,
  createTestBootstrapResponse,
} from './fixtures/bootstrap';
export type { BootstrapModelData, BootstrapResponse } from './fixtures/bootstrap';

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

export {
  createTestHarness,
} from './helpers/sync-engine-harness';
export type { TestHarness, TestHarnessOptions } from './helpers/sync-engine-harness';

export {
  flushMicrotasks,
  waitFor,
  delay,
  afterMicrotasks,
} from './helpers/wait';

// React testing helpers
export {
  createReactTestWrapper,
  renderSyncHook,
  MockSyncStore,
  createMockSyncStore,
  type TestWrapperOptions,
} from './helpers/react-wrapper';
