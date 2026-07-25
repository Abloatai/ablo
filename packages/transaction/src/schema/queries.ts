/**
 * Query definitions for a schema.
 *
 * A query pairs a Zod input schema with the name of the model it returns.
 * Input types flow through `z.infer` and result types through `InferModel`,
 * the same inference path `model` and `relation` use, so there is no separate
 * type system to learn.
 *
 * Usage:
 *   import { z } from 'zod';
 *   import {
 *     defineSchema, defineQueries, model, query, relation,
 *   } from '@ablo/transaction/schema';
 *
 *   const schema = defineSchema({
 *     block: model(
 *       { sectionId: z.string(), type: z.string() },
 *       { section: relation.belongsTo('sections', 'sectionId') },
 *       { load: 'lazy', typename: 'Block', persist: {} },
 *     ),
 *   });
 *
 *   const queries = defineQueries(schema, {
 *     blocksByReport: query({
 *       input:   z.object({ reportId: z.string() }),
 *       returns: 'block',   // ← type-checked against schema.models
 *     }),
 *   });
 *
 *   type Input  = InferQueryInput<typeof queries.queries.blocksByReport>;
 *   //    ^? { reportId: string }
 *   type Result = InferQueryResult<
 *     typeof schema,
 *     typeof queries.queries.blocksByReport
 *   >;
 *   //    ^? Array<Block>
 *
 * Design notes:
 *
 *  - `query()` accepts any string for `returns`. The check that the string
 *    names a real model runs when the query passes through
 *    `defineQueries(schema, ...)`, the same way
 *    `relation.belongsTo('projects', 'projectId')` takes a plain string at
 *    the factory and defers the cross-reference check to schema assembly.
 *
 *  - A query carries no `name` until `defineQueries()` assigns one from its
 *    record key — the same pattern `defineSchema({ tasks: model(...) })`
 *    uses, where the model's name is the record key rather than a field on
 *    the factory.
 *
 *  - Every query returns an array of a single model type. To fetch several
 *    model types at once, run several queries in one batch rather than
 *    declaring a combined shape. Each `QueryDef` therefore points at exactly
 *    one model, and the loader hydrates results through a single
 *    `schema.models[queryDef.returns]` lookup.
 */

import { z } from 'zod';
import type { Schema, InferModel, InferModelNames } from './schema.js';
import { AbloValidationError } from '../errors.js';

// ── Query definition types ────────────────────────────────────────────────

/**
 * A single query definition: a zod input shape, the schema key of the
 * model it returns, and (after assembly) the name it was registered
 * under.
 *
 * `name` is filled in by `defineQueries()` from the record key. It is
 * optional on the type so `query()` can return a value without one —
 * downstream code should only read `name` after the query has been
 * passed through `defineQueries()`.
 */
export interface QueryDef<
  TInput extends z.ZodType = z.ZodType,
  TReturns extends string = string,
> {
  /** Zod schema for the query's input arguments. */
  readonly input: TInput;
  /**
   * The schema key of the model this query returns. Narrowed by
   * `defineQueries()` to `InferModelNames<S>` via the `Q` generic, so
   * a query whose `returns` does not match a known model fails at
   * compile time.
   */
  readonly returns: TReturns;
  /**
   * The name under which the query is registered. {@link defineQueries}
   * fills this in from the record key; you do not set it directly. It lives
   * on the definition itself so dispatch and lookup code can read the name
   * straight off a {@link QueryDef} without carrying the surrounding
   * {@link Queries} object.
   */
  readonly name?: string;
}

/**
 * The raw spec accepted by `query()`. Internal type — consumers never
 * reference this directly, they call `query({ input, returns })`.
 */
interface QuerySpec<
  TInput extends z.ZodType,
  TReturns extends string,
> {
  readonly input: TInput;
  readonly returns: TReturns;
}

// ── query() factory ───────────────────────────────────────────────────────

/**
 * Define a query.
 *
 * `TReturns` is a `const` generic so TypeScript preserves the literal
 * type of the `returns` value at call time (e.g., `'block'`
 * instead of widening to `string`). This is what lets `defineQueries`
 * type-check `returns` against the schema's model keys without
 * requiring the consumer to write `as const` manually.
 *
 * ```ts
 * const blocksByReport = query({
 *   input:   z.object({ reportId: z.string() }),
 *   returns: 'block',
 * });
 * ```
 */
export function query<
  TInput extends z.ZodType,
  const TReturns extends string,
>(spec: QuerySpec<TInput, TReturns>): QueryDef<TInput, TReturns> {
  return {
    input: spec.input,
    returns: spec.returns,
  };
}

