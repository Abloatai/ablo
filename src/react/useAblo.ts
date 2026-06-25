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
 * Resolved schema-record type for the consumer's app. Reads the
 * `Register` module augmentation if declared, falls back to the
 * loose `SchemaRecord` if not. This lets `useAblo()` produce a
 * fully typed engine handle without the consumer having to pass
 * `<(typeof schema)['models']>` at every call site.
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
   * Initial row, usually from a Server Component or loader. The hook returns it
   * until the model client has a newer row in the local pool.
   */
  readonly initial?: T;
}

export interface UseAbloModelResult<T> {
  /** Current row for the id, or `initial` until the row has hydrated. */
  readonly data: T | undefined;
  /** Active work claims on this model row. */
  readonly claims: readonly ModelClaim[];
  /** Convenience flag for disabling UI while another participant is active. */
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
 * Project a reactive read into the value `useReactive` caches and returns.
 *
 * For a `Model`, this MUST read the row's fields (via `toReactiveSnapshot`),
 * not return the bare instance: MobX tracks property access, so reading the
 * fields inside this tracked function is what subscribes the reaction to them —
 * and the fresh object identity lets `useReactive`'s equality detect an
 * in-place delta update. Returning `modelAsRow(value)` (the live instance, no
 * field read) is why `useAblo(a => a.x.get(id))` used to ignore remote edits.
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
 * useAblo — access the typed engine instance, or subscribe to a specific
 * `ablo.<model>` row from inside an `<AbloProvider>` subtree.
 *
 * Zero-arg when the consumer declares the `Register` global
 * augmentation (`declare module '@abloatai/ablo' { interface Register { Schema:
 * typeof schema } }`). The default generic resolves through
 * `ResolveSchema['models']` so call sites stay clean:
 *
 * ```ts
 * // With Register augmentation (recommended):
 * const ablo = useAblo();
 * if (!ablo) return <Loading />;
 * const doc = await ablo.documents.retrieve({ id }); // async server read
 *
 * // Reactive selector (sync local-graph snapshot):
 * const doc = useAblo((ablo) => ablo.documents.get(id)) ?? serverDoc;
 * const active = useAblo((ablo) => ablo.documents.claim.state({ id }));
 *
 * // Without augmentation, pass the schema generic:
 * const ablo = useAblo<(typeof schema)['models']>();
 * ```
 *
 * Returns `null` while the engine is bootstrapping. Branch on null
 * and render a loading state (or use `useSyncStatus()` to gate on
 * `'connected'`) before reaching for model methods.
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

  // Claims live on a non-MobX event emitter (engine.claims), so the useReactive
  // reactions below cannot track them — we bridge changes through a setState bump.
  // ONLY the model-row form (`id !== undefined`) actually reads claims, so gate the
  // subscription on `id`. The selector-only form (`useAblo((a) => a.x.get/getAll)`)
  // never reads claims; subscribing it to the workspace-global claim stream would
  // re-render + double-compute it on every claim/presence delta anywhere (a real
  // storm during AI editing / live collaboration) for a value that can't change.
  const [claimVersion, setClaimVersion] = useState(0);
  useEffect(() => {
    if (!engine || id === undefined) return;
    return engine.claims.onChange(() => setClaimVersion((version) => version + 1));
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
