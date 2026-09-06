'use client';

/**
 * Capture schema inference once while reusing module-level React functions.
 * This helper creates no components, hooks, contexts or client instances.
 *
 * Define the app binding at module scope:
 * `export const { AbloProvider, useAblo, usePresence } = createAbloReact(schema)`.
 */

import type { ReactElement } from 'react';
import { AbloProvider } from './AbloProvider.js';
import {
  useAblo,
  type AbloSelector,
  type ModelClientSelector,
} from './useAblo.js';
import type { AbloClient as Ablo } from '../client.js';
import type { ModelOperations } from '../local/client/createModelOperations.js';
import type { Schema, SchemaRecord } from '@abloatai/transaction/schema/schema';
import { usePresence, type PresenceModelSelector } from './usePresence.js';
import type { PresenceSession } from '@abloatai/transaction/presence';

/** What a binding returns: the provider and the hook, with `S` fixed. */
export interface AbloReactBinding<S extends SchemaRecord> {
  /** `AbloProvider` with its `client` prop typed `Ablo<S>` — same component,
   *  no per-app generics. */
  AbloProvider: (props: AbloProvider.Props<S>) => ReactElement;
  /** `useAblo` with the schema bound — the same overloads as the global
   *  hook, minus the type arguments. */
  useAblo: {
    (): Ablo<S> | null;
    <T>(select: AbloSelector<S, T>): T | undefined;
    <T, C>(
      modelClientOrSelect: ModelOperations<T, C> | ModelClientSelector<S, T, C>,
      id: string,
      options?: useAblo.Options<T>,
    ): useAblo.Result<T>;
  };
  /** Declare and reactively read record presence with the same model clients. */
  usePresence: <T, C>(
    modelOrSelect: ModelOperations<T, C> | PresenceModelSelector<S, T, C>,
    recordId: string,
  ) => readonly PresenceSession[];
}

/** Bind the existing React functions to one schema's types. */
export function createAbloReact<S extends SchemaRecord>(
  schema: Schema<S>,
): AbloReactBinding<S> {
  void schema;

  // TypeScript cannot partially specialize the generic overloads, so this
  // assertion binds their schema parameter. Positive and negative consumer
  // type tests verify the specialization; no runtime value changes.
  // Specialize types only. Every binding uses the same module-level functions,
  // so calling this helper again cannot change component identity or reset state.
  return { AbloProvider, useAblo, usePresence } as AbloReactBinding<S>;
}
