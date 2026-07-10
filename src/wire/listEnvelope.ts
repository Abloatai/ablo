/**
 * The envelope every endpoint that returns a collection wraps its results in.
 * Because the shape is always the same — `{ object: 'list', data, has_more,
 * next_cursor }` — a consumer can detect and paginate any list the same way,
 * instead of learning a different payload key for each endpoint.
 *
 * The list endpoints emit this shape and the {@link listEnvelope} helper
 * produces it, so every list across the API reads from one definition. The
 * generic type parameter carries the row type of `data`.
 */
export interface ListEnvelope<T> {
  /** Always the literal `'list'`. Lets a generic client recognize a collection
   *  response without special-casing each endpoint. */
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
 * Wraps an already-fetched page of rows in the uniform {@link ListEnvelope}.
 *
 * Pagination stays the caller's job — fetch one more row than the limit to
 * decide `hasMore`, and derive the cursor from the last row's sort key. This
 * helper only applies the envelope so no endpoint has to build the shape by
 * hand. The defaults describe a small, unpaginated collection
 * (`has_more: false`, `next_cursor: null`); a paginated endpoint passes both
 * explicitly.
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