// ── Queries record + type inference ───────────────────────────────────────

/**
 * A record of query names → query definitions, parameterized by a
 * schema so each query's `returns` must reference a known model.
 *
 * This is the constraint type used by `defineQueries()` — it's what
 * turns "any string" into "a model in this schema" without touching
 * the `query()` factory itself.
 */
export type QueryRecord<S extends Schema> = Record<
  string,
  QueryDef<z.ZodType, InferModelNames<S>>
>;

/**
 * The object returned by `defineQueries()`. Holds a reference back to
 * the schema (so the loader can resolve `queryDef.returns` to
 * a `ModelDef` at runtime via `schema.models[def.returns]`) and the
 * resolved record of queries, each with its `name` field filled in.
 */
export interface Queries<
  S extends Schema,
  Q extends QueryRecord<S>,
> {
  readonly schema: S;
  readonly queries: Q;
}

/**
 * Infer the input type of a query from its zod schema.
 *
 * ```ts
 * type Input = InferQueryInput<typeof queries.queries.blocksByReport>;
 * // { reportId: string }
 * ```
 */
export type InferQueryInput<Q extends QueryDef> = z.infer<Q['input']>;

/**
 * Infer the result type of a query by looking up its `returns` model
 * in the schema.
 *
 * Returns `Array<InferModel<S, returns>>` — all queries return a
 * collection at this layer. Single-entity fetches use
 * `ids: [singleId]` and the caller picks `result[0]`; this avoids a
 * second `scope: 'single'` shape in the DSL for a case that can be
 * expressed with the collection form.
 *
 * ```ts
 * type Result = InferQueryResult<
 *   typeof schema,
 *   typeof queries.queries.blocksByReport
 * >;
 * // Array<Block>
 * ```
 */
export type InferQueryResult<
  S extends Schema,
  Q extends QueryDef,
> = Q extends QueryDef<z.ZodType, infer R>
  ? R extends InferModelNames<S>
    ? InferModel<S, R>[]
    : never
  : never;

// ── defineQueries() factory ───────────────────────────────────────────────

/**
 * Define a typed query set against a schema.
 *
 * Each entry's `returns` field is constrained to the schema's model
 * names at compile time via the `Q` generic bound to `QueryRecord<S>`.
 * A query whose `returns` does not match a known model will fail at
 * the `defineQueries` call site with a TypeScript error, not at
 * runtime.
 *
 * The factory also performs a runtime validation of the same
 * invariant. This catches the edge case where the schema and the
 * queries live in separate modules that drift out of sync — for
 * example, when a developer removes a model from the schema without
 * updating the queries that referenced it. The runtime error points
 * at the specific offending query and lists the available models,
 * which is a nicer failure mode than a generic "property does not
 * exist" error deep inside the loader.
 *
 * Each resolved query gets its `name` populated from the record key:
 * `queries.blocksByReport.name === 'blocksByReport'`. Dispatch and
 * lookup code read `queryDef.name` directly rather than re-deriving it from
 * the surrounding record.
 *
 * ```ts
 * const schema = defineSchema({
 *   block: model(
 *     { sectionId: z.string() },
 *     {},
 *     { load: 'lazy', typename: 'Block', persist: {} },
 *   ),
 * });
 *
 * const queries = defineQueries(schema, {
 *   blocksByReport: query({
 *     input:   z.object({ reportId: z.string() }),
 *     returns: 'block',   // ← type-checked
 *   }),
 * });
 * ```
 */
export function defineQueries<
  S extends Schema,
  const Q extends QueryRecord<S>,
>(schema: S, queries: Q): Queries<S, Q> {
  // Rebuild the queries record with `name` populated per entry. Same
  // shallow-spread strategy `defineSchema` uses for `typename` / `persist`
  // defaults — preserves input references, avoids mutating `readonly`
  // fields in place, and keeps each resolved `QueryDef` immutable from
  // construction onward.
  const resolvedQueries: Record<string, QueryDef> = {};
  for (const [name, def] of Object.entries(queries)) {
    if (!(def.returns in schema.models)) {
      throw new AbloValidationError(
        `defineQueries: query "${name}" declares returns: "${def.returns}", ` +
          `which is not a model in the schema. ` +
          `Available models: ${Object.keys(schema.models).join(', ') || '(none)'}`,
        { code: 'query_returns_unknown_model' },
      );
    }
    resolvedQueries[name] = { ...def, name };
  }

  return {
    schema,
    // Cast back to Q: the rebuild only added `name` (already optional on
    // QueryDef) to each entry, so the shape is structurally unchanged.
    queries: resolvedQueries as unknown as Q,
  };
}
