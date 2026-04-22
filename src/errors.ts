/**
 * Typed error hierarchy for `@ablo/sync-engine`.
 *
 * Inlined directly (not re-exported from `@ablo/core`) so the
 * publishable dist is self-contained. Previously this file was a
 * re-export from an internal `@ablo/core` package that wasn't
 * published to npm — which meant any customer installing
 * `@ablo/sync-engine` would get a dist referencing an unresolvable
 * bare specifier, breaking Next.js / Turbopack / any strict bundler.
 *
 * Sync-server (apps/sync-server) still imports error classes from
 * `@ablo/core` on its own path — that's fine, the two runtimes
 * never share instances so `instanceof` doesn't cross package
 * boundaries. When the two converge (post-launch cleanup) both
 * consumers will read from one place, but that's a follow-up.
 *
 * ### Two patterns for consumers
 *
 * ```ts
 * // Stripe-style instanceof
 * if (err instanceof AbloRateLimitError) backoff(err.retryAfterSeconds);
 *
 * // Discriminator-string (for cross-boundary cases where the class
 * // identity gets lost, e.g. across a web worker postMessage)
 * if (err.type === 'AbloRateLimitError') { ... }
 * ```
 *
 * Both work on every subclass.
 */

// ── AbloError hierarchy — the typed error surface ────────────────────

/** Common shape for all errors thrown by this SDK. */
export class AbloError extends Error {
  /** Discriminator string — matches the class name. Lets consumers
   *  switch on `e.type` without `instanceof` checks across package
   *  boundaries (matches Stripe's `err.type` pattern). */
  readonly type: string = 'AbloError';
  /** Stable short identifier for logs + metrics.
   *  E.g. `'apikey_invalid'`, `'capability_scope_denied'`. */
  readonly code?: string;
  /** HTTP status code when the error originated from an HTTP response. */
  readonly httpStatus?: number;
  /** Correlation id for ops — present when the server sent one on
   *  `x-request-id`. Include in support tickets. */
  readonly requestId?: string;

  constructor(
    message: string,
    options?: { code?: string; httpStatus?: number; requestId?: string; cause?: unknown },
  ) {
    super(message);
    this.name = this.constructor.name;
    if (options?.code !== undefined) this.code = options.code;
    if (options?.httpStatus !== undefined) this.httpStatus = options.httpStatus;
    if (options?.requestId !== undefined) this.requestId = options.requestId;
    if (options?.cause !== undefined) {
      Object.defineProperty(this, 'cause', { value: options.cause, enumerable: false });
    }
  }
}

/** 401 — invalid/missing/expired credentials. */
export class AbloAuthenticationError extends AbloError {
  readonly type = 'AbloAuthenticationError' as const;
}

/** 403 — credentials were valid but the action is forbidden (scope
 *  denial, revoked capability, role not authorized). */
export class AbloPermissionError extends AbloError {
  readonly type = 'AbloPermissionError' as const;
}

/** 429 — rate limit exceeded. Consumers should back off before retry. */
export class AbloRateLimitError extends AbloError {
  readonly type = 'AbloRateLimitError' as const;
  readonly retryAfterSeconds?: number;

  constructor(
    message: string,
    options?: {
      code?: string;
      httpStatus?: number;
      requestId?: string;
      cause?: unknown;
      retryAfterSeconds?: number;
    },
  ) {
    super(message, options);
    if (options?.retryAfterSeconds !== undefined) {
      this.retryAfterSeconds = options.retryAfterSeconds;
    }
  }
}

/** 409 — same `Idempotency-Key` reused with a different request body. */
export class AbloIdempotencyError extends AbloError {
  readonly type = 'AbloIdempotencyError' as const;
}

/** Network / transport failure — TCP reset, DNS, timeout, abort. */
export class AbloConnectionError extends AbloError {
  readonly type = 'AbloConnectionError' as const;
}

/** 400 / 422 — request payload was invalid. */
export class AbloValidationError extends AbloError {
  readonly type = 'AbloValidationError' as const;
}

/** 5xx — server-side error. Usually retryable with backoff. */
export class AbloServerError extends AbloError {
  readonly type = 'AbloServerError' as const;
}

/**
 * 409 — a write carried `readAt: N` but the target entity has received
 * deltas since `N`. The caller's reasoning snapshot is stale; the safe
 * response is to re-read (or re-capture a watermark) and regenerate.
 *
 * Carries `conflicts` so callers can inspect which specific (model, id)
 * pairs moved during the generation window — useful for metrics
 * ("72% of stale rejects were on slide titles") and for selective
 * regeneration (only re-think the slides that changed, not the whole
 * deck).
 */
