'use client';

import { createContext, createElement, useContext, type ReactNode } from 'react';
import type { Schema } from '../schema/schema.js';
import type { SyncStoreContract } from '../core/storeContract.js';
import { AbloValidationError } from '../errors.js';

// The store contract (`SyncStoreContract` / `LocalMutation`) moved to the
// react-free leaf core/storeContract.ts — the CORE store layer implements it,
// so it must not live in a module that runtime-imports 'react'. Re-exported
// here so React consumers (and Ablo.ts) are unchanged.
export type { SyncStoreContract, LocalMutation } from '../core/storeContract.js';

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
}

export const SyncContext = createContext<SyncReactContext | null>(null);

/**
 * Access the sync store from React components. The context is provided by
 * `<AbloProvider>` (which renders the internal {@link SyncProvider}); public
 * consumers wire `<AbloProvider client={ablo}>`, never this directly.
 */
export function useSyncContext(): SyncReactContext {
  const ctx = useContext(SyncContext);
  if (!ctx) {
    throw new AbloValidationError('Sync hooks must be used within an <AbloProvider>.', {
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
  children?: ReactNode;
}

/**
 * SyncProvider — the INTERNAL low-level provider that wires a built sync store
 * into React so SDK hooks (useModel, useModels, useMutations) can reach it.
 *
 * Public consumers do NOT use this directly (it is not exported from
 * `@abloatai/ablo/react`). `<AbloProvider client={ablo}>` constructs the
 * store from your `Ablo({ schema, apiKey })` client and renders this provider
 * underneath — reach for `<AbloProvider>`.
 */
export function SyncProvider({
  store,
  organizationId,
  schema,
  children,
}: SyncProviderProps) {
  return createElement(
    SyncContext.Provider,
    { value: { store, organizationId, schema } },
    children
  );
}
