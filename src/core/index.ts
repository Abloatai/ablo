/**
 * @abloatai/ablo/core — Framework extension
 *
 * Only imported by the handful of files that extend or orchestrate the
 * sync engine (the app-shell store/provider stack, sync adapters, demo
 * harnesses). Regular model files and components should NOT import from
 * here — the consumer surface is `Ablo({ schema })` on the root.
 *
 * TRIMMED to what framework-level consumers actually import (verified by
 * a monorepo-wide import scan). Everything else the engine defines stays
 * module-private: if a new framework concern genuinely needs another
 * primitive, add the export deliberately — don't re-widen the barrel.
 */

// Base store class + the constructor shapes subclasses reference
export {
  BaseSyncedStore,
  type ModelConstructor,
  type ConcreteModelConstructor,
} from '../BaseSyncedStore.js';

// Core infrastructure classes
export { SyncClient } from '../SyncClient.js';
export { Database } from '../Database.js';
export { ObjectPool, ModelScope } from '../ObjectPool.js';
export { Model } from '../Model.js';
export {
  LazyReferenceCollection,
  type LazyCollectionOptions,
} from '../LazyReferenceCollection.js';
export {
  ModelRegistry,
  getActiveRegistry,
} from '../ModelRegistry.js';

// Lower-level network read — for per-app demand loaders that haven't
// migrated to `ablo.<model>.list(...)` yet.
export { postQuery, type PostQueryOptions } from '../query/client.js';

// FK-cycle / dependency-order helper — used by schema-aware test
// fixtures and scaffolding tools to compute commit ordering.
export { computeFKDepthPriority, type InternalAbloOptions } from '../client/Ablo.js';

// ── Provider-facing DI types ──
// Adapters the consumer wires into the provider stack (logger,
// observability, mutation executor, session-error detector, etc.)
// implement these interfaces.
export type {
  SyncLogger,
  SyncObservabilityProvider,
  MutationExecutor,
  MutationDispatcher,
  SessionErrorDetector,
  OnlineStatusProvider,
  CommitResult,
  MutationOperation,
} from '../interfaces/index.js';

// Sync layer — the wire socket + delta shape, for sync adapters and the
// multi-agent demo harnesses.
export {
  SyncWebSocket,
  type SyncDelta,
  type SyncWebSocketOptions,
} from '../sync/SyncWebSocket.js';
export { BootstrapHelper } from '../sync/BootstrapHelper.js';

// Claim coordination primitives (the lower-level pieces behind the
// consumer-facing `ablo.<model>.claim`). The stream factory builds the
// announce/await machinery on a SyncWebSocket; `awaitClaimGrant` is the
// fair-queue grant coordinator. Exposed on /core for framework-level
// orchestration and e2e harnesses — NOT on the consumer `.` root.
export {
  createClaimStream,
  type AttachableClaimStream,
  type ClaimStreamConfig,
} from '../sync/createClaimStream.js';
export {
  awaitClaimGrant,
  type GrantTransport,
} from '../sync/awaitClaimGrant.js';

// Schema/model load strategy enum — referenced by model registration in
// framework code.
export { LoadStrategy } from '../types/index.js';
