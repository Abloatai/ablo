/**
 * Typed error hierarchy for `@abloatai/ablo`.
 *
 * Inlined directly so the publishable dist is self-contained. The public
 * package should never reference an unpublished internal package from emitted
 * JS; strict bundlers surface that immediately.
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

import type { ErrorCode } from './errorCodes.js';

export type { ErrorCode, WireErrorCode, ErrorCategory, ErrorCodeSpec } from './errorCodes.js';
export { ERROR_CODES, ERROR_CONTRACT_VERSION, errorCodeSpec, isRetryableCode } from './errorCodes.js';

// ── AbloError hierarchy — the typed error surface ────────────────────

/** Common shape for all errors thrown by this SDK. */
export class AbloError extends Error {
  /** Discriminator string — matches the class name. Lets consumers
   *  switch on `e.type` without `instanceof` checks across package
   *  boundaries (matches Stripe's `err.type` pattern). */
  readonly type: string = 'AbloError';
  /** Stable short identifier for logs + metrics, drawn from the closed
   *  {@link ErrorCode} registry — e.g. `'apikey_invalid'`,
   *  `'capability_scope_denied'`. Stored as a plain `string` (not
   *  `ErrorCode`) so an older SDK still surfaces a newer server's code it
   *  doesn't recognise yet; producers are constrained at the constructor
   *  param instead. */
  readonly code?: string;
  /** HTTP status code when the error originated from an HTTP response. */
  readonly httpStatus?: number;
  /** Correlation id for ops — present when the server sent one on
   *  `x-request-id`. Include in support tickets. */
  readonly requestId?: string;
  /** Which input caused the error — a model/field path like
   *  `'dataroomMember.grants.subject'`. Mirrors Stripe's `error.param`;
   *  lets tooling point at the exact offending declaration. */
  readonly param?: string;
  /** Link to the docs for this `code`. Mirrors Stripe's `error.doc_url`.
   *  Defaults from `code` via {@link docUrlForCode} when omitted. */
  readonly docUrl?: string;
  /** Domain-specific structured payload merged into the wire envelope —
   *  e.g. a schema push's `{ warnings, unexecutable }`, a stale write's
   *  conflicting rows. Mirrors how Stripe attaches type-specific fields
   *  (`decline_code`, `payment_intent`) alongside the standard ones, so a
   *  structured error keeps its detail through `toJSON` instead of being
   *  flattened to a bare message. */
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(
    message: string,
    options?: {
      code?: ErrorCode;
      httpStatus?: number;
      requestId?: string;
      cause?: unknown;
      param?: string;
      docUrl?: string;
      details?: Readonly<Record<string, unknown>>;
    },
  ) {
    super(message);
    this.name = this.constructor.name;
    if (options?.code !== undefined) this.code = options.code;
    if (options?.httpStatus !== undefined) this.httpStatus = options.httpStatus;
    if (options?.requestId !== undefined) this.requestId = options.requestId;
    if (options?.param !== undefined) this.param = options.param;
    if (options?.details !== undefined) this.details = options.details;
    const docUrl = options?.docUrl ?? (options?.code ? docUrlForCode(options.code) : undefined);
    if (docUrl !== undefined) this.docUrl = docUrl;
    if (options?.cause !== undefined) {
      Object.defineProperty(this, 'cause', { value: options.cause, enumerable: false });
    }
  }

  /**
   * Serialize to Stripe's error-object shape: `{ type, code, param, message,
   * doc_url, request_id }`. One JSON shape across HTTP bodies, WS frames, and
   * logs — so consumers parse Ablo errors the way they already parse Stripe's.
   */
  toJSON(): {
    type: string;
    code?: string;
    param?: string;
    message: string;
    doc_url?: string;
    request_id?: string;
    [key: string]: unknown;
  } {
    return {
      type: this.type,
      ...(this.code !== undefined ? { code: this.code } : {}),
      ...(this.param !== undefined ? { param: this.param } : {}),
      message: this.message,
      ...(this.docUrl !== undefined ? { doc_url: this.docUrl } : {}),
      ...(this.requestId !== undefined ? { request_id: this.requestId } : {}),
      ...(this.details ?? {}),
    };
  }
}

