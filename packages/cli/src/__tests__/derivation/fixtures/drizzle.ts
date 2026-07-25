/**
 * The shared fixture schema, expressed as a Drizzle module.
 *
 * The Drizzle half of the pair described in `prisma.ts`. Both files
 * describe THE SAME LOGICAL SCHEMA, and `equivalence.test.ts` enforces it by
 * lowering both and comparing the adopted models. Edit one, edit the other.
 *
 * Two pairings that look arbitrary and are not:
 *
 *   - `labels` is `.notNull()` because Prisma has no optional list — `String[]?`
 *     is not expressible — so a required array is the only shape both sources
 *     can state.
 *   - `deadline` is keyed `deadline` but named `due_at`, matching the Prisma
 *     `@map`, so both sources exercise a column that does not round-trip
 *     through the engine's field→column derivation.
 */

import { pgTable, pgEnum, text, integer, bigint, boolean, timestamp, jsonb } from 'drizzle-orm/pg-core';

export const status = pgEnum('status', ['todo', 'doing', 'done']);

export const projects = pgTable('projects', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  organizationId: text('organization_id').notNull(),
});

export const tasks = pgTable('tasks', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  status: status('status'),
  priority: integer('priority'),
  counter: bigint('counter', { mode: 'bigint' }),
  done: boolean('done'),
  meta: jsonb('meta'),
  labels: text('labels').array().notNull(),
  deadline: timestamp('due_at'),
  projectId: text('project_id').references(() => projects.id),
  organizationId: text('organization_id').notNull(),
  createdBy: text('created_by').notNull(),
  createdAt: timestamp('created_at').notNull(),
  updatedAt: timestamp('updated_at').notNull(),
});

/** Not tenant-scoped — must be skipped by the adopt contract. */
export const settings = pgTable('settings', {
  id: text('id').primaryKey(),
  theme: text('theme').notNull(),
});
