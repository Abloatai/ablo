/**
 * @abloatai/ablo/config — App initialization
 *
 * One-time setup at app boot. Provides DI interface types
 * and the initSyncEngine() function to wire real implementations.
 */

// Context lifecycle
export { initSyncEngine, resetSyncEngine, isSyncEngineInitialized } from '../context.js';

// Context type + no-op defaults (for testing or gradual adoption)
export {
  noopLogger,
  noopObservability,
  noopAnalytics,
  browserOnlineStatus,
  defaultSessionErrorDetector,
  emptyConfig,
  type SyncEngineContext,
} from '../SyncEngineContext.js';

// DI interface types
export type {
  SyncEngineConfig,
  SyncLogger,
  SyncObservabilityProvider,
  SyncAnalytics,
  MutationExecutor,
  MutationDispatcher,
  SessionErrorDetector,
  OnlineStatusProvider,
  CommitResult,
  MutationOperation,
  BreadcrumbLevel,
  SyncBreadcrumbCategory,
  TransactionFailureDetails,
  BootstrapFailureDetails,
  WebSocketErrorDetails,
  RollbackDetails,
  SpanAttributes,
} from '../interfaces/index.js';

// Errors
export { SyncSessionError } from '../errors.js';
