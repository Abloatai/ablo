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
 *
 * The column being PRESENT is not the whole question. Ablo stamps the tenancy
 * value on writes it makes; a seed, a migration, or a backfill that inserts
 * straight into Postgres does not, and a row without it can never be routed to
 * anyone — it lands, it is queryable in Postgres, and it is invisible to the
 * sync layer forever. So this counts them too. A report that reads "23 models,
 * 23 ok" over a table full of unstamped rows is the shape of that failure.
 */

import { AbloValidationError } from '@abloatai/transaction/errors';
import pc from 'picocolors';
import postgres from 'postgres';
import { serializeSchema, resolveTenancy, tenancyColumn, type SchemaJSON } from '@abloatai/transaction/schema';
import { loadSchema } from './push';
import { camelToSnake } from './schemaIr';
import { BASE_COLUMNS } from './schemaSource';
import { brand } from './theme';
import { ADMIN_URL_VAR, readProjectAdminDatabaseUrl } from './dbRole';
import { resolveRuntimeApiKey } from './config';
import { fetchDataSourceState } from './readiness';
import { apiBaseUrl } from './controlPlane';

const DEFAULT_SCHEMA_PATH = 'ablo/schema.ts';
const DEFAULT_EXPORT = 'schema';

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

/** Postgres identifier quoting, for the introspected names below. */
function quoteIdent(raw: string): string {
  return `"${raw.replace(/"/g, '""')}"`;
}

/**
 * The count is capped on purpose: `count(*)` over a large table with no index on
 * the tenancy column is a sequential scan, and this command must stay cheap
 * enough to run on a whim. The answer that matters is "any?", and past the cap
 * the exact number changes nothing about what to do next.
 */
const UNSTAMPED_CAP = 500;

/**
 * How many rows carry no tenancy value, up to {@link UNSTAMPED_CAP} + 1.
 *
 * Null on any failure. This runs beside an adoption report that is already
 * useful; a permission that blocks the count should subtract a line from it,
 * never fail the command.
 */
async function countUnstamped(
  sql: postgres.Sql,
  appSchema: string,
  table: string,
  column: string,
): Promise<number | null> {
  try {
    const rows = await sql.unsafe<{ n: number }[]>(
      `SELECT count(*)::int AS n FROM (
         SELECT 1 FROM ${quoteIdent(appSchema)}.${quoteIdent(table)}
         WHERE ${quoteIdent(column)} IS NULL
         LIMIT ${UNSTAMPED_CAP + 1}
       ) s`,
    );
    return rows[0]?.n ?? 0;
  } catch {
    return null;
  }
}

/** The host a connection string addresses, for comparing against the plane's. */
function hostOf(connectionString: string): string | null {
  try {
    return new URL(connectionString).hostname || null;
  } catch {
    return null;
  }
}

/**
 * Name the database this command is describing, and say whether Ablo reads it.
 *
 * `check` introspects whatever `DATABASE_URL` addresses. The engine reads the
 * plane's registered data source. When those are not the same database, every
 * line below is true of a database Ablo never touches — which reads as "your
 * schema is fine" while every commit is refused for a model whose table the
 * engine cannot see. Both facts are already available; only the crossing was
 * missing.
 *
 * Best-effort, like the rest of the readiness surface: no key or no answer
 * reports as unknown, never as agreement.
 */
async function reportReadSubject(dbUrl: string): Promise<void> {
  const host = hostOf(dbUrl);
  console.log(`  ${pc.dim('reading')} ${pc.bold(host ?? 'your database')}`);

  const runtimeKey = resolveRuntimeApiKey();
  const state = await fetchDataSourceState(apiBaseUrl(), runtimeKey.key);

  if (state.kind === 'unknown') {
    console.log(
      `  ${pc.dim('ablo')}    ${pc.yellow('?')} ${pc.dim(`couldn't ask which database Ablo reads (${state.detail})`)}\n`,
    );
    return;
  }
  if (state.kind === 'none') {
    console.log(
      `  ${pc.dim('ablo')}    ${pc.yellow('!')} this branch is not connected to a database, so Ablo does not read this one`,
    );
    console.log(
      `           ${pc.dim(`Connect it with ${pc.bold('ablo connect apply')}. Until then a table here is invisible to the engine.`)}\n`,
    );
    return;
  }
  const registered = [...new Set(state.hosts)];
  if (host && registered.length > 0 && !registered.includes(host)) {
    console.log(
      `  ${pc.dim('ablo')}    ${pc.yellow('!')} Ablo reads ${pc.bold(registered.join(', '))}`,
    );
    console.log(
      `           ${pc.dim('If that is this database under a pooled hostname, this is fine — otherwise the report below describes a database Ablo never reads.')}\n`,
    );
    return;
  }
  console.log(`  ${pc.dim('ablo')}    ${pc.green('✓')} ${pc.dim('reads this database')}\n`);
}

export async function check(argv: readonly string[]): Promise<void> {
  let args: CheckArgs;
  try {
    args = parseCheckArgs(argv);
  } catch (err) {
    console.error(pc.red(`  ${err instanceof Error ? err.message : String(err)}`));
    process.exit(1);
  }

  const dbUrl = readProjectAdminDatabaseUrl();
  if (!dbUrl) {
    console.error(
      pc.red(`  No database.`) +
        pc.dim(` Set ${pc.bold(ADMIN_URL_VAR)} to the Postgres you want Ablo to adopt.`),
    );
    process.exit(1);
  }

  const schema = await loadSchema(args.schemaPath, args.exportName);
  const schemaJson = JSON.parse(serializeSchema(schema)) as SchemaJSON;

  // Name the subject BEFORE connecting. A database that cannot be reached is
  // exactly when "which database is this, and does Ablo read it?" matters most:
  // reported afterwards, an unreachable host prints a driver error and nothing
  // else, and the reader cannot tell whether the host was even the right one.
  console.log(`\n  ${brand('ablo')} ${pc.dim('check')}  ${pc.dim(`schema "${args.appSchema}"`)}\n`);
  await reportReadSubject(dbUrl);

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

  const colsByTable = new Map<string, Set<string>>();
  for (const r of rows) {
    let set = colsByTable.get(r.table_name);
    if (!set) {
      set = new Set<string>();
      colsByTable.set(r.table_name, set);
    }
    set.add(r.column_name);
  }

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

    // Rows the column cannot isolate. An error, not a warning: these rows are
    // already in the table, already invisible, and a yellow line in a list of
    // twenty models is what let them stay that way.
    if (orgCol && present.has(orgCol)) {
      const unstamped = await countUnstamped(sql, args.appSchema, table, orgCol);
      if (unstamped !== null && unstamped > 0) {
        const count =
          unstamped > UNSTAMPED_CAP ? `${UNSTAMPED_CAP}+ rows` : `${unstamped} row${unstamped === 1 ? '' : 's'}`;
        problems.push(
          `${count} have no "${orgCol}", so nothing can route them. Ablo stamps it on writes it makes; ` +
            'an insert straight into Postgres does not. Backfill the value, then run `ablo connect resnapshot`.',
        );
      }
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

  await sql.end({ timeout: 2 });

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
