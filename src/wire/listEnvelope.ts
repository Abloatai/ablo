/**
 * The canonical Ablo LIST envelope — the one shape every endpoint that returns
 * a collection uses, so a consumer can detect + paginate any list uniformly
 * instead of learning a per-endpoint payload key (`{ keys }`, `{ origins }`,
 * `{ events }`, `{ buckets }`…).
 *
 * `{ object: 'list', data: [...], has_more, next_cursor }` is the shape the
 * hosted `GET /v1/models/:model` endpoint already emits (apps/sync-server
 * `routes/query.ts`) and that `@ablo/mcp` already consumes — promoted here so
 * sync-web's dashboard lists, the SDK, and any future surface produce the
 * identical envelope from one definition.
 *
 * The field NAMES are Stripe's (`object`/`has_more`/`next_cursor`), not
 * PlanetScale's (`type`/`cursor_start`/`has_next`): the rest of the Ablo API is
 * Stripe-modeled, so this keeps one vocabulary across the surface. The
 * PlanetScale discipline we deliberately borrow is *"every list is the same
 * envelope"* — not the concrete key names.
 */
export interface ListEnvelope<T> {
  /** Discriminator — always `'list'`. Lets a generic client recognise a
   *  paginated collection without per-endpoint special-casing. */
  readonly object: 'list';
  /** The page of results. Always present (an empty array when there are none),
   *  never omitted, so `body.data` is a stable access path. */
  readonly data: readonly T[];
  /** Whether more results exist past this page. Drive "load more" off this,
   *  not off `data.length === limit` (ambiguous on an exact-multiple page). */
  readonly has_more: boolean;
  /** Opaque cursor to pass back as `?starting_after=` for the next page, or
   *  `null` when {@link has_more} is `false`. */
  readonly next_cursor: string | null;
}

/**
 * Stamp the uniform {@link ListEnvelope} onto an already-resolved page of rows.
 *
 * Pagination stays the caller's responsibility (fetch `limit + 1`, decide
 * `hasMore`, derive the cursor from the last row's order key) — this only
 * applies the envelope so no endpoint hand-rolls the shape. The defaults model
 * the common "small, unpaginated collection" case (`has_more: false`,
 * `next_cursor: null`); a paginated endpoint passes both explicitly.
 */
export function listEnvelope<T>(
  data: readonly T[],
  opts: { hasMore?: boolean; nextCursor?: string | null } = {},
): ListEnvelope<T> {
  return {
    object: 'list',
    data,
    has_more: opts.hasMore ?? false,
    next_cursor: opts.nextCursor ?? null,
  };
}
