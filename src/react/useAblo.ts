'use client';

import { useContext, useEffect, useState } from 'react';
import { AbloInternalContext } from './internalContext.js';
import type { Ablo, ModelClaim } from '../client/Ablo.js';
import type { ModelOperations } from '../client/createModelProxy.js';
import { getModelClientMeta } from '../client/createModelProxy.js';
import { Model } from '../Model.js';
import type { SchemaRecord } from '../schema/schema.js';
import type { ResolveSchema } from '../types/global.js';
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

type ModelClientSelector<R extends SchemaRecord, T, C> =
  (ablo: Ablo<R>) => ModelOperations<T, C>;
type AbloSelector<R extends SchemaRecord, T> = (ablo: Ablo<R>) => T;

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

function readModelResult<T, C>(
  engine: Ablo<SchemaRecord> | null,
  modelClient: ModelOperations<T, C> | undefined,
  id: string | undefined,
  initial: T | undefined,
): UseAbloModelResult<T> {
  if (!modelClient || id === undefined) {
    return { data: initial, claims: EMPTY_CLAIMS, claimed: false };
  }

  const data = snapshotValue(modelClient.get(id) ?? initial);
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
 * ```ts
 * // With the Register augmentation (recommended):
 * const ablo = useAblo();
 * if (!ablo) return <Loading />;
 * const doc = await ablo.documents.retrieve({ id }); // async server read
 *
 * // Reactive selector (a synchronous local snapshot):
 * const doc = useAblo((ablo) => ablo.documents.get(id)) ?? serverDoc;
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
  const ctx = useContext(AbloInternalContext);
  const engine = ctx?.engine ?? null;
  const initial = options?.initial;
  const isSelectorOnly = typeof modelOrSelect === 'function' && id === undefined;
  const modelClient: ModelOperations<T, C> | undefined =
    typeof modelOrSelect === 'function' && id !== undefined
      ? engine
        ? (modelOrSelect(engine as unknown as Ablo<R>) as ModelOperations<T, C>)
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
      return snapshotValue(modelOrSelect(engine as unknown as Ablo<R>) as T);
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
  return engine as unknown as Ablo<R> | null;
}