export class AbloStaleContextError extends AbloError {
  readonly type = 'AbloStaleContextError' as const;
  /** Sync id at the caller's `readAt` when the write was attempted. */
  readonly readAt?: number;
  /** Entities that received deltas between `readAt` and the write. */
  readonly conflicts?: ReadonlyArray<{
    readonly model: string;
    readonly id: string;
    readonly observedSyncId: number;
  }>;

  constructor(
    message: string,
    options?: {
      code?: string;
      httpStatus?: number;
      requestId?: string;
      cause?: unknown;
      readAt?: number;
      conflicts?: ReadonlyArray<{
        readonly model: string;
        readonly id: string;
        readonly observedSyncId: number;
      }>;
    },
  ) {
    super(message, options);
    if (options?.readAt !== undefined) this.readAt = options.readAt;
    if (options?.conflicts !== undefined) this.conflicts = options.conflicts;
  }
}

// ── Domain-specific subclasses ───────────────────────────────────────

/**
 * Biscuit capability token failed verification — either it's
 * malformed / unknown / revoked (`capability_invalid`), or its
 * caveats deny the attempted action (`capability_scope_denied`).
 *
 * Extends `AbloPermissionError` so existing `instanceof CapabilityError`
 * checks keep working AND broader `instanceof AbloPermissionError`
 * matches for consumers who don't care about the Biscuit specifics.
 */
export class CapabilityError extends AbloPermissionError {
  constructor(
    code: 'capability_scope_denied' | 'capability_invalid',
    message: string,
  ) {
    super(`${code}: ${message}`, { code });
    this.name = 'CapabilityError';
  }
}

// ── Legacy session error (now part of the typed hierarchy) ───────────

/**
 * SyncSessionError — Thrown when authentication/session is invalid or expired.
 * Signals that the user should be redirected to sign in
 * rather than showing a generic retry option.
 *
 * Extends `AbloAuthenticationError` so existing
 * `SyncSessionError.isSessionError(...)` duck-type callers keep
 * working, AND downstream code that only catches the typed hierarchy
 * (`instanceof AbloAuthenticationError` / `e.type === 'AbloAuthenticationError'`)
 * now sees session failures too.
 */
export class SyncSessionError extends AbloAuthenticationError {
  readonly isSessionError = true;
  readonly statusCode: number;

  constructor(message: string, statusCode: number = 401) {
    super(message, { httpStatus: statusCode, code: 'session_expired' });
    this.name = 'SyncSessionError';
    this.statusCode = statusCode;

    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, SyncSessionError);
    }
  }

  /**
   * Check if an error is a session error (duck-type check)
   */
  static isSessionError(error: unknown): error is SyncSessionError {
    if (error instanceof SyncSessionError) {
      return true;
    }
    if (error && typeof error === 'object' && 'isSessionError' in error) {
      return (error as { isSessionError: boolean }).isSessionError === true;
    }
    return false;
  }

  /**
   * Check if an HTTP response status indicates a session error
   */
  static isSessionErrorResponse(status: number, body?: string): boolean {
    if (status === 401) return true;
    if (status === 403) {
      if (body) {
        const lowerBody = body.toLowerCase();
        if (
          lowerBody.includes('session') ||
          lowerBody.includes('unauthorized') ||
          lowerBody.includes('not authenticated') ||
          lowerBody.includes('token')
        ) {
          return true;
        }
      }
      return true;
    }
    return false;
  }
}

// ── HTTP → class mapping ──────────────────────────────────────────────

interface ErrorBodyShape {
  error?: string;
  code?: string;
  reason?: string;
  message?: string;
}

/**
 * Translate an HTTP response into the appropriate typed error.
 *
 * Single source of truth for status-code → class mapping — every SDK
 * fetch path that sees a non-2xx response should route through here
 * so the customer-visible error is always the right subclass.
 */
export function translateHttpError(
  status: number,
  body: unknown,
  requestId?: string,
): AbloError {
  const parsed: ErrorBodyShape =
    typeof body === 'object' && body !== null ? (body as ErrorBodyShape) : {};
  const code = parsed.code ?? parsed.error;
  const message =
    parsed.reason ??
    parsed.message ??
    parsed.error ??
    (typeof body === 'string' ? body : `HTTP ${status}`);
  const baseOpts = { code, httpStatus: status, requestId };

  if (status === 401) return new AbloAuthenticationError(message, baseOpts);
  if (status === 403) return new AbloPermissionError(message, baseOpts);
  if (status === 409) return new AbloIdempotencyError(message, baseOpts);
  if (status === 422 || status === 400) return new AbloValidationError(message, baseOpts);
  if (status === 429) return new AbloRateLimitError(message, baseOpts);
  if (status >= 500) return new AbloServerError(message, baseOpts);
  return new AbloError(message, baseOpts);
}
