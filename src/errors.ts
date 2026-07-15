/**
 * The typed error hierarchy for this package. Every error the SDK throws is an
 * {@link AbloError} or one of its subclasses, so a consumer can catch broadly or
 * narrowly. There are two equivalent ways to tell errors apart:
 *
 * ```ts
 * // By class, with instanceof
 * if (err instanceof AbloRateLimitError) backoff(err.retryAfterSeconds);
 *
 * // By discriminator string, for cases where class identity is lost —
 * // for example after an error crosses a web worker boundary
 * if (err.type === 'AbloRateLimitError') { ... }
 * ```
 *
 * Both work on every subclass.
 */

import { z } from 'zod';
import type { ErrorCode } from './errorCodes.js';
import { errorCodeSpec, classifyRecovery } from './errorCodes.js';
import {
  wireClaimSummarySchema,
  descriptionFromMeta,
  type WireClaimSummary,
  type ModelClaim,
  type ModelTarget,
  type ParticipantKind,
} from './coordination/schema.js';

export type { ErrorCode, WireErrorCode, ErrorCategory, ErrorCodeSpec, RecoveryClass } from './errorCodes.js';
export {
  ERROR_CODES,
  ERROR_CONTRACT_VERSION,
  errorCodeSpec,
  isRetryableCode,
  classifyRecovery,
  recoveryClassSchema,
  RECOVERY_CLASSES,
} from './errorCodes.js';

// ── AbloError hierarchy — the typed error surface ────────────────────

/**
 * The base class for every error this SDK throws. It carries the fields common
 * to all of them — a {@link type} discriminator, an optional stable {@link code},
 * and optional HTTP and diagnostic metadata — and defines the shared JSON and
 * string serialization. Every other error class extends it.
 */
export class AbloError extends Error {
  /** A discriminator string equal to the class name. Switch on `error.type` to
   *  distinguish error kinds when `instanceof` is unreliable, such as after an
   *  error has crossed a serialization boundary. */
  readonly type: string = 'AbloError';
  /** A stable, machine-readable identifier for the error, drawn from the
   *  {@link ErrorCode} registry — for example `'apikey_invalid'` or
   *  `'capability_scope_denied'` — suitable for logs, metrics, and `switch`
   *  handling. It is typed as a plain `string` rather than {@link ErrorCode} so
   *  this client can still surface a code from a newer server that it does not
   *  yet recognize; code producers are constrained at the constructor instead. */
  readonly code?: string;
  /** HTTP status code, when the error originated from an HTTP response. */
  readonly httpStatus?: number;
  /** A correlation id for tracing a request through the server, present when the
   *  server returned one on the `x-request-id` header. Include it in support
   *  requests. */
  readonly requestId?: string;
  /** The specific input that caused the error, as a model or field path such as
   *  `'dataroomMember.grants.subject'`, so tooling can point at the exact
   *  offending value. */
  readonly param?: string;
  /** A link to the documentation for this error's {@link code}. When not set
   *  explicitly, it is derived from the code by {@link docUrlForCode}. */
  readonly docUrl?: string;
  /** Extra structured data specific to this error, merged into the serialized
   *  envelope — for example a schema push's `{ warnings, unexecutable }`, or the
   *  conflicting rows of a stale write. This detail is preserved through
   *  {@link toJSON} rather than flattened into the message. */
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
   * Serializes the error to its wire shape: `{ type, code, param, message,
   * doc_url, request_id }`, with any {@link details} merged in. This is the same
   * JSON shape the SDK uses across HTTP bodies, WebSocket frames, and logs, so a
   * consumer parses every Ablo error the same way.
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

  /**
   * Formats the error as a single line for logs and string interpolation:
   * `AbloValidationError [code]: message (see docs) [request_id: …]`.
   *
   * It intentionally omits {@link details}, the cause, and the stack, which are
   * what turn a logged rich error into an unreadable wall of text. The full
   * structured payload remains available through {@link toJSON}; this is the
   * concise human-readable form.
   */
  override toString(): string {
    const code = this.code ? ` [${this.code}]` : '';
    const docs = this.docUrl ? ` (see ${this.docUrl})` : '';
    const req = this.requestId ? ` [request_id: ${this.requestId}]` : '';
    return `${this.name}${code}: ${this.message}${docs}${req}`;
  }
}

