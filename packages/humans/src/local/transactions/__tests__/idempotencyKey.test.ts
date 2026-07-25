import { idempotencyKeySchema } from '@ablo/transaction/transactions/settlement/idempotencyKey';

describe('durable write idempotency key', () => {
  it('accepts stable non-empty keys up to the wire limit', () => {
    expect(idempotencyKeySchema.safeParse('agent-run:turn-42:write-1').success).toBe(true);
    expect(idempotencyKeySchema.safeParse('x'.repeat(255)).success).toBe(true);
  });

  it('rejects missing and oversized keys', () => {
    expect(idempotencyKeySchema.safeParse('').success).toBe(false);
    expect(idempotencyKeySchema.safeParse('x'.repeat(256)).success).toBe(false);
  });
});
