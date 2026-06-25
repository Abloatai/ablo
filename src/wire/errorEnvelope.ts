/**
 * ERROR egress — turn ANY thrown value into Stripe's error-object envelope plus
 * an HTTP status, so every error response across the Ablo surface carries the
 * identical `{ type, code, param, message, doc_url, request_id }` shape
 * regardless of which route or service produced it.
 *
 * This is the wire-PRODUCE counterpart to `errors.ts`'s wire-PARSE
 * (`translateHttpError`/`errorFromWire`). It lives in `wire/` — not in the main
 * SDK entry — so a server-side consumer (a Next.js route) can import it without
 * dragging in the client runtime (mobx/react/IndexedDB).
 *
 * The classifier is the UNIVERSAL baseline: a typed {@link AbloError} passes
 * through (subclass + code + httpStatus preserved), everything else degrades to
 * a 500 `internal_error`. Service-specific normalization that needs a DB driver
 * (apps/sync-server classifies raw Postgres SQLSTATE + MutatorError) is layered
 * on top in that service — it is intentionally NOT pulled into the shared,
 * dependency-free contract.
 */
import { AbloError, docUrlForCode } from '../errors.js';
import { errorCodeSpec } from '../errorCodes.js';

/** The canonical wire envelope — Stripe's error-object shape. Every HTTP error
 *  response and every structured frame error carries this exact set of keys,
 *  regardless of which route or transport produced it. */
export interface ErrorEnvelope {
  readonly type: string;
  readonly code?: string;
  readonly param?: string;
  readonly message: string;
  readonly doc_url?: string;
  readonly request_id?: string;
  /** Aggregate field-level failures — so one 4xx can report EVERY invalid input
   *  at once (schema push, batch commit, CLI-arg validation) instead of failing
   *  on the first. `param` stays the single-field convenience case. (RFC 9457
   *  `errors[]` / JSON:API `errors[]` / Google `BadRequest.fieldViolations[]`.) */
  readonly errors?: ReadonlyArray<{
    readonly code?: string;
    readonly message: string;
    readonly param?: string;
  }>;
  /** Typed-details slot: `AbloError.toJSON()` spreads its `details` (e.g.
   *  `missingIds`, `conflicts`, `retryAfterSeconds`) as top-level members.
   *  Consumers MUST ignore members they don't recognize (forward-compat). */
  readonly [key: string]: unknown;
}

/** {@link AbloError} subclass → default HTTP status. The subclass is chosen to
 *  match status semantics (a validation error is a 400, a permission error a
 *  403), so a throw site only picks the right class + code and the status
 *  follows — an explicit `httpStatus` is passed only when it diverges (e.g. a
 *  404 on the base class, a 503 on AbloServerError). Mirrors the same table in
 *  apps/sync-server's self-contained `errors.ts`. */
export function statusForType(type: string): number {
  switch (type) {
    case 'AbloAuthenticationError':
      return 401;
    case 'AbloPermissionError':
      return 403;
    case 'AbloValidationError':
      return 400;
    case 'AbloRateLimitError':
      return 429;
    case 'AbloIdempotencyError':
    case 'AbloStaleContextError':
    case 'AbloClaimedError':
      return 409;
    case 'AbloConnectionError':
      return 503;
    case 'AbloServerError':
      return 500;
    default:
      return 500;
  }
}

/**
 * Convert ANY thrown value into the canonical {@link ErrorEnvelope} plus an
 * HTTP status. A typed {@link AbloError} is serialized via its own `toJSON`
 * (so `code`/`param`/`doc_url`/structured `details` survive) and gets its
 * status from an explicit `httpStatus` or, failing that, {@link statusForType}.
 * Anything else degrades to a 500 `internal_error` envelope — never a bare
 * framework "Internal Server Error" text body, and never a raw error string
 * leaked onto the wire as an unregistered code.
 *
 * `requestId` is stamped into the body when the error didn't already carry one,
 * so the response and the `x-request-id` header agree for support correlation.
 */
export function errorEnvelope(
  err: unknown,
  requestId?: string,
): { body: ErrorEnvelope; status: number } {
  if (err instanceof AbloError) {
    // Status precedence: an explicit httpStatus wins; else the code's canonical
    // status from the registry (so `new AbloError('…', { code: 'entity_not_found' })`
    // is a 404 without the throw site repeating it); else the subclass default.
    const status =
      err.httpStatus ??
      (err.code ? errorCodeSpec(err.code)?.httpStatus : undefined) ??
      statusForType(err.type);
    const body = err.toJSON();
    return {
      body: requestId && body.request_id === undefined ? { ...body, request_id: requestId } : body,
      status,
    };
  }
  const message = err instanceof Error ? err.message : String(err);
  return {
    body: {
      type: 'AbloServerError',
      code: 'internal_error',
      message,
      doc_url: docUrlForCode('internal_error'),
      ...(requestId ? { request_id: requestId } : {}),
    },
    status: 500,
  };
}
