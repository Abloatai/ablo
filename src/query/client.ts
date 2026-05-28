/**
 * HTTP client for the generic /sync/query endpoint.
 *
 * Thin wrapper over fetch() that:
 *   - POSTs a QueryBatch as JSON
 *   - Handles auth via `credentials: 'include'` (session cookie)
 *   - Throws on non-2xx responses
 *   - Parses the response into a typed QueryBatchResult
 *
 * The higher-level BootstrapHelper methods (fetchDeckSlideLayers,
 * fetchChatMessages, etc.) use this to issue structured queries
 * without duplicating the fetch boilerplate.
 */

import { z } from 'zod';
import type { QueryBatch, QueryBatchResult } from './types.js';

// ── Response validation ─────────────────────────────────────────────────
//
// Each result slot is an array of rows (or an object for bundled
// responses). Server-side per-query failures surface here as `[]`, but
// the server logs them via `console.error('[query.error] ...')` — alert
// on that prefix, not on emptiness. Parsing through Zod normalizes
// `null` slots into empty arrays so downstream callers never see raw
// null.
const QueryResultSchema = z
  .union([z.array(z.unknown()), z.record(z.string(), z.unknown()), z.null()])
  .transform((val): unknown[] | Record<string, unknown> => {
    if (val === null) return [];
    return val;
  });

const QueryBatchResultSchema = z
  .object({
    results: z.array(QueryResultSchema),
  })
  .passthrough();

export interface PostQueryOptions {
  /**
   * Full base URL of the sync server including the `/api` prefix.
   * The query endpoint is appended as `/sync/query`, so the final
   * request hits `${baseUrl}/sync/query`.
   */
  baseUrl: string;

  /** Timeout in ms for the fetch request. Default: 30000. */
  fetchTimeout?: number;

  /**
   * Bearer credential — a restricted (`rk_`) API key — attached as
   * `Authorization: Bearer <token>`. Required for Node consumers
   * (agent-worker, server-side tests) that have no session cookie to
   * ride. Browser consumers can omit this and fall back to
   * `credentials: 'include'`. When both are present the server prefers
   * the Bearer header (see `apiKeyProvider` in
   * `apps/sync-server/src/auth`), so passing the token in browser code
   * is harmless. (Field name predates the Biscuit→opaque-key migration.)
   */
  capabilityToken?: string;
}

/**
 * POST a batch of queries to /sync/query. Returns the parsed
 * QueryBatchResult. Throws a descriptive error on HTTP failure.
 *
 * The server guarantees results[i] corresponds to queries[i] in the
 * request — callers can rely on index alignment to extract typed
 * results from a multi-query batch.
 */
export async function postQuery(
  options: PostQueryOptions,
  batch: QueryBatch,
): Promise<QueryBatchResult> {
  const url = `${options.baseUrl}/sync/query`;
  const timeout = options.fetchTimeout ?? 30_000;

  // Race the fetch against a timeout so hung requests don't block
  // the calling helper indefinitely.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (options.capabilityToken) {
      headers.Authorization = `Bearer ${options.capabilityToken}`;
    }
    const response = await fetch(url, {
      method: 'POST',
      headers,
      credentials: 'include',
      body: JSON.stringify(batch),
      signal: controller.signal,
    });

    if (!response.ok) {
      // Direct console.error is INTENTIONAL — operators alert on the
      // `[postQuery.error]` prefix in browser console. Routing through
      // an injected logger here would require a coordinated change to
      // the alerting pipeline. Tracked as future work; the dual-channel
      // alternative (logger + observability.captureException) is the
      // production target. Never throw — fire-and-forget callers would
      // kill Next.js router on unhandled rejection.
      console.error(
        `[postQuery.error] ${response.status} ${response.statusText} for ${batch.queries.map((q) => q.model).join(',')}`,
      );
      return { results: batch.queries.map(() => []) };
    }

    const raw: unknown = await response.json();
    const parsed = QueryBatchResultSchema.safeParse(raw);
    if (!parsed.success) {
      console.error('[postQuery.error] malformed response:', parsed.error.issues);
      return { results: batch.queries.map(() => []) };
    }
    return parsed.data;
  } finally {
    clearTimeout(timer);
  }
}
