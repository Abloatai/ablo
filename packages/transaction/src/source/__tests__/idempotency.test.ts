import {
  assertSourceIdempotencyRetention,
  decodeSourceEchoTransactionId,
  encodeSourceEchoTransactionId,
  sourceEchoTransactionIdSchema,
  SOURCE_IDEMPOTENCY_RETENTION,
} from '../idempotency.js';
import { COMMIT_CORRELATION_ID_MAX_LENGTH } from '@abloatai/transaction/wire/commit';

describe('source WAL storage correlation envelope', () => {
  it('round-trips the shared correlation plus original operation identity', () => {
    const encoded = encodeSourceEchoTransactionId(
      'corr:/workspace-a?participant=user-1',
      'operation:[doc/1]'
    );

    expect(decodeSourceEchoTransactionId(encoded)).toEqual({
      correlationId: 'corr:/workspace-a?participant=user-1',
      transactionId: 'operation:[doc/1]',
    });
  });

  it('uses the canonical runtime object schema after decoding', () => {
    expect(
      sourceEchoTransactionIdSchema.parse({
        correlationId: 'corr-1',
        transactionId: 'op-1',
      })
    ).toEqual({ correlationId: 'corr-1', transactionId: 'op-1' });
    expect(
      sourceEchoTransactionIdSchema.safeParse({
        correlationId: '',
        transactionId: 'op-1',
      }).success
    ).toBe(false);
  });

  it('rejects invalid producer values and treats malformed stored values as uncorrelated', () => {
    expect(() => encodeSourceEchoTransactionId('', 'op-1')).toThrow();
    expect(() =>
      encodeSourceEchoTransactionId('x'.repeat(COMMIT_CORRELATION_ID_MAX_LENGTH + 1), 'op-1')
    ).toThrow();
    expect(decodeSourceEchoTransactionId('ablo_echo_tx_v1:not-json')).toBeNull();
    expect(decodeSourceEchoTransactionId('ablo_echo_tx_v1:["corr-only"]')).toBeNull();
    expect(decodeSourceEchoTransactionId('ordinary-client-transaction')).toBeNull();
  });
});

describe('source idempotency retention', () => {
  it('treats Postgres infinity as the permanent initial contract', () => {
    expect(() => assertSourceIdempotencyRetention('infinity')).not.toThrow();
    expect(() => assertSourceIdempotencyRetention(Infinity)).not.toThrow();
  });

  it('rejects an expired retained key instead of executing it as fresh', () => {
    expect(() =>
      assertSourceIdempotencyRetention('2026-01-01T00:00:00.000Z', Date.parse('2026-07-15T00:00:00.000Z')),
    ).toThrow(expect.objectContaining({ code: 'idempotency_key_expired' }));
  });

  it('writes rows with a bounded, prunable TTL — not the unbounded infinity', () => {
    // New rows use this interval; because an expired key is refused above,
    // pruning anything past it is safe, and the table stops growing forever.
    expect(SOURCE_IDEMPOTENCY_RETENTION).toBe('30 days');
    expect(SOURCE_IDEMPOTENCY_RETENTION).not.toBe('infinity');
  });
});
