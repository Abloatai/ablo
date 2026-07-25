/**
 * Where the sources genuinely disagree — pinned so a change is visible, not
 * endorsed.
 *
 * The shared fixture covers only what the sources agree on, which would
 * leave the disagreements untested and therefore free to multiply. Each case
 * below is a column a customer can plausibly write, lowered to a different
 * field kind depending on which ORM declared it. Pinning them means a new
 * divergence fails a test instead of shipping quietly, and means closing one is
 * a deliberate edit here rather than a silent behaviour change.
 *
 * None of these is settled. They are the open list for the derivation work in
 * `docs/plans/schema-derivation-seam.md`.
 */

import { bigint, numeric, pgTable, text } from 'drizzle-orm/pg-core';
import { lowerDrizzleModule } from '../../drizzlePull';
import { parsePrismaSchema } from '../../prismaPull';
import type { IRField, IRSchema } from '../../schemaIr';

const DIVERGENT_PRISMA = `
datasource db {
  provider = "postgresql"
}

model Reading {
  id             String   @id
  amount         Decimal?
  counter        BigInt?
  organizationId String

  @@map("readings")
}

model Settings {
  id    String @id
  theme String

  @@map("settings")
}
`;

const readings = pgTable('readings', {
  id: text('id').primaryKey(),
  amount: numeric('amount'),
  counter: bigint('counter', { mode: 'bigint' }),
  organizationId: text('organization_id').notNull(),
});

const settings = pgTable('settings', {
  id: text('id').primaryKey(),
  theme: text('theme').notNull(),
});

function fieldOf(ir: IRSchema, model: string, name: string): IRField {
  const found = ir.models.find((m) => m.key === model)?.fields.find((f) => f.name === name);
  if (found === undefined) throw new Error(`no field ${model}.${name}`);
  return found;
}

describe('known divergences between pull sources', () => {
  let prisma: IRSchema;
  let drizzle: IRSchema;

  beforeAll(async () => {
    prisma = parsePrismaSchema(DIVERGENT_PRISMA);
    drizzle = await lowerDrizzleModule({ readings, settings });
  });

  describe('a fixed-precision decimal', () => {
    // Prisma models it as a numeric type; Drizzle hands back a string, because
    // that is how the value arrives in JavaScript with its precision intact.
    // Both readings are defensible and they disagree, so the same column
    // becomes a different field depending on where it was declared.
    it('is a number from Prisma and a string from Drizzle', () => {
      expect(fieldOf(prisma, 'readings', 'amount').kind).toBe('number');
      expect(fieldOf(drizzle, 'readings', 'amount').kind).toBe('string');
    });

    it('warns about the lost precision only on the Prisma side', () => {
      expect(fieldOf(prisma, 'readings', 'amount').note).toMatch(/precision/i);
      expect(fieldOf(drizzle, 'readings', 'amount').note).toBeUndefined();
    });
  });

  describe('a 64-bit integer', () => {
    // Both sources narrow it to a number, so it lives in the shared fixture
    // rather than here. What they also share is silence: the narrowing loses
    // range above 2^53 and neither side attaches a reviewer note, while a
    // decimal — lossy in the same way — gets one. Pinned here because the
    // agreement is what makes it easy to miss.
    it('is a number from both, and neither warns', () => {
      expect(fieldOf(prisma, 'readings', 'counter').kind).toBe('number');
      expect(fieldOf(drizzle, 'readings', 'counter').kind).toBe('number');
      expect(fieldOf(prisma, 'readings', 'counter').note).toBeUndefined();
      expect(fieldOf(drizzle, 'readings', 'counter').note).toBeUndefined();
    });
  });

  describe('a declined table', () => {
    // Each source names the thing the customer would search for in their own
    // file: a Prisma model has a name distinct from its mapped table, and a
    // Drizzle table has only the table name. The reasons match; the labels
    // cannot, which is why `equivalence.test.ts` compares reasons alone.
    it('is named by model on the Prisma side and by table on the Drizzle side', () => {
      expect(prisma.skipped.map((s) => s.name)).toEqual(['Settings']);
      expect(drizzle.skipped.map((s) => s.name)).toEqual(['settings']);
    });

    it('gives the same reason either way', () => {
      expect(drizzle.skipped[0]?.reason).toBe(prisma.skipped[0]?.reason);
    });
  });
});
