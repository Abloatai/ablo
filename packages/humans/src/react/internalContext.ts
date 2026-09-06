'use client';

import { createContext } from 'react';
import type { AbloClient as Ablo } from '../client.js';
import type { SchemaRecord } from '@abloatai/transaction/schema/schema';

/** The provider owns only the reference to the application-owned client. */
export interface AbloInternalContextValue {
  /**
   * The typed `Ablo` client for this provider, available before bootstrap resolves. It is held here so `useAblo()` can return it without
   * reaching into the store; the client and the store are sibling objects, and
   * neither is derived from the other.
   *
   * It is typed loosely as `Ablo<SchemaRecord>` because generics do not flow
   * through React context. `useAblo<R>()` restores the precise type through its
   * own generic; the runtime value is the fully typed client.
   */
  engine: Ablo<SchemaRecord> | null;
}

export const AbloInternalContext = createContext<AbloInternalContextValue | null>(null);
