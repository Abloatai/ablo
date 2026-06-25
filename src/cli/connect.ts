/**
 * `ablo connect` — the ONE prescriptive way to connect a real database.
 *
 * Ablo reads your Postgres via LOGICAL REPLICATION: it tails your WAL and
 * NEVER runs DDL, owns, or migrates your schema — writes go through your own
 * backend. There is exactly ONE setup path, and this command IS it. It does
 * not ask for a connection-string flavor, an adapter, or a driver: those old
 * seams (DATABASE_URL adapters, `databaseUrl` on the client, source endpoints)
 * are not how you connect a real database — logical replication is. Printing
 * the recipe here, in one place, is what keeps a BYO developer from wandering
 * back into them.
 *
 * Two modes:
 *   ablo connect           Print the exact, copy-pasteable setup SQL for YOUR
 *                          Postgres (wal_level, publication, replication role).
 *   ablo connect --check   Connect to DATABASE_URL and verify readiness:
 *                          wal_level=logical, the publication exists, the
 *                          current role has REPLICATION, and every published
 *                          table has a usable REPLICA IDENTITY. Prints a green
 *                          checklist, or the precise per-item fix.
 *
 * Modeled 1:1 on the logical-replication onboarding flows of Zero
 * (`rocicorp/mono` — `stream.ts`/`replication-slots.ts`) and PowerSync
 * (`powersync-ja/powersync-service` — `replication-utils.ts` publication +
 * replica-identity checks) (2026-06-25). See docs/plans/byod-wal-consumer-structure.md.
 */

import { AbloValidationError } from '../errors.js';
import pc from 'picocolors';
import postgres from 'postgres';
import { readProjectDatabaseUrl } from './dbRole';
import { brand } from './theme';

/**
 * The single canonical publication name. The WAL consumer subscribes to
 * exactly this — hard-coded on both sides so the recipe and the runtime can
 * never disagree (the same discipline `ablo_idempotency`/`ablo_outbox` follow).
 */
export const ABLO_PUBLICATION = 'ablo_publication';

/** The least-privilege replication role the recipe prescribes. */
export const ABLO_REPLICATION_ROLE = 'ablo_replicator';

export interface ConnectArgs {
  /** `--check`: connect to DATABASE_URL and validate readiness (no printing of SQL). */
  check: boolean;
  /**
   * `--tables a,b,c`: publish only these tables instead of `FOR ALL TABLES`.
   * Empty = all tables (the default, and what the WAL consumer expects unless
   * you scope the schema to match).
   */
  tables: readonly string[];
  /** `--role <name>`: name for the replication role (default `ablo_replicator`). */
  role: string;
}

/** Parse `connect` flags. Pure — unit-tested without touching a database. */
export function parseConnectArgs(argv: readonly string[]): ConnectArgs {
  let check = false;
  let tables: readonly string[] = [];
  let role = ABLO_REPLICATION_ROLE;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--check':
        check = true;
        break;
      case '--tables': {
        const value = argv[++i] ?? '';
        tables = value
          .split(',')
          .map((t) => t.trim())
          .filter((t) => t.length > 0);
        break;
      }
      case '--role':
        role = argv[++i] ?? role;
        break;
      default:
        throw new AbloValidationError(`unknown flag: ${arg}`, { code: 'cli_invalid_arguments' });
    }
  }
  return { check, tables, role };
}

/** Quote a Postgres identifier safely (mirrors dbRole's `q`). */
function quoteIdent(id: string): string {
  return `"${id.replace(/"/g, '""')}"`;
}

/**
 * The exact, copy-pasteable setup SQL — returned as data so it's testable and
 * reused verbatim by the printed recipe. This is THE one way to connect: it
 * grants Ablo READ access to your WAL and nothing more. Ablo never runs DDL,
 * never owns your schema, never migrates it; your app keeps writing through its
 * own backend exactly as before.
 *
 * The `<password>` placeholder is intentional — you choose the secret and put
 * the resulting connection string in `DATABASE_URL`; it never passes through
 * Ablo's CLI or servers on this path.
 */
