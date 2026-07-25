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

/**
 * Known-unpublishable schemas, frozen at their current count.
 *
 * All three fail for one remaining reason: `wire/commit.ts` types a commit
 * rejection's `code` with `z.custom<ErrorCode>()`, which carries no runtime
 * shape for JSON Schema to emit. It is really the 246-entry `ERROR_CODES`
 * registry, so it could become a `z.enum` derived from that source and publish
 * the code list to clients as a side effect (see §8 of the Python-readiness
 * brief) — the open question being how such an enum keeps accepting a code
 * from a newer server, which the current escape hatch does by construction.
 *
 * Shrink this list, never grow it. A new entry means a new shape that no
 * non-TypeScript client can be told about.
 */
const UNPUBLISHABLE = new Set([
  'rejectedCommitReceiptSchema',
  'mutationResultPayloadSchema',
  'mutationResultMessageSchema',
]);

const schemas: [string, z.ZodType][] = Object.entries(
  wire as Record<string, unknown>,
)
  .flatMap(([name, value]) =>
    isZodSchema(value) && !UNPUBLISHABLE.has(name) ? [[name, value] as [string, z.ZodType]] : [],
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

/**
 * The exemption list is itself a ratchet: it must stay accurate, or it silently
 * grants a pass to a schema that has since been fixed — or hides one that never
 * failed.
 */
describe('the unpublishable list is honest', () => {
  it.each([...UNPUBLISHABLE])('%s still fails to derive, so the exemption is earned', (name) => {
    const schema = (wire as Record<string, unknown>)[name];
    if (!isZodSchema(schema)) throw new Error(`${name} is exempted but not exported`);
    expect(() => z.toJSONSchema(schema, { io: 'output' })).toThrow();
  });
});
