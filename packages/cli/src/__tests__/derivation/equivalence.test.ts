/**
 * The cross-source equivalence check — one logical schema, expressed in either
 * ORM, must derive the same models.
 *
 * This is the test the conformance battery cannot replace. The battery proves
 * each source satisfies the contract; this proves the sources agree with each
 * other, which is the whole claim behind deriving a schema instead of asking a
 * customer to restate one. It is also what holds the two fixture files
 * together: one logical schema still has to be written once per ORM, and if
 * those two descriptions stop matching, this fails.
 *
 * What is compared is the adopted artifact — the models, their fields, and
 * their relations — because that is what becomes the schema. Deliberately
 * excluded:
 *
 *   - `note`, which is the source's own prose about a lossy lowering. That it
 *     warns is asserted by the battery; how it words the warning is its own.
 *   - the name on a skip entry, which each source states in its own vocabulary
 *     (see `divergence.test.ts`). The skip *reasons* are compared here.
 *
 * Fields are compared on their effective column, not the raw value, because
 * sources differ in whether they record a column the engine could derive.
 */

import { lowerDrizzleModule } from '../../drizzlePull';
import { parsePrismaSchema } from '../../prismaPull';
import type { IRSchema } from '../../schemaIr';
import { effectiveColumn } from './conformance';
import * as drizzleTables from './fixtures/drizzle';
import { PRISMA_SCHEMA } from './fixtures/prisma';

interface ComparableField {
  name: string;
  kind: string;
  enumValues: readonly string[] | undefined;
  optional: boolean;
  column: string;
}

interface ComparableModel {
  key: string;
  fields: ComparableField[];
  relations: { name: string; target: string; fkField: string }[];
}

const byName = (a: { name: string }, b: { name: string }): number => a.name.localeCompare(b.name);

/** The part of a lowering that must agree across every source. */
function adopted(ir: IRSchema): ComparableModel[] {
  return [...ir.models]
    .sort((a, b) => a.key.localeCompare(b.key))
    .map((m) => ({
      key: m.key,
      fields: [...m.fields].sort(byName).map((f) => ({
        name: f.name,
        kind: f.kind,
        // Order is meaningful for an enum, so it is compared, not sorted.
        enumValues: f.enumValues === undefined ? undefined : [...f.enumValues],
        optional: f.optional,
        column: effectiveColumn(f),
      })),
      relations: [...m.relations].sort(byName).map((r) => ({ ...r })),
    }));
}

describe('cross-source equivalence', () => {
  let prisma: IRSchema;
  let drizzle: IRSchema;

  beforeAll(async () => {
    prisma = parsePrismaSchema(PRISMA_SCHEMA);
    drizzle = await lowerDrizzleModule({ ...drizzleTables });
  });

  it('derives identical models from either source', () => {
    expect(adopted(drizzle)).toEqual(adopted(prisma));
  });

  it('declines the same tables for the same reasons', () => {
    const reasons = (ir: IRSchema): string[] => ir.skipped.map((s) => s.reason).sort();
    expect(reasons(drizzle)).toEqual(reasons(prisma));
  });

  it('compares something — the fixture has not been emptied', () => {
    // Guards the comparison itself: two empty lowerings are trivially equal,
    // so a fixture that silently stopped adopting anything would pass above.
    const shape = adopted(prisma);
    expect(shape.map((m) => m.key)).toEqual(['projects', 'tasks']);
    expect(shape.flatMap((m) => m.fields).length).toBeGreaterThan(5);
    expect(shape.flatMap((m) => m.relations)).toHaveLength(1);
  });
});
