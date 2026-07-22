'use client';

import { createContext } from 'react';
import type { Ablo } from '../client/Ablo.js';
import type { SchemaRecord } from '../transaction/schema/schema.js';

/**
 * The context that `<AbloProvider>` populates for its own hooks. It is kept
 * separate from the data-hook context, which carries the store and schema,
 * because these fields belong to the provider rather than to the store. Read
 * them through the typed hooks such as `useCurrentUserId` and
 * `useErrorListener` rather than reaching into this context directly.
 */
export interface AbloInternalContextValue {
  /**
   * The application user id, when your app passed one to `<AbloProvider>`. Sync
   * identity is derived on the server from the API key, so this is `null`
   * unless you set it, and it is not required for sync to work.
   */
  currentUserId: string | null;
  /** Subscribe to provider-level errors: engine errors, bootstrap failures, and session issues. */
  subscribeError: (listener: (error: Error) => void) => () => void;
  /** Emit an error to every subscribed listener. The provider calls this for you. */
  emitError: (error: Error) => void;
  /**
   * The typed `Ablo` client for this provider, or `null` until the first sync
   * bootstrap resolves. It is held here so `useSync()` can return it without
   * reaching into the store; the client and the store are sibling objects, and
   * neither is derived from the other.
   *
   * It is typed loosely as `Ablo<SchemaRecord>` because generics do not flow
   * through React context. `useSync<R>()` restores the precise type through its
   * own generic; the runtime value is the fully typed client.
   */
  engine: Ablo<SchemaRecord> | null;
}

export const AbloInternalContext = createContext<AbloInternalContextValue | null>(null);
