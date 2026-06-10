/**
 * `ablo migrate` — create the schema's Postgres tables in your own database.
 *
 * Direct Postgres connector counterpart to `ablo push` (hosted). Both lower
 * the schema through the SAME pure engine — `generateProvisionPlan` from
 * `@abloatai/ablo/schema` — so the SQL (column types, RLS, enum checks) is
 * identical whether Ablo applies it or you do. No second type map: a Zod
 * `number` is `DOUBLE PRECISION` here exactly as on the hosted path.
 *
 * Usage:
 *   ablo migrate                       # apply to DATABASE_URL
 *   ablo migrate --dry-run             # print SQL without executing
 *   ablo migrate --output schema.sql   # write SQL to a file
 *   ablo migrate --schema path.ts --export schema
 */

import { AbloValidationError } from '../errors.js';
import pc from 'picocolors';
import { writeFileSync, existsSync, readFileSync, appendFileSync } from 'fs';
import { resolve } from 'path';
import { confirm, isCancel } from '@clack/prompts';
import postgres from 'postgres';
import { detectRoleSafety, createScopedRole, DEFAULT_SCOPED_ROLE } from './dbRole';
import { serializeSchema, generateProvisionPlan, type Schema, type SchemaJSON } from '@abloatai/ablo/schema';
import { adapterTableMigrations } from '@abloatai/ablo/source';
import { loadSchema } from './push';

export interface MigrateArgs {
  schemaPath: string;
  exportName: string;
  /** Postgres schema the tables live in. `public` for a direct connector DB. */
  targetSchema: string;
  dryRun: boolean;
  outputFile: string | null;
}

const DEFAULT_SCHEMA_PATH = 'ablo/schema.ts';
const DEFAULT_EXPORT = 'schema';

/** Parse `migrate` flags. Pure — unit-tested without touching a database. */
export function parseMigrateArgs(argv: readonly string[]): MigrateArgs {
  let schemaPath = DEFAULT_SCHEMA_PATH;
  let exportName = DEFAULT_EXPORT;
  let targetSchema = 'public';
  let dryRun = false;
  let outputFile: string | null = null;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--dry-run':
        dryRun = true;
        break;
      case '--output':
        outputFile = argv[++i] ?? null;
        break;
      case '--schema':
        schemaPath = argv[++i] ?? schemaPath;
        break;
      case '--export':
        exportName = argv[++i] ?? exportName;
        break;
      case '--app-schema':
        targetSchema = argv[++i] ?? targetSchema;
        break;
      default:
        throw new AbloValidationError(`unknown flag: ${arg}`, { code: 'cli_invalid_arguments' });
    }
  }
  return { schemaPath, exportName, targetSchema, dryRun, outputFile };
}

/** Lower a loaded schema to its table-creation SQL — pure, the shared engine. */
export function planFor(
  schema: Schema,
  targetSchema = 'public',
): { statements: readonly string[]; concurrent: readonly string[] } {
  const schemaJson = JSON.parse(serializeSchema(schema)) as SchemaJSON;
  // A customer-owned DB is provisioned into `public` (the DB itself is the
  // isolation boundary). Emit real foreign keys there for a clean relational
  // schema — mirrors the hosted server's `conn.schema == null` rule so the two
  // paths emit identical SQL for the same customer-owned database.
  const plan = generateProvisionPlan(schemaJson, targetSchema, {
    foreignKeys: targetSchema === 'public',
  });
  // Running against your own database (Data Source mode) also needs the
  // adapter-owned tables (`ablo_idempotency` + `ablo_outbox`). They're idempotent
  // (`IF NOT EXISTS`) and shipped from ONE canonical place so the adapters and
  // this command never disagree — provisioning them here means the scaffold never
  // has to ask the user to paste table-creation SQL by hand.
  const adapterTables = adapterTableMigrations().map((m) => m.up);
  return { statements: [...plan.statements, ...adapterTables], concurrent: plan.concurrent ?? [] };
}

/** A porsager/Postgres query error — the fields worth surfacing. */
interface PgError {
  code?: string;
  detail?: string;
  message?: string;
}

/** Structured `[migrate]` lifecycle logs — same shape/vocabulary as the hosted
 *  executor's `[migration]` logs (`@abloatai/ablo` server `prefixedLogger`),
 *  so a failure reads identically whether Ablo applied it or you did. */
const log = {
  info: (msg: string, fields: Record<string, unknown>) => console.log(`[migrate] ${msg}`, fields),
  warn: (msg: string, fields: Record<string, unknown>) => console.warn(pc.yellow(`[migrate] ${msg}`), fields),
  error: (msg: string, fields: Record<string, unknown>) => console.error(pc.red(`[migrate] ${msg}`), fields),
};

