'use client';

import { useCallback, useContext, useEffect, useMemo } from 'react';
import { AbloInternalContext } from './internalContext.js';
import type { AbloClient as Ablo, AbloReads } from '../client.js';
import type { ModelClaim } from '@abloatai/transaction/coordination';
import {
  getModelClientMeta,
  type ModelOperations,
} from '../local/client/createModelOperations.js';
import type { SchemaRecord } from '@abloatai/transaction/schema/schema';
import type { ResolveSchema } from '@abloatai/transaction/types/global';
import { useReactive } from './useReactive.js';

/**
 * The app's resolved schema-record type. It reads your `Register` module
 * augmentation when you declare one and falls back to the loose
 * {@link SchemaRecord} otherwise, so `useAblo()` returns a fully typed client
 * without you passing `<(typeof schema)['models']>` at every call site.
 */
type DefaultModels = ResolveSchema extends { models: infer M }
  ? M extends SchemaRecord
    ? M
    : SchemaRecord
  : SchemaRecord;

const EMPTY_CLAIMS: readonly ModelClaim[] = Object.freeze([]);

/**
 * Restore the caller's schema generics on the context-held engine. React
 * context erases generics (see `AbloInternalContextValue.engine`), so this is
 * the one deliberate rebind point: the runtime value is the fully typed
 * client, and `R` is the compile-time view the calling hook declared.
 */
function rebindEngine<R extends SchemaRecord>(engine: Ablo<SchemaRecord>): Ablo<R> {
  return engine as Ablo<R>;
}

/**
 * The reactive-read view of a client — the identical runtime object, with
 * model reads typed as snapshot rows, because everything a selector returns
 * is converted through `snapshotValue` before the hook hands it back. Same
 * generic in and out, so this compiles with no schema rebinding.
 */
function reactiveReads<R extends SchemaRecord>(engine: Ablo<R>): AbloReads<R> {
  return engine as AbloReads<R>;
}

// Selectors receive the reactive-read client: model reads are typed as
// snapshot rows (data fields + computeds, no relation accessors), which is the
// shape the hook actually returns after `toReactiveSnapshot()`. This makes the
// selector's inferred result type honest — `row.layers` fails to compile here
// instead of reading `undefined` at runtime.
export type ModelClientSelector<R extends SchemaRecord, T, C> =
  (ablo: AbloReads<R>) => ModelOperations<T, C>;
export type AbloSelector<R extends SchemaRecord, T> = (ablo: AbloReads<R>) => T;

function readModelResult<R extends SchemaRecord, T, C>(
  engine: Ablo<R> | null,
  modelClient: ModelOperations<T, C> | undefined,
  id: string | undefined,
  initial: T | undefined,
): useAblo.Result<T> {
  if (!modelClient || id === undefined) {
    return { data: initial, claims: EMPTY_CLAIMS, claimed: false };
  }

  const data = modelClient.local.get(id) ?? initial;
  const meta = getModelClientMeta(modelClient);
  const claims = meta && engine
    ? engine.claims.list({ model: meta.key, id })
    : EMPTY_CLAIMS;

  return { data, claims, claimed: claims.length > 0 };
}

/**
 * Reads Ablo from inside an `<AbloProvider>` subtree. Called with no arguments
 * it returns the typed client for use in callbacks and effects; called with a
 * selector it subscribes the component to a reactive read — such as one
 * `ablo.<model>` row — and re-renders when that read changes.
 *
 * You can call it with no type arguments once you declare the `Register` module
 * augmentation (`declare module '@abloatai/ablo' { interface Register {
 * Schema: typeof schema } }`); the default type then resolves through your
 * schema's models, so call sites stay clean:
 *
 * **Prefer the binding.** `createAbloReact(schema)` captures the schema once
 * in your app's binding file and returns a `useAblo` that needs none of the
 * typing arrangements below — no type argument, no `Register` declaration
 * (see `react.md`). Passing an explicit schema type argument to THIS hook is
 * deprecated in favor of that binding; it keeps working for shared packages
 * that cannot bind a concrete schema.
 *
 * ```ts
 * // With the Register augmentation (recommended):
 * const ablo = useAblo();
 * if (!ablo) return <Loading />;
 * const doc = await ablo.records.get({ id }); // observational async server read
 *
 * // Reactive selector (a synchronous local snapshot). The selector's reads
 * // are typed as snapshot rows — data fields + computeds, no relation
 * // accessors — matching what the hook actually returns:
 * const doc = useAblo((ablo) => ablo.records.local.get(id)) ?? serverDoc;
 * const { claimed } = useAblo((ablo) => ablo.records, id);
 *
 * // Without the augmentation, pass the schema as a type argument:
 * const ablo = useAblo<(typeof schema)['models']>();
 * ```
 *
 * The client and its status are available during provider startup. Select
 * `ablo.status` to display connection state; await `ablo.ready()` before
 * operations that require an initialized client. Without a provider, the
 * no-argument form returns `null` and selectors return `undefined`.
 */
