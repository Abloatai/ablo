/**
 * The shared fixture schema, as `information_schema` reports it.
 *
 * The third expression of the schema in `prisma.ts` and `drizzle.ts` — the same
 * tables, seen through the only thing a live database can tell us about them.
 *
 * It is deliberately NOT held to cross-source equivalence, because this source
 * genuinely knows less. By the time a schema reaches Postgres an enum is a
 * `USER-DEFINED` type name with its members gone, a relation is a constraint
 * rather than anything the column carries, and the field name the ORM used was
 * never stored at all — so `due_at` can only come back as `dueAt`, never as the
 * `deadline` the ORM sources declare. Those are the documented ceilings of this
 * path, and `db.test.ts` states which suites they cost.
 *
 * `step_2` is here on purpose: it is the column whose camelCase form does not
 * map back to it, so the field has to keep the raw name.
 */

import type { ColumnRow } from '../../../pull';

const col = (table: string, column: string, type: string, nullable = true): ColumnRow => ({
  table_name: table,
  column_name: column,
  data_type: type,
  is_nullable: nullable ? 'YES' : 'NO',
});

export const COLUMN_ROWS: readonly ColumnRow[] = [
  col('records', 'id', 'text', false),
  col('records', 'title', 'text', false),
  col('records', 'status', 'USER-DEFINED'),
  col('records', 'priority', 'integer'),
  col('records', 'counter', 'bigint'),
  col('records', 'done', 'boolean'),
  col('records', 'meta', 'jsonb'),
  col('records', 'labels', 'ARRAY', false),
  col('records', 'due_at', 'timestamp without time zone'),
  col('records', 'step_2', 'text'),
  col('records', 'workspace_id', 'text'),
  col('records', 'organization_id', 'text', false),
  col('records', 'created_by', 'text', false),
  col('records', 'created_at', 'timestamp without time zone', false),
  col('records', 'updated_at', 'timestamp without time zone', false),

  col('workspaces', 'id', 'text', false),
  col('workspaces', 'name', 'text', false),
  col('workspaces', 'organization_id', 'text', false),

  // Not tenant-scoped — must be declined.
  col('settings', 'id', 'text', false),
  col('settings', 'theme', 'text', false),
];
