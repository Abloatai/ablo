/**
 * `@abloatai/ablo/server` — the host-side surface of the sync engine.
 *
 * Today this exposes the DataAdapter CONTRACT vocabulary (see {@link Row}).
 * It will grow to hold the transport/storage-agnostic commit orchestration and
 * the `Hub` core lifted out of `apps/sync-server` (see
 * docs/plans/sync-engine-server-extraction-plan.md). The reference Postgres
 * adapter (`executeCommit`/`selectAdapter`) and the WebSocket process lifecycle
 * stay in the host — only the portable, driver-free pieces live here.
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
export { storageModeSchema, type StorageMode } from './storage-mode.js';
export type { ColumnOverride, BootstrapModel } from './read-config.js';
