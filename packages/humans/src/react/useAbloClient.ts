'use client';

import { useContext } from 'react';
import type { AbloClient } from '../client.js';
import type { SchemaRecord } from '@abloatai/transaction/schema/schema';
import type { ResolveModels } from '@abloatai/transaction/types/global';
import { AbloInternalContext } from './internalContext.js';

/** Writable client for event handlers. Available before ready(); null without a provider. */
export function useAbloClient<S extends SchemaRecord = ResolveModels>(): AbloClient<S> | null {
  const client = useContext(AbloInternalContext)?.engine;
  // React context erases the schema; the application binding restores it.
  return client ? client as AbloClient<S> : null;
}
