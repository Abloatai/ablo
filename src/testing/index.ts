/**
 * Package-private test scaffolding: mock implementations, fixture factories,
 * and test harnesses for this package's own tests. Not a subpath and not
 * built into dist — the published testing surface for adapter authors is
 * `./source/conformance`. Consumers outside this package write their own
 * doubles against the public contracts (see `MutationExecutor` on `./core`).
 */

// ─────────────────────────────────────────────
// Mocks
// ─────────────────────────────────────────────

export { MockMutationExecutor } from './mocks/MockMutationExecutor.js';
export type { CapturedMutation, MockMutationExecutorOptions } from './mocks/MockMutationExecutor.js';

export { MockNetworkMonitor } from './mocks/MockNetworkMonitor.js';

export { MockWebSocket } from './mocks/MockWebSocket.js';
export type { MockDelta, MockBootstrapHint } from './mocks/MockWebSocket.js';

export { fakeDatabase } from './mocks/FakeDatabase.js';
export type { FakeDatabaseOverrides } from './mocks/FakeDatabase.js';

export {
  createTestContext,
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
} from './helpers/syncEngineHarness.js';
export type { TestHarness, TestHarnessOptions } from './helpers/syncEngineHarness.js';

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
} from './helpers/reactWrapper.js';
