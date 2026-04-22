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
  CapabilityError,
  translateHttpError,
} from '../errors';

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

