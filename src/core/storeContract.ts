/**
 * storeContract — the framework-neutral store contract.
 *
 * `SyncStoreContract` is the minimal store interface the SDK's hooks and
 * mutators program against; `BaseSyncedStore` is the concrete engine class
 * that implements it. The contract used to live in `react/context.ts`, which
 * meant the CORE store layer imported its own contract from the React
 * adapter (a module that runtime-imports 'react') — an L2-core →
 * react-integration inversion and a module cycle. It now lives here, in a
 * dependency-free core leaf: `react/context.ts` re-exports these types so
 * React consumers are unchanged, and the core layer never touches 'react'.
 *
 * Everything in this module is type-only — no runtime imports, no runtime
 * exports beyond erased interfaces.
 */

import type { Model } from '../Model.js';
import type { ModelScope } from '../types/index.js';
import type { QueryView, QueryViewOptions } from './QueryView.js';
import type { ViewRegistry } from './ViewRegistry.js';
import type { ParticipantScope } from '../sync/participants.js';

/** Sync status for UI binding */
export interface SyncStatus {
  state: 'idle' | 'syncing' | 'error' | 'offline' | 'reconnecting';
  progress: number;
  error?: Error;
  /** When true, the error is a session/auth error requiring re-authentication. */
  isSessionError: boolean;
  lastSyncAt?: Date;
  pendingChanges: number;
  offlineSince?: Date;
}

/**
 * A single LOCAL mutation as observed off the commit stream — the substrate
 * the undo system records from. One is emitted per local create/update/
 * delete/archive (remote/collaborator deltas never appear here: they apply
 * through a separate pool path that doesn't queue mutations). `previousData`
 * holds the pre-edit field values (captured from the model's
 * `modifiedProperties` first-old-wins baseline), so an inverse op is fully
 * derivable from the event alone — no separate snapshot pass.
 *
 * This mirrors how Yjs's `UndoManager` derives reverse-ops by observing the
 * doc and Liveblocks' `room.history` records room ops: undo listens to the
 * one place all local writes converge, rather than wrapping the write call.
 */
export interface LocalMutation {
  type: 'create' | 'update' | 'delete' | 'archive' | 'unarchive';
  /** Registered model name (e.g. `'SlideLayer'`); resolved to a schema key by the recorder. */
  modelName: string;
  modelId: string;
  /** New field values (create/update). */
  data?: Record<string, unknown> | null;
  /** Pre-edit field values (update → inverse patch; delete → full re-create row). */
  previousData?: Record<string, unknown> | null;
}

/**
 * Minimal store interface that the SDK hooks need.
 * Consumers provide their concrete store (e.g., SyncedStore) that implements this.
 */
export interface SyncStoreContract {
  /**
   * Subscribe to the LOCAL mutation stream (optimistic, pre-ack) for undo
   * recording. Optional so minimal test doubles can omit it — when absent,
   * undo scopes simply record nothing. The concrete store
   * (`BaseSyncedStore`) wires this to the TransactionQueue's
   * `transaction:created` event. Returns an unsubscribe function.
   */
  subscribeLocalMutations?(handler: (mutation: LocalMutation) => void): () => void;
  retrieve(modelClass: abstract new (...args: never[]) => Model, id: string): Model | undefined;
  queryByClass(
    modelClass: abstract new (...args: never[]) => Model,
    options?: {
      predicate?: (model: Model) => boolean;
      scope?: ModelScope;
      orderBy?: keyof Model;
      order?: 'asc' | 'desc';
      limit?: number;
      offset?: number;
    }
  ): { data: Model[] };
  /**
   * Save (create or update) one entity. Calling `save` in a tight loop
   * produces a single wire commit with one `batchIndex`: the SyncClient
   * debounces IDB persistence and the server push to one microtask, and
   * TransactionQueue coalesces every transaction staged in the tick into
   * one batch. There is intentionally no `saveMany` — Zero, Replicache,
   * and the rest of the local-first lineage all expose one-row writes
   * and rely on the implicit tick boundary.
   *
   * `skipValidation` exists for trusted bulk paths (AI sandbox layer
   * generation, PPTX import, hydration) where the producer has already
   * type-checked and per-row Zod is a measurable cost.
   */
  save(model: Model, options?: { skipValidation?: boolean }): Promise<void>;
  delete(model: Model): Promise<void>;
  archive(model: Model): Promise<void>;
  unarchive(model: Model): Promise<void>;
  /** The ObjectPool — for entity/collection lookups by ID or typename. */
  pool: {
    get(id: string): Model | undefined;
    getByTypeName(typename: string, scope?: ModelScope): Model[];
    getByForeignKey(modelName: string, fieldName: string, fieldValue: string): Model[];
    createFromData(data: Record<string, unknown>): Model | null;
    hasForeignKeyIndex(typename: string, fieldName: string): boolean;
    createView<T extends Record<string, unknown>>(typename: string, options?: QueryViewOptions<T>): QueryView<T>;
    viewRegistry: ViewRegistry;
  };
  /**
   * Reactive sync-status getters. Powered by MobX `computed` inside
   * `BaseSyncedStore`, so they're safe to read in `observer` components
   * and inside `reaction(() => store.isReady, ...)`. Consumers that
   * don't want to touch MobX should prefer the `useSyncStatus()` hook.
   */
  readonly isReady: boolean;
  readonly isSyncing: boolean;
  readonly isOffline: boolean;
  readonly isReconnecting: boolean;
  readonly isError: boolean;
  readonly hasUnsyncedChanges: boolean;
  /**
   * Area-of-interest (dynamic read subscription). `enterScope`/`leaveScope`
   * move the connection's read interest as the user navigates (open/close a
   * deck, sheet, doc); `pinScope`/`unpinScope` express prominence (an active
   * claim keeps a group subscribed). Each resolves the scope through the same
   * resolver the claim path uses, so read interest and write claims agree on
   * the sync-group string. Optional so minimal test doubles can omit them;
   * no-ops before the socket exists. The concrete store (`BaseSyncedStore`)
   * forwards to its `AreaOfInterestManager`.
   */
  enterScope?(scope: ParticipantScope, opts?: { hydrate?: boolean }): Promise<void>;
  leaveScope?(scope: ParticipantScope): Promise<void>;
  pinScope?(scope: ParticipantScope): Promise<void>;
  unpinScope?(scope: ParticipantScope): Promise<void>;
  /**
   * Raw MobX-observable `SyncStatus` record. `useSyncStatus()` reads
   * `state`, `progress`, `pendingChanges`, `isSessionError`, `error`
   * from this to build its tagged union. Exposed on the contract so
   * consumer-facing hooks and test doubles can manipulate it directly.
   */
  readonly syncStatus: SyncStatus;
}