export function useAblo<R extends SchemaRecord = DefaultModels>(): Ablo<R> | null;
export function useAblo<
  R extends SchemaRecord = DefaultModels,
  T = unknown,
>(
  select: AbloSelector<R, T>,
): T | undefined;
export function useAblo<T, C>(
  modelClient: ModelOperations<T, C>,
  id: string,
  options?: useAblo.Options<T>,
): useAblo.Result<T>;
export function useAblo<
  R extends SchemaRecord = DefaultModels,
  T = Record<string, unknown>,
  C = unknown,
>(
  select: ModelClientSelector<R, T, C>,
  id: string,
  options?: useAblo.Options<T>,
): useAblo.Result<T>;
export function useAblo<
  R extends SchemaRecord = DefaultModels,
  T = Record<string, unknown>,
  C = unknown,
>(
  modelOrSelect?: ModelOperations<T, C> | ModelClientSelector<R, T, C> | AbloSelector<R, T>,
  id?: string,
  options?: useAblo.Options<T>,
): Ablo<R> | null | useAblo.Result<T> | T | undefined {
  const engine = useAbloClient<R>();
  const initial = options?.initial;
  const isSelectorOnly = typeof modelOrSelect === 'function' && id === undefined;
  const modelClient: ModelOperations<T, C> | undefined =
    typeof modelOrSelect === 'function' && id !== undefined
      ? engine
        ? (modelOrSelect(reactiveReads<R>(engine)) as ModelOperations<T, C>)
        : undefined
      : typeof modelOrSelect === 'function'
        ? undefined
        : modelOrSelect;

  // The initial row is a seed for this client/model/id, not a permanent
  // fallback: once local data has been committed to the UI, its removal must
  // not resurrect the seed. Only committed effects change this marker.
  // These dependencies define when the seed belongs to a different row.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const seed = useMemo(() => ({ received: false }), [engine, modelClient, id]);
  const reading = modelOrSelect !== undefined;
  const subscribe = useCallback((notify: () => void) => {
    if (!engine || !reading) return () => undefined;
    return engine.claims.onChange(notify);
  }, [engine, reading]);
  const value = useReactive<T | useAblo.Result<T> | undefined>(() => {
    if (isSelectorOnly && typeof modelOrSelect === 'function') {
      return engine ? modelOrSelect(reactiveReads<R>(engine)) as T : undefined;
    }
    if (modelOrSelect) {
      return readModelResult(engine, modelClient, id, seed.received ? undefined : initial);
    }
    return undefined;
  }, {
    subscribe,
    // The same seed produces the server HTML and the first hydration render,
    // even if the browser already has a newer row or claim in its local cache.
    ...(id !== undefined && initial !== undefined ? {
      serverSnapshot: () => ({ data: initial, claims: EMPTY_CLAIMS, claimed: false }),
    } : {}),
  });
  useEffect(() => {
    if (id !== undefined && modelClient?.local.get(id) !== undefined) seed.received = true;
  }, [seed, modelClient, id, value]);

  if (isSelectorOnly || modelOrSelect) return value;
  return engine;
}

/** @internal Resolve the nearest provider's client through one schema rebind. */
export function useAbloClient<R extends SchemaRecord>(): Ablo<R> | null {
  const ctx = useContext(AbloInternalContext);
  return ctx?.engine ? rebindEngine<R>(ctx.engine) : null;
}

/** Type annotations belong to the operation; most callers rely on inference. */
// eslint-disable-next-line @typescript-eslint/no-namespace
export namespace useAblo {
  export interface Options<T> {
    /**
     * An initial row, usually from a server component or a route loader. The hook
     * uses it for hydration and until a local row has been observed. A later
     * local removal returns undefined instead of restoring this seed.
     */
    readonly initial?: T;
  }

  export interface Result<T> {
    /** The local row or its initial seed. Undefined is a local cache miss, not proof of server absence. */
    readonly data: T | undefined;
    /** The work claims currently held on this row by any participant. */
    readonly claims: readonly ModelClaim[];
    /** True while another participant holds a claim — handy for disabling UI. */
    readonly claimed: boolean;
  }
}
