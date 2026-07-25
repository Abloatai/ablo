/**
 * The shared fixture schema, expressed as Prisma source.
 *
 * This file and `drizzle.ts` describe THE SAME LOGICAL SCHEMA. That
 * is a contract, not a coincidence: `equivalence.test.ts` lowers both and
 * asserts the adopted models are identical, so the pair cannot drift apart
 * without a test failing.
 *
 * Editing one means editing the other. The schema covers, deliberately:
 *
 *   - a model adopted because it is tenant-scoped (`tasks`), and one adopted
 *     as a relation target (`projects`)
 *   - a model skipped because it has no tenancy column (`settings`)
 *   - every field kind the IR can carry: string, number, boolean, date, json, enum
 *   - a lossy lowering (a scalar list, which has no engine type) that must
 *     carry a reviewer note
 *   - a physical column that does NOT round-trip through the engine's own
 *     field→column derivation (`deadline` → `due_at`), so `.from()` is required
 *   - a foreign key that lowers to a single `belongsTo`
 *   - the engine-owned base columns, which must never surface as declared fields
 *
 * Types the two sources disagree on are deliberately absent — they are pinned
 * with their reasons in `divergence.test.ts` instead.
 */

export const PRISMA_SCHEMA = `
datasource db {
  provider = "postgresql"
}

generator client {
  provider = "prisma-client-js"
}

enum Status {
  todo
  doing
  done
}

model Task {
  id             String    @id
  title          String
  status         Status?
  priority       Int?
  counter        BigInt?
  done           Boolean?
  meta           Json?
  labels         String[]
  deadline       DateTime? @map("due_at")
  projectId      String?
  project        Project?  @relation(fields: [projectId], references: [id])
  organizationId String
  createdBy      String
  createdAt      DateTime
  updatedAt      DateTime

  @@map("tasks")
}

model Project {
  id             String @id
  name           String
  organizationId String

  @@map("projects")
}

model Settings {
  id    String @id
  theme String

  @@map("settings")
}
`;
