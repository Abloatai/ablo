'use client';

import { createContext, useContext } from 'react';
import type { Schema } from '@abloatai/transaction/schema/schema';
import type { SyncStoreContract } from '../local/storeContract.js';
import { AbloValidationError } from '@abloatai/transaction/errors';

// `SyncStoreContract` and `LocalMutation` are defined in a React-free module,
// so code that never touches React can still implement the store. They are
// re-exported here for the convenience of React consumers.
export type {
  SyncStoreContract,
  LocalMutation,
} from '../local/storeContract.js';

export interface AbloStoreContextValue {
  store: SyncStoreContract;
  /** The organization id used as the default scope for reads and writes. */
  organizationId: string;
  /** Runtime schema used by ambient mutator overloads. */
  schema?: Schema;
}

export const AbloStoreContext = createContext<AbloStoreContextValue | null>(null);

/**
 * Reads the store scope owned by `<AbloProvider>`, throwing a clear error when
 * no provider is mounted above it.
 */
export function useAbloStoreContext(): AbloStoreContextValue {
  const ctx = useContext(AbloStoreContext);
  if (!ctx) {
    throw new AbloValidationError('Ablo hooks must be used within an <AbloProvider>.', {
      code: 'ablo_context_missing_provider',
    });
  }
  return ctx;
}
