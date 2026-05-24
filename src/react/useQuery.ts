'use client';

import { useMemo, useEffect, useRef, useCallback } from 'react';
import type { ModelScope } from '../types/index.js';
import type { Schema } from '../schema/schema.js';
import type { ModelDef } from '../schema/model.js';
import type { InferModel } from '../schema/schema.js';
import type { ResolveSchema } from '../types/global.js';
import { useSyncContext } from './context.js';
import type { QueryViewOptions } from '../core/QueryView.js';
import { useReactive } from './useReactive.js';

// ── Typed-global resolution helpers ─────────────────────────────────────
//
// When the consumer declares `interface AbloSync { Schema: typeof schema }`,
// `ResolveSchema` becomes the concrete schema and these helpers produce
// typed model keys + entity types. When no augmentation exists,
// `ResolveSchema` is the loose `DefaultSyncShape['Schema']` fallback and
// these helpers degrade gracefully to `string` keys + `Record<string,
// unknown>` entities — same behavior as the legacy untyped overload.

/** Narrow model-key union for the zero-arg overload. */
type GlobalModelKey = ResolveSchema extends { models: infer M }
  ? keyof M & string
  : string;

/** Typed entity shape for a given model key. Falls back to a loose shape
 * when the resolved schema doesn't extend the full `Schema` contract
 * (i.e., no global augmentation present). */
type GlobalEntity<K extends string> = ResolveSchema extends Schema
  ? K extends keyof ResolveSchema['models']
    ? InferModel<ResolveSchema, K>
    : Record<string, unknown>
  : Record<string, unknown>;

/**
 * Compatibility query hook for entity collections.
 *
 * Prefer selector reads for new integrations:
 *
 * ```ts
 * const tasks = useAblo((ablo) =>
 *   ablo.tasks.list({ where: { status: 'todo' } }),
 * );
 * ```
 *
 * This hook remains for older string-keyed integrations.
 *
 * **Typed overload:**
 * ```ts
 * import { schema } from '@/sync/schema';
 * const chats = useQuery(schema, 'chats', { where: { userId } });
 * // chats is fully typed: Chat[] with displayTitle, icon, color, etc.
 * ```
 *
 * **Untyped overload (legacy):**
 * ```ts
 * const chats = useQuery('Chat');
 * // chats is Record<string, unknown>[]
 * ```
 */

// ── Query shape ──────────────────────────────────────────────────────

export interface QueryOptions<T = Record<string, unknown>> {
  /** Declarative field-level filter. Shallow match: all specified fields must match. */
  where?: Partial<T>;
  /** Arbitrary predicate function for complex logic. Applied AFTER where. */
  filter?: (entity: T) => boolean;
  /** Sort field name. */
  orderBy?: keyof T & string;
  /** Sort direction. Default: 'asc'. */
  order?: 'asc' | 'desc';
  /** Max results. */
  limit?: number;
  /** Skip N results (pagination). */
  offset?: number;
  /** Filter by model scope (live, archived, all). Default: live. */
  scope?: ModelScope;
}

// ── Resolve typename from schema key ────────────────────────────────

type ResolveTypename<S extends Schema, K extends keyof S['models']> =
  S['models'][K] extends { readonly typename: infer T extends string } ? T : K & string;

// ── Stable key helper ───────────────────────────────────────────────

/**
 * Produce a stable string key for QueryOptions so useMemo only recreates
 * the view when the logical query changes.
 *
 * - `where` is serialized via JSON.stringify (deterministic for simple values).
 * - `filter` is a function — we track its reference identity.
 * - Primitives (orderBy, order, limit, offset, scope) are included directly.
 */
