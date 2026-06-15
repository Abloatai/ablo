/**
 * `ablo pull` — generate `defineSchema(...)` from your existing database.
 *
 * The inverse of `migrate`, and the read-only counterpart to `check`: instead of
 * hand-writing the schema, introspect the tables you already have and emit a
 * starting-point `ablo/schema.ts`. Like `prisma db pull` / `drizzle-kit pull`.
 *
 * Non-infringing: it only READS the database (`information_schema`) and writes a
 * local file. It never alters the database, and won't overwrite an existing
 * schema file without `--force`.
 *
 * Introspection is lossy (same as Prisma's): enum members, JSON shape,
 * relations, and defaults can't be recovered from columns alone — so the output
 * is a starting point to refine, then confirm with `ablo check`.
 */

import { AbloValidationError } from '../errors.js';
import pc from 'picocolors';
import postgres from 'postgres';
import { existsSync, writeFileSync } from 'fs';
import { brand } from './theme';

const DEFAULT_OUT = 'ablo/schema.ts';
const DEFAULT_IMPORT = '@abloatai/ablo/schema';
const TENANCY_COLUMN = 'organization_id';
/** Engine-owned columns — implicit, never emitted as declared fields. */
const BASE_COLUMNS = new Set(['id', 'organization_id', 'created_by', 'created_at', 'updated_at']);

interface PullArgs {
  out: string;
  appSchema: string;
  importPath: string;
  force: boolean;
}

export function parsePullArgs(argv: readonly string[]): PullArgs {
  let out = DEFAULT_OUT;
  let appSchema = 'public';
  let importPath = DEFAULT_IMPORT;
  let force = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--out':
        out = argv[++i] ?? out;
        break;
      case '--app-schema':
        appSchema = argv[++i] ?? appSchema;
        break;
      case '--import':
        importPath = argv[++i] ?? importPath;
        break;
      case '--force':
        force = true;
        break;
      default:
        throw new AbloValidationError(`unknown flag: ${arg}`, { code: 'cli_invalid_arguments' });
    }
  }
  return { out, appSchema, importPath, force };
}

interface ColumnRow {
  table_name: string;
  column_name: string;
  data_type: string;
  is_nullable: string;
}

