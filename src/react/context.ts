'use client';

import { createContext, createElement, useContext, type ReactNode } from 'react';
import type { Model } from '../Model.js';
import type { ModelScope } from '../types/index.js';
import type { QueryView, QueryViewOptions } from '../core/QueryView.js';
import type { ViewRegistry } from '../core/ViewRegistry.js';
import type { Schema } from '../schema/schema.js';
import type { SyncStatus } from '../BaseSyncedStore.js';
import type { ParticipantScope } from '../sync/participants.js';
import { AbloValidationError } from '../errors.js';

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

export interface SyncReactContext {
  store: SyncStoreContract;
  /** Current organization ID for default entity context */
  organizationId: string;
  /**
   * Optional schema reference. When set, compatibility hook overloads
   * (`useQuery('tasks')`, `useOne('tasks', id)`, etc.) resolve their
   * model metadata from this schema — consumers don't pass `schema` at
   * every call site. When absent, hooks fall back to the legacy
   * `(schema, modelKey, …)` signatures so non-opting consumers keep
   * working unchanged.
   *
   * The stored reference is untyped here (`Schema` with default
   * parameters) because the React context is a single runtime value
   * shared by every hook. The compile-time types flow from the
   * consumer's `declare module '@abloatai/ablo' { interface Register { Schema: ... } }`
   * augmentation — see `src/types/global.ts`.
   */
  schema?: Schema;
  /**
   * Optional presence source. When set, `usePresence()` returns this
   * value cast to the consumer's `ResolvePresence` type (declared via
   * `interface Register { Presence: ... }`). The SDK doesn't own a
   * presence wire format — consumers plug whatever backs their cursors,
   * status, or activity state (a MobX store, a Zustand slice, a custom
   * subscription). The typed-global gives it a call-site-ergonomic
   * type without the SDK dictating the transport.
   */
  presence?: unknown;
  /**
   * Optional claim initiator. Same pattern as presence — consumers
   * plug a function that turns an claim claim into a handle they
   * control (WebSocket send, optimistic local update, whatever).
   * `useClaim(name)` returns a typed invoker for the named claim
   * from `interface Register { Claims: ... }`.
   */
  beginClaim?: (claimName: string, claim: unknown) => unknown;
}

export const SyncContext = createContext<SyncReactContext | null>(null);

/**
 * Access the sync store from React components.
 * Must be used within a SyncProvider.
 */
export function useSyncContext(): SyncReactContext {
  const ctx = useContext(SyncContext);
  if (!ctx) {
    throw new AbloValidationError('useSyncContext must be used within a SyncProvider', {
      code: 'sync_context_missing_provider',
    });
  }
  return ctx;
}

/**
 * Props for SyncProvider.
 */
export interface SyncProviderProps {
  /** The sync store (must implement SyncStoreContract). */
  store: SyncStoreContract;
  /** Current organization ID for default entity context. */
  organizationId: string;
  /**
   * Optional schema. Wire this when you want compatibility string-keyed hooks
   * (`useQuery('tasks')`) — the schema type also narrows via the
   * consumer's `Register` registration. Omit to keep hooks on
   * their legacy `(schema, modelKey, …)` signatures.
   */
  schema?: Schema;
  /**
   * Optional presence source for `usePresence()`. See
   * {@link SyncReactContext.presence} — the consumer plugs whatever
   * backs their presence state; the hook returns it with
   * `ResolvePresence` typing.
   */
  presence?: unknown;
  /**
   * Optional claim initiator for `useClaim()`. See
   * {@link SyncReactContext.beginClaim}.
   */
  beginClaim?: (claimName: string, claim: unknown) => unknown;
  children?: ReactNode;
}

/**
 * SyncProvider wires the sync store into React so SDK hooks
 * (useModel, useModels, useMutations) can access it.
 *
 * @example
 * import { SyncProvider } from '@abloatai/ablo/react';
 *
 * function App() {
 *   return (
 *     <SyncProvider store={syncStore} organizationId={orgId}>
 *       <YourApp />
 *     </SyncProvider>
 *   );
 * }
 */
export function SyncProvider({
  store,
  organizationId,
  schema,
  presence,
  beginClaim,
  children,
}: SyncProviderProps) {
  return createElement(
    SyncContext.Provider,
    { value: { store, organizationId, schema, presence, beginClaim } },
    children
  );
}
