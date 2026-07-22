/**
 * The where-clause grammar carried by a filtered read.
 *
 * A `where` is a flat list of `[column, operator, value]` conditions combined
 * with AND. The protocol carries no model-specific logic: the server compiles a
 * condition against your schema, so adding a model or relation is a schema
 * change rather than a server change.
 *
 * The `IN` operator lets you batch a read by any column, including a foreign
 * key — for example, fetching every block whose `sectionId` falls in a set of ids.
 *
 * These types describe the *request*, not any local copy of the rows it returns,
 * so they live with the settlement core rather than the reactive consumer.
 */

import { z } from 'zod';

/** Primitive operand types allowed in a where clause. */
export type WherePrimitive = string | number | boolean | null;

/**
 * The comparison operators a {@link WhereClause} may use: equality and
 * inequality, ordering, set membership (`IN` / `NOT IN`), null checks
 * (`IS` / `IS NOT`), and case-sensitive or case-insensitive pattern
 * matching (`LIKE`, `ILIKE`, and their negations).
 */
export const whereOpSchema = z.enum([
  '=',
  '!=',
  '<',
  '<=',
  '>',
  '>=',
  'IN',
  'NOT IN',
  'IS',
  'IS NOT',
  'LIKE',
  'NOT LIKE',
  'ILIKE',
  'NOT ILIKE',
]);
export type WhereOp = z.infer<typeof whereOpSchema>;

/**
 * How each operator binds its operand — the classification a compiler needs
 * before it can render or evaluate a condition: a scalar on the right, an array
 * to expand, or a null check with no operand at all. `LIKE_OPS` is the subset
 * whose operand is a pattern and therefore needs pattern validation.
 *
 * These live here, beside the operators, because every consumer of the grammar
 * needs the same split and there is more than one consumer: a where clause is
 * compiled to SQL on a hosted plane and evaluated in memory against the log on
 * a source plane. Two hand-maintained copies of this split meant the same
 * request could be accepted by one plane and rejected by the other — and the
 * pattern-safety set existed on only one of them.
 */
export const WHERE_SCALAR_OPS: ReadonlySet<WhereOp> = new Set<WhereOp>([
  '=',
  '!=',
  '<',
  '<=',
  '>',
  '>=',
  'LIKE',
  'NOT LIKE',
  'ILIKE',
  'NOT ILIKE',
]);
export const WHERE_ARRAY_OPS: ReadonlySet<WhereOp> = new Set<WhereOp>(['IN', 'NOT IN']);
export const WHERE_NULL_OPS: ReadonlySet<WhereOp> = new Set<WhereOp>(['IS', 'IS NOT']);
export const WHERE_LIKE_OPS: ReadonlySet<WhereOp> = new Set<WhereOp>([
  'LIKE',
  'NOT LIKE',
  'ILIKE',
  'NOT ILIKE',
]);

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
