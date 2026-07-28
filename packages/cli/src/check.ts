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

import { AbloValidationError } from '@abloatai/transaction/errors';
import pc from 'picocolors';
import postgres from 'postgres';
import { serializeSchema, resolveTenancy, tenancyColumn, type SchemaJSON } from '@abloatai/transaction/schema';
import { loadSchema } from './push';
import { camelToSnake } from './schemaIr';
import { BASE_COLUMNS } from './schemaSource';
import { brand } from './theme';
import { ADMIN_URL_VAR, readProjectAdminDatabaseUrl } from './dbRole';
import { resolveEffectiveApiKey } from './config';
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

  const effective = resolveEffectiveApiKey();
  const state = await fetchDataSourceState(apiBaseUrl(), effective.key);

  if (state.kind === 'unknown') {
    console.log(
      `  ${pc.dim('ablo')}    ${pc.yellow('?')} ${pc.dim(`couldn't ask which database Ablo reads (${state.detail})`)}\n`,
    );
    return;
  }
  if (state.kind === 'none') {
    console.log(
      `  ${pc.dim('ablo')}    ${pc.yellow('!')} no database is registered for this plane, so Ablo does not read this one`,
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