/**
 * Builds the documentation URL for a stable error {@link ErrorCode}. This is the
 * single place the URL convention lives, so every error that carries a code gets
 * a `doc_url` automatically.
 */
export function docUrlForCode(code: ErrorCode): string {
  return `https://docs.abloatai.com/errors#${code}`;
}

/** 401 — invalid/missing/expired credentials. */
export class AbloAuthenticationError extends AbloError {
  override readonly type = 'AbloAuthenticationError' as const;
}

/** 403 — credentials were valid but the action is forbidden (scope
 *  denial, revoked capability, role not authorized). */
export class AbloPermissionError extends AbloError {
  override readonly type = 'AbloPermissionError' as const;
}

/** 429 — rate limit exceeded. Consumers should back off before retry. */
export class AbloRateLimitError extends AbloError {
  override readonly type = 'AbloRateLimitError' as const;
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
  override readonly type = 'AbloIdempotencyError' as const;
}

/** Network / transport failure — TCP reset, DNS, timeout, abort. */
export class AbloConnectionError extends AbloError {
  override readonly type = 'AbloConnectionError' as const;
}

/** 400 / 422 — request payload was invalid. */
export class AbloValidationError extends AbloError {
  override readonly type = 'AbloValidationError' as const;
}

/**
 * An update or delete addressed a row that does not exist, or lies outside the
 * caller's organization (HTTP 404). Raw commit responses may report those
 * targets as `missingIds`; typed model methods raise this error instead of
 * returning a successful result for a write that quietly matched zero rows.
 * The absent ids are carried on {@link missingIds}.
 */
export class AbloNotFoundError extends AbloError {
  override readonly type = 'AbloNotFoundError' as const;
  /** The id(s) that matched no row. */
  readonly missingIds: readonly string[];
  constructor(message: string, missingIds: readonly string[], options?: { requestId?: string }) {
    super(message, {
      code: 'mutate_update_entity_not_found',
      httpStatus: 404,
      details: { missingIds },
      ...(options?.requestId !== undefined ? { requestId: options.requestId } : {}),
    });
    this.missingIds = missingIds;
  }
}

/** 5xx — server-side error. Usually retryable with backoff. */
export class AbloServerError extends AbloError {
  override readonly type = 'AbloServerError' as const;
}

/**
 * A write carried a `readAt` watermark, but the target row has changed since
 * that point (HTTP 409). The snapshot the caller reasoned from is stale, so the
 * safe response is to re-read the row and regenerate the write.
 *
 * {@link conflicts} lists the specific model-and-id pairs that changed during
 * the window between the read and the write, which lets a caller regenerate only
 * the rows that actually moved rather than everything.
 */
export class AbloStaleContextError extends AbloError {
  override readonly type = 'AbloStaleContextError' as const;
  /** Sync id at the caller's `readAt` when the write was attempted. */
  readonly readAt?: number;
  /** Entities that received deltas between `readAt` and the write. */
  readonly conflicts?: readonly {
    readonly model: string;
    readonly id: string;
    readonly observedSyncId: number;
  }[];

  constructor(
    message: string,
    options?: {
      code?: ErrorCode;
      httpStatus?: number;
      requestId?: string;
      cause?: unknown;
      readAt?: number;
      conflicts?: readonly {
        readonly model: string;
        readonly id: string;
        readonly observedSyncId: number;
      }[];
    },
  ) {
    super(message, options);
    if (options?.readAt !== undefined) this.readAt = options.readAt;
    if (options?.conflicts !== undefined) this.conflicts = options.conflicts;
  }
}