export function snakeToCamel(s: string): string {
  return s.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

export function camelToSnake(s: string): string {
  return s.replace(/[A-Z]/g, (ch) => `_${ch.toLowerCase()}`);
}

/** Reverse of the engine's Zod→Postgres map. Lossy: enums/relations/JSON shape
 *  can't be recovered, so this picks the safe supertype. */
export function zodForPgType(dataType: string): { expr: string; note?: string } {
  const t = dataType.toLowerCase();
  if (['text', 'character varying', 'varchar', 'character', 'char', 'citext', 'uuid', 'name'].includes(t)) {
    return { expr: 'z.string()' };
  }
  if (['integer', 'bigint', 'smallint', 'numeric', 'double precision', 'real', 'decimal'].includes(t)) {
    return { expr: 'z.number()' };
  }
  if (t === 'boolean') return { expr: 'z.boolean()' };
  if (t.startsWith('timestamp') || t === 'date' || t.startsWith('time')) return { expr: 'z.date()' };
  if (t === 'jsonb' || t === 'json') return { expr: 'z.record(z.string(), z.unknown())' };
  if (t === 'array' || t.endsWith('[]')) return { expr: 'z.array(z.unknown())' };
  return { expr: 'z.string()', note: dataType }; // fallback — flag for review
}

function isIdentifier(s: string): boolean {
  return /^[a-z][a-z0-9_]*$/.test(s);
}

export interface PulledSchema {
  source: string;
  models: string[];
  skipped: number;
}

/**
 * Introspect the database and build the `defineSchema(...)` source. Read-only;
 * adopts only tables that clear the contract (`id` + `organization_id`).
 */
export async function buildSchemaSourceFromDb(opts: {
  dbUrl: string;
  appSchema: string;
  importPath: string;
}): Promise<PulledSchema> {
  const sql = postgres(opts.dbUrl, { max: 1, prepare: false, onnotice: () => {} });
  let rows: ColumnRow[];
  try {
    rows = (await sql.unsafe(
      `SELECT table_name, column_name, data_type, is_nullable
         FROM information_schema.columns
        WHERE table_schema = $1
        ORDER BY table_name, ordinal_position`,
      [opts.appSchema] as never[],
    )) as unknown as ColumnRow[];
  } finally {
    await sql.end({ timeout: 2 });
  }

  const byTable = new Map<string, ColumnRow[]>();
  for (const r of rows) {
    const list = byTable.get(r.table_name) ?? [];
    list.push(r);
    byTable.set(r.table_name, list);
  }

  const models: string[] = [];
  let skipped = 0;
  const lines: string[] = [
    `import { defineSchema, model, z } from '${opts.importPath}';`,
    '',
    'export const schema = defineSchema({',
  ];

  for (const [table, cols] of [...byTable.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const names = new Set(cols.map((c) => c.column_name));
    // Only tables that clear the adopt contract become models.
    if (!names.has('id') || !names.has(TENANCY_COLUMN)) {
      skipped++;
      continue;
    }
    models.push(table);
    const key = isIdentifier(table) ? table : `'${table}'`;
    lines.push(`  ${key}: model({`);
    for (const col of cols) {
      if (BASE_COLUMNS.has(col.column_name)) continue;
      // Prefer a camelCase field name, but only when it maps back to the EXACT
      // column (the engine derives the column via `camelToSnake(field)`). When it
      // wouldn't round-trip (e.g. `step_2` → `step2` → `step2`), keep the raw
      // column name so the mapping is 1:1 — Prisma's `@map` claim, the exact
      // column, never an approximation.
      const camel = snakeToCamel(col.column_name);
      const fieldName = camelToSnake(camel) === col.column_name ? camel : col.column_name;
      const key = /^[a-z_][a-z0-9_]*$/i.test(fieldName) ? fieldName : `'${fieldName}'`;
      const { expr, note } = zodForPgType(col.data_type);
      const zod = col.is_nullable === 'YES' ? `${expr}.optional()` : expr;
      const review = note ? ` // review: was ${note} (verify type)` : '';
      lines.push(`    ${key}: ${zod},${review}`);
    }
    lines.push('  }),');
  }

  lines.push('});', '');
  return { source: lines.join('\n'), models, skipped };
}

export async function pull(argv: readonly string[]): Promise<void> {
  let args: PullArgs;
  try {
    args = parsePullArgs(argv);
  } catch (err) {
    console.error(pc.red(`  ${err instanceof Error ? err.message : String(err)}`));
    process.exit(1);
  }

  const dbUrl = process.env.DATABASE_URL ?? process.env.ABLO_DATABASE_URL;
  if (!dbUrl) {
    console.error(pc.red(`  No database.`) + pc.dim(` Set ${pc.bold('DATABASE_URL')} to the Postgres to pull from.`));
    process.exit(1);
  }

  if (existsSync(args.out) && !args.force) {
    console.error(
      pc.red(`  ${args.out} already exists.`) + pc.dim(` Re-run with ${pc.bold('--force')} to overwrite.`),
    );
    process.exit(1);
  }

  console.log(`\n  ${brand('ablo')} ${pc.dim('pull')}  ${pc.dim(`schema "${args.appSchema}"`)}\n`);

  let result: PulledSchema;
  try {
    result = await buildSchemaSourceFromDb({ dbUrl, appSchema: args.appSchema, importPath: args.importPath });
  } catch (err) {
    console.error(pc.red(`  Couldn't read the database: ${err instanceof Error ? err.message : String(err)}`));
    process.exit(1);
  }

  if (result.models.length === 0) {
    console.error(
      pc.yellow(`  No adoptable tables found`) +
        pc.dim(` (a model needs an ${pc.bold('id')} + ${pc.bold('organization_id')} column).`),
    );
    process.exit(1);
  }

  writeFileSync(args.out, result.source);
  console.log(`  ${pc.green('✓')} wrote ${pc.bold(args.out)} ${pc.dim(`(${result.models.length} models)`)}`);
  console.log(`  ${pc.dim(`models: ${result.models.join(', ')}`)}`);
  if (result.skipped > 0) {
    console.log(`  ${pc.dim(`${result.skipped} table(s) skipped — no id/organization_id`)}`);
  }
  console.log(
    `\n  ${pc.dim('Introspection is lossy (enums, JSON shape, relations). Review the file, then')} ${pc.bold('ablo check')}.\n`,
  );
}
