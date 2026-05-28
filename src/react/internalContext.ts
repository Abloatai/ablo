'use client';

import { createContext } from 'react';
import type { Ablo } from '../client/Ablo.js';
import type { SchemaRecord } from '../schema/schema.js';

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
  /**
   * Optional app user id when the application passed one. Hosted Ablo
   * identity is server-derived, so this may be null.
   */
  currentUserId: string | null;
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
   * Typed as `Ablo<SchemaRecord>` on the context because
   * generics don't flow through React context. `useSync<R>()` widens
   * via its own generic — runtime value is the concrete engine.
   */
  engine: Ablo<SchemaRecord> | null;
}

export const AbloInternalContext = createContext<AbloInternalContextValue | null>(null);
