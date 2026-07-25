/**
 * The framework-extension entry point of this package. Import from here only
 * when you are building on top of the sync engine — wiring your own store and
 * provider stack, writing a sync adapter, or driving a test harness. Everyday
 * application code should use the `Ablo({ schema })` client from the package
 * root instead; the primitives exported here are lower-level building blocks.
 *
 * The surface is deliberately narrow: it exposes only the types and classes an
 * extension actually needs. Anything the engine does not export here is
 * internal and may change.
 */

// The base store class, plus the constructor shapes that subclasses reference.
export {
  BaseSyncedStore,
  type ModelConstructor,
  type ConcreteModelConstructor,
} from './local/BaseSyncedStore.js';

// Core infrastructure classes
export { SyncClient } from './local/SyncClient.js';
export { Database } from './local/Database.js';
export { InstanceCache, ModelScope } from './local/InstanceCache.js';
/** @deprecated `ObjectPool` was renamed to {@link InstanceCache} — the class is an
 *  identity-map cache of live model instances, not a reuse pool. This alias keeps existing
 *  imports working and will be removed in a future major version. */
export { InstanceCache as ObjectPool } from './local/InstanceCache.js';
export { Model } from './local/Model.js';
export {
  LazyReferenceCollection,
  type LazyCollectionOptions,
} from './local/LazyReferenceCollection.js';
export {
  ModelRegistry,
  getActiveRegistry,
} from './local/ModelRegistry.js';

// A lower-level network read primitive. Prefer `ablo.<model>.list(...)` for
// ordinary reads; reach for this only when writing a custom on-demand loader.
export { postQuery, type PostQueryOptions } from './local/query/client.js';

// Computes a dependency-safe ordering for a set of models by walking their
// foreign-key relationships, so writes commit parents before children. Used by
// schema-aware test fixtures and scaffolding tools.
export { computeFKDepthPriority } from './local/client/schemaConfig.js';

// ── Provider-facing dependency-injection types ──
// The interfaces you implement to plug your own services into the provider
// stack — a logger, an observability sink, a mutation executor, a
// session-error detector, and so on.
// The two `Sync*` names below are deprecated aliases removed in 0.36.0. A
// barrel has to keep re-exporting its own aliases until then, or consumers
// lose them a version early — so the deprecation is acknowledged, not heeded.
export type {
  // eslint-disable-next-line @typescript-eslint/no-deprecated
  SyncLogger,
  // eslint-disable-next-line @typescript-eslint/no-deprecated
  SyncObservabilityProvider,
  MutationExecutor,
  SessionErrorDetector,
  OnlineStatusProvider,
  MutationCommitResult,
  MutationOperation,
  MutationOptions,
} from './local/interfaces/index.js';
export type {
  MutationCommitResult as CommitResult,
} from './local/interfaces/index.js';

// The sync layer: the WebSocket wrapper and the delta shape it carries. Needed
// when writing a sync adapter or a multi-participant test harness.
export {
  SyncWebSocket,
  type SyncDelta,
  type SyncWebSocketOptions,
} from './local/sync/SyncWebSocket.js';
export { BootstrapFetcher } from './local/sync/BootstrapFetcher.js';
/** @deprecated `BootstrapHelper` was renamed to {@link BootstrapFetcher}. This alias keeps
 *  existing imports working and will be removed in a future major version. */
export { BootstrapFetcher as BootstrapHelper } from './local/sync/BootstrapFetcher.js';

// The lower-level claim-coordination primitives behind the `ablo.<model>.claim`
// API. `createClaimStream` builds the announce-and-await machinery on top of a
// `SyncWebSocket`; `awaitClaimGrant` coordinates fair, first-in-first-out
// grants. These are for extension code and test harnesses; ordinary
// application code should use `ablo.<model>.claim`.
export {
  createClaimStream,
  type AttachableClaimStream,
  type ClaimStreamConfig,
} from './local/sync/createClaimStream.js';
export {
  awaitClaimGrant,
  type GrantTransport,
} from '@ablo/transaction/coordination/awaitClaimGrant';

// An enum naming the strategies for loading a model's data. Referenced when
// registering models in extension code.
export { LoadStrategy } from '@ablo/transaction/types';

// Construction-only options used by extension packages that assemble the
// client around an existing store/provider. Kept on the explicit extension
// surface so those packages do not need the private alias package.
export type { InternalAbloOptions } from './local/client/options.js';
