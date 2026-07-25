import { bootstrapReasonSchema } from '@abloatai/transaction/wire/bootstrapReason';

describe('bootstrapReasonSchema', () => {
  it('accepts the durable stream-gap recovery signal', () => {
    expect(bootstrapReasonSchema.parse('stream_gap')).toBe('stream_gap');
  });

  it('rejects unregistered recovery reasons', () => {
    expect(bootstrapReasonSchema.safeParse('maybe_retry').success).toBe(false);
  });
});
