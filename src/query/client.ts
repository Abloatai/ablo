/**
 * HTTP client for the generic /sync/query endpoint.
 *
 * Thin wrapper over fetch() that:
 *   - POSTs a QueryBatch as JSON
 *   - Sends the bearer credential via withAuthHeaders (Authorization header)
 *   - Throws on non-2xx responses
 *   - Parses the response into a typed QueryBatchResult
 *
 * The higher-level BootstrapHelper methods (fetchDeckSlideLayers,
 * fetchChatMessages, etc.) use this to issue structured queries
 * without duplicating the fetch boilerplate.
 */

import { z } from 'zod';
import type { QueryBatch, QueryBatchResult } from './types.js';
import { translateHttpError } from '../errors.js';
import { withAuthHeaders, type AuthTokenGetter } from '../auth/credentialSource.js';
import { getContext } from '../context.js';

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
   * Live bearer credential getter. Preferred over `capabilityToken` because it
   * is read per request, so token refreshes propagate without reconstructing
   * query helpers.
   */
  getAuthToken?: AuthTokenGetter;

  /**
   * Compatibility fallback for callers that have only a copied token string.
   * New SDK internals should pass `getAuthToken`.
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
    const headers = withAuthHeaders(
      options.getAuthToken,
      { 'Content-Type': 'application/json' },
      options.capabilityToken,
    );
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(batch),
      signal: controller.signal,
    });

    if (!response.ok) {
      // Build the typed AbloError for this HTTP failure (same code→class
      // map the throwing paths use) so the log is tagged + carries a
      // registry `code` (e.g. AbloAuthenticationError/session_expired on a
      // 401) instead of a bare status. We deliberately DON'T throw —
      // fire-and-forget callers would kill the Next.js router on an
      // unhandled rejection — and still return empty slots, but the failure
      // is now legible as an Ablo error. Routed through the gated logger so it
      // obeys ABLO_LOG_LEVEL like everything else: a consumer-register `warn`
      // (their models + the typed message + a wire `code`) with the forensics on
      // a `debug` companion. Actionable and not self-healing — the read returns
      // empty until the underlying cause (auth, network) is resolved.
      let body: unknown = null;
      try {
        body = await response.clone().json();
      } catch {
        // non-JSON error page — translateHttpError falls back to status text
      }
      const err = translateHttpError(response.status, body);
      const models = batch.queries.map((q) => q.model).join(', ');
      getContext().logger.warn(
        `Could not load ${models} — ${err.message} (code: ${err.code ?? response.status}). No results were returned.`,
      );
      getContext().logger.debug('[postQuery.error] query http failure', {
        type: err.type,
        code: err.code ?? response.status,
        models,
        message: err.message,
      });
      return { results: batch.queries.map(() => []) };
    }

    const raw: unknown = await response.json();
    const parsed = QueryBatchResultSchema.safeParse(raw);
    if (!parsed.success) {
      // A malformed server response isn't something the consumer can act on
      // (server/protocol issue) → debug, gated like everything else.
      getContext().logger.debug('[postQuery.error] malformed response', {
        issues: parsed.error.issues,
      });
      return { results: batch.queries.map(() => []) };
    }
    return parsed.data;
  } finally {
    clearTimeout(timer);
  }
}
