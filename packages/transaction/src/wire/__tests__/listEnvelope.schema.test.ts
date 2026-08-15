import { z } from 'zod';
import {
  listEnvelope,
  listEnvelopeSchema,
} from '@abloatai/transaction/wire/listEnvelope';

const itemSchema = z.object({
  id: z.string(),
  title: z.string(),
});

describe('listEnvelopeSchema', () => {
  it('parses the helper default envelope with validated rows', () => {
    const envelope = listEnvelope([{ id: 'item_1', title: 'Ship it' }]);

    expect(listEnvelopeSchema(itemSchema).parse(envelope)).toEqual({
      object: 'list',
      data: [{ id: 'item_1', title: 'Ship it' }],
      has_more: false,
      next_cursor: null,
    });
  });

  it('preserves pagination metadata', () => {
    const envelope = listEnvelope([{ id: 'item_1', title: 'Ship it' }], {
      hasMore: true,
      nextCursor: 'cursor_2',
    });

    expect(listEnvelopeSchema(itemSchema).parse(envelope)).toMatchObject({
      has_more: true,
      next_cursor: 'cursor_2',
    });
  });

  it('rejects a wrong envelope tag or an invalid item', () => {
    const schema = listEnvelopeSchema(itemSchema);

    expect(
      schema.safeParse({
        object: 'collection',
        data: [],
        has_more: false,
        next_cursor: null,
      }).success,
    ).toBe(false);
    expect(
      schema.safeParse({
        object: 'list',
        data: [{ id: 'item_1' }],
        has_more: false,
        next_cursor: null,
      }).success,
    ).toBe(false);
  });
});
