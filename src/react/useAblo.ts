'use client';

import { useContext, useEffect, useState } from 'react';
import { AbloInternalContext } from './internalContext.js';
import type { Ablo, AbloReads, ModelClaim } from '../client/Ablo.js';
import type { ModelOperations } from '../client/createModelProxy.js';
import { getModelClientMeta } from '../client/createModelProxy.js';
import { Model } from '../Model.js';
import type { SchemaRecord } from '../transaction/schema/schema.js';
import type { ResolveSchema } from '../transaction/types/global.js';
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

export interface UseAbloModelOptions<T> {
  /**
   * An initial row, usually from a server component or a route loader. The hook
   * returns it until sync delivers a newer row for the same id.
   */
  readonly initial?: T;
}

export interface UseAbloModelResult<T> {
  /** The current row for the id, or `initial` until the row has synced. */
  readonly data: T | undefined;
  /** The work claims currently held on this row by any participant. */
  readonly claims: readonly ModelClaim[];
  /** True while another participant holds a claim — handy for disabling UI. */
  readonly claimed: boolean;
}

export type UseAbloHydratedModelResult<T> =
  Omit<UseAbloModelResult<T>, 'data'> & { readonly data: T };

function readModelResult<R extends SchemaRecord, T, C>(
  engine: Ablo<R> | null,
  modelClient: ModelOperations<T, C> | undefined,
  id: string | undefined,
  initial: T | undefined,
): UseAbloModelResult<T> {
  if (!modelClient || id === undefined) {
    return { data: initial, claims: EMPTY_CLAIMS, claimed: false };
  }

  const data = snapshotValue(modelClient.local.retrieve(id) ?? initial);
  const meta = getModelClientMeta(modelClient);
  const claims = meta && engine
    ? engine.claims.list({ model: meta.key, id })
    : EMPTY_CLAIMS;

  return { data, claims, claimed: claims.length > 0 };
}

/**
 * Projects a reactive read into the value that `useReactive` caches and
 * returns.
 *
 * For a `Model`, this reads the row's fields through `toReactiveSnapshot`
 * rather than returning the instance itself. Property access is what subscribes
 * the reaction to those fields, so the read has to happen inside this tracked
 * function; returning the live instance without reading its fields would leave
 * the component blind to later edits. The fresh object it produces also lets
 * `useReactive`'s equality check detect an in-place update.
 */
function snapshotValue<T>(value: T): T {
  if (value instanceof Model) {
    return value.toReactiveSnapshot<T>();
  }
  if (Array.isArray(value)) {
    return value.map((item) => snapshotValue(item)) as T;
  }
  return value;
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
 * const doc = await ablo.documents.retrieve({ id }); // async server read
 *
 * // Reactive selector (a synchronous local snapshot). The selector's reads
 * // are typed as snapshot rows — data fields + computeds, no relation
 * // accessors — matching what the hook actually returns:
 * const doc = useAblo((ablo) => ablo.documents.local.retrieve(id)) ?? serverDoc;
 * const active = useAblo((ablo) => ablo.documents.claim.state({ id }));
 *
 * // Without the augmentation, pass the schema as a type argument:
 * const ablo = useAblo<(typeof schema)['models']>();
 * ```
 *
 * The no-argument form returns `null` while the engine is still bootstrapping.
 * Branch on `null` and render a loading state — or gate on `useSyncStatus()`
 * reaching `'connected'` — before calling model methods.
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
  options: UseAbloModelOptions<T> & { readonly initial: T },
): UseAbloHydratedModelResult<T>;
export function useAblo<
  R extends SchemaRecord = DefaultModels,
  T = Record<string, unknown>,
  C = unknown,
>(
  select: ModelClientSelector<R, T, C>,
  id: string,
  options: UseAbloModelOptions<T> & { readonly initial: T },
): UseAbloHydratedModelResult<T>;
export function useAblo<T, C>(
  modelClient: ModelOperations<T, C>,
  id: string,
  options?: UseAbloModelOptions<T>,
): UseAbloModelResult<T>;
export function useAblo<
  R extends SchemaRecord = DefaultModels,
  T = Record<string, unknown>,
  C = unknown,
>(
  select: ModelClientSelector<R, T, C>,
  id: string,
  options?: UseAbloModelOptions<T>,
): UseAbloModelResult<T>;
export function useAblo<
  R extends SchemaRecord = DefaultModels,
  T = Record<string, unknown>,
  C = unknown,
>(
  modelOrSelect?: ModelOperations<T, C> | ModelClientSelector<R, T, C> | AbloSelector<R, T>,
  id?: string,
  options?: UseAbloModelOptions<T>,
): Ablo<R> | null | UseAbloModelResult<T> | T | undefined {
  return useAbloImpl<R, T, C>(null, modelOrSelect, id, options);
}

/**
 * @internal The one implementation behind `useAblo` and the bound hooks a
 * `createAbloReact` binding returns — written once so the reactive read path
 * cannot fork between the global hook and a factory's.
 *
 * `boundClient` is a binding's own context value — typed `Ablo<S>` at the
 * factory, so that path never rebinds and never casts. `null` means "no
 * binding provider in this tree": the global hook always passes it, and a
 * binding hook mounted under a legacy provider falls through to the erased
 * internal context, which is what keeps both mounts working while the last
 * legacy mount migrates.
 */
export function useAbloImpl<
  R extends SchemaRecord,
  T = Record<string, unknown>,
  C = unknown,
>(
  boundClient: Ablo<R> | null,
  modelOrSelect?: ModelOperations<T, C> | ModelClientSelector<R, T, C> | AbloSelector<R, T>,
  id?: string,
  options?: UseAbloModelOptions<T>,
): Ablo<R> | null | UseAbloModelResult<T> | T | undefined {
  const ctx = useContext(AbloInternalContext);
  // The bound client wins — it is already `Ablo<R>`, no rebinding. The
  // fallback is the ONE remaining schema rebind in the SDK; it retires with
  // the last legacy provider mount (docs/plans/typed-react-binding.md).
  const engine: Ablo<R> | null =
    boundClient ?? (ctx?.engine ? rebindEngine<R>(ctx.engine) : null);
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

  // Claims arrive through an event emitter (engine.claims), not through MobX, so
  // the useReactive reactions below cannot track them; we bridge changes with a
  // setState bump instead. Only the model-row form (`id !== undefined`) reads
  // claims, so we subscribe only when `id` is set. The selector-only form never
  // reads claims, and subscribing it to the workspace-wide claim stream would
  // re-render and recompute it on every claim or presence change anywhere — a
  // real storm during AI editing or live collaboration — for a value that cannot
  // change.
  const [claimVersion, setClaimVersion] = useState(0);
  useEffect(() => {
    if (!engine || id === undefined) return;
    return engine.claims.onChange(() => { setClaimVersion((version) => version + 1); });
  }, [engine, id]);

  const selected = useReactive<T | undefined>(
    () => {
      if (!engine || !isSelectorOnly || typeof modelOrSelect !== 'function') {
        return undefined;
      }
      // The selector runs against the real engine — reads inside it return the
      // pool's model instances. `snapshotValue` then converts the RESULT to
      // plain snapshot rows, which is what the selector's `AbloReads`
      // parameter type already promised.
      return snapshotValue(modelOrSelect(reactiveReads<R>(engine)) as T);
    },
  );

  const modelResult = useReactive<UseAbloModelResult<T>>(
    () => {
      void claimVersion;
      return readModelResult(engine, modelClient, id, initial);
    },
  );

  if (isSelectorOnly) return selected;
  if (modelOrSelect) return modelResult;
  return engine;
}
