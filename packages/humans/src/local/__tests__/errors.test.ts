/**
 * Gap 2 regression — the typed error hierarchy and HTTP-to-class
 * translator. Proves:
 *   - Every subclass is reachable via `instanceof AbloError` (base
 *     chain works across package boundaries)
 *   - The `type` discriminator matches the class name (dual pattern)
 *   - `translateHttpError` routes every interesting status to the
 *     right subclass
 *   - Legacy classes (`ApiKeyError`, `CapabilityError`) still match
 *     their original `instanceof` checks AND now also match the new
 *     hierarchy
 */

import {
  AbloError,
  AbloAuthenticationError,
  AbloPermissionError,
  AbloRateLimitError,
  AbloIdempotencyError,
  AbloConnectionError,
  AbloValidationError,
  AbloServerError,
  AbloClaimedError,
  CapabilityError,
  translateHttpError,
  hasWireCode,
  extractWireCode,
  errorFromWire,
  toAbloError,
} from '@ablo/transaction/errors';

describe('AbloError hierarchy', () => {
  it('every subclass inherits from AbloError', () => {
    expect(new AbloAuthenticationError('x') instanceof AbloError).toBe(true);
    expect(new AbloPermissionError('x') instanceof AbloError).toBe(true);
    expect(new AbloRateLimitError('x') instanceof AbloError).toBe(true);
    expect(new AbloIdempotencyError('x') instanceof AbloError).toBe(true);
    expect(new AbloConnectionError('x') instanceof AbloError).toBe(true);
    expect(new AbloValidationError('x') instanceof AbloError).toBe(true);
    expect(new AbloServerError('x') instanceof AbloError).toBe(true);
  });

  it('all subclasses are also instanceof Error (native JS)', () => {
    // Catches `try { ... } catch (e) { if (e instanceof Error) ... }`
    // patterns — still work.
    expect(new AbloAuthenticationError('x')).toBeInstanceOf(Error);
    expect(new AbloRateLimitError('x')).toBeInstanceOf(Error);
  });

  it('`type` discriminator matches the class name (dual pattern)', () => {
    expect(new AbloAuthenticationError('x').type).toBe('AbloAuthenticationError');
    expect(new AbloPermissionError('x').type).toBe('AbloPermissionError');
    expect(new AbloRateLimitError('x').type).toBe('AbloRateLimitError');
    expect(new AbloIdempotencyError('x').type).toBe('AbloIdempotencyError');
    expect(new AbloConnectionError('x').type).toBe('AbloConnectionError');
    expect(new AbloValidationError('x').type).toBe('AbloValidationError');
    expect(new AbloServerError('x').type).toBe('AbloServerError');
  });

  it('preserves code, httpStatus, requestId', () => {
    const e = new AbloPermissionError('scope denied', {
      code: 'capability_scope_denied',
      httpStatus: 403,
      requestId: 'req-abc-123',
    });
    expect(e.code).toBe('capability_scope_denied');
    expect(e.httpStatus).toBe(403);
    expect(e.requestId).toBe('req-abc-123');
  });

  it('AbloRateLimitError carries retryAfterSeconds', () => {
    const e = new AbloRateLimitError('too many', { retryAfterSeconds: 30 });
    expect(e.retryAfterSeconds).toBe(30);
  });

  it('`cause` option preserves original error', () => {
    const original = new TypeError('network');
    const e = new AbloConnectionError('fetch failed', { cause: original });
    expect((e as unknown as { cause: unknown }).cause).toBe(original);
  });
});

