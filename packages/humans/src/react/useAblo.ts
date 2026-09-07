'use client';

import { useCallback, useEffect, useMemo } from 'react';
import { useAbloClient } from './useAbloClient.js';
import type { AbloClient as Ablo, AbloReads } from '../client.js';
import type { ModelClaim } from '@abloatai/transaction/coordination';
import {
  getModelClientMeta,
  type ModelOperations,
} from '../local/client/createModelOperations.js';
import type { SchemaRecord } from '@abloatai/transaction/schema/schema';
import type { ResolveModels as DefaultModels } from '@abloatai/transaction/types/global';
import { useReactive } from './useReactive.js';

const EMPTY_CLAIMS: readonly ModelClaim[] = Object.freeze([]);

// Selector results are detached snapshots with no model methods or relations.
function reactiveReads<R extends SchemaRecord>(engine: Ablo<R>): AbloReads<R> {
  return engine as AbloReads<R>;
}

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

/** Select a reactive snapshot or read a row with its current claims. */
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
  modelOrSelect: ModelOperations<T, C> | ModelClientSelector<R, T, C> | AbloSelector<R, T>,
  id?: string,
  options?: useAblo.Options<T>,
): useAblo.Result<T> | T | undefined {
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
  const subscribe = useCallback((notify: () => void) => {
    if (!engine) return () => undefined;
    return engine.claims.onChange(notify);
  }, [engine]);
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

  return value;
}

/** Type annotations belong to the operation; most callers rely on inference. */
// eslint-disable-next-line @typescript-eslint/no-namespace
export namespace useAblo {
  export interface Bound<S extends SchemaRecord> {
    <T>(select: AbloSelector<S, T>): T | undefined;
    <T, C>(
      model: ModelOperations<T, C> | ModelClientSelector<S, T, C>,
      id: string,
      options?: Options<T>,
    ): Result<T>;
  }

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
