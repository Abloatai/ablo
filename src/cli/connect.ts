/**
 * `ablo connect` sets up the read path: Ablo reads your database by tailing its
 * write-ahead log through Postgres logical replication.
 *
 * Ablo consumes the logical replication stream and fans the changes out to
 * connected clients as live shapes. It does not run DDL, own, migrate, or host
 * your schema, and it never writes — your data stays in your database. Writes
 * continue to go through your own backend to your own Postgres, exactly as
 * before; Ablo records its coordination and transaction deltas on top and is
 * never in your write path.
 *
 * The command has three modes:
 *
 *   ablo connect            Prints the exact, copy-pasteable setup SQL for your
 *                           Postgres: the WAL level, the publication, and the
 *                           replication role.
 *   ablo connect --check    Connects to `DATABASE_URL` and verifies readiness —
 *                           that `wal_level` is `logical`, the publication
 *                           exists, the current role can stream replication, and
 *                           every published table has a usable replica identity.
 *                           It prints a checklist, with the precise fix for any
 *                           item that fails.
 *   ablo connect --register Verifies readiness, then registers the database so
 *                           Ablo begins replicating it on the next sync.
 */

import { AbloValidationError } from '../errors.js';
import pc from 'picocolors';
import postgres from 'postgres';
import { readProjectDatabaseUrl } from './dbRole';
import { resolveApiKey } from './config';
import { DEFAULT_URL } from './push';
import { brand } from './theme';

/**
 * The canonical Postgres publication name that Ablo's replication reads from.
 * The setup SQL and the replication consumer both use exactly this name, so the
 * recipe you run and the runtime that connects can never disagree.
 */
export const ABLO_PUBLICATION = 'ablo_publication';

/** The least-privilege replication role the recipe prescribes. */
export const ABLO_REPLICATION_ROLE = 'ablo_replicator';

export interface ConnectArgs {
  /** `--check`: connect to DATABASE_URL and validate readiness (no printing of SQL). */
  check: boolean;
  /**
   * `--register`: validate readiness, then register this database with Ablo so it
   * begins replicating (`POST /v1/datasources { connectionString }`, authorized
   * by your project key). Registering the database is what enables the read
   * path — there is no separate tier or flag to turn on.
   */
  register: boolean;
  /**
   * `--audit-infra`: a read-only audit that reports leftover Ablo sync tables and
   * types in the database — infrastructure a previous integration may have
   * created. It only reports what it finds and never drops anything.
   */
  auditInfra: boolean;
  /**
   * `--tables a,b,c`: publish only these tables instead of every table. When
   * empty (the default), the publication covers all tables.
   */
  tables: readonly string[];
  /** `--role <name>`: name for the replication role (default `ablo_replicator`). */
  role: string;
}

/** Parse `connect` flags. Pure — unit-tested without touching a database. */
export function parseConnectArgs(argv: readonly string[]): ConnectArgs {
  let check = false;
  let register = false;
  let auditInfra = false;
  let tables: readonly string[] = [];
  let role = ABLO_REPLICATION_ROLE;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--check':
        check = true;
        break;
      case '--register':
        register = true;
        break;
      case '--audit-infra':
        auditInfra = true;
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
  return { check, register, auditInfra, tables, role };
}

/** Safely quotes a Postgres identifier by doubling any embedded quote marks. */
function quoteIdent(id: string): string {
  return `"${id.replace(/"/g, '""')}"`;
}

/**
 * Returns the setup SQL for the read path as an array of statements, so it can be
 * both printed as a recipe and asserted in tests. The statements grant Ablo
 * read-only access to your write-ahead log and nothing more: Ablo does not run
 * DDL, own your schema, or migrate it, and your app keeps writing through its own
 * backend.
 *
 * The `<password>` placeholder is deliberate. You choose the secret and put the
 * resulting connection string in `DATABASE_URL`; the password never passes
 * through Ablo's CLI or servers.
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
 * Prints the setup recipe as numbered steps, with the provider-specific caveats
 * (the required restart, and the RDS parameter group and `rds_replication`
 * grant) inline — the points where this setup most often trips people up.
 */