export function connectSetupSql(input: {
  readonly tables?: readonly string[];
  readonly role?: string;
}): readonly string[] {
  const role = input.role && input.role.length > 0 ? input.role : ABLO_REPLICATION_ROLE;
  const tables = input.tables ?? [];
  const publicationTarget =
    tables.length > 0 ? `FOR TABLE ${tables.map(quoteIdent).join(', ')}` : 'FOR ALL TABLES';

  return [
    // 1. Turn on logical decoding. Requires a restart (it's not reloadable).
    `ALTER SYSTEM SET wal_level = 'logical';`,
    // 2. Publish the tables Ablo should read.
    `CREATE PUBLICATION ${quoteIdent(ABLO_PUBLICATION)} ${publicationTarget};`,
    // 3. A least-privilege role: it can stream replication and SELECT, nothing more.
    `CREATE ROLE ${quoteIdent(role)} WITH REPLICATION LOGIN PASSWORD '<password>';`,
    `GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${quoteIdent(role)};`,
    // Future tables get SELECT automatically, so the publication doesn't outgrow the grant.
    `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO ${quoteIdent(role)};`,
  ];
}

/**
 * Print the prescriptive recipe. Spelled out as numbered steps with the
 * provider-specific caveats (restart, RDS parameter group + `rds_replication`)
 * inline, because those are exactly where a developer gets stuck and then
 * reaches for the wrong seam.
 */
export function printConnectRecipe(args: ConnectArgs): void {
  const sql = connectSetupSql({ tables: args.tables, role: args.role });

  console.log(`\n  ${brand('ablo')} ${pc.dim('connect')}  ${pc.dim('logical replication — the one way to connect a real database')}\n`);
  console.log(
    `  Ablo READS your write-ahead log (WAL) and ${pc.bold('never')} runs DDL, owns, or migrates your\n` +
      `  schema. Your app keeps writing through your own backend — Ablo only tails the changes.\n` +
      `  Run this once against your Postgres ${pc.dim('(as a superuser / the DB owner)')}:\n`,
  );

  console.log(`  ${pc.bold('1.')} Enable logical decoding ${pc.dim('(then RESTART Postgres — wal_level is not reloadable)')}`);
  console.log(`       ${pc.cyan(sql[0]!)}`);
  console.log(
    pc.dim(
      `       On Amazon RDS / Aurora you can't ALTER SYSTEM: set ${pc.bold('rds.logical_replication = 1')} in the\n` +
        `       instance's parameter group instead, then reboot.`,
    ),
  );

  console.log(`\n  ${pc.bold('2.')} Publish the tables Ablo should read`);
  console.log(`       ${pc.cyan(sql[1]!)}`);
  if (args.tables.length === 0) {
    console.log(pc.dim(`       (Scope it with ${pc.bold('ablo connect --tables a,b,c')} to publish a subset.)`));
  }

  console.log(`\n  ${pc.bold('3.')} Create a least-privilege replication role ${pc.dim('(pick your own password)')}`);
  console.log(`       ${pc.cyan(sql[2]!)}`);
  console.log(`       ${pc.cyan(sql[3]!)}`);
  console.log(`       ${pc.cyan(sql[4]!)}`);
  console.log(
    pc.dim(
      `       On Amazon RDS, the REPLICATION attribute is granted, not set directly:\n` +
        `       ${pc.bold(`GRANT rds_replication TO ${quoteIdent(args.role)};`)}`,
    ),
  );

  console.log(
    `\n  ${pc.bold('4.')} Put the role's connection string in ${pc.bold('DATABASE_URL')}, then verify:\n` +
      `       ${pc.cyan('npx ablo connect --check')}\n`,
  );
  console.log(
    pc.dim(
      `  Reminder: Ablo never writes to your database on this path. Provisioning tables with\n` +
        `  ${pc.bold('ablo migrate')} is a separate, optional escape hatch — connecting a real database is this.`,
    ),
  );
  console.log();
}

// ── `--check`: validate readiness against DATABASE_URL ──────────────────────

