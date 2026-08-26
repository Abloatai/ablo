/**
 * `ablo migrate` creates your schema's tables in your own Postgres database.
 *
 * It is the counterpart to `ablo push`: where `push` sends your schema to the
 * hosted service to apply, `migrate` applies it directly to the database named
 * by `DATABASE_URL`. Both commands lower the schema through the same planner,
 * {@link generateProvisionPlan} from `@abloatai/transaction/schema`, so the SQL —
 * column types, row-level security, enum checks — is identical no matter which
 * side runs it. There is no second type map: a Zod `number` becomes
 * `DOUBLE PRECISION` here exactly as it does on the hosted path.
 *
 * Usage:
 *   ablo migrate                       # apply to DATABASE_URL
 *   ablo migrate --dry-run             # print SQL without executing
 *   ablo migrate --output schema.sql   # write SQL to a file
 *   ablo migrate --schema path.ts --export schema
 */

import { AbloValidationError } from '@abloatai/transaction/errors';
import { spinner } from '@clack/prompts';
import pc from 'picocolors';
import { writeFileSync } from 'fs';
import postgres from 'postgres';
import { ADMIN_URL_VAR, readProjectAdminDatabaseUrl } from './dbRole';
import {
  serializeSchema,
  generateProvisionPlan,
  PG_LOCK_NOT_AVAILABLE,
  resolveDdlLockTimeout,
  resolveDdlMaxLockAttempts,
  ddlLockRetryBackoffMs,
  type Schema,
  type SchemaJSON,
} from '@abloatai/transaction/schema';
import { adapterTableMigrations } from '@abloatai/transaction/source';
import { loadSchema } from './push';

/**
 * Usage text for `ablo migrate --help`. Kept beside the parser (and exported so
 * the CLI dispatcher can print it) so the two never drift. Mirrors the flags in
 * `parseMigrateArgs` below.
 */
export const MIGRATE_USAGE = `  ablo migrate — create the tables your schema needs in your own database (DATABASE_URL)

  Use it when your schema defines models with no tables behind them yet;
  \`ablo connect\` adopts tables you already have.

  Usage:
    npx ablo migrate                      Create the synced-model tables (with row-level security)
    npx ablo migrate --dry-run            Print the SQL without executing it
    npx ablo migrate --output schema.sql  Write the SQL to a file instead of applying
    npx ablo migrate --schema <path>      Use a schema file other than ablo/schema.ts
    npx ablo migrate --export <name>      Use a named export other than \`schema\``;

export interface MigrateArgs {
  schemaPath: string;
  exportName: string;
  /** The Postgres schema the tables live in. Defaults to `public` when you own
   *  the database, since the database itself is the tenant boundary. */
  targetSchema: string;
  dryRun: boolean;
  outputFile: string | null;
}

const DEFAULT_SCHEMA_PATH = 'ablo/schema.ts';
const DEFAULT_EXPORT = 'schema';

/** Parses the `migrate` command's flags into {@link MigrateArgs}. Does no I/O,
 *  so it can run without a database. */
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

/** Lowers a loaded schema to the SQL that creates its tables, using the same
 *  planner the hosted path uses. Does no I/O. */
export function planFor(
  schema: Schema,
  targetSchema = 'public',
): { statements: readonly string[]; concurrent: readonly string[] } {
  const schemaJson = JSON.parse(serializeSchema(schema)) as SchemaJSON;
  // A database you own is provisioned into `public`, since the database itself
  // is the tenant boundary. Emit real foreign keys there for a clean relational
  // schema; the hosted path applies the same rule, so both produce identical SQL
  // for the same database.
  const plan = generateProvisionPlan(schemaJson, targetSchema, {
    foreignKeys: targetSchema === 'public',
  });
  // Running against your own database also needs the two tables the runtime
  // manages itself, `ablo_idempotency` and `ablo_outbox`. Their definitions come
  // from a single source and use `IF NOT EXISTS`, so re-running is safe and the
  // command never has to ask you to paste table-creation SQL by hand.
  // Adapter infrastructure remains in `public`, matching the unqualified
  // runtime queries issued by every endpoint adapter. `targetSchema` applies
  // only to application models.
  const adapterTables = adapterTableMigrations().map((m) => m.up);
  return { statements: [...plan.statements, ...adapterTables], concurrent: plan.concurrent ?? [] };
}

/** The fields worth surfacing from a query error raised by the `postgres` driver. */
interface PgError {
  code?: string;
  detail?: string;
  message?: string;
}

/** Structured lifecycle logs, each tagged `[migrate]`. They use the same shape
 *  and vocabulary as the hosted path's logs, so a failure reads the same way no
 *  matter which side applied the migration. */
const log = {
  info: (msg: string, fields: Record<string, unknown>) => { console.log(`[migrate] ${msg}`, fields); },
  warn: (msg: string, fields: Record<string, unknown>) => { console.warn(pc.yellow(`[migrate] ${msg}`), fields); },
  error: (msg: string, fields: Record<string, unknown>) => { console.error(pc.red(`[migrate] ${msg}`), fields); },
};

// Safe schema-change settings, the same ones the hosted path uses: a low
// `lock_timeout` so a blocked `ALTER` never freezes the table behind the lock
// queue, plus a bounded retry when a lock is contended (SQLSTATE 55P03). Tune
// them with the `ABLO_SCHEMA_LOCK_TIMEOUT` and `ABLO_SCHEMA_LOCK_ATTEMPTS`
// environment variables (the older `ABLO_DDL_*` names still work).

