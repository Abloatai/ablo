/**
 * `ablo pull` generates a `defineSchema(...)` starting point from your existing
 * database.
 *
 * It is the inverse of `ablo migrate` and the read-only counterpart to `ablo
 * check`: rather than hand-writing the schema, it introspects the tables you
 * already have and writes a first draft to `ablo/schema.ts`. This mirrors the
 * `db pull` step familiar from other ORMs.
 *
 * The command only reads the database, through `information_schema`, and writes
 * a local file. It never alters the database, and it won't overwrite an existing
 * schema file unless you pass `--force`.
 *
 * Introspection is lossy: enum members, JSON shape, relations, and defaults
 * can't be recovered from columns alone. Treat the output as a draft to refine,
 * then confirm it with `ablo check`.
 */

import { AbloValidationError } from '@ablo/transaction/errors';
import pc from 'picocolors';
import postgres from 'postgres';
import { existsSync, writeFileSync } from 'fs';
import { brand } from './theme';
import { ADMIN_URL_VAR, readProjectAdminDatabaseUrl } from './dbRole';
import { emitSchemaSource, type IRFieldKind, type IRSchema } from './schemaIr';
import { adoptReflection, fieldNameForColumn, type ReflectedTable } from './schemaSource';

const DEFAULT_OUT = 'ablo/schema.ts';
const DEFAULT_IMPORT = '@abloatai/ablo/schema';

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

/** One row of `information_schema.columns` — the whole of what this source
 *  gets to see, which is why enums and relations cannot survive it. */
export interface ColumnRow {
  table_name: string;
  column_name: string;
  data_type: string;
  is_nullable: string;
}

/** A Postgres column type as `information_schema` reports it, mapped to a field
 *  kind. Lossy by nature: enums, JSON shape, and relations are gone by the time
 *  a schema reaches the database, so this picks the safe supertype. */
export function pgTypeToKind(dataType: string): { kind: IRFieldKind; note?: string } {
  const t = dataType.toLowerCase();
  if (['text', 'character varying', 'varchar', 'character', 'char', 'citext', 'uuid', 'name'].includes(t)) {
    return { kind: 'string' };
  }
  if (['integer', 'bigint', 'smallint', 'numeric', 'double precision', 'real', 'decimal'].includes(t)) {
    return { kind: 'number' };
  }
  if (t === 'boolean') return { kind: 'boolean' };
  if (t.startsWith('timestamp') || t === 'date' || t.startsWith('time')) return { kind: 'date' };
  if (t === 'jsonb' || t === 'json') return { kind: 'json' };
  if (t === 'array' || t.endsWith('[]')) return { kind: 'json', note: `${dataType} — stored as JSON` };
  return { kind: 'string', note: `was ${dataType} (verify type)` }; // fallback — flag for review
}

/**
 * Lower `information_schema` rows into the shared representation. Pure — the
 * query lives in {@link buildSchemaSourceFromDb} — so the database source runs
 * the same conformance battery as the ORM sources.
 *
 * Relations are always empty: a foreign key is a constraint the column itself
 * does not carry, which is the ceiling this path is documented to have.
 */
export function lowerColumnRows(rows: readonly ColumnRow[]): IRSchema {
  const byTable = new Map<string, ColumnRow[]>();
  for (const r of rows) {
    const list = byTable.get(r.table_name) ?? [];
    list.push(r);
    byTable.set(r.table_name, list);
  }

  const tables: ReflectedTable[] = [...byTable.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([table, cols]) => ({
      table,
      label: table,
      relations: [],
      columns: cols.map((col) => {
        const { kind, note } = pgTypeToKind(col.data_type);
        return {
          field: fieldNameForColumn(col.column_name),
          column: col.column_name,
          kind,
          optional: col.is_nullable === 'YES',
          note,
        };
      }),
    }));

  return adoptReflection(tables);
}

export interface PulledSchema {
  source: string;
  models: string[];
  skipped: IRSchema['skipped'];
}

/**
 * Introspects the database and builds the `defineSchema(...)` source. Reads
 * only; adopts a table only when it has both an `id` and an `organization_id`
 * column.
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

  const ir = lowerColumnRows(rows);
  return {
    source: emitSchemaSource(ir, opts.importPath),
    models: ir.models.map((m) => m.key),
    skipped: ir.skipped,
  };
}

export async function pull(argv: readonly string[]): Promise<void> {
  let args: PullArgs;
  try {
    args = parsePullArgs(argv);
  } catch (err) {
    console.error(pc.red(`  ${err instanceof Error ? err.message : String(err)}`));
    process.exit(1);
  }

  const dbUrl = readProjectAdminDatabaseUrl();
  if (!dbUrl) {
    console.error(
      pc.red(`  No database.`) + pc.dim(` Set ${pc.bold(ADMIN_URL_VAR)} to the Postgres to pull from.`),
    );
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
  if (result.skipped.length > 0) {
    console.log(`  ${pc.dim(`${result.skipped.length} table(s) skipped:`)}`);
    for (const s of result.skipped) console.log(`    ${pc.dim(`- ${s.name}: ${s.reason}`)}`);
  }
  console.log(
    `\n  ${pc.dim('Introspection is lossy (enums, JSON shape, relations). Review the file, then')} ${pc.bold('ablo check')}.\n`,
  );
}
