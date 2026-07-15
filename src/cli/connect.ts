/**
 * `ablo connect` sets up Ablo's direct DataSource: a scoped replication role
 * tails committed changes, while a separate least-privilege DML role applies
 * coordinated writes directly to the customer's Postgres.
 *
 * Ablo consumes the logical replication stream and fans the changes out to
 * connected clients as live shapes. Customer Postgres remains authoritative;
 * Ablo applies DML but never owns or migrates application tables. The direct
 * transaction also writes `ablo_idempotency` and emits a logical correlation
 * marker. WAL supplies post-commit truth and confirmation.
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
 *                           item that fails. When this machine can't reach the
 *                           host at all (IPv6-only hosts, IP allowlists, VPNs),
 *                           the check runs from Ablo's infrastructure instead —
 *                           the network replication actually uses.
 *   ablo connect --register Verifies readiness, then registers the database so
 *                           Ablo begins replicating it on the next sync. Local
 *                           unreachability doesn't block it: the server
 *                           validates from its own network at registration.
 */

import { AbloValidationError } from '../errors.js';
import pc from 'picocolors';
import postgres from 'postgres';
import { readProjectDatabaseUrl, readProjectWriteDatabaseUrl } from './dbRole';
import { resolveApiKey } from './config';
import { DEFAULT_URL } from './push';
import { brand } from './theme';
import {
  describeRemoteFailure,
  dialFailureReason,
  requestRemoteValidation,
} from './remoteValidation';
import { idempotencyLedgerMigrations } from '../source/migrations';

/**
 * The canonical Postgres publication name that Ablo's replication reads from.
 * The setup SQL and the replication consumer both use exactly this name, so the
 * recipe you run and the runtime that connects can never disagree.
 */
export const ABLO_PUBLICATION = 'ablo_publication';

/** The least-privilege replication role the recipe prescribes. */
export const ABLO_REPLICATION_ROLE = 'ablo_replicator';

/** The separate least-privilege role used only for direct application DML. */
export const ABLO_WRITE_ROLE = 'ablo_writer';

export const DIRECT_DATA_SOURCE_ROUTES = [
  'public-allowlist',
  'privatelink',
  'peering',
  'vpn',
] as const;
export type DirectDataSourceRoute = (typeof DIRECT_DATA_SOURCE_ROUTES)[number];

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
  /** `--write-role <name>`: scoped DML role (default `ablo_writer`). */
  writeRole: string;
  /** The established inbound network route; every value here is direct. */
  route: DirectDataSourceRoute;
}

