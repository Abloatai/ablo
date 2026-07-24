'use client';

/**
 * The typed react binding — the schema generic is captured ONCE, at a factory
 * call in app code, and every hook the factory returns is born typed. This is
 * the shape the reference libraries converged on independently (tRPC's
 * `createTRPCReact`, XState's `createActorContext`, react-redux's
 * `withTypes`): no module augmentation, no generic parameters at call sites,
 * and — once the legacy generic erasure retires — no casts anywhere on the
 * path from context to component.
 *
 * The app's one binding file, by convention:
 *
 * ```ts
 * // lib/ablo.ts
 * import { createAbloReact } from '@abloatai/ablo/react';
 * import { schema } from './schema';
 *
 * export const { AbloProvider, useAblo } = createAbloReact(schema);
 * ```
 *
 * Components then import `useAblo` from `lib/ablo` and never spell a type
 * argument; `useAblo()` is `Ablo<S> | null`, and a selector's `ablo`
 * parameter is the reactive-read view of the same `S`.
 */

import { createContext, createElement, useContext, type ReactElement } from 'react';
import { AbloProvider, type AbloProviderProps } from './AbloProvider.js';
import {
  useAbloImpl,
  type AbloSelector,
  type ModelClientSelector,
  type UseAbloHydratedModelResult,
  type UseAbloModelOptions,
  type UseAbloModelResult,
} from './useAblo.js';
import type { Ablo } from '../client/Ablo.js';
import type { ModelOperations } from '../client/createModelProxy.js';
import type { Schema, SchemaRecord } from '../transaction/schema/schema.js';

/** What a binding returns: the provider and the hook, with `S` fixed. */
export interface AbloReactBinding<S extends SchemaRecord> {
  /** `AbloProvider` with its `client` prop typed `Ablo<S>` — same component,
   *  no per-app generics. */
  AbloProvider: (props: AbloProviderProps<S>) => ReactElement;
  /** `useAblo` with the schema bound — the same overloads as the global
   *  hook, minus the type arguments. */
  useAblo: {
    (): Ablo<S> | null;
    <T>(select: AbloSelector<S, T>): T | undefined;
    <T, C>(
      modelClient: ModelOperations<T, C>,
      id: string,
      options: UseAbloModelOptions<T> & { readonly initial: T },
    ): UseAbloHydratedModelResult<T>;
    <T, C>(
      select: ModelClientSelector<S, T, C>,
      id: string,
      options: UseAbloModelOptions<T> & { readonly initial: T },
    ): UseAbloHydratedModelResult<T>;
    <T, C>(
      modelClient: ModelOperations<T, C>,
      id: string,
      options?: UseAbloModelOptions<T>,
    ): UseAbloModelResult<T>;
    <T, C>(
      select: ModelClientSelector<S, T, C>,
      id: string,
      options?: UseAbloModelOptions<T>,
    ): UseAbloModelResult<T>;
  };
}

/**
 * Bind the react surface to one schema. The schema value is taken for
 * inference — write `createAbloReact(schema)`, never a hand-spelled type
 * argument — and it is the seam where the binding's own typed context arrives
 * when the legacy erasure retires (docs/plans/typed-react-binding.md, step 3).
 */
export function createAbloReact<S extends SchemaRecord>(
  schema: Schema<S>,
): AbloReactBinding<S> {
  void schema;

  // The binding's own context — created here, AFTER the schema generic is
  // known, so it is typed `Ablo<S>` from birth (the XState
  // `createActorContext` shape). A hook that reads it never rebinds and
  // never casts; a binding hook mounted under a legacy provider (no bound
  // provider in the tree) reads `null` here and falls through to the shared
  // implementation's internal-context fallback.
  const BoundClientContext = createContext<Ablo<S> | null>(null);

  function BoundAbloProvider(props: AbloProviderProps<S>): ReactElement {
    return createElement(
      BoundClientContext.Provider,
      { value: props.client },
      createElement(AbloProvider<S>, props),
    );
  }

  function useBoundAblo(): Ablo<S> | null;
  function useBoundAblo<T>(select: AbloSelector<S, T>): T | undefined;
  function useBoundAblo<T, C>(
    modelClient: ModelOperations<T, C>,
    id: string,
    options: UseAbloModelOptions<T> & { readonly initial: T },
  ): UseAbloHydratedModelResult<T>;
  function useBoundAblo<T, C>(
    select: ModelClientSelector<S, T, C>,
    id: string,
    options: UseAbloModelOptions<T> & { readonly initial: T },
  ): UseAbloHydratedModelResult<T>;
  function useBoundAblo<T, C>(
    modelClient: ModelOperations<T, C>,
    id: string,
    options?: UseAbloModelOptions<T>,
  ): UseAbloModelResult<T>;
  function useBoundAblo<T, C>(
    select: ModelClientSelector<S, T, C>,
    id: string,
    options?: UseAbloModelOptions<T>,
  ): UseAbloModelResult<T>;
  function useBoundAblo<T, C>(
    modelOrSelect?:
      | ModelOperations<T, C>
      | ModelClientSelector<S, T, C>
      | AbloSelector<S, T>,
    id?: string,
    options?: UseAbloModelOptions<T>,
  ): Ablo<S> | null | UseAbloModelResult<T> | T | undefined {
    const bound = useContext(BoundClientContext);
    return useAbloImpl<S, T, C>(bound, modelOrSelect, id, options);
  }

  return { AbloProvider: BoundAbloProvider, useAblo: useBoundAblo };
}
