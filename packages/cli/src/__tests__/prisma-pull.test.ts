/**
 * `ablo pull prisma` — argument parsing, and that the one-step build wires the
 * parse and the emit together.
 *
 * What the lowering actually produces is asserted by the shared conformance
 * battery in `derivation/`, alongside every other source, so it cannot drift
 * away from what `pull drizzle` produces for the same schema.
 */

import { buildSchemaSourceFromPrisma, parsePrismaPullArgs } from '../prismaPull';
import { PRISMA_SCHEMA } from './derivation/fixtures/prisma';

describe('buildSchemaSourceFromPrisma', () => {
  it('returns the emitted source alongside what was adopted and declined', () => {
    const result = buildSchemaSourceFromPrisma({ src: PRISMA_SCHEMA, importPath: '@abloatai/ablo/schema' });
    expect(result.source).toContain("import { defineSchema, model, relation, field } from '@abloatai/ablo/schema';");
    expect(result.models.sort()).toEqual(['projects', 'tasks']);
    expect(result.skipped.map((s) => s.name)).toEqual(['Settings']);
  });
});

describe('parsePrismaPullArgs', () => {
  it('takes a bare path as the schema', () => {
    expect(parsePrismaPullArgs(['db/schema.prisma'])).toMatchObject({ schema: 'db/schema.prisma' });
  });

  it('parses flags', () => {
    expect(parsePrismaPullArgs(['--schema', 'a.prisma', '--out', 'b.ts', '--force'])).toMatchObject({
      schema: 'a.prisma',
      out: 'b.ts',
      force: true,
    });
  });

  it('rejects unknown flags', () => {
    expect(() => parsePrismaPullArgs(['--nope'])).toThrow(/unknown flag/);
  });
});