/** Parse `connect` flags. Pure — unit-tested without touching a database. */
export function parseConnectArgs(argv: readonly string[]): ConnectArgs {
  let check = false;
  let register = false;
  let auditInfra = false;
  let tables: readonly string[] = [];
  let role = ABLO_REPLICATION_ROLE;
  let writeRole = ABLO_WRITE_ROLE;
  let route: DirectDataSourceRoute = 'public-allowlist';

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
      case '--write-role':
        writeRole = argv[++i] ?? writeRole;
        break;
      case '--route': {
        const value = argv[++i] ?? '';
        if (!DIRECT_DATA_SOURCE_ROUTES.includes(value as DirectDataSourceRoute)) {
          throw new AbloValidationError(
            `invalid direct route: ${value || '(missing)'} (expected ${DIRECT_DATA_SOURCE_ROUTES.join(', ')})`,
            { code: 'cli_invalid_arguments' },
          );
        }
        route = value as DirectDataSourceRoute;
        break;
      }
      default:
        throw new AbloValidationError(`unknown flag: ${arg}`, { code: 'cli_invalid_arguments' });
    }
  }
  if (role === writeRole) {
    throw new AbloValidationError('replication and write roles must be different', {
      code: 'cli_invalid_arguments',
    });
  }
  return { check, register, auditInfra, tables, role, writeRole, route };
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
  readonly writeRole?: string;
}): readonly string[] {
  const role = input.role && input.role.length > 0 ? input.role : ABLO_REPLICATION_ROLE;
  const writeRole =
    input.writeRole && input.writeRole.length > 0 ? input.writeRole : ABLO_WRITE_ROLE;
  const tables = input.tables ?? [];
  const publicationTarget =
    tables.length > 0 ? `FOR TABLE ${tables.map(quoteIdent).join(', ')}` : 'FOR ALL TABLES';

  const applicationGrant =
    tables.length > 0
      ? `GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE ${tables.map(quoteIdent).join(', ')} TO ${quoteIdent(writeRole)};`
      : `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${quoteIdent(writeRole)};`;
  const ledger = idempotencyLedgerMigrations().map((migration) => migration.up);

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
    // 4. A distinct DML role: no replication, role administration, ownership,
    // schema creation, or DDL. It is subject to RLS on every transaction.
    `CREATE ROLE ${quoteIdent(writeRole)} WITH LOGIN PASSWORD '<write-password>' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT;`,
    `ALTER ROLE ${quoteIdent(writeRole)} SET row_security = on;`,
    // PUBLIC can carry CREATE on older Postgres clusters. A role-level REVOKE
    // cannot override that inherited grant, so harden the schema explicitly.
    `REVOKE CREATE ON SCHEMA public FROM PUBLIC;`,
    `GRANT USAGE ON SCHEMA public TO ${quoteIdent(writeRole)};`,
    applicationGrant,
    `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${quoteIdent(writeRole)};`,
    ...(tables.length === 0
      ? [
          `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${quoteIdent(writeRole)};`,
          `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ${quoteIdent(writeRole)};`,
        ]
      : []),
    // 5. Direct uses the durable replay ledger but deliberately no outbox.
    ...ledger,
    `REVOKE ALL ON TABLE public.ablo_idempotency FROM PUBLIC;`,
    `GRANT SELECT, INSERT, UPDATE ON TABLE public.ablo_idempotency TO ${quoteIdent(writeRole)};`,
    `REVOKE DELETE ON TABLE public.ablo_idempotency FROM ${quoteIdent(writeRole)};`,
    // Grant every pg_logical_emit_message variant by lookup instead of one
    // literal signature: PostgreSQL 17 adds an optional fourth `flush`
    // parameter, so the historical three-argument form no longer exists there
    // and a signature-pinned GRANT fails on an otherwise healthy database.
    `DO $$
DECLARE fn regprocedure;
BEGIN
  FOR fn IN
    SELECT p.oid::regprocedure
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'pg_catalog' AND p.proname = 'pg_logical_emit_message'
  LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO ${quoteIdent(writeRole)}', fn);
  END LOOP;
END $$;`,
  ];
}

/**
 * Prints the setup recipe as numbered steps, with the provider-specific caveats
 * (the required restart, and the RDS parameter group and `rds_replication`
 * grant) inline — the points where this setup most often trips people up.
 */