function useStableKey<T>(options: QueryOptions<T> | undefined): string {
  // We use a ref to track the previous filter reference. When it changes
  // the key changes and the view is recreated.
  const filterRef = useRef<((entity: T) => boolean) | undefined>(undefined);

  // Bump a generation counter when the filter reference changes
  const genRef = useRef(0);
  if (options?.filter !== filterRef.current) {
    filterRef.current = options?.filter;
    genRef.current++;
  }

  return useMemo(() => {
    if (!options) return '';
    const parts: string[] = [];
    if (options.where) parts.push('w:' + JSON.stringify(options.where));
    if (options.filter) parts.push('f:' + genRef.current);
    if (options.orderBy) parts.push('ob:' + String(options.orderBy));
    if (options.order) parts.push('o:' + options.order);
    if (options.limit !== undefined) parts.push('l:' + options.limit);
    if (options.offset !== undefined) parts.push('off:' + options.offset);
    if (options.scope) parts.push('s:' + options.scope);
    return parts.join('|');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    // eslint-disable-next-line react-hooks/exhaustive-deps
    options?.where ? JSON.stringify(options.where) : '',
    genRef.current,
    options?.orderBy,
    options?.order,
    options?.limit,
    options?.offset,
    options?.scope,
  ]);
}

// ── Hook overloads ──────────────────────────────────────────────────

/**
 * Typed query (explicit schema arg).
 *
 * @deprecated Prefer `useAblo((ablo) => ablo.<model>.list(options))` for new
 * integrations. This overload remains for compatibility with older
 * string-keyed React code.
 *
 * ```ts
 * const tasks = useQuery(schema, 'tasks', { where: { status: 'todo' } });
 * // tasks: Task[] — fully typed from Zod shape + computed getters
 * ```
 */
export function useQuery<
  S extends Schema,
  K extends keyof S['models'] & string,
>(
  schema: S,
  modelKey: K,
  options?: QueryOptions<InferModel<S, K>>,
): InferModel<S, K>[];

/**
 * Typed query (global-augmented): pass just the model key. Resolves
 * the schema from the `AbloSync` global augmentation the consumer
 * declared in a `.d.ts`. No `schema` arg at the call site — this is
 * the Liveblocks-style ergonomic path.
 *
 * @deprecated Prefer `useAblo((ablo) => ablo.<model>.list(options))` for new
 * integrations. This overload remains for compatibility with older
 * string-keyed React code.
 *
 * ```ts
 * // apps/your-app/src/ablo-sync.d.ts
 * declare global { interface AbloSync { Schema: typeof schema } }
 *
 * // any component
 * const tasks = useQuery('tasks', { where: { status: 'todo' } });
 * // tasks: Task[] — typed via the declared global
 * ```
 *
 * When no global augmentation exists, `GlobalEntity` falls back to
 * `Record<string, unknown>` — same ergonomics as the legacy untyped
 * overload, with the key still validated against the resolved schema's
 * model keys when that schema is declared.
 */
export function useQuery<K extends GlobalModelKey>(
  modelKey: K,
  options?: QueryOptions<GlobalEntity<K>>,
): GlobalEntity<K>[];

/** @deprecated Prefer selector reads through `useAblo`. */
export function useQuery<T = Record<string, unknown>>(
  typename: string,
  options?: QueryOptions<T>,
): T[];

// ── Implementation ──────────────────────────────────────────────────

