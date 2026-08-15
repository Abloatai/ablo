/**
 * Resource lookups are scoped to their model.
 *
 * The instance pool is a single id space — one `Map<id, entry>` shared by every
 * model. That is a deliberate storage shape (ids are globally unique, the same
 * premise as Relay's Global Object Identification), but it means an id alone
 * cannot say which model a row belongs to. Apollo and EmberData sidestep this by
 * keying their identity maps on `Type:id`; with unique ids the equivalent
 * guarantee has to come from stating the expected model at the lookup.
 *
 * Before this, `ablo.<model>.local.get(id)` returned whatever row carried that id and
 * cast it to the asking model's type. Three product bugs came from that, the
 * last being a entry resize that reverted after every commit because
 * `entryLayoutLayers.local.get(<a EntryDetail id>)` answered truthy and was read as
 * "this is a layout layer".
 *
 * Reads scope to `undefined` (from this model's view the id is absent). Writes
 * throw, naming both models: a cross-model write is never a legitimate outcome,
 * and silence is precisely how the earlier corruption went unnoticed.
 */

import { z } from 'zod';
import { Ablo, type InternalAbloOptions } from '../../src/Ablo.js';
import { defineSchema } from '@abloatai/transaction/schema/schema';
import { model } from '@abloatai/transaction/schema/model';

const silentLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

function makeSchema() {
  return defineSchema({
    widgets: model({ label: z.string().default('') }, { typename: 'Widget' }),
    gadgets: model({ label: z.string().default('') }, { typename: 'Gadget' }),
  });
}

type TestSchema = ReturnType<typeof makeSchema>;

function makeAblo() {
  return Ablo({
    schema: makeSchema(),
    baseURL: 'ws://localhost:1234',
    user: { id: 'user-1' },
    inMemory: true,
    logger: silentLogger,
  } as InternalAbloOptions<TestSchema['models']>);
}

const FOREIGN_ID = 'row-owned-by-gadgets';

describe('reads scope to the asking model', () => {
  it('does not return a sibling model’s row', async () => {
    const ablo = makeAblo();
    try {
      await ablo.gadgets.create({ data: { id: FOREIGN_ID, label: 'a gadget' } });

      // The row is genuinely in the pool...
      expect(ablo.gadgets.local.get(FOREIGN_ID)).toBeDefined();
      // ...but it is not a widget, so the widget resource reads it as absent.
      expect(ablo.widgets.local.get(FOREIGN_ID)).toBeUndefined();
    } finally {
      await ablo.dispose();
    }
  });

  it('still returns the model’s own row', async () => {
    const ablo = makeAblo();
    try {
      await ablo.widgets.create({ data: { id: 'w-1', label: 'a widget' } });
      expect(ablo.widgets.local.get('w-1')?.label).toBe('a widget');
    } finally {
      await ablo.dispose();
    }
  });
});

describe('writes refuse a sibling model’s id', () => {
  it('update names both models instead of writing the wrong row', async () => {
    const ablo = makeAblo();
    try {
      await ablo.gadgets.create({ data: { id: FOREIGN_ID, label: 'original' } });

      await expect(
        ablo.widgets.update({ id: FOREIGN_ID, data: { label: 'clobbered' } }),
      ).rejects.toThrow(/belongs to a Gadget/);

      // The row the caller never addressed is untouched.
      expect(ablo.gadgets.local.get(FOREIGN_ID)?.label).toBe('original');
    } finally {
      await ablo.dispose();
    }
  });

  it('delete refuses a sibling model’s id rather than removing it', async () => {
    const ablo = makeAblo();
    try {
      await ablo.gadgets.create({ data: { id: FOREIGN_ID, label: 'keep me' } });

      await expect(ablo.widgets.delete({ id: FOREIGN_ID })).rejects.toThrow(
        /belongs to a Gadget/,
      );

      expect(ablo.gadgets.local.get(FOREIGN_ID)).toBeDefined();
    } finally {
      await ablo.dispose();
    }
  });

  /**
   * Scoping must not cost delete its idempotency: an id this model simply
   * doesn't hold is still "already absent", not an error. Only an id owned by
   * another model — which is distinguishable, and always a caller bug — throws.
   */
  it('delete stays a no-op for an id no model holds', async () => {
    const ablo = makeAblo();
    try {
      await expect(ablo.widgets.delete({ id: 'never-existed' })).resolves.toBeUndefined();
    } finally {
      await ablo.dispose();
    }
  });
});
