/**
 * The rate-limit fields are Structured Fields, and the reason to test the
 * serializers rather than the constants is that a header a client cannot parse
 * is indistinguishable from no header at all — it fails at the client, silently,
 * long after the response left.
 *
 * Each assertion pins a spelling from draft-ietf-httpapi-ratelimit-headers:
 * the policy name is a quoted String, the parameters are `q`/`w` on the policy
 * and `r`/`t` on the position, and multiple policies are one comma-joined List.
 */
import {
  RATE_LIMIT_HEADER,
  RATE_LIMIT_POLICY_HEADER,
  RETRY_AFTER_HEADER,
  rateLimitField,
  rateLimitHeaders,
  rateLimitPolicyField,
} from '@abloatai/transaction/wire';

describe('rateLimitPolicyField', () => {
  it('writes the quota and window as the draft spells them', () => {
    expect(rateLimitPolicyField([{ name: 'secret', quota: 600, windowSeconds: 12 }])).toBe(
      '"secret";q=600;w=12',
    );
  });

  it('joins several policies into one List, as one field value', () => {
    expect(
      rateLimitPolicyField([
        { name: 'permin', quota: 50, windowSeconds: 60 },
        { name: 'perhr', quota: 1000, windowSeconds: 3600 },
      ]),
    ).toBe('"permin";q=50;w=60, "perhr";q=1000;w=3600');
  });

  it('names a non-default quota unit so a byte budget is not read as a request count', () => {
    expect(
      rateLimitPolicyField([
        { name: 'upload', quota: 65535, quotaUnit: 'content-bytes', windowSeconds: 10 },
      ]),
    ).toBe('"upload";q=65535;qu="content-bytes";w=10');
  });

  it('omits the window when the policy has none', () => {
    expect(rateLimitPolicyField([{ name: 'lifetime', quota: 10 }])).toBe('"lifetime";q=10');
  });

  it('refuses a name that would need escaping, at the producer', () => {
    expect(() => rateLimitPolicyField([{ name: 'a "b"', quota: 1 }])).toThrow(
      /must match/,
    );
  });

  it('refuses an empty List — the field is defined as non-empty', () => {
    expect(() => rateLimitPolicyField([])).toThrow(/at least one policy/);
  });
});

describe('rateLimitField', () => {
  it('writes the remaining count and the reset delay', () => {
    expect(rateLimitField([{ policy: 'secret', remaining: 412, resetSeconds: 8 }])).toBe(
      '"secret";r=412;t=8',
    );
  });

  it('clamps a negative remaining to zero rather than emitting an unparseable value', () => {
    expect(rateLimitField([{ policy: 'secret', remaining: -3, resetSeconds: 1.4 }])).toBe(
      '"secret";r=0;t=1',
    );
  });
});

describe('rateLimitHeaders', () => {
  it('states the standing allowance even when the caller is unattributed', () => {
    // This is the case the audit found bare: an unauthenticated request was
    // answered with no rate-limit information at all, because the only limiter
    // ran after credential resolution. The policy does not depend on identity.
    const headers = rateLimitHeaders({
      policies: [{ name: 'secret', quota: 600, windowSeconds: 12 }],
    });
    expect(headers[RATE_LIMIT_POLICY_HEADER]).toBe('"secret";q=600;w=12');
    expect(headers[RATE_LIMIT_HEADER]).toBeUndefined();
    expect(headers[RETRY_AFTER_HEADER]).toBeUndefined();
  });

  it('adds the live position once the request is attributed', () => {
    const headers = rateLimitHeaders({
      policies: [{ name: 'secret', quota: 600, windowSeconds: 12 }],
      limits: [{ policy: 'secret', remaining: 412, resetSeconds: 8 }],
    });
    expect(headers[RATE_LIMIT_HEADER]).toBe('"secret";r=412;t=8');
  });

  it('floors Retry-After at one second, so a rejection never says "retry now"', () => {
    const headers = rateLimitHeaders({
      policies: [{ name: 'secret', quota: 600, windowSeconds: 12 }],
      retryAfterSeconds: 0,
    });
    expect(headers[RETRY_AFTER_HEADER]).toBe('1');
  });
});
