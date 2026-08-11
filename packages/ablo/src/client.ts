export * from '@abloatai/humans';
export { Ablo as default } from '@abloatai/humans';

/**
 * The model layer a consumer needs to build its own stores and adapters.
 *
 * These live in the reactive package's `core` barrel. They are named here one
 * by one rather than star-exported so the published surface stays a decision:
 * an application that defines a synced model, walks the registry, or supplies
 * its own logger reaches these through the SDK instead of importing past it.
 */
export {
  BaseSyncedStore,
  BootstrapFetcher,
  LoadStrategy,
  Model,
  ModelRegistry,
  ModelScope,
  computeFKDepthPriority,
  getActiveRegistry,
  postQuery,
} from '@abloatai/humans/core';
export type {
  CommitResult,
  Database,
  InstanceCache,
  ModelConstructor,
  MutationExecutor,
  MutationOperation,
  OnlineStatusProvider,
  SessionErrorDetector,
  SyncClient,
  SyncLogger,
  SyncObservabilityProvider,
} from '@abloatai/humans/core';

/** Options for the synchronous local-graph reads. */
export type { LocalReadOptions } from '@abloatai/humans/client';