/**
 * The functional `update(id, current => next)` form gave up after exhausting its
 * reconcile budget, because the row stayed continuously contended under
 * sustained concurrent writes and no attempt could land its compare-and-swap.
 *
 * The SDK reaches this only at the extreme: it has already re-read, recomputed,
 * and retried on every intervening conflict on the caller's behalf. Catch it to
 * back off and retry later, raise the `retries` budget, or move the row to the
 * WebSocket transport, which queues writers fairly instead of racing them. The
 * last underlying conflict is available on `cause`.
 */
export class AbloContentionError extends AbloError {
  override readonly type = 'AbloContentionError' as const;
  /** The contended model + row that could not be written. */
  readonly model: string;
  readonly id: string;
  /** How many reconcile rounds were attempted before giving up. */
  readonly attempts: number;

  constructor(
    model: string,
    id: string,
    attempts: number,
    options?: { cause?: unknown },
  ) {
    super(
      `Could not update ${model}/${id} after ${attempts} attempts — the row stayed ` +
        `continuously contended, so nothing was written. Retry later, raise \`retries\`, ` +
        `or use the WebSocket transport for a fair FIFO queue.`,
      {
        code: 'contention_exhausted',
        ...(options?.cause !== undefined ? { cause: options.cause } : {}),
      },
    );
    this.model = model;
    this.id = id;
    this.attempts = attempts;
  }
}

export interface ClaimContext {
  readonly id?: string;
  readonly claimId?: string;
  readonly actor?: string;
  readonly participantKind?: ParticipantKind;
  /** Human-readable phase the holder is in (`'editing'`). */
  readonly reason?: string;
  readonly description?: string;
  readonly field?: string;
  readonly status?: string;
  readonly position?: number;
  /** The epoch-milliseconds timestamp at which the claim expires. */
  readonly expiresAt?: number;
  readonly declaredAt?: number;
  readonly entityType?: string;
  readonly entityId?: string;
  // The claim target reuses the canonical {@link ModelTarget} shape (as a
  // Partial, since an error-context locator may be sparse) rather than
  // re-declaring model, id, path, range, field, and meta inline.
  readonly target?: Partial<ModelTarget>;
  readonly meta?: Record<string, unknown>;
}

export type ClaimErrorClaim = WireClaimSummary | ClaimContext;

function claimDescription(claim: ClaimErrorClaim | undefined): string | undefined {
  if (!claim) return undefined;
  if ('description' in claim && typeof claim.description === 'string') {
    return claim.description;
  }
  const meta = 'target' in claim ? claim.target?.meta ?? claim.meta : claim.meta;
  // Fall back through the meta carrier so a frame that stashed its description
  // there still renders its holder's work.
  return descriptionFromMeta(meta);
}

function claimExpiresAt(claim: ClaimErrorClaim | undefined): number | undefined {
  return claim?.expiresAt;
}

function claimActor(
  claim: ClaimErrorClaim | undefined,
  fallback: string | undefined,
): string | undefined {
  if (claim && 'actor' in claim && typeof claim.actor === 'string') {
    return claim.actor;
  }
  return fallback;
}

function secondsUntil(ms: number | undefined, now = Date.now()): number | undefined {
  if (ms === undefined || !Number.isFinite(ms)) return undefined;
  return Math.max(0, Math.ceil((ms - now) / 1000));
}

export function formatClaimedErrorMessage(args: {
  readonly targetLabel: string;
  readonly heldBy?: string;
  readonly claim?: ClaimErrorClaim;
  readonly policyReason?: string;
  readonly fallback?: string;
}): string {
  const holder = claimActor(args.claim, args.heldBy);
  const description = claimDescription(args.claim);
  const expiresIn = secondsUntil(claimExpiresAt(args.claim));

  if (!holder && !description) {
    return args.fallback ?? `Model row is claimed: ${args.targetLabel}.`;
  }

  const actor = holder ?? 'another participant';
  const descriptionPart = description ? `: ${description}` : '';
  const expiresPart =
    expiresIn !== undefined ? ` - expires in ${expiresIn}s` : '';
  const policyPart = args.policyReason
    ? ` Policy reason: ${args.policyReason}.`
    : '';
  return `Claimed by ${actor}${descriptionPart}${expiresPart} on ${args.targetLabel}.${policyPart}`;
}