/**
 * How a run in progress reaches the person watching it. A 59-statement plan
 * against a remote database runs for tens of seconds, and with no output
 * between "applying" and "applied" a run in flight looks exactly like one that
 * has hung.
 *
 * `quiet` suppresses only the two lifecycle *info* lines, which a spinner
 * restates in plain words. Warnings and failures always print: they carry the
 * failing statement, its position, and the SQLSTATE, and no spinner shows that.
 */
interface MigrateObserver {
  /** Fires after each statement succeeds inside the transaction. */
  readonly onStatement?: (done: number, total: number) => void;
  readonly quiet?: boolean;
}

/**
 * Applies the statements in a single transaction, guarded by the same advisory
 * lock the hosted path uses. If any statement fails, the transaction aborts so
 * nothing partial lands, and the failure is logged in the `migration_failed`
 * shape: which statement broke, its position in the plan, and the Postgres
 * SQLSTATE.
 */
async function applyStatements(
  dbUrl: string,
  targetSchema: string,
  statements: readonly string[],
  concurrent: readonly string[] = [],
  observer: MigrateObserver = {},
): Promise<void> {
  const sql = postgres(dbUrl, { max: 1, prepare: false, onnotice: () => {} });
  const total = statements.length;
  const startedAt = Date.now();
  const lockTimeout = resolveDdlLockTimeout();
  const maxLockAttempts = resolveDdlMaxLockAttempts();
  if (!observer.quiet) log.info('applying migration plan', { targetSchema, statements: total });
  try {
    // Inside a transaction under advisory lock with a low lock_timeout + bounded retry on lock
    // contention (55P03), so a blocked ALTER never parks ACCESS EXCLUSIVE at the
    // head of the lock queue and freezes the table.
    for (let attempt = 1; ; attempt++) {
      try {
        await sql.begin(async (tx) => {
          await tx.unsafe(`SET LOCAL lock_timeout = '${lockTimeout}'`);
          await tx`SELECT pg_advisory_xact_lock(hashtext(${`provision:${targetSchema}`}))`;
          for (const [index, statement] of statements.entries()) {
            try {
              await tx.unsafe(statement);
              // Counts down the plan. A lock retry restarts the transaction, so
              // this can step backwards — which is what is actually happening,
              // and the retry warning above it says so.
              observer.onStatement?.(index + 1, total);
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
        if (pg.code === PG_LOCK_NOT_AVAILABLE && attempt < maxLockAttempts) {
          const backoffMs = ddlLockRetryBackoffMs(attempt);
          log.warn('schema change blocked by a lock; backing off and retrying', { targetSchema, attempt, backoffMs });
          await new Promise((resolve) => setTimeout(resolve, backoffMs));
          continue;
        }
        throw err;
      }
    }
    // A best-effort pass after the commit, outside any transaction: `VALIDATE`
    // and `CREATE INDEX CONCURRENTLY`, which cannot run inside a transaction.
    // These never abort a migration that already committed; a `VALIDATE` that
    // trips on a table's existing rows is only logged. `statement_timeout` is set
    // to 0 so a long, non-blocking scan on a large table isn't killed partway.
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
  if (!observer.quiet) {
    log.info('migration plan applied', { targetSchema, statements: total, durationMs: Date.now() - startedAt });
  }
}

export async function migrate(argv: readonly string[]): Promise<void> {
  // A parse failure propagates as the typed `cli_invalid_arguments` error it
  // already is — the dispatcher's renderer shows the code, the message, and
  // the docs link, the same block every other failure gets.
  const args = parseMigrateArgs(argv);

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

  // Resolve DATABASE_URL the way a web framework would: the process environment
  // first, then the `.env.local` and `.env` files. Run through `npx`, this
  // command has no framework to load those files for it, so it reads them
  // directly — otherwise it would miss a DATABASE_URL that lives only in
  // `.env.local`, which is a common place to keep it.
  const dbUrl = readProjectAdminDatabaseUrl();
  if (!dbUrl) {
    throw new AbloValidationError(
      `No ${ADMIN_URL_VAR} found (checked process env, .env.local, .env). Set it to apply, or use --dry-run to preview.`,
      { code: 'cli_database_url_missing' },
    );
  }

  // `ablo migrate` provisions tables and nothing more: it does not create roles,
  // enable row-level security, or rewrite DATABASE_URL. It runs the DDL as the
  // role you supply, like any migration tool, so securing the connection with a
  // scoped role and row-level security is up to you. The command is optional —
  // your existing tables can be read and written without it.
  // A terminal gets a spinner counting the plan down; a pipe or a CI log gets
  // the structured `[migrate]` lines, which carry the same facts in the same
  // vocabulary as the hosted path. Neither audience gets both.
  const interactive = process.stdout.isTTY === true;
  const progress = interactive ? spinner() : null;
  progress?.start(`Applying ${totalStatements} statements`);
  try {
    await applyStatements(dbUrl, args.targetSchema, plan.statements, plan.concurrent, {
      quiet: interactive,
      onStatement: (done, total) => progress?.message(`Applying schema — ${done} of ${total} statements`),
    });
    if (progress) progress.stop(`Migration complete (${totalStatements} statements)`, 0);
    else console.log(`  ${pc.green('✓')} Migration complete`);
  } catch (err) {
    progress?.stop('Migration failed', 1);
    // Say what went wrong. A statement that fails is already logged with its
    // position and SQLSTATE, but everything before the first statement — a
    // refused connection, a bad password, an unreachable host — arrives here.
    // The spinner is stopped, then the error travels to the dispatcher's
    // renderer like every other failure, so the block carries the code, the
    // recovery hint, and the docs link.
    throw err;
  }
}