export function useQuery<T = Record<string, unknown>>(
  schemaOrTypename: Schema | string,
  modelKeyOrOptions?: string | QueryOptions<T>,
  maybeOptions?: QueryOptions<T>,
): unknown[] {
  const ctx = useSyncContext();
  const { store } = ctx;

  let typename: string;
  let options: QueryOptions<T> | undefined;

  if (typeof schemaOrTypename === 'string') {
    // First arg is a string. Could be either the new zero-arg typed
    // overload (a schema model key, resolved via `ctx.schema`) or the
    // legacy untyped overload (a raw typename like 'Chat'). When a
    // schema is present on the context and the string maps to a known
    // model key, we look up the real typename from the schema's
    // `ModelDef.typename`. Otherwise we treat the string as a typename
    // directly — preserving the legacy behavior for any non-opting
    // consumer. Both paths converge on the same runtime lookup.
    const key = schemaOrTypename;
    const ctxSchema = ctx.schema;
    const modelDef = ctxSchema
      ? (ctxSchema.models as Record<string, ModelDef>)[key]
      : undefined;
    typename = modelDef?.typename ?? key;
    options = modelKeyOrOptions as QueryOptions<T> | undefined;
  } else {
    // Explicit schema path: useQuery(schema, 'chats', options?)
    const schema = schemaOrTypename;
    const modelKey = modelKeyOrOptions as string;
    const modelDef = (schema.models as Record<string, ModelDef>)[modelKey];
    typename = modelDef?.typename ?? modelKey;
    options = maybeOptions;
  }

  const optionsKey = useStableKey(options);

  // The QueryView is generic-erased to `Record<string, unknown>`, but
  // the caller's filter is typed in `T`. Wrap rather than cast: the
  // view passes a Record at runtime and the wrapper narrows to T —
  // single typed boundary, no `as unknown as` chain.
  const userFilter = options?.filter;
  const viewOptions: QueryViewOptions<Record<string, unknown>> | undefined = options
    ? {
        where: options.where as Partial<Record<string, unknown>> | undefined,
        filter: userFilter
          ? (entity: Record<string, unknown>) => userFilter(entity as T)
          : undefined,
        orderBy: options.orderBy as string | undefined,
        order: options.order,
        limit: options.limit,
        offset: options.offset,
        scope: options.scope,
      }
    : undefined;

  const view = useMemo(
    () => store.pool.createView<Record<string, unknown>>(typename, viewOptions),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [store.pool, typename, optionsKey],
  );

  useEffect(() => () => view.dispose(), [view]);

  // Self-subscribing — consumers never wrap their component in
  // `observer`. `useReactive` tracks the observables read inside the
  // compute function (`view.results`), recomputes on change, and
  // returns a stable slice so downstream `.sort()` / `.reverse()`
  // calls don't trip MobX error 37. The default structural equality
  // check prevents re-renders when nothing actually moved.
  //
  // The compute closure MUST be stable when `view` is stable. Without
  // useCallback([view]), each render passes a fresh arrow to
  // useReactive, which then can't distinguish "swapped to a new
  // QueryView" from "same view, new render" — the wrong call would
  // either re-subscribe every render (waste) or never re-subscribe
  // when view actually swaps (stale snapshot bug returning a previous
  // view's results forever).
  const compute = useCallback(() => view.results.slice(), [view]);
  return useReactive(compute);
}

/**
 * Compatibility single-entity lookup. Prefer selector reads:
 *
 * ```ts
 * const task = useAblo((ablo) => ablo.tasks.retrieve(taskId));
 * ```
 *
 * ```ts
 * // Typed
 * const task = useOne(schema, 'tasks', taskId);
 *
 * // Untyped (legacy)
 * const task = useOne(taskId);
 * ```
 */
/** @deprecated Prefer `useAblo((ablo) => ablo.<model>.retrieve(id))`. */
export function useOne<
  S extends Schema,
  K extends keyof S['models'] & string,
>(schema: S, modelKey: K, id?: string): InferModel<S, K> | undefined;

/** Typed single-entity lookup via the `AbloSync` global augmentation.
 *
 * @deprecated Prefer `useAblo((ablo) => ablo.<model>.retrieve(id))`.
 *
 * The pool `.get(id)` call doesn't actually need the typename at runtime
 * — the return is already keyed by id globally — so the model key serves
 * as a compile-time narrowing hint for consumers who want the specific
 * entity type at the call site. */
export function useOne<K extends GlobalModelKey>(
  modelKey: K,
  id?: string,
): GlobalEntity<K> | undefined;

/** @deprecated Prefer `useAblo((ablo) => ablo.<model>.retrieve(id))`. */
export function useOne<T = Record<string, unknown>>(id?: string): T | undefined;

export function useOne(
  schemaOrIdOrKey?: Schema | string,
  modelKeyOrId?: string,
  maybeId?: string,
): unknown {
  const { store } = useSyncContext();

  if (schemaOrIdOrKey === undefined) {
    return undefined;
  }

  if (typeof schemaOrIdOrKey === 'string') {
    // Either `useOne(id)` (legacy, one arg) or `useOne(modelKey, id)` (global).
    // Disambiguate by whether a second arg was passed — both paths
    // converge on the same runtime pool lookup because entity IDs are
    // globally unique across model types.
    if (modelKeyOrId !== undefined) {
      return store.pool.get(modelKeyOrId);
    }
    return store.pool.get(schemaOrIdOrKey);
  }

  // Explicit schema path: useOne(schema, 'tasks', id)
  if (!maybeId) return undefined;
  return store.pool.get(maybeId);
}
