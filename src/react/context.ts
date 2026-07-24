'use client';

import { createContext, createElement, useContext, type ReactNode } from 'react';
import type { Schema } from '../transaction/schema/schema.js';
import type { SyncStoreContract } from '../storeContract.js';
import { AbloValidationError } from '../transaction/errors.js';

// `SyncStoreContract` and `LocalMutation` are defined in a React-free module,
// so code that never touches React can still implement the store. They are
// re-exported here for the convenience of React consumers.
export type { SyncStoreContract, LocalMutation } from '../storeContract.js';

export interface SyncReactContext {
  store: SyncStoreContract;
  /** The organization id used as the default scope for reads and writes. */
  organizationId: string;
  /**
   * An optional schema. When provided, hooks that take a model by name (such as
   * `useQuery('tasks')`) read that model's metadata from this schema, so
   * callers don't pass a schema at every call site. When omitted, those hooks
   * require the schema as an argument instead.
   *
   * The field is loosely typed here because a single runtime context value is
   * shared by every hook. Precise per-model types come from your `Register`
   * module augmentation
   * (`declare module '@abloatai/ablo' { interface Register { Schema: typeof schema } }`),
   * not from this reference.
   */
  schema?: Schema;
}

export const SyncContext = createContext<SyncReactContext | null>(null);

/**
 * Reads the sync store context from inside a provider subtree, throwing a clear
 * error when no provider is mounted above. `<AbloProvider>` supplies this
 * context by rendering the internal {@link SyncProvider}; you wire
 * `<AbloProvider client={ablo}>` rather than touching this directly.
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
  /** The sync store, which must implement {@link SyncStoreContract}. */
  store: SyncStoreContract;
  /** The organization id used as the default scope for reads and writes. */
  organizationId: string;
  /**
   * An optional schema. Provide it to enable hooks that take a model by name
   * (such as `useQuery('tasks')`); the model types also narrow through your
   * `Register` augmentation. Omit it to pass the schema to those hooks directly
   * instead.
   */
  schema?: Schema;
  children?: ReactNode;
}

/**
 * A low-level provider that places a built sync store on React context so the
 * data hooks can reach it. This is an internal building block: it is not part
 * of the package's public entry point. Reach for `<AbloProvider>` instead,
 * which builds the store from your `Ablo({ schema, apiKey })` client and
 * renders this provider underneath.
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
