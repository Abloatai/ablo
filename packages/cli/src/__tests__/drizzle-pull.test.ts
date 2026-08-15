/**
 * `ablo pull drizzle` — argument parsing, and that the one-step build wires the
 * reflection and the emit together.
 *
 * What the reflection actually produces is asserted by the shared conformance
 * battery in `derivation/`, alongside every other source.
 */

import { buildSchemaSourceFromDrizzle, parseDrizzlePullArgs } from '../drizzlePull';
import * as tables from './derivation/fixtures/drizzle';

describe('buildSchemaSourceFromDrizzle', () => {
  it('returns the emitted source alongside what was adopted and declined', async () => {
    const result = await buildSchemaSourceFromDrizzle({
      mod: { ...tables },
      importPath: '@abloatai/ablo/schema',
    });
    expect(result.source).toContain("import { defineSchema, model, relation, field } from '@abloatai/ablo/schema';");
    expect(result.models.sort()).toEqual(['records', 'workspaces']);
    expect(result.skipped.map((s) => s.name)).toEqual(['settings']);
  });
});

describe('parseDrizzlePullArgs', () => {
  it('takes a bare path as the schema module', () => {
    expect(parseDrizzlePullArgs(['src/db/schema.ts'])).toMatchObject({ schema: 'src/db/schema.ts' });
  });

  it('defaults schema to null when none given', () => {
    expect(parseDrizzlePullArgs([])).toMatchObject({ schema: null });
  });

  it('rejects unknown flags', () => {
    expect(() => parseDrizzlePullArgs(['--nope'])).toThrow(/unknown flag/);
  });
});