/**
 * The target entity is currently claimed by another participant and the caller
 * asked the SDK not to read/write through that claim.
 *
 * Pass `ifClaimed: 'return'` to inspect active claims yourself instead of
 * throwing; to wait for the claim to clear, take `ablo.<model>.claim({ id })`
 * (it queues fairly) rather than blocking the read.
 */
export class AbloClaimedError extends AbloError {
  override readonly type = 'AbloClaimedError' as const;
  readonly claims?: readonly ClaimErrorClaim[];

  constructor(
    message: string,
    options?: {
      code?: ErrorCode;
      httpStatus?: number;
      requestId?: string;
      cause?: unknown;
      claims?: readonly ClaimErrorClaim[];
    },
  ) {
    super(message, options);
    if (options?.claims !== undefined) this.claims = options.claims;
  }
}

/**
 * Builds a human-readable label for a claim target by joining its `model`, `id`,
 * and `field` with `/`, omitting any absent parts and falling back to `'target'`
 * when none are present.
 */
export function claimTargetLabel(target: {
  readonly model?: string;
  readonly id?: string;
  readonly field?: string;
}): string {
  return [target.model, target.id, target.field].filter(Boolean).join('/') || 'target';
}

/**
 * Builds the {@link AbloClaimedError} for a write that was rejected because the
 * row is claimed. The first entry in `claims` is treated as the current holder,
 * and its metadata shapes the error message.
 */
export function claimedError(
  target: { readonly model?: string; readonly id?: string; readonly field?: string },
  claims: readonly ModelClaim[],
  code: 'model_claimed' | 'model_claimed_timeout' | 'queue_too_deep',
): AbloClaimedError {
  const label = claimTargetLabel(target);
  const holder = claims[0];
  return new AbloClaimedError(
    formatClaimedErrorMessage({
      targetLabel: label,
      heldBy: holder?.actor,
      claim: holder,
      fallback: `Model row is claimed: ${label} held by another participant.`,
    }),
    { code, claims },
  );
}

// ── Domain-specific subclasses ───────────────────────────────────────

/**
 * A structured description of the capability that would be needed to satisfy a
 * denied request. The server emits enough detail for the client to request, or
 * narrow an existing capability into, one that would pass on retry.
 */
export interface RequiredCapability {
  /** The operation or capability scope, for example `"slide.update"` or
   *  `"subscribe"`. */
  readonly scope: string;
  /** The concrete constraints the capability must satisfy — for example
   *  `{ syncGroup: ["org_abc"] }` for a rejected subscription. Treat unknown
   *  keys as forward-compatible additions and ignore them. */
  readonly constraints?: Readonly<Record<string, readonly string[] | string>>;
  /** A hint at the issuer — a public-key fingerprint or well-known URL
   *  fragment. */
  readonly issuer?: string;
  /** The maximum lifetime, in seconds, the server suggests for the narrowed
   *  capability. */
  readonly ttlSeconds?: number;
  /** A single-use value to embed in the retried request's capability, which
   *  ties the retry to this specific denial and prevents replaying an old
   *  capability. */
  readonly nonce?: string;
}

/**
 * A scoped credential was denied, either because the key is unknown, revoked, or
 * expired (`capability_invalid`), or because the connection's scope does not
 * cover the attempted action (`capability_scope_denied`). For restricted (`rk_`)
 * API keys this is a server-side check against the key's granted sync groups and
 * operations.
 *
 * It extends {@link AbloPermissionError}, so it is caught both by code that
 * specifically checks for `CapabilityError` and by code that only distinguishes
 * the broader permission category. When present, {@link requiredCapability}
 * describes the scope a key would need to carry for the request to succeed on
 * retry.
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
 * Thrown when the login session itself is invalid or expired, signaling that the
 * user should be sent to sign in again rather than offered a generic retry.
 *
 * It extends {@link AbloAuthenticationError}, so it is caught both by code using
 * the {@link SyncSessionError.isSessionError} check and by code that catches the
 * authentication category in general.
 */
