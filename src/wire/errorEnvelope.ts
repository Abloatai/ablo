/**
 * Turns any thrown value into the canonical error envelope and an HTTP status,
 * so every error response carries the same
 * `{ type, code, param, message, doc_url, request_id }` shape no matter which
 * route or transport produced it. This is the counterpart to the wire-parsing
 * helpers in the errors module, which turn a received envelope back into a typed
 * error.
 *
 * It has no dependency on the client runtime, so a server-side handler can
 * import it on its own to format error responses. A typed {@link AbloError}
 * passes through with its code and status intact; anything else becomes a
 * generic 500. A service that needs to classify database-driver failures can
 * layer that on top before falling back to this baseline.
 */
import { AbloError, docUrlForCode } from '../errors.js';
import { errorCodeSpec } from '../errorCodes.js';

/**
 * The fixed, public-facing message returned for an unclassified 500. A raw
 * `err.message` can carry driver text, connection strings, or stack fragments,
 * so it is never placed on the wire; a caller that needs those details logs the
 * original error server-side before formatting the response.
 */
export const INTERNAL_ERROR_PUBLIC_MESSAGE = 'An internal error occurred.';

/** The canonical error envelope. Every HTTP error response and every structured
 *  frame error carries this exact set of keys, regardless of which route or
 *  transport produced it. */
export interface ErrorEnvelope {
  readonly type: string;
  readonly code?: string;
  readonly param?: string;
  readonly message: string;
  readonly doc_url?: string;
  readonly request_id?: string;
  /** Field-level failures collected together, so a single 4xx can report every
   *  invalid input at once — for example a schema push, a batch commit, or CLI
   *  argument validation — instead of failing on the first. Use `param` for the
   *  single-field case. */
  readonly errors?: readonly {
    readonly code?: string;
    readonly message: string;
    readonly param?: string;
  }[];
  /** Additional typed details. {@link AbloError} serialization spreads its
   *  `details` — such as `missingIds`, `conflicts`, or `retryAfterSeconds` — as
   *  top-level members here. Ignore any member you do not recognize, so new ones
   *  can be added without breaking you. */
  readonly [key: string]: unknown;
}

/** Maps an {@link AbloError} subclass name to its default HTTP status. Each
 *  subclass is chosen to match the status — a validation error is a 400, a
 *  permission error a 403 — so a throw site picks the right class and code and
 *  the status follows. An explicit `httpStatus` is supplied only when it
 *  diverges, such as a 404 on the base class or a 503 on a server error. */
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
 * Converts any thrown value into the canonical {@link ErrorEnvelope} and an HTTP
 * status. A typed {@link AbloError} is serialized through its own `toJSON`, so
 * its code, param, doc_url, and structured details survive, and its status comes
 * from an explicit `httpStatus` or, failing that, {@link statusForType}.
 * Anything else becomes a 500 `internal_error` envelope — never a bare framework
 * "Internal Server Error" body, and never a raw error string leaked onto the
 * wire as an unregistered code.
 *
 * When `requestId` is supplied and the error does not already carry one, it is
 * stamped into the body so the response and the `x-request-id` header agree for
 * support correlation.
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
  // Unknown throw: mask it. An unclassified 500 can carry database, driver, or
  // other internal detail, so the raw message is never echoed here — this
  // envelope is served directly to browsers. The original error stays with the
  // caller for logging.
  return {
    body: {
      type: 'AbloServerError',
      code: 'internal_error',
      message: INTERNAL_ERROR_PUBLIC_MESSAGE,
      doc_url: docUrlForCode('internal_error'),
      ...(requestId ? { request_id: requestId } : {}),
    },
    status: 500,
  };
}
