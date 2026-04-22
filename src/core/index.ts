/**
 * @ablo/sync-engine/core — Framework extension
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
} from '../BaseSyncedStore';

// Core infrastructure
export { SyncClient, type RehydrationStats } from '../SyncClient';
export { Database, type BootstrapResult, type BootstrapRequirements } from '../Database';
export { ObjectPool, ModelScope } from '../ObjectPool';
export { LazyReferenceCollection, type LazyCollectionOptions } from '../LazyReferenceCollection';
export { ModelRegistry, getActiveRegistry, type ExtendedReferenceMetadata, type BackReferenceMetadata } from '../ModelRegistry';
export { TransactionQueue } from '../transactions/TransactionQueue';
export { QueryProcessor } from './QueryProcessor';
export { QueryView, type QueryViewOptions } from './QueryView';
export { ViewRegistry } from './ViewRegistry';
export { ObjectStore } from '../stores/ObjectStore';
export { NetworkMonitor } from '../NetworkMonitor';

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
} from '../sync/SyncWebSocket';
export { BootstrapHelper, type BootstrapData, type BootstrapOptions, type BootstrapFetchResult } from '../sync/BootstrapHelper';
export { postBootstrapRegistry, type PostBootstrapStoreAPI, type PostBootstrapHook } from '../PostBootstrapRegistry';

// Offline transaction queue — moved out of the main barrel in the headless
// audit cleanup (see docs/headless-audit.md §4.1 Task 23). The class
// touches indexedDB + crypto.subtle and therefore cannot live on the main
// headless-clean import path. Framework-level consumers (the few files
// that orchestrate sync) import from /core explicitly.
export { OfflineTransactionStore, offlineTxStore, Priority } from '../sync/OfflineTransactionStore';

// Types used by framework-level code
export { PropertyType, LoadStrategy, MutationOperationType } from '../types';
export type {
  PropertyMetadata,
  ReferenceMetadata,
  ModelMetadata,
  SyncAction,
  DeltaPacket,
  BootstrapMetadata,
  DatabaseMetadata,
} from '../types';
export type { ModelData } from '../BaseSyncedStore';