export class SyncSessionError extends AbloAuthenticationError {
  readonly isSessionError = true;
  readonly statusCode: number;

  constructor(message: string, statusCode = 401) {
    super(message, { httpStatus: statusCode, code: 'session_expired' });
    this.name = 'SyncSessionError';
    this.statusCode = statusCode;

    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, SyncSessionError);
    }
  }

  /**
   * Returns true when a value is a {@link SyncSessionError}, or any error-like
   * object that reports itself as a session error through an `isSessionError`
   * flag.
   */
  static isSessionError(error: unknown): error is SyncSessionError {
    if (error instanceof SyncSessionError) {
      return true;
    }
    if (error && typeof error === 'object' && 'isSessionError' in error) {
      return (error as { isSessionError: boolean }).isSessionError;
    }
    return false;
  }

  /**
   * Determines whether an HTTP response means the login session has expired and
   * the user should sign in again. When the body carries a structured Ablo error
   * code, the decision is made from that code's recovery class; otherwise a bare
   * 401 is treated as an expiry and a 403 is not.
   */
  static isSessionErrorResponse(status: number, body?: string): boolean {
    // Sign the user out only for a genuine expiry of the long-lived login
    // (`recovery: 'session_expiry'`). The decision runs through the recovery
    // classification rather than a hardcoded list, so the access-versus-session
    // split lives in one place.
    //
    // It deliberately does not fire for `access_credential_expiry`
    // (`apikey_expired`): an expired short-lived key is re-mintable from the
    // still-valid login and must not sign the user out — the connection layer
    // re-mints it instead. It also does not fire for `auth_blocked` or
    // `permission` failures, where re-authenticating would present the same
    // rejected credential and loop.
    const code = extractWireCode(body);
    if (code) {
      return classifyRecovery(code) === 'session_expiry';
    }
    // With no structured code (a bare body or a non-Ablo proxy response), treat
    // a 401 as an expiry that drives re-authentication, and a 403 as a
    // permission failure rather than a session error.
    return status === 401;
  }
}

/**
 * The WebSocket-close counterpart to {@link SyncSessionError.isSessionErrorResponse}:
 * returns true for close reasons that mean the short-lived access credential
 * (`ek_` or `rk_`) has expired. The server closes such sockets with code 4001
 * and reason `'credential_expired'`. Because the credential is re-mintable from
 * the still-valid login, the connection layer re-mints it and reconnects rather
 * than signing the user out or clearing local data. Every other session close
 * reason, such as a revoked key or a genuinely lost login, stays terminal.
 */
export function isAccessCredentialExpiryCloseReason(reason: string): boolean {
  return reason === 'credential_expired' || classifyRecovery(reason) === 'access_credential_expiry';
}

// ── HTTP → class mapping ──────────────────────────────────────────────

const OptionalWireStringSchema = z.preprocess(
  (value) => (typeof value === 'string' ? value : undefined),
  z.string().optional(),
);

const RequiredCapabilityWireSchema = z
  .object({
    scope: z.string(),
    constraints: z
      .record(z.string(), z.union([z.array(z.string()), z.string()]))
      .optional(),
    issuer: OptionalWireStringSchema,
    ttlSeconds: z
      .preprocess((value) => (typeof value === 'number' ? value : undefined), z.number().optional()),
    nonce: OptionalWireStringSchema,
  })
  .passthrough();

const NestedErrorShapeSchema = z
  .object({
    code: OptionalWireStringSchema,
    message: OptionalWireStringSchema,
    field: OptionalWireStringSchema,
    requiredCapability: RequiredCapabilityWireSchema.optional().catch(undefined),
    heldBy: OptionalWireStringSchema,
    policyReason: OptionalWireStringSchema,
    heldByClaim: wireClaimSummarySchema.optional().catch(undefined),
    claims: z.array(wireClaimSummarySchema).optional().catch(undefined),
  })
  .passthrough();

