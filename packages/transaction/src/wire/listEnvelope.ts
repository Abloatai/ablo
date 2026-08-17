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
import { z } from 'zod';

/**
 * The query parameter a caller resumes a collection with, and the single alias
 * retained for it.
 *
 * Declared beside the envelope that issues `next_cursor`, because the parameter
 * and the field it consumes are one contract and both planes read them: the
 * server to know which names are taken, the spec generator to document them,
 * the client to send one. When the name lived in each of those separately, this
 * spec described `starting_after` for a model list and `cursor` for a commit
 * record list — the same concept under two names, in one document.
 *
 * `starting_after` is the spelling used through 0.52.0. It borrowed a name whose
 * established meaning elsewhere is a row id, while this value has always been an
 * opaque token bound to the sort it was issued for.
 */
export const CURSOR_PARAM = 'cursor';

/** @deprecated The pre-0.53.0 spelling of {@link CURSOR_PARAM}. */
export const CURSOR_PARAM_ALIAS = 'starting_after';

/** Both names a cursor may arrive under, for reserving them in a query string. */
export const CURSOR_PARAM_NAMES: readonly string[] = [CURSOR_PARAM, CURSOR_PARAM_ALIAS];

/**
 * Builds the authoritative list-envelope schema for a row schema. Keeping the
 * item validator generic lets every endpoint share the same envelope contract
 * without weakening `data` to `unknown[]`.
 */
export function listEnvelopeSchema<T>(itemSchema: z.ZodType<T>) {
  return z.object({
    object: z.literal('list'),
    data: z.array(itemSchema).readonly(),
    has_more: z.boolean(),
    next_cursor: z.string().nullable(),
  });
}

export type ListEnvelope<T> = Readonly<z.infer<
  ReturnType<typeof listEnvelopeSchema<T>>
>>;

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