interface WalLevelRow {
  setting: string;
}
interface RoleReplRow {
  rolreplication: boolean;
  rolsuper: boolean;
}
interface PublicationRow {
  puballtables: boolean;
}
/**
 * A published table whose REPLICA IDENTITY can't carry a stable key for
 * UPDATE/DELETE (`relreplident = 'n'` NOTHING, or `'d'` DEFAULT on a table
 * with no primary key). `'f'` (FULL) and `'i'` (USING INDEX) are usable, as is
 * `'d'` when a primary key exists — the SQL below already excludes those.
 */
interface BadReplicaIdentityRow {
  table_name: string;
  relreplident: string;
}

/** A porsager/Postgres query error — the field worth surfacing. */
interface PgErrorLike {
  message?: string;
}

/** One validated readiness item, ready to render as a checklist line. */
export interface CheckItem {
  readonly ok: boolean;
  readonly label: string;
  /** Shown indented under a failed item — the precise fix. */
  readonly fix?: string;
}

/** Render a checklist item the way `ablo check` renders model rows. */
function printCheckItem(item: CheckItem): void {
  if (item.ok) {
    console.log(`  ${pc.green('✓')} ${item.label}`);
  } else {
    console.log(`  ${pc.red('✗')} ${item.label}`);
    if (item.fix) {
      for (const line of item.fix.split('\n')) console.log(`      ${pc.red('•')} ${line}`);
    }
  }
}

/**
 * Probe the connected database for the four readiness invariants. Pure-ish:
 * takes an already-open `sql` handle so it's exercised against a real ephemeral
 * Postgres in integration tests without re-implementing connection handling.
 */
export async function probeReadiness(
  sql: postgres.Sql,
  opts: { readonly publication?: string } = {},
): Promise<readonly CheckItem[]> {
  const publication = opts.publication ?? ABLO_PUBLICATION;
  const items: CheckItem[] = [];

  // 1. wal_level must be 'logical'.
  const walRows = (await sql.unsafe(`SHOW wal_level`)) as unknown as WalLevelRow[];
  const walLevel = walRows[0]?.setting ?? 'unknown';
  items.push(
    walLevel === 'logical'
      ? { ok: true, label: `wal_level is ${pc.bold('logical')}` }
      : {
          ok: false,
          label: `wal_level is ${pc.bold(walLevel)} (need ${pc.bold('logical')})`,
          fix:
            `ALTER SYSTEM SET wal_level = 'logical'; then RESTART Postgres.\n` +
            `On RDS/Aurora set rds.logical_replication = 1 in the parameter group, then reboot.`,
        },
  );

  // 2. The Ablo publication must exist.
  const pubRows = (await sql.unsafe(
    `SELECT puballtables FROM pg_publication WHERE pubname = $1`,
    [publication] as never[],
  )) as unknown as PublicationRow[];
  items.push(
    pubRows.length > 0
      ? {
          ok: true,
          label: `publication ${pc.bold(publication)} exists ${pc.dim(pubRows[0]!.puballtables ? '(all tables)' : '(table subset)')}`,
        }
      : {
          ok: false,
          label: `publication ${pc.bold(publication)} not found`,
          fix: `CREATE PUBLICATION ${quoteIdent(publication)} FOR ALL TABLES;`,
        },
  );

  // 3. The connected role must have REPLICATION (superuser implies it).
  const roleRows = (await sql.unsafe(
    `SELECT rolreplication, rolsuper FROM pg_roles WHERE rolname = current_user`,
  )) as unknown as RoleReplRow[];
  const role = roleRows[0];
  const hasReplication = Boolean(role && (role.rolreplication || role.rolsuper));
  items.push(
    hasReplication
      ? { ok: true, label: `DATABASE_URL role can stream replication ${pc.dim('(REPLICATION)')}` }
      : {
          ok: false,
          label: `DATABASE_URL role lacks the ${pc.bold('REPLICATION')} attribute`,
          fix:
            `ALTER ROLE current_user WITH REPLICATION;\n` +
            `On RDS: GRANT rds_replication TO <your_role>;`,
        },
  );

  // 4. Every published table needs a usable REPLICA IDENTITY for UPDATE/DELETE.
  //    'd' (DEFAULT) is usable ONLY when the table has a primary key; 'n'
  //    (NOTHING) is never usable. 'f'/'i' are always fine. (PowerSync's
  //    replication-utils replica-identity check, ported.)
  if (pubRows.length > 0) {
    const badRows = (await sql.unsafe(
      `SELECT c.relname AS table_name, c.relreplident
         FROM pg_publication_tables pt
         JOIN pg_class c ON c.relname = pt.tablename
         JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = pt.schemaname
        WHERE pt.pubname = $1
          AND (
            c.relreplident = 'n'
            OR (
              c.relreplident = 'd'
              AND NOT EXISTS (
                SELECT 1 FROM pg_index i
                 WHERE i.indrelid = c.oid AND i.indisprimary
              )
            )
          )`,
      [publication] as never[],
    )) as unknown as BadReplicaIdentityRow[];
    items.push(
      badRows.length === 0
        ? { ok: true, label: `all published tables have a usable REPLICA IDENTITY` }
        : {
            ok: false,
            label: `${badRows.length} published table${badRows.length === 1 ? '' : 's'} cannot replicate UPDATE/DELETE`,
            fix: badRows
              .map(
                (r) =>
                  `${r.table_name}: add a PRIMARY KEY, or ALTER TABLE ${quoteIdent(r.table_name)} REPLICA IDENTITY FULL;`,
              )
              .join('\n'),
          },
    );
  }

  return items;
}

