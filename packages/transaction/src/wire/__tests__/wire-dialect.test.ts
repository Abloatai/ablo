/**
 * Every wire schema must survive the crossing.
 *
 * `wire/` is the protocol, and the published contract is derived from it — so a
 * schema that cannot be expressed as JSON Schema is a schema no other language
 * can be told about. `z.date()`, `z.map()`, `z.set()`, `z.bigint()`,
 * `.transform()`, `z.custom()`, and branded types either throw during derivation
 * or degrade to `{}`, and the degradation is the dangerous one: the spec still
 * builds, and the field simply vanishes from the contract.
 *
 * This asserts the property — "derives to something a client can use" — rather
 * than banning today's list of offending constructs. A grep for `z.date()`
 * catches the violation that already happened; this catches the next one.
 *
 * Both directions are checked, because a schema can be representable one way and
 * not the other, and requests derive from `input` while responses derive from
 * `output`.
 */

import { z } from 'zod';
import * as wire from '@abloatai/transaction/wire';

const isZodSchema = (value: unknown): value is z.ZodType =>
  typeof value === 'object' && value !== null && '_zod' in value;

const schemas: [string, z.ZodType][] = Object.entries(
  wire as Record<string, unknown>,
)
  .flatMap(([name, value]) =>
    isZodSchema(value) ? [[name, value] as [string, z.ZodType]] : [],
  )
  .sort(([a], [b]) => a.localeCompare(b));

describe('wire schemas derive to a publishable contract', () => {
  it('finds the exported schemas to check', () => {
    // A guard on the guard: if the barrel stops exporting schemas, the loop
    // below would pass vacuously and this file would read as coverage.
    expect(schemas.length).toBeGreaterThan(10);
  });

  describe.each(schemas)('%s', (_name, schema) => {
    it.each(['input', 'output'] as const)('derives (%s)', (io) => {
      expect(() => z.toJSONSchema(schema, { io })).not.toThrow();
    });

    it('does not derive to an empty schema', () => {
      // `{}` means "anything" — the field survives the build and disappears from
      // the contract, which is worse than throwing.
      const derived = z.toJSONSchema(schema, { io: 'output' });
      const meaningful = Object.keys(derived).filter((k) => k !== '$schema');
      expect(meaningful.length).toBeGreaterThan(0);
    });
  });
});