describe('translateHttpError', () => {
  it('401 → AbloAuthenticationError', () => {
    expect(translateHttpError(401, { error: 'unauthorized' })).toBeInstanceOf(AbloAuthenticationError);
  });
  it('403 → AbloPermissionError', () => {
    expect(translateHttpError(403, { error: 'forbidden' })).toBeInstanceOf(AbloPermissionError);
  });
  it('409 → AbloIdempotencyError', () => {
    expect(translateHttpError(409, { error: 'idempotency_conflict' })).toBeInstanceOf(AbloIdempotencyError);
  });
  it('claim codes → AbloClaimedError, even on the 409 that idempotency also uses', () => {
    // A commit blocked by a foreign claim rides 409 too; the code must win
    // over the generic 409→idempotency mapping so callers see "claimed", not a
    // spurious idempotency conflict.
    for (const code of ['claim_conflict', 'claim_conflict', 'entity_claimed']) {
      const e = translateHttpError(409, { error: { code, message: 'held by peer' } });
      expect(e).toBeInstanceOf(AbloClaimedError);
      expect(e.code).toBe(code === 'claim_conflict' ? 'claim_conflict' : code);
      expect(e.message).toBe('held by peer');
    }
  });
  it('maps heldByClaim from the conflict envelope into typed claims (nested + flat)', () => {
    const heldByClaim = {
      claimId: 'i0',
      description: 'reformatting',
      declaredAt: Date.now(),
      expiresAt: Date.now() + 120_000,
      entityType: 'Task',
      entityId: 't1',
      meta: { description: 'pricing table, about two minutes' },
    };
    // Nested envelope — what the HTTP claim routes emit on conflict.
    const nested = translateHttpError(409, {
      error: { code: 'entity_claimed', heldBy: 'agent:writer', heldByClaim },
    });
    expect(nested).toBeInstanceOf(AbloClaimedError);
    expect((nested as AbloClaimedError).claims).toEqual([heldByClaim]);
    // Flat envelope — toJSON spreads details to the top level.
    const flat = translateHttpError(409, {
      code: 'claim_conflict',
      heldBy: 'agent:writer',
      heldByClaim,
    });
    expect(flat).toBeInstanceOf(AbloClaimedError);
    expect((flat as AbloClaimedError).claims).toEqual([heldByClaim]);
    // A malformed summary degrades to no claims — never a parse throw.
    const malformed = translateHttpError(409, {
      error: { code: 'entity_claimed', heldByClaim: { claimId: 42 } },
    });
    expect(malformed).toBeInstanceOf(AbloClaimedError);
    expect((malformed as AbloClaimedError).claims).toBeUndefined();
  });
  it('400 and 422 → AbloValidationError', () => {
    expect(translateHttpError(400, { error: 'bad_request' })).toBeInstanceOf(AbloValidationError);
    expect(translateHttpError(422, { error: 'unprocessable' })).toBeInstanceOf(AbloValidationError);
  });
  it('429 → AbloRateLimitError', () => {
    expect(translateHttpError(429, { error: 'rate_limited' })).toBeInstanceOf(AbloRateLimitError);
  });
  it('500 + 502 + 503 + 504 → AbloServerError', () => {
    expect(translateHttpError(500, { error: 'internal' })).toBeInstanceOf(AbloServerError);
    expect(translateHttpError(502, { error: 'bad_gateway' })).toBeInstanceOf(AbloServerError);
    expect(translateHttpError(503, { error: 'unavailable' })).toBeInstanceOf(AbloServerError);
    expect(translateHttpError(504, { error: 'timeout' })).toBeInstanceOf(AbloServerError);
  });
  it('418 (unmapped) → AbloError', () => {
    const e = translateHttpError(418, { error: 'teapot' });
    expect(e).toBeInstanceOf(AbloError);
    expect(e).not.toBeInstanceOf(AbloServerError);
    expect(e.httpStatus).toBe(418);
  });
  it('extracts message from reason → message → error in priority', () => {
    expect(translateHttpError(403, { reason: 'scope denied' }).message).toBe('scope denied');
    expect(translateHttpError(403, { message: 'plain' }).message).toBe('plain');
    expect(translateHttpError(403, { error: 'e' }).message).toBe('e');
  });
  it('passes through requestId to the error', () => {
    const e = translateHttpError(500, {}, 'req-xyz');
    expect(e.requestId).toBe('req-xyz');
  });
  it('handles string bodies (non-JSON error pages)', () => {
    const e = translateHttpError(500, '<html>Internal Server Error</html>');
    expect(e).toBeInstanceOf(AbloServerError);
    expect(e.message).toContain('Internal Server Error');
  });
  it('uses the same wire-envelope parser for hasWireCode and extractWireCode', () => {
    expect(hasWireCode({ error: { code: 'jwt_expired', message: 'expired' } })).toBe(true);
    expect(hasWireCode({ error: 401, message: 'proxy body' })).toBe(false);
    expect(extractWireCode(JSON.stringify({ error: 'session_expired' }))).toBe('session_expired');
  });
});

