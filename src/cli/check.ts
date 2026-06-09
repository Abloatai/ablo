/**
 * `ablo check` — does your existing database fit your schema? (read-only)
 *
 * The table-adoption front door for the optional direct Postgres connector:
 * instead of migrating (creating or altering tables on your database), Ablo checks the tables you already
 * have. This command introspects `DATABASE_URL`, compares it to
 * `defineSchema(...)`, and tells you — per declared model — whether the table is
 * adoptable, naming the exact gap if not. It never writes or alters anything.
 *
 * A table is adoptable when it has a primary key `id` and (for org-scoped
 * models) the `organization_id` tenancy column the engine isolates on — the same
 * rule the server's introspection path enforces. Every other table in your
 * database is ignored.
 */

import { AbloValidationError } from '../errors.js';
import pc from 'picocolors';
import postgres from 'postgres';
import { serializeSchema, resolveTenancy, tenancyColumn, type SchemaJSON } from '@abloatai/ablo/schema';
import { loadSchema } from './push';
import { brand } from './theme';

const DEFAULT_SCHEMA_PATH = 'ablo/schema.ts';
const DEFAULT_EXPORT = 'schema';

/** Columns the engine provisions/owns; never expected to be a declared field. */
const BASE_COLUMNS = new Set(['id', 'organization_id', 'created_by', 'created_at', 'updated_at']);

/** Mirror of the engine's field→column rule (ddl.ts `camelToSnake`). */
function camelToSnake(identifier: string): string {
  return identifier.replace(/[A-Z]/g, (ch) => `_${ch.toLowerCase()}`);
}

interface CheckArgs {
  schemaPath: string;
  exportName: string;
  appSchema: string;
}

export function parseCheckArgs(argv: readonly string[]): CheckArgs {
  let schemaPath = DEFAULT_SCHEMA_PATH;
  let exportName = DEFAULT_EXPORT;
  let appSchema = 'public';
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--schema':
        schemaPath = argv[++i] ?? schemaPath;
        break;
      case '--export':
        exportName = argv[++i] ?? exportName;
        break;
      case '--app-schema':
        appSchema = argv[++i] ?? appSchema;
        break;
      default:
        throw new AbloValidationError(`unknown flag: ${arg}`, { code: 'cli_invalid_arguments' });
    }
  }
  return { schemaPath, exportName, appSchema };
}

interface ColumnRow {
  table_name: string;
  column_name: string;
}

export async function check(argv: readonly string[]): Promise<void> {
  let args: CheckArgs;
  try {
    args = parseCheckArgs(argv);
  } catch (err) {
    console.error(pc.red(`  ${err instanceof Error ? err.message : String(err)}`));
    process.exit(1);
  }

  const dbUrl = process.env.DATABASE_URL ?? process.env.ABLO_DATABASE_URL;
  if (!dbUrl) {
    console.error(
      pc.red(`  No database.`) + pc.dim(` Set ${pc.bold('DATABASE_URL')} to the Postgres you want Ablo to adopt.`),
    );
    process.exit(1);
  }

  const schema = await loadSchema(args.schemaPath, args.exportName);
  const schemaJson = JSON.parse(serializeSchema(schema)) as SchemaJSON;

  // Introspect: every column in the target schema. Read-only.
  const sql = postgres(dbUrl, { max: 1, prepare: false, onnotice: () => {} });
  let rows: ColumnRow[];
  try {
    rows = (await sql.unsafe(
      `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = $1`,
      [args.appSchema] as never[],
    )) as unknown as ColumnRow[];
  } catch (err) {
    console.error(pc.red(`  Couldn't read the database: ${err instanceof Error ? err.message : String(err)}`));
    await sql.end({ timeout: 2 });
    process.exit(1);
  }
  await sql.end({ timeout: 2 });

  const colsByTable = new Map<string, Set<string>>();
  for (const r of rows) {
    let set = colsByTable.get(r.table_name);
    if (!set) {
      set = new Set<string>();
      colsByTable.set(r.table_name, set);
    }
    set.add(r.column_name);
  }

  console.log(`\n  ${brand('ablo')} ${pc.dim('check')}  ${pc.dim(`schema "${args.appSchema}"`)}\n`);

  const declaredTables = new Set<string>();
  let errors = 0;
  let warnings = 0;

  for (const [key, model] of Object.entries(schemaJson.models)) {
    const table = model.tableName ?? key;
    declaredTables.add(table);
    const present = colsByTable.get(table);

    if (!present) {
      console.log(`  ${pc.red('✗')} ${pc.bold(key)} ${pc.dim('→')} table ${pc.bold(table)} ${pc.red('not found')}`);
      errors++;
      continue;
    }

    const problems: string[] = [];
    const warns: string[] = [];

    if (!present.has('id')) problems.push('missing primary key "id"');

    // The tenancy column this model is isolated on (configurable; null for
    // parent-scoped / global models).
    const orgCol = tenancyColumn(resolveTenancy(model));
    if (orgCol && !present.has(orgCol)) {
      problems.push(
        `missing "${orgCol}" — Ablo isolates tenants (RLS) and routes realtime by it, ` +
          'so a table without it has no safe boundary. Add the column, or use a Data Source endpoint.',
      );
    }

    for (const col of ['created_by', 'created_at', 'updated_at']) {
      if (!present.has(col)) warns.push(`no "${col}" (audit/ordering will degrade)`);
    }

    for (const [fieldName, meta] of Object.entries(model.fields)) {
      const col = meta.column ?? camelToSnake(fieldName);
      if (BASE_COLUMNS.has(col) || col === orgCol) continue;
      if (!present.has(col)) problems.push(`missing column "${col}" (field ${fieldName})`);
    }

    if (problems.length > 0) {
      console.log(`  ${pc.red('✗')} ${pc.bold(key)} ${pc.dim('→')} ${table}`);
      for (const p of problems) console.log(`      ${pc.red('•')} ${p}`);
      for (const w of warns) console.log(`      ${pc.yellow('•')} ${w}`);
      errors++;
    } else if (warns.length > 0) {
      console.log(`  ${pc.yellow('!')} ${pc.bold(key)} ${pc.dim('→')} ${table}`);
      for (const w of warns) console.log(`      ${pc.yellow('•')} ${w}`);
      warnings++;
    } else {
      console.log(`  ${pc.green('✓')} ${pc.bold(key)} ${pc.dim(`→ ${table} (id, ${orgCol ?? 'no org'} ok)`)}`);
    }
  }

  const modelCount = Object.keys(schemaJson.models).length;
  const ignored = [...colsByTable.keys()].filter((t) => !declaredTables.has(t)).length;

  console.log(
    `\n  ${modelCount} model${modelCount === 1 ? '' : 's'} · ${pc.green(`${modelCount - errors - warnings} ok`)}` +
      (warnings ? ` · ${pc.yellow(`${warnings} warning${warnings === 1 ? '' : 's'}`)}` : '') +
      (errors ? ` · ${pc.red(`${errors} error${errors === 1 ? '' : 's'}`)}` : ''),
  );
  if (ignored > 0) {
    console.log(`  ${pc.dim(`${ignored} other table${ignored === 1 ? '' : 's'} in your database — ignored by Ablo`)}`);
  }
  console.log();

  process.exit(errors > 0 ? 1 : 0);
}