/**
 * Map a stable error `code` to its docs URL — the one place the convention
 * lives, so every error carrying a code gets a `doc_url` for free (Stripe
 * ships a link on every error).
 */
export function docUrlForCode(code: ErrorCode): string {
  return `https://docs.abloatai.com/errors#${code}`;
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
      code?: ErrorCode;
      httpStatus?: number;
      requestId?: string;
      cause?: unknown;
      retryAfterSeconds?: number;
      details?: Readonly<Record<string, unknown>>;
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
      code?: ErrorCode;
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

/**
 * The target entity is currently claimed by another participant and the caller
 * asked the SDK not to read/write through that claim.
 *
 * Use `ifClaimed: 'wait'` to wait for the claim to clear, or
 * `ifClaimed: 'return'` to inspect active claims yourself.
 */
export class AbloClaimedError extends AbloError {
  readonly type = 'AbloClaimedError' as const;
  readonly claims?: ReadonlyArray<unknown>;

  constructor(
    message: string,
    options?: {
      code?: ErrorCode;
      httpStatus?: number;
      requestId?: string;
      cause?: unknown;
      claims?: ReadonlyArray<unknown>;
    },
  ) {
    super(message, options);
    if (options?.claims !== undefined) this.claims = options.claims;
  }
}

// ── Domain-specific subclasses ───────────────────────────────────────

/**
 * Structured description of the capability an agent would need to
 * satisfy a denied request. Mirrors the x402 `paymentRequirements`
 * shape: the server emits enough information for the client to
 * attenuate (or request) a capability that would pass on retry.
 */
export interface RequiredCapability {
  /** Operation or capability scope identifier (e.g. `"slide.update"`,
   *  `"subscribe"`). */
  readonly scope: string;
  /** Concrete constraints the capability must satisfy. Keys map to
   *  Datalog fact families — e.g. `{ syncGroup: ["org_abc"] }` for a
   *  rejected subscription. Forward-compatible: ignore unknown keys. */
  readonly constraints?: Readonly<Record<string, readonly string[] | string>>;
  /** Issuer hint — public-key fingerprint or well-known URL fragment. */
  readonly issuer?: string;
  /** Server-suggested maximum TTL for the attenuated capability. */
  readonly ttlSeconds?: number;
  /** Single-use nonce to embed in the retry's capability facts; binds
   *  retry → denial and prevents replay of a stale attenuation. */
  readonly nonce?: string;
}

/**
 * Canonical receipt returned by every successful or rejected commit,
 * regardless of transport (WebSocket `mutation_result` payload, HTTP
 * `/v1/commits` response body, or `AgentJob.result.receipt`). One
 * shape across all three surfaces.
 *
 * Linear-style correlation receipt — no cryptographic signature
 * (single-tenant trust boundary). A Hub signature is a forward-
 * compatible extension when cross-org agent crossings arrive.
 */
export interface CommitReceipt {
  readonly object: 'commit_receipt';
  /** Client-issued idempotency handle. Echoed verbatim. */
  readonly clientTxId: string;
  /** Server-issued opaque commit id — typically `String(lastSyncId)`. */
  readonly serverTxId: string;
  /** Convenience boolean. `status === 'confirmed'`. */
  readonly success: boolean;
  /** `'confirmed'` on apply, `'rejected'` on any failure. */
  readonly status: 'confirmed' | 'rejected';
  /** Last syncId visible after this commit (or high-water mark on
   *  rejection). */
  readonly lastSyncId?: number;
  /** Number of operations metered. Reported on both success and
   *  rejection so quota systems see attempted work. */
  readonly ops?: number;
  /** Populated on rejection. `requiredCapability` (when present)
   *  carries the x402-style structured retry hint. */
  readonly error?: {
    readonly code: string;
    readonly message: string;
    readonly field?: string;
    readonly requiredCapability?: RequiredCapability;
  };
}

/**
 * A scoped credential was denied — either the key is unknown / revoked /
 * expired (`capability_invalid`), or the connection's resolved scope
 * doesn't cover the attempted action (`capability_scope_denied`). With
 * opaque restricted (`rk_`) API keys this is a server-side check against
 * the key's `syncGroups` / `operations`, not a signed-caveat verification.
 *
 * Extends `AbloPermissionError` so existing `instanceof CapabilityError`
 * checks keep working AND broader `instanceof AbloPermissionError`
 * matches for consumers who don't care about the scope specifics.
 *
 * `requiredCapability` (when present) describes the scope a key must
 * carry for the request to succeed on retry.
 */
export class CapabilityError extends AbloPermissionError {
  readonly requiredCapability?: RequiredCapability;

  constructor(
    code: 'capability_scope_denied' | 'capability_invalid',
    message: string,
    requiredCapability?: RequiredCapability,
  ) {
    super(`${code}: ${message}`, { code });
    this.name = 'CapabilityError';
    if (requiredCapability !== undefined) {
      this.requiredCapability = requiredCapability;
    }
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

interface NestedErrorShape {
  code?: string;
  message?: string;
  field?: string;
  requiredCapability?: RequiredCapability;
}

interface ErrorBodyShape {
  /** Legacy: `error` was a flat code string on older endpoints. Newer
   *  endpoints (CommitReceipt) carry `error` as a nested object. */
  error?: string | NestedErrorShape;
  code?: string;
  reason?: string;
  message?: string;
  requiredCapability?: RequiredCapability;
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
  const nested: NestedErrorShape | undefined =
    parsed.error != null && typeof parsed.error === 'object'
      ? parsed.error
      : undefined;
  const flatError = typeof parsed.error === 'string' ? parsed.error : undefined;
  const code = parsed.code ?? nested?.code ?? flatError;
  const message =
    nested?.message ??
    parsed.reason ??
    parsed.message ??
    flatError ??
    (typeof body === 'string' ? body : `HTTP ${status}`);
  const requiredCapability =
    nested?.requiredCapability ?? parsed.requiredCapability;
  // Wire boundary: an incoming code is an arbitrary string (a newer server
  // may send a code this SDK predates). Cast to ErrorCode here — the one
  // sanctioned crossing — so internal producers stay statically checked.
  const publicCode = (code === 'intent_conflict' ? 'claim_conflict' : code) as
    | ErrorCode
    | undefined;
  const baseOpts = { code: publicCode, httpStatus: status, requestId };

  if (status === 401) return new AbloAuthenticationError(message, baseOpts);
  if (status === 403 || code === 'capability_scope_denied' || code === 'capability_invalid') {
    if (code === 'capability_scope_denied' || code === 'capability_invalid') {
      return new CapabilityError(code, message, requiredCapability);
    }
    return new AbloPermissionError(message, baseOpts);
  }
  // Claim enforcement also rides 409 (a commit blocked by a foreign claim).
  // Discriminate on the code BEFORE the generic idempotency mapping so a
  // claim rejection surfaces as AbloClaimedError, not AbloIdempotencyError —
  // same typed error the WebSocket commit path yields for these codes.
  if (code === 'intent_conflict' || code === 'claim_conflict' || code === 'entity_claimed') {
    return new AbloClaimedError(message, baseOpts);
  }
  if (status === 409) return new AbloIdempotencyError(message, baseOpts);
  if (status === 422 || status === 400) return new AbloValidationError(message, baseOpts);
  if (status === 429) return new AbloRateLimitError(message, baseOpts);
  if (status >= 500) return new AbloServerError(message, baseOpts);
  return new AbloError(message, baseOpts);
}
