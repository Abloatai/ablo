/**
 * Test: a model the schema projection left out answers with the error that
 * names it, not `undefined`.
 *
 * An app can compile against the full source schema while running a
 * projection (`selectModels`), so reaching for a projected-out model never
 * fails a type check. Without the stub the access reads as `undefined` and
 * the caller crashes one property later with a bare TypeError ("reading
 * 'local'") that names neither the model nor the fix. These tests pin the
 * contract from `buildReactiveEngine`: every `schema.omittedModels` name is a
 * throwing accessor, and the stubs stay invisible to enumeration.
 */

import { Ablo, type InternalAbloOptions } from '../../../Ablo.js';
import { defineSchema } from '@abloatai/transaction/schema/schema';
import { model } from '@abloatai/transaction/schema/model';
import { selectModels } from '@abloatai/transaction/schema/select';
import { AbloError } from '@abloatai/transaction/errors';
import { z } from 'zod';

const full = defineSchema({
  tasks: model({ title: z.string() }, { typename: 'OmitAccessTask' }),
  invoices: model({ total: z.number() }, { typename: 'OmitAccessInvoice' }),
});

const silentLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const makeProjected = () => {
  const schema = selectModels(full, ['tasks']);
  return Ablo({
    schema,
    baseURL: 'ws://localhost:1234',
    user: { id: 'user-1' },
    inMemory: true,
    logger: silentLogger,
  } as InternalAbloOptions<(typeof schema)['models']>);
};

describe('a model the schema projection left out', () => {
  it('throws the named error on access while kept models still answer', async () => {
    const ablo = makeProjected();
    try {
      expect(ablo.tasks.local.list()).toEqual([]);

      let thrown: unknown;
      try {
        Reflect.get(ablo, 'invoices');
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(AbloError);
      expect((thrown as AbloError).code).toBe('model_not_in_schema');
      expect((thrown as AbloError).message).toContain('invoices');
    } finally {
      await ablo.dispose();
    }
  });

  it('keeps the stubs invisible to enumeration, spread, and serialization', async () => {
    const ablo = makeProjected();
    try {
      // Non-enumerable by design: devtools, spread, and JSON walks must not
      // trip the throw while doing nothing wrong.
      expect(() => Object.keys(ablo)).not.toThrow();
      expect(() => ({ ...(ablo as object) })).not.toThrow();
      expect(Object.keys(ablo)).not.toContain('invoices');
    } finally {
      await ablo.dispose();
    }
  });
});
