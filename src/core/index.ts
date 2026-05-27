/**
 * @abloatai/ablo/core — Framework extension
 *
 * Only imported by SyncedStore.ts and ApplicationStore.ts —
 * the 2-3 files that extend or orchestrate the sync engine.
 * Regular model files and components should NOT import from here.
 */

// Base store class
export {
  BaseSyncedStore,
  type SyncStatus,
  type UserContext,
  type SyncedStoreConfig,
  type QueryResult,
  type SmartSyncOptions,
  type ModelConstructor,
  type ConcreteModelConstructor,
  BOOTSTRAP_CONFIG,
} from '../BaseSyncedStore.js';

// Core infrastructure
export { SyncClient, type RehydrationStats } from '../SyncClient.js';
export { Database, type BootstrapResult, type BootstrapRequirements } from '../Database.js';
export { ObjectPool, ModelScope } from '../ObjectPool.js';
export { Model } from '../Model.js';
export { LazyReferenceCollection, type LazyCollectionOptions } from '../LazyReferenceCollection.js';
// Undo runtime — `useUndoScope` hook from `@abloatai/ablo/react` is
// the canonical access path. Type counterparts (`Ablo.Mutator.UndoScope`,
// `Ablo.Mutator.UndoEntry`, `Ablo.Mutator.InverseOp`) live on the main `Ablo`
// namespace. Direct class access (tests, non-React hosts) imports via
// the package's internal subpath.
// Lower-level network primitives — exposed here for the per-app demand
// loaders. The main barrel hides these so consumer code converges on
// `ablo.<model>.fetch(...)` for hydration. Loaders that haven't been
// migrated yet can keep importing from `/core`.
export { postQuery, type PostQueryOptions } from '../query/client.js';
export { probeNetwork, type ProbeResult } from '../sync/NetworkProbe.js';
export {
  ConnectionManager,
  type ConnectionState,
  type ConnectionEvent,
  type ConnectionCallbacks,
  type ConnectionManagerOptions,
} from '../sync/ConnectionManager.js';
export { ModelRegistry, getActiveRegistry, type ExtendedReferenceMetadata, type BackReferenceMetadata } from '../ModelRegistry.js';
// FK-cycle / dependency-order helper — used by schema-aware test
// fixtures and scaffolding tools to compute commit ordering. Lives
// here because it traverses model relations and isn't part of the
// consumer-facing API.
export { computeFKDepthPriority, type InternalAbloOptions } from '../client/Ablo.js';
export { TransactionQueue } from '../transactions/TransactionQueue.js';

// ── Provider-facing DI types (was the deleted `/config` subpath) ──
// Adapters that the consumer wires into `<AbloProvider>` props
// (logger, observability, mutation executor, session-error
// detector, etc.) implement these interfaces. Lives on `/core`
// because most consumers don't need them; only apps that wrap the
// provider with custom adapters reach for them.
export { initSyncEngine, resetSyncEngine, isSyncEngineInitialized } from '../context.js';
export {
  noopLogger,
  noopObservability,
  noopAnalytics,
  browserOnlineStatus,
  defaultSessionErrorDetector,
  emptyConfig,
  type SyncEngineContext,
} from '../SyncEngineContext.js';
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
export { SyncSessionError } from '../errors.js';
export { QueryProcessor } from './QueryProcessor.js';
export { QueryView, type QueryViewOptions } from './QueryView.js';
export { ViewRegistry } from './ViewRegistry.js';
export { ObjectStore } from '../stores/ObjectStore.js';
export { NetworkMonitor } from '../NetworkMonitor.js';

// Sync layer
export {
  SyncWebSocket,
  type SyncDelta,
  type VersionVector,
  type BootstrapHint,
  type SyncGroupChangePayload,
  type BootstrapDataEvent,
  type PresenceUpdateEvent,
  type SyncWebSocketOptions,
} from '../sync/SyncWebSocket.js';
export { BootstrapHelper, type BootstrapData, type BootstrapOptions, type BootstrapFetchResult } from '../sync/BootstrapHelper.js';

// Intent coordination primitives (the lower-level pieces behind the
// consumer-facing `ablo.<model>.claim`). The stream factory builds the
// announce/await machinery on a SyncWebSocket; `awaitIntentGrant` is the
// fair-queue grant coordinator. Exposed on /core for framework-level
// orchestration and e2e harnesses — NOT on the consumer `.` root.
export {
  createIntentStream,
  type AttachableIntentStream,
  type IntentStreamConfig,
} from '../sync/createIntentStream.js';
export {
  awaitIntentGrant,
  type GrantTransport,
} from '../sync/awaitIntentGrant.js';

// Offline transaction queue — moved out of the main barrel in the headless
// audit cleanup (see docs/headless-audit.md §4.1 Task 23). The class
// touches indexedDB + crypto.subtle and therefore cannot live on the main
// headless-clean import path. Framework-level consumers (the few files
// that orchestrate sync) import from /core explicitly.
export { OfflineTransactionStore, offlineTxStore, Priority } from '../sync/OfflineTransactionStore.js';

// Types used by framework-level code
export { PropertyType, LoadStrategy, MutationOperationType } from '../types/index.js';
export type {
  PropertyMetadata,
  ReferenceMetadata,
  ModelMetadata,
  SyncAction,
  DeltaPacket,
  BootstrapMetadata,
  DatabaseMetadata,
} from '../types/index.js';
export type { ModelData } from '../BaseSyncedStore.js';
