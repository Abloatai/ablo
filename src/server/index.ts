/**
 * The server-side entry point of the sync engine. It re-exports the contract types
 * you implement a storage backend against: the {@link DataAdapter} and its
 * vocabulary ({@link Row}, {@link ReadRequest}, {@link ChangeSet}, and the rest),
 * the {@link CommitContext} and {@link CommitResult} commit types, the
 * {@link StorageMode} enumeration, and the per-model read configuration
 * ({@link BootstrapModel}, {@link ColumnOverride}). These are plain, driver-free
 * types; you supply the database code that fulfills them.
 */
export type {
  Row,
  ReadResult,
  SyncCursor,
  DataAdapterCapabilities,
  ProposalResult,
  ReadRequest,
  ChangeSet,
  SyncResult,
  DataAdapter,
  ProposableDataAdapter,
  AdapterResolver,
} from './adapter.js';
export type { CommitContext, CommitResult } from './commit.js';
export { commitExecutionResultSchema } from '../wire/commit.js';
export { storageModeSchema, type StorageMode } from './storageMode.js';
export type { ColumnOverride, BootstrapModel } from './readConfig.js';
