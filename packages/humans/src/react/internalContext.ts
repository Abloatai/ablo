'use client';

import { createContext } from 'react';
import type { AbloClient as Ablo } from '../client.js';
import type { SchemaRecord } from '@abloatai/transaction/schema/schema';

/** The provider owns only the reference to the application-owned client. */
export interface AbloInternalContextValue {
  engine: Ablo<SchemaRecord> | null;
}

export const AbloInternalContext = createContext<AbloInternalContextValue | null>(null);
