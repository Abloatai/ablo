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

/**
 * 404 — an UPDATE/DELETE addressed a row that doesn't exist (or is outside the
 * caller's org). The engine reports such targets on `CommitReceipt.missingIds`;
 * the typed resource wrappers raise this instead of returning a success receipt
 * for a write that quietly matched zero rows. Carries the offending ids so a
 * caller can see exactly which targets were absent.
 */
export class AbloNotFoundError extends AbloError {
  readonly type = 'AbloNotFoundError' as const;
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

export interface ClaimContext {
  readonly id?: string;
  readonly claimId?: string;
  readonly actor?: string;
  readonly participantKind?: ParticipantKind;
  /** Human-readable phase the holder is in (`'editing'`). Matches the public
   *  claim surface; the wire summary carries the same value as `action`. */
  readonly reason?: string;
  readonly description?: string;
  readonly field?: string;
  readonly status?: string;
  readonly position?: number;
  /** Epoch-ms the claim expires. One timestamp encoding everywhere. */
  readonly expiresAt?: number;
  readonly declaredAt?: number;
  readonly entityType?: string;
  readonly entityId?: string;
  // The claim target reuses the canonical {@link ModelTarget} (Partial: an
  // error-context locator may be sparse) rather than re-declaring the
  // model/id/path/range/field/meta shape inline — see
  // docs/plans/ablo-claim-resource-canonicalization.md.
  readonly target?: Partial<ModelTarget>;
  readonly meta?: Record<string, unknown>;
}

export type ClaimErrorClaim = WireClaimSummary | ClaimContext;

function claimAction(claim: ClaimErrorClaim | undefined): string | undefined {
  if (!claim) return undefined;
  // The public `ClaimContext` exposes the phase as `reason`; the wire
  // `WireClaimSummary` projection still carries it under `action`. Read both.
  const c = claim as { readonly reason?: string; readonly action?: string };
  return c.reason ?? c.action;
}

function claimDescription(claim: ClaimErrorClaim | undefined): string | undefined {
  if (!claim) return undefined;
  if ('description' in claim && typeof claim.description === 'string') {
    return claim.description;
  }
  const meta = 'target' in claim ? claim.target?.meta ?? claim.meta : claim.meta;
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
  const action = claimAction(args.claim);
  const description = claimDescription(args.claim);
  const expiresIn = secondsUntil(claimExpiresAt(args.claim));

  if (!holder && !action && !description) {
    return args.fallback ?? `Model row is claimed: ${args.targetLabel}.`;
  }

  const actor = holder ?? 'another participant';
  const actionPart = action ? ` (${action})` : '';
  const descriptionPart = description ? `: ${description}` : '';
  const expiresPart =
    expiresIn !== undefined ? ` - expires in ${expiresIn}s` : '';
  const policyPart = args.policyReason
    ? ` Policy reason: ${args.policyReason}.`
    : '';
  return `Claimed by ${actor}${actionPart}${descriptionPart}${expiresPart} on ${args.targetLabel}.${policyPart}`;
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
  readonly type = 'AbloClaimedError' as const;
  readonly claims?: ReadonlyArray<ClaimErrorClaim>;

  constructor(
    message: string,
    options?: {
      code?: ErrorCode;
      httpStatus?: number;
      requestId?: string;
      cause?: unknown;
      claims?: ReadonlyArray<ClaimErrorClaim>;
    },
  ) {
    super(message, options);
    if (options?.claims !== undefined) this.claims = options.claims;
  }
}

/**
 * The `/`-joined human label for a claim target — `model/id/field`, dropping
 * absent parts, falling back to `'target'`. The one place this join lived in
 * three copies (client `Ablo`, HTTP `ApiClient`, `awaitClaimGrant`).
 */
export function claimTargetLabel(target: {
  readonly model?: string;
  readonly id?: string;
  readonly field?: string;
}): string {
  return [target.model, target.id, target.field].filter(Boolean).join('/') || 'target';
}

/**
 * Build the {@link AbloClaimedError} for a contended `ablo.<model>` write — the
 * single factory shared by the realtime client (`Ablo`) and the HTTP client
 * (`ApiClient`), which carried byte-identical copies. The first claim is the
 * holder whose metadata shapes the message.
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
  /** Ids of UPDATE/DELETE targets that matched ZERO rows (loud 0-row writes).
   *  Present (non-empty) only when a write missed; typed wrappers raise
   *  `AbloNotFoundError` from it. */
  readonly missingIds?: readonly string[];
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
    // "Should this response sign the user out?" — TRUE only for a genuine
    // expiry of the LONG-LIVED login (`recovery: 'session_expiry'`). Decided
    // via the closed recovery taxonomy rather than a hardcoded code list, so
    // the access-vs-session split lives in one place (errorCodes.ts). This is
    // behaviourally identical to the old `session_expired || jwt_expired` list.
    //
    // Deliberately NOT true for `access_credential_expiry` (`apikey_expired` —
    // the Stripe-style ephemeral key): an expired `ek_`/`rk_` is re-mintable
    // from the still-valid login and must NOT log the user out — the connection
    // layer silently re-mints instead. Likewise NOT true for `auth_blocked` /
    // `permission` failures (api_key_required, jwt_issuer_untrusted, 403s):
    // re-auth re-mints the same rejected credential and loops ("flash then
    // bounce to /signin").
    const code = extractWireCode(body);
    if (code) {
      return classifyRecovery(code) === 'session_expiry';
    }
    // No structured code (bare body, non-Ablo proxy response): a 401 is taken as
    // expiry — the historical default that drives re-auth — while a 403 is a
    // permission failure, not a session error.
    return status === 401;
  }
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
    /** Legacy: `error` was a flat code string on older endpoints. Newer
     *  endpoints (CommitReceipt) carry `error` as a nested object. */
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
 * Coerce ANY thrown value into an {@link AbloError} — the last-line guarantee
 * that an SDK consumer never catches an untagged error. An already-typed
 * AbloError passes through untouched (so `code`/`httpStatus`/subclass survive);
 * a bare `Error` keeps its message and is preserved as `cause` (carrying any
 * `.code` someone attached); a non-Error is stringified.
 *
 * This is the client mirror of the server's `normalizeError` — applied at the
 * SDK's public async boundaries so `instanceof AbloError` / `e.type` always
 * hold for whatever a consumer catches, regardless of which internal layer
 * (transport, IndexedDB, bootstrap, a third-party throw) produced it.
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
 * Build the appropriate typed {@link AbloError} from a wire error — the
 * single code→class mapping shared by every transport that can reject a
 * request (HTTP responses via {@link translateHttpError}, WebSocket
 * `mutation_result`/`claim_ack` frames, agent-job receipts).
 *
 * Code-first, then status-driven. A known {@link ErrorCode} carries its own
 * canonical `httpStatus` in the registry, so frame transports that don't have
 * an HTTP status (the WebSocket commit path) still produce the right subclass
 * — instead of a hand-rolled `new Error(message)` that drops out of the typed
 * hierarchy and loses `code`/`httpStatus`/retryability.
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
    claims?: ReadonlyArray<ClaimErrorClaim>;
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
  // participant. Discriminate on code BEFORE the generic 409→idempotency
  // mapping so a claim rejection surfaces as AbloClaimedError.
  if (code === 'claim_conflict' || code === 'claim_conflict' || code === 'entity_claimed') {
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
 * Translate an HTTP response into the appropriate typed error.
 *
 * Single source of truth for status-code → class mapping — every SDK
 * fetch path that sees a non-2xx response should route through here
 * so the customer-visible error is always the right subclass. Delegates
 * the actual class selection to {@link errorFromWire} (shared with the
 * frame transports) after extracting code/message from the HTTP body.
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
 * Whether an HTTP error body carries a code {@link translateHttpError} can read
 * — a top-level `code`, a nested `error.code`, or a string `error`. Callers that
 * own a meaningful fallback code (e.g. `turn_open_failed`) use this to decide
 * between routing through `translateHttpError` (structured envelope present) and
 * throwing their own typed error with the fallback (bare/non-Ablo body), instead
 * of emitting a code-less error.
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
 * Extract the canonical error `code` from a raw HTTP error body STRING — the
 * top-level `code` or a nested `error.code`. Returns undefined for non-JSON or
 * code-less bodies. Used by session-error detection to tell a genuine expiry
 * (`session_expired`/`jwt_expired`) apart from other auth failures.
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