/** Run the readiness check against DATABASE_URL and report. */
async function runCheck(): Promise<void> {
  const dbUrl = readProjectDatabaseUrl();
  if (!dbUrl) {
    console.error(
      pc.red('  No DATABASE_URL found (checked process env, .env.local, .env).') +
        pc.dim(` Set it to the Postgres you want Ablo to read, then re-run ${pc.bold('ablo connect --check')}.`),
    );
    process.exit(1);
  }

  console.log(`\n  ${brand('ablo')} ${pc.dim('connect --check')}  ${pc.dim('logical-replication readiness')}\n`);

  const sql = postgres(dbUrl, { max: 1, prepare: false, onnotice: () => {} });
  let items: readonly CheckItem[];
  try {
    items = await probeReadiness(sql);
  } catch (err) {
    const pg = (err ?? {}) as PgErrorLike;
    console.error(pc.red(`  Couldn't read the database: ${pg.message ?? String(err)}`));
    await sql.end({ timeout: 2 });
    process.exit(1);
  }
  await sql.end({ timeout: 2 });

  for (const item of items) printCheckItem(item);

  const failures = items.filter((i) => !i.ok).length;
  console.log();
  if (failures === 0) {
    console.log(`  ${pc.green('✓')} Ready — Ablo can connect and tail this database's WAL.\n`);
    process.exit(0);
  }
  console.log(
    `  ${pc.red(`${failures} item${failures === 1 ? '' : 's'} to fix`)} ${pc.dim(`— apply the fixes above, then re-run ${pc.bold('ablo connect --check')}.`)}\n`,
  );
  process.exit(1);
}

export async function connect(argv: readonly string[]): Promise<void> {
  let args: ConnectArgs;
  try {
    args = parseConnectArgs(argv);
  } catch (err) {
    console.error(pc.red(`  ${err instanceof Error ? err.message : String(err)}`));
    process.exit(1);
  }

  if (args.check) {
    await runCheck();
    return;
  }
  printConnectRecipe(args);
}

/**
 * Usage text for `ablo connect --help`. Kept beside the parser (and exported
 * so the CLI dispatcher can print it) so the two never drift.
 */
export const CONNECT_USAGE = `  ablo connect — connect a real database to Ablo via logical replication (the one way)

  Ablo READS your WAL and never runs DDL, owns, or migrates your schema. Your app
  keeps writing through your own backend.

  Usage:
    npx ablo connect                      Print the exact setup SQL for your Postgres
    npx ablo connect --tables a,b,c       Publish only these tables (default: all tables)
    npx ablo connect --role <name>        Name the replication role (default: ablo_replicator)
    npx ablo connect --check              Validate DATABASE_URL is replication-ready`;
