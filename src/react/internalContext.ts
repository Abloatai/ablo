'use client';

import { createContext } from 'react';
import type { SyncEngine } from '../client/createSyncEngine';
import type { SchemaRecord } from '../schema/schema';

/**
 * Internal context populated by `<AbloProvider>`. Separate from
 * `SyncContext` (which carries the store + schema for the data
 * hooks) because these fields are owned by the umbrella provider
 * and don't belong on the raw `SyncStoreContract`.
 *
 * Consumers should NOT use this directly — access the fields via
 * the typed hooks (`useCurrentUserId`, `useErrorListener`, etc.).
 */
export interface AbloInternalContextValue {
  /** The user ID passed to `<AbloProvider>`. Stable until the provider remounts on userId change. */
  currentUserId: string;
  /** Subscribe to provider-level errors (engine errors, bootstrap failures, session issues). */
  subscribeError: (listener: (error: Error) => void) => () => void;
  /** Fire an error to all subscribed listeners. Called internally by the provider. */
  emitError: (error: Error) => void;
  /**
   * The SyncEngine proxy for this provider. `null` before bootstrap
   * resolves. Exposed through the internal context so `useSync()`
   * can return it without having to reach into the store — the two
   * are sibling objects constructed together by `createSyncEngine`
   * and shouldn't be coerced through each other.
   *
   * Typed as `SyncEngine<SchemaRecord>` on the context because
   * generics don't flow through React context. `useSync<R>()` widens
   * via its own generic — runtime value is the concrete engine.
   */
  engine: SyncEngine<SchemaRecord> | null;
}

export const AbloInternalContext = createContext<AbloInternalContextValue | null>(null);