const ErrorFieldSchema = z
  .preprocess(
    (value) =>
      typeof value === 'string' || (typeof value === 'object' && value !== null)
        ? value
        : undefined,
    z.union([z.string(), NestedErrorShapeSchema]).optional(),
  )
  .catch(undefined);

const ErrorBodyShapeSchema = z
  .object({
    /** The `error` field may be a flat code string, as some endpoints return,
     *  or a nested error object, as commit endpoints return on rejection. */
    error: ErrorFieldSchema,
    code: OptionalWireStringSchema,
    reason: OptionalWireStringSchema,
    message: OptionalWireStringSchema,
    requiredCapability: RequiredCapabilityWireSchema.optional().catch(undefined),
    heldBy: OptionalWireStringSchema,
    policyReason: OptionalWireStringSchema,
    heldByClaim: wireClaimSummarySchema.optional().catch(undefined),
    claims: z.array(wireClaimSummarySchema).optional().catch(undefined),
  })
  .passthrough();

type NestedErrorShape = z.infer<typeof NestedErrorShapeSchema>;
type ErrorBodyShape = z.infer<typeof ErrorBodyShapeSchema>;

function parseErrorBodyShape(body: unknown): ErrorBodyShape {
  if (typeof body !== 'object' || body === null) return {};
  const parsed = ErrorBodyShapeSchema.safeParse(body);
  return parsed.success ? parsed.data : {};
}

/**
 * Coerces any thrown value into an {@link AbloError}, so a consumer never catches
 * an untyped error from the SDK. An error that is already an {@link AbloError}
 * passes through unchanged, preserving its subclass, `code`, and `httpStatus`; a
 * plain `Error` keeps its message and is retained as the `cause` (carrying any
 * `code` attached to it); anything else is stringified.
 *
 * The SDK applies this at its public async boundaries so that `instanceof
 * AbloError` and `error.type` hold for whatever a consumer catches, no matter
 * which internal layer — transport, local storage, bootstrap, or a third-party
 * throw — produced the original error.
 */
export function toAbloError(err: unknown): AbloError {
  if (err instanceof AbloError) return err;
  if (err instanceof Error) {
    const rawCode = (err as { code?: unknown }).code;
    const code = typeof rawCode === 'string' ? (rawCode as ErrorCode) : undefined;
    return new AbloError(err.message, { code, cause: err });
  }
  return new AbloError(String(err), { cause: err });
}

/**
 * Builds the appropriate typed {@link AbloError} from a wire error. This is the
 * single code-to-class mapping shared by every transport that can reject a
 * request — HTTP responses through {@link translateHttpError}, WebSocket result
 * frames, and agent-job receipts.
 *
 * It decides by code first, then by status. Because a known {@link ErrorCode}
 * carries its canonical HTTP status in the registry, a transport that has no
 * status of its own (such as the WebSocket commit path) still produces the right
 * subclass, with its `code`, status, and retryability intact.
 */
