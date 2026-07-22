/**
 * The framework-neutral store contract. {@link SyncStoreContract} is the minimal
 * store interface the SDK's hooks and mutators are written against, and
 * {@link BaseSyncedStore} is the concrete class that implements it. Framework
 * integrations, such as the React bindings, re-export these types, so a hook can
 * accept any store that satisfies the contract without depending on a particular
 * UI framework.
 *
 * This module is type-only: it has no runtime imports and contributes nothing to
 * the runtime bundle beyond the erased interface declarations.
 */

import type { Model } from '../Model.js';
import type { ModelScope } from '../transaction/types/index.js';
import type { QueryView, QueryViewOptions } from './QueryView.js';
import type { ViewRegistry } from './ViewRegistry.js';
import type { ParticipantScope } from '../sync/participants.js';

/**
 * A snapshot of the client's synchronization state, shaped for binding to UI.
 * {@link SyncStoreContract.syncStatus} exposes a reactive instance of this, and
 * the `useSyncStatus()` hook reads its fields to render connection and progress
 * indicators.
 */
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
 * A single locally-originated mutation, observed as it flows through the commit
 * stream. The undo system records these to build its inverse operations: one is
 * emitted per local create, update, delete, or archive. Changes arriving from
 * other participants do not appear here — they apply through a separate path
 * that does not queue mutations. Because `previousData` captures the field
 * values as they were before the edit, each event carries everything needed to
 * derive its inverse, with no separate snapshot step. A store exposes this
 * stream through {@link SyncStoreContract.subscribeLocalMutations}.
 */
export interface LocalMutation {
  type: 'create' | 'update' | 'delete' | 'archive' | 'unarchive';
  /** The registered name of the mutated model, for example `'Block'`. */
  modelName: string;
  modelId: string;
  /** The new field values, for a create or an update. */
  data?: Record<string, unknown> | null;
  /** The field values as they were before the edit. For an update these form
   *  the inverse patch; for a delete they hold the full row needed to recreate
   *  it. */
  previousData?: Record<string, unknown> | null;
}

/**
 * The minimal store interface the SDK's hooks and mutators depend on. Provide a
 * concrete store that implements it — {@link BaseSyncedStore} is the built-in
 * implementation — and the hooks work against your store without knowing its
 * exact type. Optional members exist so lightweight test doubles can implement
 * only the parts they exercise.
 */
export interface SyncStoreContract {
  /**
   * Subscribes to the stream of local mutations for undo recording, delivering
   * each optimistic write before it is acknowledged by the server. See
   * {@link LocalMutation}. Returns a function that removes the subscription.
   * This is optional: when a store does not implement it, undo scopes simply
   * record nothing.
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
   * Saves one entity, creating it if new or updating it if it already exists.
   * Calling `save` repeatedly within the same tick is efficient: the writes are
   * coalesced and persisted, then sent to the server, as a single commit. There
   * is deliberately no bulk method — issue one `save` per row and let the tick
   * boundary batch them.
   *
   * Pass `skipValidation` on trusted, high-volume paths — bulk import or
   * hydration, where the data has already been validated — to skip the per-row
   * schema check, which is a measurable cost at that volume.
   */
  save(model: Model, options?: { skipValidation?: boolean }): Promise<void>;
  delete(model: Model): Promise<void>;
  archive(model: Model): Promise<void>;
  unarchive(model: Model): Promise<void>;
  /** The in-memory object pool: look up individual entities or collections by
   *  id or model name, create views, and resolve foreign-key relationships. */
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
   * Reactive getters for the current sync state. In the built-in store these
   * are backed by observable computeds, so reading them inside a reactive
   * context — an observer component or a reaction — re-runs that context when
   * the state changes. Code that prefers not to work with the reactivity system
   * directly can read the same values through the `useSyncStatus()` hook.
   */
  readonly isReady: boolean;
  readonly isSyncing: boolean;
  readonly isOffline: boolean;
  readonly isReconnecting: boolean;
  readonly isError: boolean;
  readonly hasUnsyncedChanges: boolean;
  /**
   * Manages the connection's area of interest — the dynamic set of data it
   * subscribes to. Call `enterScope` and `leaveScope` to move that interest as
   * the user navigates between documents, and `pinScope` and `unpinScope` to
   * keep a scope subscribed while it stays important, such as while a claim is
   * held. Every scope resolves through the same resolver the claim path uses, so
   * read subscriptions and write claims always agree on which group they refer
   * to. These are optional and do nothing until the connection is open.
   */
  enterScope?(scope: ParticipantScope, opts?: { hydrate?: boolean }): Promise<void>;
  leaveScope?(scope: ParticipantScope): Promise<void>;
  pinScope?(scope: ParticipantScope): Promise<void>;
  unpinScope?(scope: ParticipantScope): Promise<void>;
  /**
   * The full reactive {@link SyncStatus} record. The `useSyncStatus()` hook
   * reads its fields — `state`, `progress`, `pendingChanges`, `isSessionError`,
   * and `error` — to present the current sync state. It is part of the contract
   * so hooks and test doubles can read or set it directly.
   */
  readonly syncStatus: SyncStatus;
}
