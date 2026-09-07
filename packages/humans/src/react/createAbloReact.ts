'use client';

import type { ReactElement } from 'react';
import { useAbloClient } from './useAbloClient.js';
import { useMutationFailure } from './useMutationFailure.js';
import { AbloProvider } from './AbloProvider.js';
import { useAblo } from './useAblo.js';
import type { AbloClient as Ablo } from '../client.js';
import type { Schema, SchemaRecord } from '@abloatai/transaction/schema/schema';
import { usePresence } from './usePresence.js';

/** Shared provider and hooks specialized to one schema. */
export interface AbloReactBinding<S extends SchemaRecord> {
  AbloProvider: (props: AbloProvider.Props<S>) => ReactElement;
  useAblo: useAblo.Bound<S>;
  /** Writable client for actions; useAblo(selector) supplies render snapshots. */
  useAbloClient: () => Ablo<S> | null;
  useMutationFailure: typeof useMutationFailure;
  /** Declare and reactively read record presence with the same model clients. */
  usePresence: usePresence.Bound<S>;
}

/** Bind the existing React functions to one schema's types. */
export function createAbloReact<S extends SchemaRecord>(
  schema: Schema<S>,
): AbloReactBinding<S> {
  void schema;

  // Specialize the shared functions without creating new contexts or identities.
  return { AbloProvider, useAblo, useAbloClient, useMutationFailure, usePresence } as AbloReactBinding<S>;
}