export function printConnectRecipe(args: ConnectArgs): void {
  const sql = connectSetupSql({ tables: args.tables, role: args.role });

  console.log(`\n  ${brand('ablo')} ${pc.dim('connect')}  ${pc.dim('logical replication — the read path (your writes stay on your own backend)')}\n`);
  console.log(
    `  Ablo consumes your write-ahead log (WAL) via logical replication and ${pc.bold('never')} runs DDL,\n` +
      `  owns, hosts, or migrates your schema. Your app continues to own the write path — Ablo tails\n` +
      `  the changes and serves them as live shapes. Run this once against your Postgres ${pc.dim('(as a superuser / DB owner)')}:\n`,
  );

  console.log(`  ${pc.bold('1.')} Enable logical decoding ${pc.dim('(then RESTART Postgres — wal_level is not reloadable)')}`);
  console.log(`       ${pc.cyan(sql[0])}`);
  console.log(
    pc.dim(
      `       On Amazon RDS / Aurora you can't ALTER SYSTEM: set ${pc.bold('rds.logical_replication = 1')} in the\n` +
        `       instance's parameter group instead, then reboot.`,
    ),
  );

  console.log(`\n  ${pc.bold('2.')} Publish the tables Ablo should read`);
  console.log(`       ${pc.cyan(sql[1])}`);
  if (args.tables.length === 0) {
    console.log(pc.dim(`       (Scope it with ${pc.bold('ablo connect --tables a,b,c')} to publish a subset.)`));
  }

  console.log(`\n  ${pc.bold('3.')} Create a least-privilege replication role ${pc.dim('(pick your own password)')}`);
  console.log(`       ${pc.cyan(sql[2])}`);
  console.log(`       ${pc.cyan(sql[3])}`);
  console.log(`       ${pc.cyan(sql[4])}`);
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
      `  Reminder: this is the READ path — Ablo tails your WAL and never writes to your database.\n` +
        `  Your writes keep going through your own backend. (Ablo HOSTING your rows, or dialing in via\n` +
        `  ${pc.bold('databaseUrl')}, is the deprecated posture — see the read-path decision doc.)`,
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

/** A query error from the `postgres` client — the one field worth surfacing. */
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

export type SyncInfraArtifactKind = 'relation' | 'type';

export interface SyncInfraArtifact {
  readonly kind: SyncInfraArtifactKind;
  readonly name: string;
  readonly present: boolean;
}

const SYNC_INFRA_RELATIONS = [
  'sync_deltas',
  'sync_id_seq',
  'sync_metadata',
  'mutation_log',
] as const;

const SYNC_INFRA_TYPES = [
  'participant_kind',
  'backfill_provenance',
  'confirmation_state',
] as const;

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
 * Probes the connected database for the four readiness invariants and returns one
 * {@link CheckItem} per check. It takes an already-open `sql` handle rather than a
 * connection URL, so callers control connection handling and the checks can run
 * against a real Postgres in tests.
 */
export async function probeReadiness(
  sql: postgres.Sql,
  opts: { readonly publication?: string } = {},
): Promise<readonly CheckItem[]> {
  const publication = opts.publication ?? ABLO_PUBLICATION;
  const items: CheckItem[] = [];

  // 1. wal_level must be 'logical'.
  // `SHOW wal_level` returns a column named `wal_level`, not `setting`, so reading
  // `.setting` off it is always undefined and every database looks like "unknown".
  // `pg_settings` exposes the value in a `setting` column, matching {@link WalLevelRow}.
  const walRows = (await sql.unsafe(
    `SELECT setting FROM pg_settings WHERE name = 'wal_level'`,
  )) as unknown as WalLevelRow[];
  const walLevel = walRows[0]?.setting ?? 'unknown';
  items.push(
    walLevel === 'logical'
      ? { ok: true, label: `wal_level is ${pc.bold('logical')}` }
      : {
          ok: false,
          label: `wal_level is ${pc.bold(walLevel)} (need ${pc.bold('logical')})`,
          fix:
            `ALTER SYSTEM SET wal_level = 'logical'; then RESTART Postgres.\n` +
            `On RDS/Aurora set rds.logical_replication = 1 in the parameter group, then reboot.\n` +
            `On Neon enable Logical Replication in the project (Console → Settings → Logical Replication, ` +
            `or the API) — Neon forbids ALTER SYSTEM; the toggle sets wal_level=logical.`,
        },
  );

  // 2. The Ablo publication must exist.
  const pubRows = (await sql.unsafe(
    `SELECT puballtables FROM pg_publication WHERE pubname = $1`,
    [publication] as never[],
  )) as unknown as PublicationRow[];
  const pubRow = pubRows[0];
  items.push(
    pubRow
      ? {
          ok: true,
          label: `publication ${pc.bold(publication)} exists ${pc.dim(pubRow.puballtables ? '(all tables)' : '(table subset)')}`,
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
  //    'd' (DEFAULT) is usable only when the table has a primary key; 'n'
  //    (NOTHING) is never usable; 'f' (FULL) and 'i' (USING INDEX) are always fine.
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

/**
 * Detects leftover Ablo-owned sync tables and types in the connected database.
 * Read-only by design — it reports what it finds and never drops anything, since
 * removing this infrastructure is a deliberate, confirmed step rather than
 * something the CLI does on its own.
 */
export async function auditTenantSyncInfra(
  sql: postgres.Sql,
): Promise<readonly SyncInfraArtifact[]> {
  const artifacts: SyncInfraArtifact[] = [];
  for (const name of SYNC_INFRA_RELATIONS) {
    const rows = (await sql.unsafe(
      `SELECT to_regclass($1)::text AS reg`,
      [`public.${name}`] as never[],
    )) as unknown as { reg: string | null }[];
    artifacts.push({ kind: 'relation', name, present: rows[0]?.reg != null });
  }
  for (const name of SYNC_INFRA_TYPES) {
    const rows = (await sql.unsafe(
      `SELECT to_regtype($1)::text AS reg`,
      [`public.${name}`] as never[],
    )) as unknown as { reg: string | null }[];
    artifacts.push({ kind: 'type', name, present: rows[0]?.reg != null });
  }
  return artifacts;
}

/**
 * Resolve DATABASE_URL or exit with a clear message. Shared by `--check` and
 * `--register` — both act on the database the developer points us at.
 */
function requireDatabaseUrl(verb: string): string {
  const dbUrl = readProjectDatabaseUrl();
  if (!dbUrl) {
    console.error(
      pc.red('  No DATABASE_URL found (checked process env, .env.local, .env).') +
        pc.dim(` Set it to the Postgres you want Ablo to read, then re-run ${pc.bold(`ablo connect ${verb}`)}.`),
    );
    process.exit(1);
  }
  return dbUrl;
}

/**
 * Probe readiness against `dbUrl`, print each item, return the failure count.
 * Exits the process if the database can't be read at all (a connection error,
 * not a fixable readiness item).
 */
async function probeAndReport(dbUrl: string): Promise<number> {
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
  return items.filter((i) => !i.ok).length;
}

/** Run the readiness check against DATABASE_URL and report. */
async function runCheck(): Promise<void> {
  const dbUrl = requireDatabaseUrl('--check');
  console.log(`\n  ${brand('ablo')} ${pc.dim('connect --check')}  ${pc.dim('logical-replication readiness')}\n`);
  const failures = await probeAndReport(dbUrl);
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

/**
 * The registration endpoint for a given API base URL. The server mounts every
 * route under `/api`, so the full path is `/api/v1/datasources` — the same path
 * the SDK's `registerDataSource` resolves. A bare `/v1/datasources` matches no
 * route and comes back as the server's global "Not found".
 */
export function registerEndpoint(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/api/v1/datasources`;
}

/**
 * Register DATABASE_URL as this project's data source: the engine replicates it
 * on the next sync. Validates readiness first (registering a database that can't
 * stream is a silent dead end), then `POST /api/v1/datasources { connectionString }`
 * authed by the project key — the org is derived server-side from the key, never
 * sent in the body.
 */
async function runRegister(): Promise<void> {
  const dbUrl = requireDatabaseUrl('--register');
  const apiKey = resolveApiKey();
  if (!apiKey) {
    console.error(
      pc.red('  Not logged in.') +
        pc.dim(` Run ${pc.bold('ablo login')} (or set ${pc.bold('ABLO_API_KEY')}) so Ablo knows which project to register this database for.`),
    );
    process.exit(1);
  }

  console.log(`\n  ${brand('ablo')} ${pc.dim('connect --register')}  ${pc.dim('register this database for replication')}\n`);

  const failures = await probeAndReport(dbUrl);
  if (failures > 0) {
    console.log(
      `\n  ${pc.red(`${failures} item${failures === 1 ? '' : 's'} to fix`)} ${pc.dim('— a database that isn’t replication-ready can’t stream. Fix the above, then re-run.')}\n`,
    );
    process.exit(1);
  }

  const apiUrl = (process.env.ABLO_API_URL ?? DEFAULT_URL).replace(/\/+$/, '');
  let res: Response;
  try {
    res = await fetch(registerEndpoint(apiUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ connectionString: dbUrl }),
    });
  } catch (err) {
    console.error(pc.red(`\n  Couldn't reach ${apiUrl}: ${err instanceof Error ? err.message : String(err)}\n`));
    process.exit(1);
  }

  if (res.ok) {
    const body = (await res.json().catch(() => ({}))) as { id?: string; host?: string };
    console.log(
      `\n  ${pc.green('✓')} Registered${body.host ? ` ${pc.dim(body.host)}` : ''}${body.id ? ` ${pc.dim(`(${body.id})`)}` : ''} — Ablo will replicate this database on the next sync.\n`,
    );
    process.exit(0);
  }

  // The server's error envelope is flat: `{ type, code, message, details }`. The
  // nested `error.code` fallback is kept for older or wrapped deployments.
  const body = (await res.json().catch(() => ({}))) as {
    code?: string;
    message?: string;
    details?: {
      failures?: readonly { item?: string; actual?: string; fix?: string }[];
      reason?: string;
    };
    error?: { code?: string; message?: string };
  };
  const code = body.code ?? body.error?.code;
  const message = body.message ?? body.error?.message ?? `HTTP ${res.status}`;
  console.error(pc.red(`\n  Registration failed: ${message}`));
  if (code === 'forbidden') {
    console.error(pc.dim(`  Registering a database needs a ${pc.bold('secret')} key (sk_…). Run ${pc.bold('ablo login')} for one.`));
  } else if (code === 'datasource_connection_unsupported') {
    console.error(
      pc.dim(`  This deployment can’t accept connection strings — use a self-hosted/hosted engine, or the signed endpoint fallback.`),
    );
  } else if (code === 'database_not_replication_ready') {
    // The server re-ran the readiness probes from its own side and found failures.
    // It can see a different picture than the local --check — for example a
    // publication added since, or probes running as the replication role rather
    // than yours.
    for (const f of body.details?.failures ?? []) {
      console.error(`  ${pc.red('✗')} ${pc.bold(f.item ?? 'item')}${f.actual ? pc.dim(` (${f.actual})`) : ''}`);
      if (f.fix) for (const line of f.fix.split('\n')) console.error(`      ${pc.red('•')} ${line}`);
    }
    console.error(pc.dim(`\n  Apply the fixes, verify with ${pc.bold('ablo connect --check')}, then re-run.`));
  } else if (code === 'database_unreachable') {
    if (body.details?.reason) console.error(pc.dim(`  ${body.details.reason}`));
    console.error(
      pc.dim(
        `  Ablo's servers must be able to reach this database — a localhost or private-network\n` +
          `  Postgres can't be replicated by the hosted service. Use a reachable host (or a tunnel),\n` +
          `  or the signed ${pc.bold('dataSource()')} endpoint fallback.`,
      ),
    );
  }
  console.error();
  process.exit(1);
}

async function runAuditInfra(): Promise<void> {
  const dbUrl = requireDatabaseUrl('--audit-infra');
  const sql = postgres(dbUrl, { max: 1, prepare: false, onnotice: () => {} });
  let artifacts: readonly SyncInfraArtifact[];
  try {
    artifacts = await auditTenantSyncInfra(sql);
  } catch (err) {
    const pg = (err ?? {}) as PgErrorLike;
    console.error(pc.red(`  Couldn't audit the database: ${pg.message ?? String(err)}`));
    await sql.end({ timeout: 2 });
    process.exit(1);
  }
  await sql.end({ timeout: 2 });

  console.log(`\n  ${brand('ablo')} ${pc.dim('connect --audit-infra')}  ${pc.dim('Stage 5 tenant DB sync-infra audit')}\n`);
  const present = artifacts.filter((a) => a.present);
  if (present.length === 0) {
    console.log(`  ${pc.green('✓')} No deprecated Ablo sync infrastructure found in public.\n`);
    process.exit(0);
  }

  for (const artifact of present) {
    const label = artifact.kind === 'type' ? 'type' : 'relation';
    console.log(`  ${pc.yellow('!')} ${label} ${pc.bold(`public.${artifact.name}`)} exists`);
  }
  console.log(
    `\n  ${pc.yellow(`${present.length} artifact${present.length === 1 ? '' : 's'} found`)} ` +
      pc.dim('— do not drop automatically. Confirm the org/environment is log-authoritative, then follow ') +
      pc.bold('docs/runbooks/wal-stage5-customer-db-infra-cleanup.md') +
      pc.dim('.\n'),
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
  if (args.register) {
    await runRegister();
    return;
  }
  if (args.auditInfra) {
    await runAuditInfra();
    return;
  }
  printConnectRecipe(args);
}

/**
 * Usage text for `ablo connect --help`. Kept beside the parser (and exported
 * so the CLI dispatcher can print it) so the two never drift.
 */
export const CONNECT_USAGE = `  ablo connect — connect your database for the read path, via logical replication

  The Electric/PowerSync/Zero model: Ablo consumes your WAL via logical replication and
  never runs DDL, owns, hosts, or migrates your schema. Your app continues to own the write path.

  Usage:
    npx ablo connect                      Print the exact setup SQL for your Postgres
    npx ablo connect --tables a,b,c       Publish only these tables (default: all tables)
    npx ablo connect --role <name>        Name the replication role (default: ablo_replicator)
    npx ablo connect --check              Validate DATABASE_URL is replication-ready
    npx ablo connect --register           Register DATABASE_URL so Ablo replicates it (one self-service step)
    npx ablo connect --audit-infra        Read-only Stage 5 audit for deprecated Ablo sync tables/types`;
