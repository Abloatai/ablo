/**
 * How a rate limit is stated on the wire, so a caller can pace itself instead
 * of discovering the ceiling by hitting it.
 *
 * Two fields, from "RateLimit header fields for HTTP"
 * (draft-ietf-httpapi-ratelimit-headers), and they answer different questions:
 *
 *   - `RateLimit-Policy` is the STANDING allowance — the quota and the window
 *     the server allocates. It does not move between responses, so it can be
 *     stated on any response, including one that carried no credential. This is
 *     the field an agent reads once and paces against.
 *   - `RateLimit` is the LIVE position within that allowance — what is left and
 *     when it refills. It is per caller, so it appears only once a request has
 *     been attributed to a credential.
 *
 * Both are Structured Field Lists whose members are Strings naming the policy,
 * carrying `q`/`w` (quota, window seconds) and `r`/`t` (remaining, seconds to
 * reset) as parameters. Serializing them by hand is the reason this module
 * exists: the field names and the parameter spellings were previously written
 * out at each producer, so a change had to be made in every one of them and
 * nothing failed when it was not.
 *
 * `Retry-After` is not defined here — it is plain HTTP (RFC 9110 § 10.2.3) and
 * the value is a count of seconds. Its NAME lives here so a producer emitting
 * the 429 triple names all three fields from one place.
 */

import { z } from 'zod';

/** The standing-allowance field. Safe on any response; independent of caller. */
export const RATE_LIMIT_POLICY_HEADER = 'RateLimit-Policy';

/** The live-position field. Per caller, so only on an attributed request. */
export const RATE_LIMIT_HEADER = 'RateLimit';

/** Seconds to wait before retrying, on a 429 or a 503 (RFC 9110 § 10.2.3). */
export const RETRY_AFTER_HEADER = 'Retry-After';

/**
 * A policy name as it appears inside the fields. Constrained to characters that
 * need no Structured-Fields escaping, which is what lets the serializers below
 * be a template rather than a String encoder — and what makes an unquotable
 * name a thrown error at the definition site rather than a malformed header on
 * the wire.
 */
const POLICY_NAME = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * One allocation of server capacity: how much, over how long.
 *
 * `quotaUnit` is omitted for the default unit, requests. A limiter that meters
 * something else — bytes, operations — names it, and a client that does not
 * recognize the unit knows to leave the number alone rather than read it as a
 * request count.
 */
export const quotaPolicySchema = z.object({
  /** Identifier the matching {@link ServiceLimit} refers back to. */
  name: z.string(),
  /** `q` — the allocation, in `quotaUnit`. */
  quota: z.number(),
  /** `w` — the window the allocation applies over, in whole seconds. */
  windowSeconds: z.number().optional(),
  /** `qu` — the unit `quota` counts. Omit for the default, requests. */
  quotaUnit: z.string().optional(),
});
export type QuotaPolicy = Readonly<z.infer<typeof quotaPolicySchema>>;

/** Where this caller currently stands against one {@link QuotaPolicy}. */
export const serviceLimitSchema = z.object({
  /** The {@link QuotaPolicy} name this position is measured against. */
  policy: z.string(),
  /** `r` — units left in the current window. */
  remaining: z.number(),
  /** `t` — seconds until the allocation refills. */
  resetSeconds: z.number().optional(),
});
export type ServiceLimit = Readonly<z.infer<typeof serviceLimitSchema>>;

function assertName(name: string, field: string): void {
  if (!POLICY_NAME.test(name)) {
    throw new Error(
      `${field} policy name ${JSON.stringify(name)} must match ${String(POLICY_NAME)}`,
    );
  }
}

/**
 * A non-negative whole number, which is what both fields' numeric parameters
 * are. A fractional or negative value is a producer bug; clamping it here keeps
 * one malformed reading from making the whole field unparseable for the client.
 */
function integer(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}

/** Serialize {@link QuotaPolicy} values into a `RateLimit-Policy` field value. */
export function rateLimitPolicyField(policies: readonly QuotaPolicy[]): string {
  if (policies.length === 0) {
    throw new Error(`${RATE_LIMIT_POLICY_HEADER} must name at least one policy`);
  }
  return policies
    .map((policy) => {
      assertName(policy.name, RATE_LIMIT_POLICY_HEADER);
      let item = `"${policy.name}";q=${integer(policy.quota)}`;
      if (policy.quotaUnit !== undefined) item += `;qu="${policy.quotaUnit}"`;
      if (policy.windowSeconds !== undefined) item += `;w=${integer(policy.windowSeconds)}`;
      return item;
    })
    .join(', ');
}

/** Serialize {@link ServiceLimit} values into a `RateLimit` field value. */
export function rateLimitField(limits: readonly ServiceLimit[]): string {
  if (limits.length === 0) {
    throw new Error(`${RATE_LIMIT_HEADER} must name at least one policy`);
  }
  return limits
    .map((limit) => {
      assertName(limit.policy, RATE_LIMIT_HEADER);
      let item = `"${limit.policy}";r=${integer(limit.remaining)}`;
      if (limit.resetSeconds !== undefined) item += `;t=${integer(limit.resetSeconds)}`;
      return item;
    })
    .join(', ');
}

/** What a producer knows about the limit at the moment it writes the response. */
export const rateLimitSignalSchema = z.object({
  /** The standing allowance. Always known; stated on every response. */
  policies: z.array(quotaPolicySchema).readonly(),
  /** This caller's position, once the request has been attributed to one. */
  limits: z.array(serviceLimitSchema).readonly().optional(),
  /** Present only on a rejection, and only when a wait is what resolves it. */
  retryAfterSeconds: z.number().optional(),
});
export type RateLimitSignal = Readonly<z.infer<typeof rateLimitSignalSchema>>;

/**
 * The header map for one response. This is the single call every producer
 * makes, so the three fields cannot be emitted in one place and forgotten in
 * the next.
 */
export function rateLimitHeaders(signal: RateLimitSignal): Record<string, string> {
  const headers: Record<string, string> = {
    [RATE_LIMIT_POLICY_HEADER]: rateLimitPolicyField(signal.policies),
  };
  if (signal.limits && signal.limits.length > 0) {
    headers[RATE_LIMIT_HEADER] = rateLimitField(signal.limits);
  }
  if (signal.retryAfterSeconds !== undefined) {
    headers[RETRY_AFTER_HEADER] = String(Math.max(1, integer(signal.retryAfterSeconds)));
  }
  return headers;
}
