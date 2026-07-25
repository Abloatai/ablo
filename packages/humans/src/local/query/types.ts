/**
 * Structured query types for the `/sync/query` endpoint.
 *
 * A query describes a filtered read in a compact wire format. `where` is a flat
 * list of `[column, operator, value]` conditions combined with AND, and
 * `related` names the schema relations to fetch alongside each row. The server
 * compiles a query against your schema: it reads the model's relation metadata
 * to turn `related: ['blocks']` into the right join, and turns each condition
 * into a WHERE fragment. The protocol carries no model-specific logic, so
 * adding a model or relation is a schema change rather than a server change.
 *
 * The `IN` operator lets you batch a read by any column, including a foreign
 * key — for example, fetching every block whose `sectionId` falls in a set of
 * ids.
 */

// The where grammar describes the *request*, not any local copy of the rows it
// returns, so it lives in the settlement core (ADR 0016). Re-exported here so
// the existing `query/types` import path keeps resolving.
export type {
  WherePrimitive,
  WhereOp,
  WhereClause,
  LoadWhere,
} from '@ablo/transaction/resources/where';
import type { WhereClause } from '@ablo/transaction/resources/where';

/** A single structured fetch request. */
export interface Query {
  /**
   * Client-facing model name (e.g. "File", "Block", "Message").
   * The server's adapter maps this to the actual database table.
   */
  model: string;

  /**
   * The conditions to filter by, combined with AND. Empty or omitted returns
   * every row the caller may see; reads are still scoped to the caller's
   * organization on the server. Use `['col', 'IN', values]` to batch a read by
   * any column.
   */
  where?: readonly WhereClause[];

  /**
   * The relations to fetch with each row, named as they are declared on this
   * model in the schema. The server resolves each name from the schema's
   * relation metadata and joins the related rows in. They come back nested
   * under the relation key:
   *
   *   { __typename: 'Section', id: '…', blocks: [{ __typename: 'Block', … }] }
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
   * The result of each query, in request order: `results[i]` corresponds to
   * `queries[i]`. Each element is an array of rows, or an object bundling
   * several named row collections when the source returns more than one. Every
   * row carries a `__typename` field naming its model, so callers can dispatch
   * on it, along with any requested `related` rows nested under their relation
   * key.
   *
   * A query that fails on the server comes back as an empty array, which is
   * indistinguishable from a query that simply matched nothing — treat an empty
   * result as "no rows", not as proof the query succeeded. The element type is
   * `unknown` because one batch can mix row shapes, so narrow each result
   * before use.
   */
  results: unknown[];
  /**
   * The server watermark observed after the batch ran. Model reads expose this
   * as `stamp`, and callers thread it into `commits.create({ readAt })` so the
   * server can reject a write built on stale data.
   */
  lastSyncId?: number;
}
