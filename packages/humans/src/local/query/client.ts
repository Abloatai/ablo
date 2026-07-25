/**
 * The HTTP client for the sync query endpoint.
 *
 * {@link postQuery} is a small wrapper over `fetch` that POSTs a
 * {@link QueryBatch} as JSON to `/sync/query`, attaches the bearer credential
 * as an `Authorization` header, and parses the response into a typed
 * {@link QueryBatchResult}. An HTTP failure is not thrown: it is logged, and
 * every query in the batch comes back with an empty result, so a
 * fire-and-forget caller cannot crash on an unhandled rejection.
 *
 * Higher-level query helpers build on this to issue structured queries without
 * repeating the fetch and error-handling boilerplate.
 */

import { z } from 'zod';
import type { QueryBatch, QueryBatchResult } from './types.js';
import { translateHttpError } from '@abloatai/transaction/errors';
import { classifyRecovery, type RecoveryClass } from '@abloatai/transaction/errorCodes';
import { withAuthHeaders, type AuthTokenGetter } from '@abloatai/transaction/auth/credentialSource';
import { globalRuntime } from '../context.js';
import type { RuntimeContext } from '../RuntimeContext.js';

// ── Response validation ─────────────────────────────────────────────────
//
// Each result slot is an array of rows, or an object for a bundled response.
// A per-query failure on the server surfaces here as an empty array rather
// than an error, so emptiness alone does not distinguish "no rows" from
// "the query failed." Parsing through Zod normalizes a `null` slot into an
// empty array, so callers never receive a raw null.
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
  .loose();

export interface PostQueryOptions {
  /**
   * Full base URL of the sync server including the `/api` prefix.
   * The query endpoint is appended as `/sync/query`, so the final
   * request hits `${baseUrl}/sync/query`.
   */
  baseUrl: string;

  /** Timeout in ms for the fetch request. Default: 30000. */
  fetchTimeout?: number;

  /** The owning client's runtime. Defaults to the module-global bridge. */
  runtime?: RuntimeContext;

  /**
   * Live bearer credential getter. Preferred over `capabilityToken` because it
   * is read per request, so token refreshes propagate without reconstructing
   * query helpers.
   */
  getAuthToken?: AuthTokenGetter;

  /**
   * A fixed credential string, for callers that hold only a copied token.
   * Prefer `getAuthToken`, which is re-read on each request so a refresh takes
   * effect without rebuilding the client.
   */
  capabilityToken?: string;

  /**
   * An optional hook that tries to recover from a rejected credential. When a
   * query comes back with a 401, its {@link RecoveryClass} is passed here: a
   * return of `'retry'` means a fresh credential has been obtained and the
   * request is replayed exactly once, while `'stop'` ends the attempt. Because
   * the replay happens at most once, a wedged credential cannot cause a retry
   * loop. When this hook is absent, a 401 is logged and returns empty results
   * like any other failure.
   */
  recoverCredential?: (recovery: RecoveryClass) => Promise<'retry' | 'stop'>;
}

/**
 * Sends a batch of queries to `/sync/query` and returns the parsed
 * {@link QueryBatchResult}. An HTTP failure is not thrown: it is logged, and
 * every query in the batch comes back with an empty result, which keeps a
 * fire-and-forget caller from crashing on an unhandled rejection. A 401 may
 * first be handed to {@link PostQueryOptions.recoverCredential} for a single
 * retry.
 *
 * The response preserves order: `results[i]` corresponds to the query at
 * `queries[i]`, so callers can rely on index alignment to pull typed results
 * out of a multi-query batch.
 */
export async function postQuery(
  options: PostQueryOptions,
  batch: QueryBatch,
): Promise<QueryBatchResult> {
  const url = `${options.baseUrl}/sync/query`;
  const timeout = options.fetchTimeout ?? 30_000;
  const runtime = options.runtime ?? globalRuntime;

  // At most two attempts: the original request, plus one replay after a
  // successful credential recovery (see `recoverCredential`). A second auth
  // rejection falls through to the log-and-empty path, so a wedged credential
  // can never retry-loop.
  for (let attempt = 0; ; attempt++) {
    // Race the fetch against a timeout so hung requests don't block
    // the calling helper indefinitely. Fresh controller per attempt.
    const controller = new AbortController();
    const timer = setTimeout(() => { controller.abort(); }, timeout);

    try {
      // Recomputed per attempt: `withAuthHeaders` reads the live credential
      // source, so a replay after recovery carries the freshly-minted key.
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
        // Build the typed AbloError for this HTTP failure (the same
        // code-to-class map the throwing paths use) so the log carries a
        // registry `code` — for example an authentication error with
        // `session_expired` on a 401 — rather than a bare status. This path
        // deliberately does not throw, since a fire-and-forget caller could
        // crash on an unhandled rejection. It returns empty slots while still
        // logging a legible Ablo error.
        let body: unknown = null;
        try {
          body = await response.clone().json();
        } catch {
          // non-JSON error page — translateHttpError falls back to status text
        }
        const err = translateHttpError(response.status, body);

        // On a 401, hand the failure to the recovery hook once. The recovery
        // class routes the outcome: an expired access credential is re-minted
        // and the request replays; a lost session is terminal and stops here;
        // anything else stops. A bare 401 with no readable code is treated as
        // an expired access credential, so the only terminal path is the
        // re-mint itself coming back empty, never an ambiguous status.
        if (attempt === 0 && response.status === 401 && options.recoverCredential) {
          const recovery: RecoveryClass =
            typeof err.code === 'string'
              ? classifyRecovery(err.code)
              : 'access_credential_expiry';
          const outcome = await options.recoverCredential(recovery);
          if (outcome === 'retry') {
            runtime.logger.debug('[postQuery] credential recovered — replaying query once', {
              code: err.code ?? response.status,
            });
            continue;
          }
        }

        // Logged through the level-gated logger, so it honors ABLO_LOG_LEVEL:
        // a `warn` line the app developer can read (the models, the typed
        // message, and a wire `code`), with the forensic detail on a companion
        // `debug` line. The read stays empty until the underlying cause, such
        // as auth or network, is resolved.
        const models = batch.queries.map((q) => q.model).join(', ');
        runtime.logger.warn(
          `Could not load ${models} — ${err.message} (code: ${err.code ?? response.status}). No results were returned.`,
        );
        runtime.logger.debug('[postQuery.error] query http failure', {
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
        runtime.logger.debug('[postQuery.error] malformed response', {
          issues: parsed.error.issues,
        });
        return { results: batch.queries.map(() => []) };
      }
      return parsed.data;
    } finally {
      clearTimeout(timer);
    }
  }
}
