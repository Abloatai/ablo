/**
 * Wire error-envelope producer contract (doctor T1.24).
 *
 * This is the only envelope producer there is — sync-web's dashboard routes and
 * the hosted engine both serve its output — so three behaviors are pinned here:
 *
 *   1. MASKING — an unclassified throw must degrade to the constant public
 *      message. It used to leak the raw `err.message` (driver text, internal
 *      endpoints) to the browser.
 *
 *   2. STATUS PRECEDENCE — explicit `httpStatus` wins; else the code's
 *      canonical registry status (`errorCodeSpec`); else the subclass default
 *      (`statusForType`). The docblock promises `new AbloError('…', { code:
 *      'entity_not_found' })` is a 404 without repeating the status.
 *
 *   3. MASKING — a value this module cannot type never reaches the wire. A
 *      deployment that recognizes more failures than the core does, such as a
 *      database driver's integrity errors, classifies them into an `AbloError`
 *      BEFORE calling, rather than handing in a callback: this envelope is
 *      consumed across a package boundary, where an argument the built copy
 *      does not declare is dropped in silence rather than refused.
 */
import { describe, it, expect } from '@jest/globals';
import {
  errorEnvelope,
  errorEnvelopeSchema,
  statusForType,
  INTERNAL_ERROR_PUBLIC_MESSAGE,
} from '@ablo/transaction/wire/errorEnvelope';
import { AbloError, AbloValidationError } from '@ablo/transaction/errors';
import { errorCodeSpec } from '@ablo/transaction/errorCodes';

describe('wire errorEnvelope — unknown-error masking', () => {
  it('masks a plain Error to the constant public message (no raw driver text)', () => {
    const { body, status } = errorEnvelope(
      new Error('connect ECONNREFUSED 10.0.12.34:5432'),
    );
    expect(status).toBe(500);
    expect(body.type).toBe('AbloServerError');
    expect(body.code).toBe('internal_error');
    expect(body.message).toBe(INTERNAL_ERROR_PUBLIC_MESSAGE);
    expect(JSON.stringify(body)).not.toContain('ECONNREFUSED');
  });

  it('masks a non-Error throw the same way', () => {
    const { body, status } = errorEnvelope('raw string with a secret');
    expect(status).toBe(500);
    expect(body.message).toBe(INTERNAL_ERROR_PUBLIC_MESSAGE);
    expect(JSON.stringify(body)).not.toContain('secret');
  });

  it('still stamps the requestId on the masked envelope', () => {
    const { body } = errorEnvelope(new Error('boom'), 'req_mask_1');
    expect(body.request_id).toBe('req_mask_1');
    expect(body.message).toBe(INTERNAL_ERROR_PUBLIC_MESSAGE);
  });
});

describe('wire errorEnvelope — status precedence', () => {
  it('a code-only base AbloError resolves the code registry status (entity_not_found → 404)', () => {
    expect(errorCodeSpec('entity_not_found')?.httpStatus).toBe(404);
    const { status } = errorEnvelope(new AbloError('missing', { code: 'entity_not_found' }));
    expect(status).toBe(404);
  });

  it('an explicit httpStatus wins over the code registry', () => {
    const { status } = errorEnvelope(
      new AbloError('gone', { code: 'entity_not_found', httpStatus: 410 }),
    );
    expect(status).toBe(410);
  });

  it('no code, no httpStatus → subclass default via statusForType', () => {
    const { status } = errorEnvelope(new AbloValidationError('bad input'));
    expect(status).toBe(statusForType('AbloValidationError'));
    expect(status).toBe(400);
  });

  it('a typed AbloError keeps its own message (masking is only for unclassified throws)', () => {
    const { body } = errorEnvelope(new AbloValidationError('title is required'));
    expect(body.message).toBe('title is required');
  });
});

describe('wire errorEnvelope — a throw it cannot type', () => {
  it('masks an opaque failure, leaking none of its detail', () => {
    // Stand-in for a database driver's error: an object this module has no way
    // to recognize. A deployment that CAN recognize it classifies it before
    // calling here — the envelope takes no classifier callback, because one
    // would cross a package boundary where an argument the built copy does not
    // declare is dropped in silence rather than refused.
    const driverFailure = { sqlstate: '23505', table: 'internal_ledger' };
    const { body, status } = errorEnvelope(driverFailure);
    expect(status).toBe(500);
    expect(body.code).toBe('internal_error');
    expect(body.message).toBe(INTERNAL_ERROR_PUBLIC_MESSAGE);
    expect(JSON.stringify(body)).not.toContain('internal_ledger');
  });

  it('serializes what the caller classified, on the same status precedence', () => {
    // The caller-classifies-first shape: whatever a deployment's own classifier
    // returns arrives already typed and travels the ordinary path.
    const { body, status } = errorEnvelope(
      new AbloValidationError('A value violates a uniqueness constraint.', {
        code: 'unique_violation',
        httpStatus: 409,
      }),
    );
    expect(status).toBe(409);
    expect(body.type).toBe('AbloValidationError');
    expect(body.code).toBe('unique_violation');
  });

  it('masks a plain Error rather than echoing its message', () => {
    const { body, status } = errorEnvelope(new Error('deep failure'));
    expect(status).toBe(500);
    expect(body.code).toBe('internal_error');
    expect(body.message).toBe(INTERNAL_ERROR_PUBLIC_MESSAGE);
    expect(JSON.stringify(body)).not.toContain('deep failure');
  });
});

describe('errorEnvelopeSchema', () => {
  it('parses producer output and preserves additive domain details', () => {
    const { body } = errorEnvelope(
      new AbloError('rows are missing', {
        code: 'entity_not_found',
        details: { missingIds: ['task_1', 'task_2'] },
      }),
      'req_schema_1',
    );

    expect(errorEnvelopeSchema.parse(body)).toMatchObject({
      type: 'AbloError',
      code: 'entity_not_found',
      message: 'rows are missing',
      request_id: 'req_schema_1',
      missingIds: ['task_1', 'task_2'],
    });
    // Spread at the top level and NOT also nested. `toMatchObject` above would
    // pass either way, so the absence is what pins the shape: a reader looking
    // for `missingIds` must find it in one place, not two.
    expect((body as Record<string, unknown>).details).toBeUndefined();
  });

  it('accepts aggregate item errors and validates their required message', () => {
    expect(
      errorEnvelopeSchema.safeParse({
        type: 'AbloValidationError',
        code: 'invalid_request',
        message: 'two fields are invalid',
        errors: [
          { code: 'invalid_field', param: 'title', message: 'title is required' },
          { param: 'status', message: 'status is invalid' },
        ],
      }).success,
    ).toBe(true);

    expect(
      errorEnvelopeSchema.safeParse({
        type: 'AbloValidationError',
        message: 'invalid field',
        errors: [{ code: 'invalid_field', param: 'title' }],
      }).success,
    ).toBe(false);
  });

  it('rejects an envelope without its required public message', () => {
    expect(
      errorEnvelopeSchema.safeParse({ type: 'AbloServerError', code: 'internal_error' }).success,
    ).toBe(false);
  });
});
