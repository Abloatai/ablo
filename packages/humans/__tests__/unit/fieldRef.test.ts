/**
 * `schema.fields.<model>.<field>` — a field as a value rather than a quoted
 * name.
 *
 * A model is declared as Zod schemas keyed by name, so a field's name lives on
 * the object key and never on the value. Every surface that had to say "which
 * field" quoted it, and `fields: ['titel']` therefore compiled, was granted,
 * excluded nobody, and left the write of `title` unguarded — the conflict rule
 * compares names as opaque strings, so an invented one matches no other claim
 * and nothing reports it.
 *
 * These pin the two halves that make the reference worth having: it exists for
 * every declared field, and it reaches the wire as the same name a string
 * would have — so nothing downstream needs to know which spelling was used.
 */

import { z } from 'zod';
import { describe, expect, it } from '@jest/globals';
import { defineSchema, model } from '@abloatai/transaction/schema';
import { subTarget } from '@abloatai/transaction/claims';
import { part } from '@abloatai/transaction/coordination/schema';

const schema = defineSchema({
  items: model({
    title: z.string(),
    status: z.enum(['todo', 'doing', 'done']).default('todo'),
  }),
  records: model({
    content: z.string(),
  }),
});

describe('schema.fields', () => {
  it('carries a reference for every declared field, naming its model', () => {
    expect(schema.fields.items.status).toEqual({ model: 'items', field: 'status' });
    expect(schema.fields.items.title).toEqual({ model: 'items', field: 'title' });
    expect(schema.fields.records.content).toEqual({
      model: 'records',
      field: 'content',
    });
  });

  // Base fields are supplied by the SDK rather than declared, and naming one
  // means the row rather than a part of it.
  it('does not invent references for base fields', () => {
    expect(schema.fields.items).not.toHaveProperty('id');
    expect(schema.fields.items).not.toHaveProperty('createdAt');
  });

  it('does not compile for a field the model does not have', () => {
    // @ts-expect-error — `titel` is not a field of `items`. This is the whole
    // point: the string spelling accepts it silently.
    void schema.fields.items.titel;
  });

  // All three spellings cross to the same wire name — the difference is how
  // much was known before the crossing, not what arrives.
  it('reaches the wire as the same name a string would have', () => {
    expect(subTarget({ field: schema.fields.items.status })).toEqual({
      field: 'status',
    });
    expect(subTarget({ field: 'status' })).toEqual({ field: 'status' });
    expect(subTarget({ field: part('B2') })).toEqual({ field: 'B2' });

    expect(
      subTarget({ fields: [schema.fields.items.title, part('B2'), 'status'] }),
    ).toEqual({ fields: ['title', 'B2', 'status'] });
  });

  it('turns the public model selector into wire fields at one seam', () => {
    expect(
      subTarget({ fields: (item) => item.status }, 'items'),
    ).toEqual({ fields: ['status'] });

    expect(
      subTarget(
        { fields: (item) => [item.title, item.status] },
        'items',
      ),
    ).toEqual({ fields: ['title', 'status'] });
  });
});
