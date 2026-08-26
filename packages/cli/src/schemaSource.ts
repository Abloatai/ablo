/**
 * What a schema source reflects, and the one policy that turns a reflection
 * into the intermediate representation.
 *
 * A source's job is narrow: read its own world — a Prisma file, a Drizzle
 * module, `information_schema` — and describe the tables it found in the terms
 * below. It decides nothing about what Ablo does with them.
 *
 * Everything that is Ablo's policy rather than the source's fact lives here and
 * is stated once: which tables become models, which columns the engine owns and
 * so never declares, and how a column that was never given a field name gets
 * one. Before this module each source carried its own copy of all three, which
 * is why they had drifted — two spellings of the skip reason, and two
 * definitions of the identifier rule that disagreed about capitals.
 *
 * Adding a source means writing a reflector and a type map. It does not mean
 * restating the adopt rule, and it never means writing a second emitter.
 */

import { BASE_FIELDS as ENGINE_BASE_FIELDS } from '@abloatai/transaction/schema';
import type { IRField, IRFieldKind, IRModel, IRRelation, IRSchema, IRSkip } from './schemaIr';
import { camelToSnake } from './schemaIr';

/** The tenancy column a table must carry to be reachable per-tenant. */
const TENANCY_COLUMN = 'organization_id';

/**
 * Columns the engine manages itself, matched by the name a source declares…
 *
 * Derived, not restated. This set decides which columns adoption SKIPS, so a
 * name that lingers here after the engine stops owning it does not fail
 * anything — it silently drops a real column out of the schema `ablo pull`
 * generates, and `ablo check` then never reports the field as missing. That is
 * what a hand-written copy of the 0.52.0 list did to `created_at`,
 * `updated_at` and `created_by`, which have been ordinary declarable fields
 * since that release.
 */
const BASE_FIELDS: ReadonlySet<string> = new Set<string>([
  ...ENGINE_BASE_FIELDS,
  'organizationId',
]);
/**
 * …and by the physical column, for sources that only see columns.
 *
 * Exported because `ablo check` needs the same list to know which columns it
 * should not expect a declaration for. It is one fact about the engine, so it
 * is stated once.
 */
export const BASE_COLUMNS: ReadonlySet<string> = new Set<string>([
  ...ENGINE_BASE_FIELDS.map(camelToSnake),
  TENANCY_COLUMN,
]);

/** One column, as a source found it. */
export interface ReflectedColumn {
  /** The key the schema declares. Equal to {@link column} for a source that
   *  only sees physical columns — see {@link fieldNameForColumn}. */
  readonly field: string;
  /** The physical column. Always stated, so no source has to decide whether an
   *  unremarkable column is worth recording; the emitter drops the override
   *  when the engine could have derived it. */
  readonly column: string;
  readonly kind: IRFieldKind;
  /** Members of an enum, when the source could recover them. */
  readonly enumValues?: readonly string[];
  readonly optional: boolean;
  /** A reviewer note, when the lowering lost something. */
  readonly note?: string;
  /** Set when the source knows this column is the primary key, for sources
   *  where the key is not necessarily named `id`. */
  readonly primary?: boolean;
}

/** One table, as a source found it. */
export interface ReflectedTable {
  /** The physical table name. Becomes the model key when adopted. */
  readonly table: string;
  /** What this source calls the table, used only when reporting a decline.
   *  Prisma names a model, which can differ from the table it maps to; a
   *  Drizzle module and a live database both name the table. */
  readonly label: string;
  readonly columns: readonly ReflectedColumn[];
  readonly relations: readonly IRRelation[];
}

/**
 * The field name for a column no source gave one — prefer camelCase, but keep
 * the raw column when camelCase would not map back to it.
 *
 * The engine derives a column from a field with `camelToSnake`, so a name that
 * does not survive the round trip (`step_2` → `step2` → `step2`) would point
 * the field at a column that does not exist.
 */
export function fieldNameForColumn(column: string): string {
  const camel = column.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
  return camelToSnake(camel) === column ? camel : column;
}

/**
 * Apply Ablo's adopt policy to a reflection.
 *
 * A table becomes a model only when it can be reached per-tenant: it needs a
 * primary key and a tenancy column. Anything else is declined by name, with the
 * reason, so the customer can see what was left out and why.
 */
export function adoptReflection(tables: readonly ReflectedTable[]): IRSchema {
  const models: IRModel[] = [];
  const skipped: IRSkip[] = [];

  for (const table of tables) {
    let hasKey = false;
    let hasTenancy = false;
    const fields: IRField[] = [];

    for (const col of table.columns) {
      if (col.primary === true || col.field === 'id' || col.column === 'id') hasKey = true;
      if (col.field === 'organizationId' || col.column === TENANCY_COLUMN) hasTenancy = true;
      // The engine owns these; they are implicit and never declared.
      if (BASE_FIELDS.has(col.field) || BASE_COLUMNS.has(col.column)) continue;

      fields.push({
        name: col.field,
        kind: col.kind,
        enumValues: col.enumValues,
        optional: col.optional,
        column: col.column,
        note: col.note,
      });
    }

    if (!hasKey || !hasTenancy) {
      skipped.push({
        name: table.label,
        reason: hasKey ? `no ${TENANCY_COLUMN} (not tenant-scoped)` : 'no id column',
      });
      continue;
    }

    models.push({ key: table.table, fields, relations: [...table.relations] });
  }

  return { models, skipped };
}
