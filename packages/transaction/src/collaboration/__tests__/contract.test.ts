import { describe, expect, it } from '@jest/globals';
import { modelEventEnvelopeSchema, modelEventInputSchema } from '../contract.js';

describe('model event contract', () => {
  const input = {
    target: { model: 'File', id: 'file-1', syncGroup: 'file:file-1' },
    event: 'selection',
    payload: { from: 2, to: 9 },
  };

  it('accepts a bounded record-addressed input', () => {
    expect(modelEventInputSchema.parse(input)).toEqual(input);
  });

  it('requires the server-authored attribution on delivery', () => {
    expect(modelEventEnvelopeSchema.safeParse(input).success).toBe(false);
    expect(modelEventEnvelopeSchema.safeParse({
      ...input,
      sender: {
        presenceSessionId: 'b6741f5a-e982-4f9c-916b-2d247b8d4646',
        participant: { id: 'agent-coder', kind: 'agent' },
      },
      sentAt: '2026-09-05T10:00:00.000Z',
    }).success).toBe(true);
  });

  it('rejects unbounded names and non-object payloads', () => {
    expect(modelEventInputSchema.safeParse({ ...input, event: 'x'.repeat(129) }).success).toBe(false);
    expect(modelEventInputSchema.safeParse({ ...input, payload: null }).success).toBe(false);
  });
});