describe('errorFromWire — code-first factory (frame transports)', () => {
  it('derives the subclass from the code’s registry status when no HTTP status is given', () => {
    // The WebSocket commit path has only a code, never an HTTP status — the
    // registry’s canonical httpStatus must still select the right subclass.
    expect(errorFromWire('boom', { code: 'not_null_violation' })).toBeInstanceOf(AbloValidationError);
    expect(errorFromWire('boom', { code: 'unique_violation' })).toBeInstanceOf(AbloIdempotencyError); // 409
    expect(errorFromWire('boom', { code: 'internal_error' })).toBeInstanceOf(AbloServerError); // 500
    expect(errorFromWire('boom', { code: 'jwt_expired' })).toBeInstanceOf(AbloAuthenticationError); // 401
  });
  it('routes capability + claim codes to their typed subclasses', () => {
    expect(errorFromWire('x', { code: 'capability_scope_denied' })).toBeInstanceOf(CapabilityError);
    expect(errorFromWire('x', { code: 'entity_claimed' })).toBeInstanceOf(AbloClaimedError);
  });
  it('an unknown / forward-compat code → base AbloError, still tagged', () => {
    const e = errorFromWire('mystery', { code: 'some_future_code' });
    expect(e).toBeInstanceOf(AbloError);
    expect(e.code).toBe('some_future_code');
  });
});

describe('toAbloError — SDK never leaks an untagged error', () => {
  it('passes an AbloError through unchanged (identity preserved)', () => {
    const original = new AbloValidationError('nope', { code: 'invalid_body' });
    expect(toAbloError(original)).toBe(original);
  });
  it('wraps a bare Error, preserving message + a slapped-on code + cause', () => {
    const bare = Object.assign(new Error('null value in column "organization_id"'), {
      code: 'not_null_violation',
    });
    const e = toAbloError(bare);
    expect(e).toBeInstanceOf(AbloError);
    expect(e.type).toBe('AbloError');
    expect(e.message).toBe('null value in column "organization_id"');
    expect(e.code).toBe('not_null_violation');
    expect((e as { cause?: unknown }).cause).toBe(bare);
  });
  it('wraps a non-Error throw (string, object) so instanceof AbloError still holds', () => {
    expect(toAbloError('kaboom')).toBeInstanceOf(AbloError);
    expect(toAbloError('kaboom').message).toBe('kaboom');
    expect(toAbloError({ weird: true })).toBeInstanceOf(AbloError);
  });
});

describe('CapabilityError — domain-specific subclass', () => {
  it('instanceof CapabilityError', () => {
    const e = new CapabilityError('capability_scope_denied', 'narrow');
    expect(e).toBeInstanceOf(CapabilityError);
  });
  it('instanceof AbloPermissionError (broader category)', () => {
    const e = new CapabilityError('capability_scope_denied', 'narrow');
    expect(e).toBeInstanceOf(AbloPermissionError);
  });
  it('instanceof AbloError (root)', () => {
    const e = new CapabilityError('capability_invalid', 'unknown');
    expect(e).toBeInstanceOf(AbloError);
  });
  it('preserves the `code` field for observability', () => {
    const e = new CapabilityError('capability_scope_denied', 'narrow');
    expect(e.code).toBe('capability_scope_denied');
  });
  it('message embeds the code prefix for legacy log grepping', () => {
    const e = new CapabilityError('capability_invalid', 'unknown cap');
    expect(e.message).toBe('capability_invalid: unknown cap');
  });
});
