/**
 * Shared schema for the Data Source example.
 *
 * The schema is the contract between three sides:
 *
 *   1. The application UI — `ablo.tasks.update(...)`.
 *   2. The Ablo Cloud — translates writes into signed POSTs.
 *   3. The customer's Data Source endpoint — applies them to its own
 *      database.
 *
 * All three import the SAME schema file. Adding a column on either
 * side without the other is a compile error.
 */

import { defineSchema, model, z } from '@abloatai/ablo/schema';

export const schema = defineSchema({
  tasks: model({
    title: z.string(),
    status: z.enum(['todo', 'doing', 'done']),
    assignee: z.string().optional(),
  }),
});

export type Schema = typeof schema;
