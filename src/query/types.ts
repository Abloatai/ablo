/**
 * Structured query types for the generic /sync/query endpoint.
 *
 * Zero-shaped ZQL-ish wire format: `where` is a flat list of `[col, op, val]`
 * tuples (AND'd together), and `related` is a list of schema-declared
 * relation names to traverse. The server compiler reads the schema's
 * relation metadata to turn `related: ['layers']` into the right JOIN.
 *
 * # Why this shape
 *
 * An earlier revision used equality-only `where: Record<string, unknown>`
 * plus a PK-only `ids: string[]` batch field. That worked for simple cases
 * but collapsed on two real workloads:
 *
 *   1. "Fetch all layers for these slide IDs" — the IDs are foreign keys
 *      (`SlideLayer.slideId`), not primary keys. The old `ids` field
 *      filtered on `id`, silently returning empty.
 *
 *   2. "Fetch all layers for this deck" — needs a JOIN through
 *      `slides.deck_id → slide_layers.slide_id`. Equality-only `where` had
 *      no way to express it, so the Go server hardcoded a dispatch case.
 *
 * Both are generic patterns ("batch by FK column", "filter via relation")
 * that should be first-class in the protocol, not model-specific escape
 * hatches on the server. This shape matches Zero's ZQL:
 *
 *   - `where('slideId', 'IN', ids)` → `['slideId', 'IN', ids]`
 *   - `.related('layers')` → `related: ['layers']`
 *
 * The server's compiler stays schema-driven: given a model name, it reads
 * the schema's declared relations to emit JOIN SQL, and given a `[col, op,
 * val]` tuple it emits a WHERE fragment — never a switch on specific model
 * names. Adding a new model or relation is a schema change, not a server
 * change.
 */

/** Primitive operand types allowed in a where clause. */
export type WherePrimitive = string | number | boolean | null;

/**
 * Comparison operators. Mirrors Zero's ZQL set so client authors can
 * lean on familiar semantics and server compilers that already target
 * ZQL stay portable.
 */
export type WhereOp =
  | '='
  | '!='
  | '<'
  | '<='
  | '>'
  | '>='
  | 'IN'
  | 'NOT IN'
  | 'IS'
  | 'IS NOT'
  | 'LIKE'
  | 'NOT LIKE'
  | 'ILIKE'
  | 'NOT ILIKE';

/**
 * A single condition. Two supported shapes:
 *
 *   - `[col, value]` — shortcut for `[col, '=', value]`
 *   - `[col, op, value]` — explicit operator
 *
 * The value is a single primitive for scalar operators and an array of
 * primitives for IN/NOT IN.
 */
export type WhereClause =
  | readonly [col: string, value: WherePrimitive]
  | readonly [col: string, op: WhereOp, value: WherePrimitive | readonly WherePrimitive[]];

/**
 * Client-facing where shape for `load({where})` and `deleteMany({where})`.
 *
 * Two shapes accepted, both AND-combined:
 *
 *   - Object form: `{ name: 'foo', orgId: '1' }` — each entry is an `=`
 *     clause; array values become `IN`. Ergonomic for the common case.
 *   - Tuple form: `[['name', 'ILIKE', '%Goldman%'], ['orgId', '1']]` —
 *     explicit operators (LIKE/ILIKE/<=/etc.). Matches the wire
 *     `WhereClause[]` 1:1, so no translation layer.
 *
 * The two forms compose: pass tuple form when you need an operator,
 * object form otherwise. For OR semantics, run two `load()` calls and
 * union client-side — keeps the protocol AND-only.
 */
export type LoadWhere<T> =
  | Partial<T>
  | { [K in keyof T]?: T[K] | readonly T[K][] }
  | readonly WhereClause[];

/** A single structured fetch request. */
export interface Query {
  /**
   * Client-facing model name (e.g. "File", "SlideLayer", "Message").
   * The server's adapter maps this to the actual database table.
   */
  model: string;

  /**
   * List of where clauses AND'd together. Empty or omitted means "no
   * filter" (still subject to server-side org scoping).
   *
   * Use `['col', 'IN', values]` to batch by any column — the old
   * primary-key-only `ids` field is subsumed by this form.
   */
  where?: readonly WhereClause[];

  /**
   * Relation names declared in the schema for this model. The server's
   * compiler resolves each name via the schema's relation metadata
   * (`relation.hasMany` / `relation.belongsTo`) and emits the JOIN
   * SQL — no model-specific dispatch on the server.
   *
   * Results come back as nested objects under the relation key:
   *
   *   { __typename: 'Slide', id: '…', layers: [{ __typename: 'SlideLayer', … }] }
   */
  related?: readonly string[];

  /**
   * Row limit. Applied after where + JOIN, before related nesting.
   * Omit for no limit.
   */
  limit?: number;

  /**
   * Column to order by. For stable pagination. Omit for unordered.
   */
  orderBy?: string;

  /** Order direction. Defaults to `'asc'`. */
  order?: 'asc' | 'desc';
}

/** Request body for POST /sync/query. */
export interface QueryBatch {
  /**
   * Batch of queries to execute in one round trip. Results are
   * returned in request order at the same indices. Keep batches
   * small — the server caps at 16 queries per batch by default.
   */
  queries: Query[];
}

/** Response body from POST /sync/query. */
export interface QueryBatchResult {
  /**
   * Per-query results in request order. `results[i]` corresponds to
   * `queries[i]`. Each element is an array of rows for array-shaped
   * queries, or a bundled object for providers that return multiple
   * collections under named keys.
   *
   * Each row carries `__typename` for client-side model dispatch, plus
   * any `related` keys nested under the row.
   *
   * Failed queries surface as empty arrays. The server logs them via
   * `console.error('[query.error] ...')` — alert on that prefix rather
   * than trying to infer failure from empty results. A tagged-union
   * wire shape that forces caller acknowledgement is the right next
   * step once every `postQuery` consumer is updated at once.
   */
  results: unknown[];
  /**
   * Server watermark observed after the batch ran. Public resource reads
   * expose this as `stamp` and callers thread it into `commits.create({
   * readAt })` to reject stale writes.
   */
  lastSyncId?: number;
}