export function errorFromWire(
  message: string,
  opts: {
    code?: string;
    /** Explicit transport status (HTTP). When omitted, derived from the
     *  registry spec for `code` so frame transports map correctly too. */
    httpStatus?: number;
    requestId?: string;
    requiredCapability?: RequiredCapability;
    claims?: readonly ClaimErrorClaim[];
  } = {},
): AbloError {
  const { code, requestId, requiredCapability, claims } = opts;
  // Effective status: an explicit HTTP status wins; otherwise fall back to
  // the code's canonical status from the registry (undefined for unknown /
  // forward-compat codes, which then map to the base AbloError).
  const httpStatus = opts.httpStatus ?? (code ? errorCodeSpec(code)?.httpStatus : undefined);
  // Wire boundary: an incoming code is an arbitrary string (a newer server
  // may send a code this SDK predates). Cast to ErrorCode here — the one
  // sanctioned crossing — so internal producers stay statically checked.
  const publicCode = (code === 'claim_conflict' ? 'claim_conflict' : code) as
    | ErrorCode
    | undefined;
  const baseOpts = { code: publicCode, httpStatus, requestId };

  // ── Code-first specials (transport-independent) ──────────────────────
  // A scoped credential was denied — route through CapabilityError so callers
  // can read `.requiredCapability` to attenuate-and-retry.
  if (code === 'capability_scope_denied' || code === 'capability_invalid') {
    return new CapabilityError(code, message, requiredCapability);
  }
  // Claim enforcement (rides 409): the target entity is held by another
  // participant, or a lease this participant held is gone (`claim_lost` —
  // the answer a heartbeat gets after its lease lapsed). Discriminate on
  // code BEFORE the generic 409→idempotency mapping so claim outcomes
  // surface as AbloClaimedError on every transport.
  if (
    code === 'claim_conflict' ||
    code === 'entity_claimed' ||
    code === 'claim_lost'
  ) {
    return new AbloClaimedError(message, { ...baseOpts, claims });
  }
  // A write whose `readAt` watermark went stale — callers re-read and retry.
  if (code === 'stale_context') {
    return new AbloStaleContextError(message, baseOpts);
  }

  // ── Status-driven dispatch (HTTP parity) ─────────────────────────────
  if (httpStatus === 401) return new AbloAuthenticationError(message, baseOpts);
  if (httpStatus === 403) return new AbloPermissionError(message, baseOpts);
  if (httpStatus === 409) return new AbloIdempotencyError(message, baseOpts);
  if (httpStatus === 422 || httpStatus === 400) return new AbloValidationError(message, baseOpts);
  if (httpStatus === 429) return new AbloRateLimitError(message, baseOpts);
  if (httpStatus !== undefined && httpStatus >= 500) return new AbloServerError(message, baseOpts);
  return new AbloError(message, baseOpts);
}

/**
 * Translates an HTTP response into the appropriate typed {@link AbloError}. This
 * is the single mapping every request path routes a non-2xx response through, so
 * the error a consumer sees is always the right subclass. After extracting the
 * code and message from the response body, it delegates the class selection to
 * {@link errorFromWire}, the same logic the frame transports use.
 */
export function translateHttpError(
  status: number,
  body: unknown,
  requestId?: string,
): AbloError {
  const parsed = parseErrorBodyShape(body);
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
  const claims =
    parsed.claims ??
    nested?.claims ??
    (parsed.heldByClaim
      ? [parsed.heldByClaim]
      : nested?.heldByClaim
        ? [nested.heldByClaim]
        : undefined);

  return errorFromWire(message, {
    code,
    httpStatus: status,
    requestId,
    requiredCapability,
    claims,
  });
}

/**
 * Reports whether an HTTP error body carries a code that {@link translateHttpError}
 * can read — a top-level `code`, a nested `error.code`, or a string `error`. A
 * caller that has a meaningful fallback code uses this to choose between routing
 * a structured body through {@link translateHttpError} and throwing its own typed
 * error with the fallback when the body is bare, rather than producing an error
 * with no code.
 */
export function hasWireCode(body: unknown): boolean {
  const parsed = parseErrorBodyShape(body);
  if (typeof parsed.code === 'string') return true;
  if (typeof parsed.error === 'string') return true;
  return (
    typeof parsed.error === 'object' &&
    parsed.error !== null &&
    typeof parsed.error.code === 'string'
  );
}

/**
 * Extracts the canonical error `code` from a raw HTTP error body string — the
 * top-level `code` or a nested `error.code` — returning `undefined` for a
 * non-JSON or code-less body. Session-error detection uses it to tell a genuine
 * session expiry apart from other authentication failures.
 */
export function extractWireCode(body?: string): string | undefined {
  if (!body) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const b = parseErrorBodyShape(parsed);
  if (typeof b.code === 'string') return b.code;
  if (typeof b.error === 'string') return b.error;
  if (typeof b.error === 'object' && b.error !== null && typeof b.error.code === 'string') {
    return b.error.code;
  }
  return undefined;
}