// Safe schema-change settings (mirror apps/sync-server/src/schema/ddlExec.ts): a low
// lock_timeout so a blocked ALTER never freezes the table behind the lock queue,
// + bounded retry on lock contention (55P03).
const PG_LOCK_NOT_AVAILABLE = '55P03';
// Configurable per deployment via `ABLO_SCHEMA_LOCK_TIMEOUT` (the older
// `ABLO_DDL_LOCK_TIMEOUT` name is still honored, so existing setups don't break).
const LOCK_TIMEOUT =
  process.env.ABLO_SCHEMA_LOCK_TIMEOUT ?? process.env.ABLO_DDL_LOCK_TIMEOUT ?? '5s';
const MAX_LOCK_ATTEMPTS = 5;

/**
 * Apply statements in one transaction under the same advisory-lock discipline
 * as the hosted executor. On failure, the transaction aborts (nothing partial
 * lands) and we report the canonical `migration_failed` shape — which statement
 * broke, its index, and the Postgres SQLSTATE.
 */
async function applyStatements(
  dbUrl: string,
  targetSchema: string,
  statements: readonly string[],
  concurrent: readonly string[] = [],
): Promise<void> {
  const sql = postgres(dbUrl, { max: 1, prepare: false, onnotice: () => {} });
  const total = statements.length;
  const startedAt = Date.now();
  log.info('applying migration plan', { targetSchema, statements: total });
  try {
    // Inside a transaction under advisory lock with a low lock_timeout + bounded retry on lock
    // contention (55P03), so a blocked ALTER never parks ACCESS EXCLUSIVE at the
    // head of the lock queue and freezes the table.
    for (let attempt = 1; ; attempt++) {
      try {
        await sql.begin(async (tx) => {
          await tx.unsafe(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT}'`);
          await tx`SELECT pg_advisory_xact_lock(hashtext(${`provision:${targetSchema}`}))`;
          for (let index = 0; index < total; index++) {
            const statement = statements[index]!;
            try {
              await tx.unsafe(statement);
            } catch (err) {
              const pg = (err ?? {}) as PgError;
              if (pg.code === PG_LOCK_NOT_AVAILABLE) throw err; // retryable — rethrow raw
              log.error('migration plan failed', {
                code: 'migration_failed',
                durationMs: Date.now() - startedAt,
                targetSchema,
                statementCount: total,
                failedStatement: statement,
                failedStatementIndex: index,
                ...(pg.code ? { pgCode: pg.code } : {}),
                ...(pg.detail ? { pgDetail: pg.detail } : {}),
              });
              throw err;
            }
          }
        });
        break;
      } catch (err) {
        const pg = (err ?? {}) as PgError;
        if (pg.code === PG_LOCK_NOT_AVAILABLE && attempt < MAX_LOCK_ATTEMPTS) {
          const backoffMs = Math.min(60_000, 10 * 2 ** attempt) + Math.floor(Math.random() * 50);
          log.warn('schema change blocked by a lock; backing off and retrying', { targetSchema, attempt, backoffMs });
          await new Promise((resolve) => setTimeout(resolve, backoffMs));
          continue;
        }
        throw err;
      }
    }
    // Post-commit, NON-transactional pass: VALIDATE + CREATE INDEX CONCURRENTLY,
    // best-effort — never aborts a completed migration (a VALIDATE that trips on a
    // live table's pre-existing rows is logged only). statement_timeout 0 so a long
    // non-blocking scan on a large direct-connector table isn't killed (max:1 → same connection).
    if (concurrent.length > 0) {
      await sql.unsafe(`SET statement_timeout = 0`);
      for (const statement of concurrent) {
        try {
          await sql.unsafe(statement);
        } catch (err) {
          const pg = (err ?? {}) as PgError;
          log.warn('post-commit schema change skipped (non-fatal)', {
            targetSchema,
            statement,
            ...(pg.code ? { pgCode: pg.code } : {}),
          });
        }
      }
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
  log.info('migration plan applied', { targetSchema, statements: total, durationMs: Date.now() - startedAt });
}

export async function migrate(argv: readonly string[]): Promise<void> {
  let args: MigrateArgs;
  try {
    args = parseMigrateArgs(argv);
  } catch (err) {
    console.error(pc.red(`  ${err instanceof Error ? err.message : String(err)}`));
    process.exit(1);
  }

  const schema = await loadSchema(args.schemaPath, args.exportName);
  const plan = planFor(schema, args.targetSchema);
  const sql = [
    ...plan.statements,
    ...(plan.concurrent.length ? ['', '-- post-commit (run each OUTSIDE a transaction):', ...plan.concurrent] : []),
  ].join('\n');
  const totalStatements = plan.statements.length + plan.concurrent.length;
  console.log(
    `  ${pc.dim('Schema')} ${pc.bold(args.schemaPath)} → ${pc.dim(`${Object.keys(schema.models).length} models, ${totalStatements} statements`)}`,
  );

  if (args.outputFile) {
    writeFileSync(args.outputFile, sql + '\n');
    console.log(`  ${pc.green('✓')} SQL written to ${pc.bold(args.outputFile)}`);
    return;
  }

  if (args.dryRun) {
    console.log('\n' + sql + '\n');
    return;
  }

  const dbUrl = process.env.DATABASE_URL ?? process.env.ABLO_DATABASE_URL;
  if (!dbUrl) {
    console.error(pc.red('  Set DATABASE_URL (or ABLO_DATABASE_URL) to apply, or use --dry-run to preview.'));
    process.exit(1);
  }

  const effectiveUrl = await ensureScopedRole(dbUrl);

  try {
    await applyStatements(effectiveUrl, args.targetSchema, plan.statements, plan.concurrent);
    console.log(`  ${pc.green('✓')} Migration complete`);
  } catch {
    process.exit(1);
  }
}

/**
 * The CLI side of the server's RLS gate. Neon/Supabase dashboard connection
 * strings use the database OWNER role (BYPASSRLS) — Ablo's server refuses
 * those (`database_role_cannot_enforce_rls`) because row-level security
 * would be unenforceable. Instead of making the user hand-write SQL, offer
 * to create the scoped role HERE, from their machine, with the credential
 * they already configured — the owner string never reaches Ablo's servers,
 * and the generated password is written to the env file, never printed.
 *
 * Returns the URL the migration (and the app) should use from now on.
 */
async function ensureScopedRole(dbUrl: string): Promise<string> {
  let safety;
  try {
    const sql = postgres(dbUrl, { max: 1, prepare: false, onnotice: () => {} });
    try {
      safety = await detectRoleSafety(sql);
    } finally {
      await sql.end({ timeout: 5 });
    }
  } catch {
    return dbUrl; // unreachable DB — let the migration produce the real error
  }
  if (!safety.unsafe) return dbUrl;

  const why = safety.superuser ? 'a superuser' : 'BYPASSRLS';
  console.log(
    `\n  ${pc.yellow('!')} DATABASE_URL connects as ${pc.bold(safety.role)} — ${why}, so ` +
      `row-level security can't be enforced.\n    Ablo's server will refuse this connection ` +
      `(${pc.bold('database_role_cannot_enforce_rls')}).`,
  );

  // CI / agents (no TTY): don't block, don't guess — point at the recipe.
  if (!process.stdout.isTTY) {
    console.log(
      pc.dim(
        `    Create a scoped role and update DATABASE_URL — run \`npx ablo migrate\` interactively\n` +
          `    to do it automatically, or see https://docs.abloatai.com/quickstart#scoped-role`,
      ),
    );
    return dbUrl;
  }

  const proceed = await confirm({
    message: `Create a scoped role ${DEFAULT_SCOPED_ROLE} (NOSUPERUSER, NOBYPASSRLS) and update DATABASE_URL?`,
    initialValue: true,
  });
  if (isCancel(proceed) || !proceed) {
    console.log(pc.dim('    Skipped — see https://docs.abloatai.com/quickstart#scoped-role for the manual recipe.'));
    return dbUrl;
  }

  const { role, databaseUrl } = await createScopedRole(dbUrl);
  const where = persistDatabaseUrl(databaseUrl);
  console.log(
    `  ${pc.green('✓')} Created role ${pc.bold(role)} and updated ${pc.bold('DATABASE_URL')} in ${pc.bold(where)}.\n` +
      pc.dim(`    The owner credential never left this machine; the new password was written, not printed.`),
  );
  return databaseUrl;
}

/**
 * Update DATABASE_URL where the user keeps it: the env file that already
 * defines it (.env.local, then .env), else append to .env.local (0600) and
 * make sure it's gitignored. Mirrors \`wireEnvLocal\`'s behavior for keys.
 */
function persistDatabaseUrl(databaseUrl: string, cwd: string = process.cwd()): string {
  const line = `DATABASE_URL=${databaseUrl}`;
  for (const name of ['.env.local', '.env']) {
    const path = resolve(cwd, name);
    if (!existsSync(path)) continue;
    const content = readFileSync(path, 'utf8');
    if (/^DATABASE_URL=/m.test(content)) {
      writeFileSync(path, content.replace(/^DATABASE_URL=.*$/m, line));
      return name;
    }
  }
  const envLocal = resolve(cwd, '.env.local');
  if (existsSync(envLocal)) {
    const content = readFileSync(envLocal, 'utf8');
    appendFileSync(envLocal, `${content.endsWith('\n') || content.length === 0 ? '' : '\n'}${line}\n`);
  } else {
    writeFileSync(envLocal, `${line}\n`, { mode: 0o600 });
  }
  const gitignorePath = resolve(cwd, '.gitignore');
  const gitignore = existsSync(gitignorePath) ? readFileSync(gitignorePath, 'utf8') : '';
  if (!/^(\.env\.local|\.env\*|\.env\.\*|\.env.*)$/m.test(gitignore)) {
    writeFileSync(
      gitignorePath,
      `${gitignore.endsWith('\n') || gitignore.length === 0 ? gitignore : `${gitignore}\n`}.env.local\n`,
    );
  }
  return '.env.local';
}
