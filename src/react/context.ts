'use client';

import { createContext, createElement, useContext, type ReactNode } from 'react';
import type { Model } from '../Model';
import type { ModelScope } from '../types';
import type { QueryView, QueryViewOptions } from '../core/QueryView';
import type { ViewRegistry } from '../core/ViewRegistry';
import type { Schema } from '../schema/schema';
import type { SyncStatus } from '../BaseSyncedStore';
import { AbloValidationError } from '../errors';

/**
 * Minimal store interface that the SDK hooks need.
 * Consumers provide their concrete store (e.g., SyncedStore) that implements this.
 */
export interface SyncStoreContract {
  findById(modelClass: abstract new (...args: never[]) => Model, id: string): Model | undefined;
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
  save(model: Model): Promise<void>;
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
   * Optional schema reference. When set, zero-arg hook overloads
   * (`useQuery('tasks')`, `useOne('tasks', id)`, etc.) resolve their
   * model metadata from this schema — consumers don't pass `schema` at
   * every call site. When absent, hooks fall back to the legacy
   * `(schema, modelKey, …)` signatures so non-opting consumers keep
   * working unchanged.
   *
   * The stored reference is untyped here (`Schema` with default
   * parameters) because the React context is a single runtime value
   * shared by every hook. The compile-time types flow from the
   * consumer's `declare global { interface AbloSync { Schema: ... } }`
   * augmentation — see `src/types/global.ts`.
   */
  schema?: Schema;
  /**
   * Optional presence source. When set, `usePresence()` returns this
   * value cast to the consumer's `ResolvePresence` type (declared via
   * `interface AbloSync { Presence: ... }`). The SDK doesn't own a
   * presence wire format — consumers plug whatever backs their cursors,
   * status, or activity state (a MobX store, a Zustand slice, a custom
   * subscription). The typed-global gives it a call-site-ergonomic
   * type without the SDK dictating the transport.
   */
  presence?: unknown;
  /**
   * Optional intent initiator. Same pattern as presence — consumers
   * plug a function that turns an intent claim into a handle they
   * control (WebSocket send, optimistic local update, whatever).
   * `useIntent(name)` returns a typed invoker for the named intent
   * from `interface AbloSync { Intents: ... }`.
   */
  beginIntent?: (intentName: string, claim: unknown) => unknown;
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
   * Optional schema. Wire this when you want zero-arg hooks
   * (`useQuery('tasks')`) — the schema type also narrows via the
   * consumer's global `AbloSync` declaration. Omit to keep hooks on
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
   * Optional intent initiator for `useIntent()`. See
   * {@link SyncReactContext.beginIntent}.
   */
  beginIntent?: (intentName: string, claim: unknown) => unknown;
  children?: ReactNode;
}

/**
 * SyncProvider wires the sync store into React so SDK hooks
 * (useModel, useModels, useMutations) can access it.
 *
 * @example
 * import { SyncProvider } from '@ablo/sync-engine/react';
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
  beginIntent,
  children,
}: SyncProviderProps) {
  return createElement(
    SyncContext.Provider,
    { value: { store, organizationId, schema, presence, beginIntent } },
    children
  );
}