export function printConnectRecipe(args: ConnectArgs): void {
  const sql = connectSetupSql({
    tables: args.tables,
    role: args.role,
    writeRole: args.writeRole,
  });

  console.log(`\n  ${brand('ablo')} ${pc.dim('connect')}  ${pc.dim('direct writes + WAL-settled sync')}\n`);
  console.log(
    `  Ablo applies coordinated writes directly to your Postgres with a scoped DML role. WAL\n` +
      `  observes what committed, orders it with external writes, and confirms it in the sync log.\n` +
      `  Your database stays authoritative; Ablo never owns or migrates your application tables.\n` +
      `  Run this once against your Postgres ${pc.dim('(as a superuser / DB owner)')}:\n`,
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

  console.log(`\n  ${pc.bold('3.')} Create the scoped replication role ${pc.dim('(pick your own replication password)')}`);
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
    `\n  ${pc.bold('4.')} Create the separate DML role and permanent idempotency ledger ` +
      pc.dim('(pick your own write password)'),
  );
  for (const statement of sql.slice(5)) {
    for (const line of statement.split('\n')) console.log(`       ${pc.cyan(line)}`);
  }
  console.log(
    pc.dim(
      `       The writer gets row DML + ledger access only. It has no REPLICATION, schema CREATE,\n` +
        `       role administration, database creation, ownership, or customer-table DDL. Direct uses\n` +
        `       ${pc.bold('ablo_idempotency')} but no outbox; WAL carries the committed row changes.`,
    ),
  );

  console.log(
    `\n  ${pc.bold('5.')} Configure both scoped connections, then verify:\n` +
      `       ${pc.bold('DATABASE_URL')}              ${pc.dim(`→ ${args.role} (replication only)`)}\n` +
      `       ${pc.bold('ABLO_WRITE_DATABASE_URL')}   ${pc.dim(`→ ${args.writeRole} (DML only)`)}\n` +
      `       ${pc.cyan('npx ablo connect --check')}\n`,
  );
  console.log(
    pc.dim(
      `  Reachable databases use this direct path. If no inbound route can be established, use the\n` +
        `  signed ${pc.bold('dataSource()')} endpoint fallback; its correlated events confirm writes\n` +
        `  without an Ablo-side customer database socket.`,
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
interface DirectWriteRoleRow {
  rolname: string;
  rolsuper: boolean;
  rolbypassrls: boolean;
  rolcreatedb: boolean;
  rolcreaterole: boolean;
  rolreplication: boolean;
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
  const walRows = await sql.unsafe<WalLevelRow[]>(
    `SELECT setting FROM pg_settings WHERE name = 'wal_level'`,
  );
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
  const pubRows = await sql.unsafe<PublicationRow[]>(
    `SELECT puballtables FROM pg_publication WHERE pubname = $1`,
    [publication] as never[],
  );
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
  const roleRows = await sql.unsafe<RoleReplRow[]>(
    `SELECT rolreplication, rolsuper FROM pg_roles WHERE rolname = current_user`,
  );
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
    const badRows = await sql.unsafe<BadReplicaIdentityRow[]>(
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
    );
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
 * Validate the direct DML credential independently from the replication role.
 * Keeping this a separate probe is load-bearing: one broad role that happens to
 * pass both checklists is exactly the privilege collapse the setup avoids.
 */
export async function probeDirectWriteReadiness(
  sql: postgres.Sql,
  opts: { readonly schema?: string; readonly publication?: string } = {},
): Promise<readonly CheckItem[]> {
  const schema = opts.schema ?? 'public';
  const publication = opts.publication ?? ABLO_PUBLICATION;
  const items: CheckItem[] = [];

  const roleRows = await sql.unsafe<DirectWriteRoleRow[]>(
    `SELECT rolname, rolsuper, rolbypassrls, rolcreatedb, rolcreaterole, rolreplication
       FROM pg_roles WHERE rolname = current_user`,
  );
  const role = roleRows[0];
  const dangerous = Boolean(
    !role ||
      role.rolsuper ||
      role.rolbypassrls ||
      role.rolcreatedb ||
      role.rolcreaterole ||
      role.rolreplication,
  );
  items.push(
    dangerous
      ? {
          ok: false,
          label: `ABLO_WRITE_DATABASE_URL is not a scoped DML role`,
          fix:
            `Use ${ABLO_WRITE_ROLE} from the setup recipe: NOSUPERUSER, NOBYPASSRLS, ` +
            `NOCREATEDB, NOCREATEROLE, NOREPLICATION.`,
        }
      : { ok: true, label: `write role ${pc.bold(role?.rolname ?? ABLO_WRITE_ROLE)} is DML-only` },
  );

  const schemaRows = await sql.unsafe<{ usage: boolean; create: boolean; row_security: string }[]>(
    `SELECT
       has_schema_privilege(current_user, $1, 'USAGE') AS usage,
       has_schema_privilege(current_user, $1, 'CREATE') AS create,
       current_setting('row_security') AS row_security`,
    [schema] as never[],
  );
  const schemaRow = schemaRows[0];
  items.push(
    schemaRow?.usage && !schemaRow.create && schemaRow.row_security === 'on'
      ? { ok: true, label: `writer uses ${schema} with RLS on and no schema CREATE` }
      : {
          ok: false,
          label: `writer schema/RLS privileges are not least-privilege`,
          fix:
            `REVOKE CREATE ON SCHEMA ${quoteIdent(schema)} FROM PUBLIC; ` +
            `GRANT USAGE ON SCHEMA ${quoteIdent(schema)} TO ${quoteIdent(role?.rolname ?? ABLO_WRITE_ROLE)}; ` +
            `ALTER ROLE ${quoteIdent(role?.rolname ?? ABLO_WRITE_ROLE)} SET row_security = on;`,
        },
  );

  const ledgerName = `${quoteIdent(schema)}.${quoteIdent('ablo_idempotency')}`;
  const ledgerRows = await sql.unsafe<{ present: boolean; writes: boolean; deletes: boolean }[]>(
    `SELECT
       to_regclass($1) IS NOT NULL AS present,
       CASE WHEN to_regclass($1) IS NULL THEN false ELSE has_table_privilege(current_user, $1, 'SELECT,INSERT,UPDATE') END AS writes,
       CASE WHEN to_regclass($1) IS NULL THEN false ELSE has_table_privilege(current_user, $1, 'DELETE') END AS deletes`,
    [ledgerName] as never[],
  );
  const ledger = ledgerRows[0];
  items.push(
    ledger?.present && ledger.writes && !ledger.deletes
      ? { ok: true, label: `${pc.bold('ablo_idempotency')} is durable and protected from DELETE` }
      : {
          ok: false,
          label: `${pc.bold('ablo_idempotency')} is missing or has unsafe grants`,
          fix: `Apply the DML-role and idempotency-ledger statements printed by ${pc.bold('ablo connect')}.`,
        },
  );

  const tableRows = await sql.unsafe<{ relation: string }[]>(
    `SELECT format('%I.%I', schemaname, tablename) AS relation
       FROM pg_publication_tables
      WHERE pubname = $1 AND schemaname = $2 AND tablename <> 'ablo_idempotency'
        AND NOT has_table_privilege(
          current_user,
          format('%I.%I', schemaname, tablename),
          'SELECT,INSERT,UPDATE,DELETE'
        )`,
    [publication, schema] as never[],
  );
  items.push(
    tableRows.length === 0
      ? { ok: true, label: `writer can apply DML to every published application table` }
      : {
          ok: false,
          label: `writer lacks DML on ${tableRows.length} published table${tableRows.length === 1 ? '' : 's'}`,
          fix: `Grant SELECT, INSERT, UPDATE, DELETE on: ${tableRows.map((row) => row.relation).join(', ')}`,
        },
  );

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
    const rows = await sql.unsafe<{ reg: string | null }[]>(
      `SELECT to_regclass($1)::text AS reg`,
      [`public.${name}`] as never[],
    );
    artifacts.push({ kind: 'relation', name, present: rows[0]?.reg != null });
  }
  for (const name of SYNC_INFRA_TYPES) {
    const rows = await sql.unsafe<{ reg: string | null }[]>(
      `SELECT to_regtype($1)::text AS reg`,
      [`public.${name}`] as never[],
    );
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

/** Resolve the separately scoped writer URL; never substitute the replication URL. */
function requireWriteDatabaseUrl(verb: string): string {
  const dbUrl = readProjectWriteDatabaseUrl();
  if (!dbUrl) {
    console.error(
      pc.red('  No ABLO_WRITE_DATABASE_URL found (checked process env, .env.local, .env).') +
        pc.dim(
          ` Set it to the ${ABLO_WRITE_ROLE} connection printed by ${pc.bold('ablo connect')}, ` +
            `then re-run ${pc.bold(`ablo connect ${verb}`)}. The replication credential is never reused for DML.`,
        ),
    );
    process.exit(1);
  }
  return dbUrl;
}

/**
 * What the local dial-and-probe found. `no-dial` means this MACHINE couldn't
 * reach the host at all — which says nothing about whether Ablo's
 * infrastructure can (IPv6-only hosts, IP allowlists, VPNs), so callers treat
 * it as "ask the engine" rather than a verdict.
 */
type LocalProbeOutcome =
  | { readonly kind: 'probed'; readonly failures: number }
  | { readonly kind: 'no-dial'; readonly reason: string };

/**
 * Probe readiness against `dbUrl`, print each item, return the failure count —
 * or report that this machine couldn't dial the host. Exits the process only
 * for errors where the host WAS reached (bad credentials, TLS, a Postgres
 * error): those would fail identically from anywhere, so there is nothing to
 * escalate to the engine.
 */
async function probeAndReport(
  dbUrl: string,
  kind: 'replication' | 'write' = 'replication',
): Promise<LocalProbeOutcome> {
  // Bounded dial, mirroring the engine's own preflight: a black-holed host
  // must surface as a dial failure, not pin the command forever.
  const sql = postgres(dbUrl, { max: 1, prepare: false, connect_timeout: 10, onnotice: () => {} });
  let items: readonly CheckItem[];
  try {
    items =
      kind === 'replication'
        ? await probeReadiness(sql)
        : await probeDirectWriteReadiness(sql);
  } catch (err) {
    await sql.end({ timeout: 2 }).catch(() => undefined);
    const dial = dialFailureReason(err);
    if (dial) return { kind: 'no-dial', reason: dial };
    const pg = (err ?? {}) as PgErrorLike;
    console.error(pc.red(`  Couldn't read the database: ${pg.message ?? String(err)}`));
    process.exit(1);
  }
  await sql.end({ timeout: 2 });

  for (const item of items) printCheckItem(item);
  return { kind: 'probed', failures: items.filter((i) => !i.ok).length };
}

/**
 * The engine-side fallback for `--check`: this machine couldn't dial the host,
 * so ask Ablo to dial from its own infrastructure — the network replication
 * actually runs from — and render the same checklist from its answer.
 */
async function runRemoteCheck(
  dbUrl: string,
  writeDbUrl: string,
  localReason: string,
): Promise<never> {
  console.log(
    `  This machine can't reach one or both scoped connections (${pc.dim(localReason)}).\n` +
      `  That is not the verdict: direct writes and replication run from Ablo's infrastructure.\n` +
      `  Asking Ablo to check both roles from its side…\n`,
  );

  const apiKey = resolveApiKey();
  if (!apiKey) {
    console.error(
      pc.red(`  The engine-side check needs an API key, and none was found.`) +
        pc.dim(
          ` Run ${pc.bold('ablo login')} (or set ${pc.bold('ABLO_API_KEY')}), then re-run ${pc.bold('ablo connect --check')}.`,
        ),
    );
    process.exit(1);
  }

  const apiUrl = (process.env.ABLO_API_URL ?? DEFAULT_URL).replace(/\/+$/, '');
  const result = await requestRemoteValidation({
    apiUrl,
    apiKey,
    connectionString: dbUrl,
    writeConnectionString: writeDbUrl,
  });

  if (!result.ok) {
    console.error(pc.red(`  The engine-side check failed: ${result.message}`));
    if (result.code === 'forbidden') {
      console.error(
        pc.dim(`  Checking a database from Ablo's side needs a ${pc.bold('secret')} key (sk_…). Run ${pc.bold('ablo login')} for one.`),
      );
    }
    console.error();
    process.exit(1);
  }

  if (!result.reachable) {
    console.error(
      `  ${pc.red('✗')} Ablo's infrastructure can't reach both direct connections${result.reason ? ` ${pc.dim(`(${result.reason})`)}` : ''}.`,
    );
    console.error(
      pc.dim(
        `  Direct needs a route Ablo's servers can dial — public allowlist, PrivateLink, peering,\n` +
          `  or VPN. Only when no inbound route can exist, use the signed ${pc.bold('dataSource()')} endpoint fallback.\n`,
      ),
    );
    process.exit(1);
  }

  for (const failure of result.failures) {
    const { label, fix } = describeRemoteFailure(failure);
    printCheckItem({ ok: false, label, fix });
  }
  console.log();
  if (result.ready) {
    console.log(
      `  ${pc.green('✓')} Ready — checked from Ablo's infrastructure. Both direct DML and WAL settlement are available.\n`,
    );
    process.exit(0);
  }
  const count = result.failures.length;
  console.log(
    `  ${pc.red(`${count} item${count === 1 ? '' : 's'} to fix`)} ${pc.dim(`— found by Ablo's infrastructure. Apply the fixes above, then re-run ${pc.bold('ablo connect --check')}.`)}\n`,
  );
  process.exit(1);
}

/** Run the readiness check against DATABASE_URL and report. */
async function runCheck(): Promise<void> {
  const dbUrl = requireDatabaseUrl('--check');
  const writeDbUrl = requireWriteDatabaseUrl('--check');
  console.log(`\n  ${brand('ablo')} ${pc.dim('connect --check')}  ${pc.dim('direct-write + WAL readiness')}\n`);
  console.log(`  ${pc.bold('Replication role')}\n`);
  const replication = await probeAndReport(dbUrl, 'replication');
  console.log(`\n  ${pc.bold('Direct-write role')}\n`);
  const write = await probeAndReport(writeDbUrl, 'write');
  if (replication.kind === 'no-dial' || write.kind === 'no-dial') {
    const reasons = [
      replication.kind === 'no-dial' ? `replication: ${replication.reason}` : null,
      write.kind === 'no-dial' ? `write: ${write.reason}` : null,
    ].filter((reason): reason is string => reason !== null);
    return runRemoteCheck(dbUrl, writeDbUrl, reasons.join('; '));
  }
  const failures = replication.failures + write.failures;
  console.log();
  if (failures === 0) {
    console.log(`  ${pc.green('✓')} Ready — Ablo can apply scoped DML and settle it from WAL.\n`);
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
 * `ablo connect --register` posts to. A bare `/v1/datasources` matches no
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
async function runRegister(args: ConnectArgs): Promise<void> {
  const dbUrl = requireDatabaseUrl('--register');
  const writeDbUrl = requireWriteDatabaseUrl('--register');
  const apiKey = resolveApiKey();
  if (!apiKey) {
    console.error(
      pc.red('  Not logged in.') +
        pc.dim(` Run ${pc.bold('ablo login')} (or set ${pc.bold('ABLO_API_KEY')}) so Ablo knows which project to register this database for.`),
    );
    process.exit(1);
  }

  console.log(`\n  ${brand('ablo')} ${pc.dim('connect --register')}  ${pc.dim('register a direct DataSource')}\n`);

  // The local probe is a fast pre-flight, not the gate. When this machine
  // can't dial the host at all, registration proceeds anyway: the server runs
  // the same readiness checks from Ablo's own network — the one replication
  // actually uses — and refuses with the full checklist if the database isn't
  // ready. Only a probe that CONNECTED and found failures stops us here.
  console.log(`  ${pc.bold('Replication role')}\n`);
  const replication = await probeAndReport(dbUrl, 'replication');
  console.log(`\n  ${pc.bold('Direct-write role')}\n`);
  const write = await probeAndReport(writeDbUrl, 'write');
  const noDial = [
    replication.kind === 'no-dial' ? `replication: ${replication.reason}` : null,
    write.kind === 'no-dial' ? `write: ${write.reason}` : null,
  ].filter((reason): reason is string => reason !== null);
  const failures =
    (replication.kind === 'probed' ? replication.failures : 0) +
    (write.kind === 'probed' ? write.failures : 0);
  if (noDial.length > 0) {
    console.log(
      `  This machine can't reach one or both scoped connections (${pc.dim(noDial.join('; '))}) — continuing anyway.\n` +
        `  Ablo validates both credentials from the infrastructure that will use them and refuses\n` +
        `  registration unless replication and direct DML are both ready.\n`,
    );
  }
  if (failures > 0) {
    console.log(
      `\n  ${pc.red(`${failures} item${failures === 1 ? '' : 's'} to fix`)} ${pc.dim('— direct registration requires both scoped roles. Fix the above, then re-run.')}\n`,
    );
    process.exit(1);
  }

  const apiUrl = (process.env.ABLO_API_URL ?? DEFAULT_URL).replace(/\/+$/, '');
  let res: Response;
  try {
    res = await fetch(registerEndpoint(apiUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        connection: 'direct',
        connectionString: dbUrl,
        writeConnectionString: writeDbUrl,
        route: args.route,
      }),
    });
  } catch (err) {
    console.error(pc.red(`\n  Couldn't reach ${apiUrl}: ${err instanceof Error ? err.message : String(err)}\n`));
    process.exit(1);
  }

  if (res.ok) {
    const body = (await res.json().catch(() => ({}))) as {
      id?: string;
      host?: string;
      status?: string;
    };
    const statusNote = body.status === 'active' ? `${args.route}, active` : args.route;
    console.log(
      `\n  ${pc.green('✓')} Registered${body.host ? ` ${pc.dim(body.host)}` : ''}${body.id ? ` ${pc.dim(`(${body.id})`)}` : ''} as a direct DataSource (${statusNote}).\n` +
        `  Customer COMMIT is durable acceptance; correlated WAL promotes queued writes to confirmed.\n`,
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
  } else if (code === 'database_not_replication_ready' || code === 'data_source_blocked') {
    // The server re-ran the readiness probes from its own side and found failures.
    // It can see a different picture than the local --check — for example a
    // publication added since, or probes running as the replication role rather
    // than yours.
    for (const f of body.details?.failures ?? []) {
      console.error(`  ${pc.red('✗')} ${pc.bold(f.item ?? 'item')}${f.actual ? pc.dim(` (${f.actual})`) : ''}`);
      if (f.fix) for (const line of f.fix.split('\n')) console.error(`      ${pc.red('•')} ${line}`);
    }
    console.error(pc.dim(`\n  Apply the fixes, verify with ${pc.bold('ablo connect --check')}, then re-run.`));
  } else if (code === 'database_unreachable' || code === 'source_unreachable') {
    if (body.details?.reason) console.error(pc.dim(`  ${body.details.reason}`));
    console.error(
      pc.dim(
        `  Ablo's servers must be able to reach this database — a localhost or private-network\n` +
          `  Postgres can't use the direct path. Establish an allowlist, PrivateLink, peering, or VPN.\n` +
          `  Only when no inbound route is possible, register the signed ${pc.bold('dataSource()')} endpoint fallback.`,
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
    await runRegister(args);
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
export const CONNECT_USAGE = `  ablo connect — direct writes, settled by logical replication

  Ablo applies coordinated DML with a scoped writer role. WAL observes what committed,
  orders it with external changes, and confirms it. Your Postgres remains authoritative.

  Usage:
    npx ablo connect                      Print the exact setup SQL for your Postgres
    npx ablo connect --tables a,b,c       Publish only these tables (default: all tables)
    npx ablo connect --role <name>        Name the replication role (default: ablo_replicator)
    npx ablo connect --write-role <name>  Name the DML role (default: ablo_writer)
    npx ablo connect --route <route>      public-allowlist | privatelink | peering | vpn
    npx ablo connect --check              Validate DATABASE_URL + ABLO_WRITE_DATABASE_URL
    npx ablo connect --register           Register both scoped credentials as one direct DataSource
    npx ablo connect --audit-infra        Read-only Stage 5 audit for deprecated Ablo sync tables/types`;
