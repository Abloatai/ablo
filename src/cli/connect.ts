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
 * The mode is a subcommand — `ablo connect <verb>`:
 *
 *   ablo connect             Prints the exact, copy-pasteable setup SQL for your
 *                            Postgres: the WAL level, the publication, and the
 *                            replication role.
 *   ablo connect apply       Runs that setup for you from a one-time admin
 *                            connection, then registers the DataSource.
 *   ablo connect register    Verifies readiness, then registers the database so
 *                            Ablo begins replicating it on the next sync. Local
 *                            unreachability doesn't block it: the server validates
 *                            from its own network at registration.
 *   ablo connect deregister  Removes the DataSource registration — Ablo stops
 *                            reading and writing it (the inverse of register).
 *   ablo connect check       Verifies readiness for the registered database from
 *                            Ablo's own infrastructure — the network replication
 *                            and direct writes actually run from. Needs only
 *                            `ABLO_API_KEY`: Ablo holds the scoped credentials, so
 *                            there is nothing to wire. Prints a checklist (that
 *                            `wal_level` is `logical`, the publication exists, the
 *                            replication role can stream, every published table has
 *                            a usable replica identity, and the writer role is
 *                            DML-ready) with the precise fix for any failing item.
 *   ablo connect rotate      Re-keys both scoped roles and re-registers.
 *   ablo connect scan        Read-only audit for leftover Ablo sync tables/types
 *                            from a prior integration; reports, never drops.
 */

import { AbloValidationError } from '../transaction/errors.js';
import pc from 'picocolors';
import postgres from 'postgres';
import { ABLO_FOOTPRINT, type FootprintKind } from '../source/footprint.js';
import {
  readProjectWriteDatabaseUrl,
  readProjectReplicationUrlWithSource,
  readProjectAdminDatabaseUrl,
} from './dbRole';
import { resolveApiKey } from './config';
import { apiBaseUrl } from './push';
import { brand } from './theme';
import {
  describeRemoteFailure,
  dialFailureReason,
  requestRemoteValidation,
} from './remoteValidation';
// `ablo connect`'s setup primitives (role names, the SQL recipe, the readiness
// probe, DataSource registration) live in ./connectSetup so the `--apply` path
// (./connectApply) shares them without importing this command module back — a
// runtime edge in that direction would close an import cycle.
import {
  ABLO_PUBLICATION,
  ABLO_REPLICATION_ROLE,
  ABLO_WRITE_ROLE,
  connectSetupSql,
  DIRECT_DATA_SOURCE_ROUTES,
  probeReadiness,
  quoteIdent,
  registerDirectDataSource,
  type CheckItem,
  type DirectDataSourceRoute,
} from './connectSetup';

export interface ConnectArgs {
  /** `check`: verify the registered database's readiness from Ablo's side (needs only `ABLO_API_KEY`; no printing of SQL). */
  check: boolean;
  /**
   * `register`: validate readiness, then register this database with Ablo so it
   * begins replicating (`POST /v1/datasources { connectionString }`, authorized
   * by your project key). Registering the database is what enables the read
   * path — there is no separate tier or flag to turn on.
   */
  register: boolean;
  /**
   * `apply`: run the setup for the developer instead of printing SQL — create
   * the scoped roles and publication, enable logical decoding where allowed, and
   * register both scoped roles with Ablo directly. The admin credential is used
   * on this machine only (from `--url`, or `DATABASE_URL` as a fallback) and is
   * never persisted or sent anywhere; nothing is written to your `.env` — your
   * app keeps holding only `ABLO_API_KEY`.
   */
  apply: boolean;
  /**
   * `rotate`: generate fresh passwords for the two scoped roles, `ALTER ROLE`
   * them in place (using the admin credential from `--url` / `DATABASE_URL`), and
   * re-register the new connection strings with Ablo. The revoke-and-replace
   * answer to "what if a role credential leaks?"
   */
  rotate: boolean;
  /**
   * `--url <conn>`: the admin connection string `apply` / `rotate` provision
   * through, passed transiently rather than left in the environment. Falls back
   * to `DATABASE_URL` when omitted. Used on this machine only; never persisted.
   */
  url?: string;
  /** `--yes`: skip the `apply` confirmation (for non-interactive use). */
  yes: boolean;
  /** `--show-sql`: include the exact statements in the `apply` plan. */
  showSql: boolean;
  /**
   * `scan`: a read-only audit that reports leftover Ablo sync tables and types in
   * the database — infrastructure a previous integration may have created. It only
   * reports what it finds and never drops anything.
   */
  scan: boolean;
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
  /**
   * `--manual`: print the setup SQL instead of running it, even when a credential
   * is reachable. Bare `ablo connect` runs the seamless apply path when it can
   * reach the database and a person is present to confirm; this forces the recipe
   * for someone who would rather run the statements themselves.
   */
  manual: boolean;
}

/**
 * Parse `connect` arguments. Pure — unit-tested without touching a database.
 *
 * The mode is a leading subcommand — `ablo connect register|check|apply|rotate|
 * scan` — matching the `<noun> <verb>` grammar of aws/gcloud/stripe. Modifiers
 * (`--url`, `--tables`, `--yes`, …) follow as flags. (`deregister`, the inverse of
 * `register`, is handled one level up in {@link connect} — it forwards to the
 * disconnect implementation.)
 */
export function parseConnectArgs(argv: readonly string[]): ConnectArgs {
  let check = false;
  let register = false;
  let apply = false;
  let rotate = false;
  let url: string | undefined;
  let yes = false;
  let showSql = false;
  let scan = false;
  let manual = false;
  let tables: readonly string[] = [];
  let role = ABLO_REPLICATION_ROLE;
  let writeRole = ABLO_WRITE_ROLE;
  let route: DirectDataSourceRoute = 'public-allowlist';

  // A leading non-flag token is the subcommand — the mode selector.
  let start = 0;
  const lead = argv[0];
  if (lead !== undefined && !lead.startsWith('-')) {
    switch (lead) {
      case 'register':
        register = true;
        break;
      case 'check':
        check = true;
        break;
      case 'apply':
        apply = true;
        break;
      case 'rotate':
        rotate = true;
        break;
      case 'scan':
        scan = true;
        break;
      default:
        throw new AbloValidationError(
          `unknown connect subcommand: ${lead} (expected register, deregister, check, apply, rotate, scan)`,
          { code: 'cli_invalid_arguments' }
        );
    }
    start = 1;
  }

  for (let i = start; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--url':
        url = argv[++i] ?? url;
        break;
      case '--yes':
      case '-y':
        yes = true;
        break;
      case '--show-sql':
        showSql = true;
        break;
      case '--manual':
        manual = true;
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
            { code: 'cli_invalid_arguments' }
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
  return {
    check,
    register,
    apply,
    rotate,
    url,
    yes,
    showSql,
    scan,
    tables,
    role,
    writeRole,
    route,
    manual,
  };
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

  console.log(
    `\n  ${brand('ablo')} ${pc.dim('connect')}  ${pc.dim('direct writes + WAL-settled sync')}\n`
  );
  console.log(
    `  Ablo applies coordinated writes directly to your Postgres with a scoped DML role. WAL\n` +
      `  observes what committed, orders it with external writes, and confirms it in the sync log.\n` +
      `  Your database stays authoritative; Ablo never owns or migrates your application tables.\n\n` +
      `  ${pc.bold('ablo connect apply')} runs every step below for you from a one-time admin\n` +
      `  connection and leaves your app holding only ${pc.bold('ABLO_API_KEY')}. To do it by hand,\n` +
      `  run this once against your Postgres ${pc.dim('(as a superuser / DB owner)')}:\n`
  );

  console.log(
    `  ${pc.bold('1.')} Enable logical decoding ${pc.dim('(then RESTART Postgres — wal_level is not reloadable)')}`
  );
  console.log(`       ${pc.cyan(sql[0])}`);
  console.log(
    pc.dim(
      `       Managed hosts don't take ALTER SYSTEM: on Amazon RDS / Aurora set ${pc.bold('rds.logical_replication = 1')}\n` +
        `       in the parameter group and reboot; on Neon or Supabase enable logical replication in the\n` +
        `       project settings. ${pc.bold('ablo connect apply')} detects the host and does the right thing.`
    )
  );

  console.log(`\n  ${pc.bold('2.')} Publish the tables Ablo should read`);
  console.log(`       ${pc.cyan(sql[1])}`);
  if (args.tables.length === 0) {
    console.log(
      pc.dim(
        `       (Scope it with ${pc.bold('ablo connect --tables a,b,c')} to publish a subset.)`
      )
    );
  }

  // Split on the writer role so the two halves stay correct whether the
  // replication grant is one scoped statement (--tables) or the schema-wide
  // pair (all-tables mode), rather than assuming fixed array positions.
  const writerStart = sql.findIndex((s) => s.includes('NOSUPERUSER NOBYPASSRLS'));
  const replicationStatements = sql.slice(2, writerStart);
  const writerStatements = sql.slice(writerStart);

  console.log(
    `\n  ${pc.bold('3.')} Create the scoped replication role ${pc.dim('(pick your own replication password)')}`
  );
  for (const statement of replicationStatements) {
    for (const line of statement.split('\n')) console.log(`       ${pc.cyan(line)}`);
  }
  console.log(
    pc.dim(
      `       On Amazon RDS, the REPLICATION attribute is granted, not set directly:\n` +
        `       ${pc.bold(`GRANT rds_replication TO ${quoteIdent(args.role)};`)}`
    )
  );

  console.log(
    `\n  ${pc.bold('4.')} Create the separate DML role and the idempotency ledger ` +
      pc.dim('(pick your own write password)')
  );
  for (const statement of writerStatements) {
    for (const line of statement.split('\n')) console.log(`       ${pc.cyan(line)}`);
  }
  console.log(
    pc.dim(
      `       The writer gets row DML + ledger access only. It has no REPLICATION, schema CREATE,\n` +
        `       role administration, database creation, ownership, or customer-table DDL. Direct uses\n` +
        `       ${pc.bold('ablo_idempotency')} but no outbox; WAL carries the committed row changes.\n` +
        `       Each ledger row carries an ${pc.bold('expires_at')}; the writer can't DELETE (tamper-\n` +
        `       resistance), so prune it from your own admin/cron when convenient:\n` +
        `       ${pc.bold('DELETE FROM ablo_idempotency WHERE expires_at < now();')}`
    )
  );

  console.log(
    `\n  ${pc.bold('5.')} Register the two roles with Ablo. Set them just long enough to register —\n` +
      `     Ablo holds them from here, so your app keeps only ${pc.bold('ABLO_API_KEY')}:\n` +
      `       ${pc.bold('ABLO_REPLICATION_DATABASE_URL')}   ${pc.dim(`→ ${args.role} (replication only)`)}\n` +
      `       ${pc.bold('ABLO_WRITE_DATABASE_URL')}         ${pc.dim(`→ ${args.writeRole} (DML only)`)}\n` +
      `       ${pc.cyan('npx ablo connect register')}\n`
  );
  console.log(
    `  ${pc.bold('6.')} Verify readiness ${pc.dim('(checked from Ablo’s side — needs only ABLO_API_KEY):')}\n` +
      `       ${pc.cyan('npx ablo connect check')}\n`
  );
  console.log(
    pc.dim(
      `  Reachable databases use this direct path. If no inbound route can be established, use the\n` +
        `  signed ${pc.bold('dataSource()')} endpoint fallback; its correlated events confirm writes\n` +
        `  without an Ablo-side customer database socket.`
    )
  );
  console.log();
}

// ── readiness checks: `check` (engine-side, registered source) + the local
//    pre-registration probe `register` / `scan` run before handing a
//    connection to Ablo ─────────────────────────────────────────────────────

interface DirectWriteRoleRow {
  rolname: string;
  rolsuper: boolean;
  rolbypassrls: boolean;
  rolcreatedb: boolean;
  rolcreaterole: boolean;
  rolreplication: boolean;
}

/** A query error from the `postgres` client — the one field worth surfacing. */
interface PgErrorLike {
  message?: string;
}

/**
 * One entry of the audit: a footprint object and whether this database has it.
 * The declaration is carried through rather than flattened to a name, so the
 * report can lead with what leaving the object behind costs.
 */
export interface SyncInfraArtifact {
  readonly kind: FootprintKind;
  readonly name: string;
  readonly present: boolean;
  /** What it is for, from the footprint declaration. */
  readonly purpose: string;
  /** Set when leaving it in place has a cost worth naming. */
  readonly hazard?: string;
  /** Installed by an older Ablo only — never by a current one. */
  readonly retired?: boolean;
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
 * Validate the direct DML credential independently from the replication role.
 * Keeping this a separate probe is load-bearing: one broad role that happens to
 * pass both checklists is exactly the privilege collapse the setup avoids.
 */
export async function probeDirectWriteReadiness(
  sql: postgres.Sql,
  opts: { readonly schema?: string; readonly publication?: string } = {}
): Promise<readonly CheckItem[]> {
  const schema = opts.schema ?? 'public';
  const publication = opts.publication ?? ABLO_PUBLICATION;
  const items: CheckItem[] = [];

  const roleRows = await sql.unsafe<DirectWriteRoleRow[]>(
    `SELECT rolname, rolsuper, rolbypassrls, rolcreatedb, rolcreaterole, rolreplication
       FROM pg_roles WHERE rolname = current_user`
  );
  const role = roleRows[0];
  const dangerous = Boolean(
    !role ||
    role.rolsuper ||
    role.rolbypassrls ||
    role.rolcreatedb ||
    role.rolcreaterole ||
    role.rolreplication
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
      : { ok: true, label: `write role ${pc.bold(role?.rolname ?? ABLO_WRITE_ROLE)} is DML-only` }
  );

  const schemaRows = await sql.unsafe<{ usage: boolean; create: boolean; row_security: string }[]>(
    `SELECT
       has_schema_privilege(current_user, $1, 'USAGE') AS usage,
       has_schema_privilege(current_user, $1, 'CREATE') AS create,
       current_setting('row_security') AS row_security`,
    [schema] as never[]
  );
  const schemaRow = schemaRows[0];
  items.push(
    schemaRow?.usage && !schemaRow.create && schemaRow.row_security === 'on'
      ? { ok: true, label: `writer uses ${schema} with row_security on and no schema CREATE` }
      : {
          ok: false,
          label: `writer schema/RLS privileges are not least-privilege`,
          fix:
            `REVOKE CREATE ON SCHEMA ${quoteIdent(schema)} FROM PUBLIC; ` +
            `GRANT USAGE ON SCHEMA ${quoteIdent(schema)} TO ${quoteIdent(role?.rolname ?? ABLO_WRITE_ROLE)}; ` +
            `ALTER ROLE ${quoteIdent(role?.rolname ?? ABLO_WRITE_ROLE)} SET row_security = on;`,
        }
  );

  const ledgerName = `${quoteIdent(schema)}.${quoteIdent('ablo_idempotency')}`;
  const ledgerRows = await sql.unsafe<{ present: boolean; writes: boolean; deletes: boolean }[]>(
    `SELECT
       to_regclass($1) IS NOT NULL AS present,
       CASE WHEN to_regclass($1) IS NULL THEN false ELSE has_table_privilege(current_user, $1, 'SELECT,INSERT,UPDATE') END AS writes,
       CASE WHEN to_regclass($1) IS NULL THEN false ELSE has_table_privilege(current_user, $1, 'DELETE') END AS deletes`,
    [ledgerName] as never[]
  );
  const ledger = ledgerRows[0];
  items.push(
    ledger?.present && ledger.writes && !ledger.deletes
      ? { ok: true, label: `${pc.bold('ablo_idempotency')} is durable and protected from DELETE` }
      : {
          ok: false,
          label: `${pc.bold('ablo_idempotency')} is missing or has unsafe grants`,
          fix: `Apply the DML-role and idempotency-ledger statements printed by ${pc.bold('ablo connect')}.`,
        }
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
    [publication, schema] as never[]
  );
  items.push(
    tableRows.length === 0
      ? { ok: true, label: `writer can apply DML to every published application table` }
      : {
          ok: false,
          label: `writer lacks DML on ${tableRows.length} published table${tableRows.length === 1 ? '' : 's'}`,
          fix: `Grant SELECT, INSERT, UPDATE, DELETE on: ${tableRows.map((row) => row.relation).join(', ')}`,
        }
  );

  // Honest coverage report: row_security = on only does something on a table
  // that HAS policies. Tell the operator exactly how many of their published
  // tables actually govern the writer, rather than implying RLS protects a
  // schema that may have none. This is information, not a failure — RLS is the
  // customer's choice — so it never flips the check red.
  const rlsCoverageRows = await sql.unsafe<{ total: number; with_rls: number }[]>(
    `SELECT
       count(*)::int AS total,
       (count(*) FILTER (WHERE c.relrowsecurity))::int AS with_rls
       FROM pg_publication_tables pt
       JOIN pg_class c ON c.relname = pt.tablename
       JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = pt.schemaname
      WHERE pt.pubname = $1 AND pt.schemaname = $2 AND pt.tablename <> 'ablo_idempotency'`,
    [publication, schema] as never[]
  );
  const coverage = rlsCoverageRows[0];
  if (coverage && coverage.total > 0) {
    const { total, with_rls: withRls } = coverage;
    const plural = total === 1 ? '' : 's';
    items.push(
      withRls === total
        ? {
            ok: true,
            label: `row-level security governs the writer on all ${total} published table${plural}`,
          }
        : {
            ok: true,
            label:
              `row-level security governs the writer on ${withRls} of ${total} published tables — ` +
              `the other ${total - withRls} have no policies, so the writer's table grants alone bound it`,
          }
    );
  }

  // Enforcement canary: a table owner bypasses row-level security unless the
  // table forces it (NO FORCE is the default). If the writer role owns a
  // published table whose RLS is enabled but not forced, its policies are
  // silently skipped for that role — a green DML check would mask a tenant-
  // isolation hole. Non-owner writers (the recipe's default) never hit this.
  const ownerBypassRows = await sql.unsafe<{ relation: string }[]>(
    `SELECT format('%I.%I', n.nspname, c.relname) AS relation
       FROM pg_publication_tables pt
       JOIN pg_class c ON c.relname = pt.tablename
       JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = pt.schemaname
      WHERE pt.pubname = $1 AND pt.schemaname = $2 AND pt.tablename <> 'ablo_idempotency'
        AND c.relowner = (SELECT oid FROM pg_roles WHERE rolname = current_user)
        AND c.relrowsecurity = true
        AND c.relforcerowsecurity = false`,
    [publication, schema] as never[]
  );
  items.push(
    ownerBypassRows.length === 0
      ? {
          ok: true,
          label: `row-level security is enforced on the writer — it owns no published table that could bypass its own policies`,
        }
      : {
          ok: false,
          label: `writer owns ${ownerBypassRows.length} published table${ownerBypassRows.length === 1 ? '' : 's'} whose RLS is enabled but not forced — its policies are silently skipped`,
          fix:
            `A table owner bypasses row-level security unless the table forces it. Reassign these tables to another owner, ` +
            `or force it: ${ownerBypassRows.map((r) => `ALTER TABLE ${r.relation} FORCE ROW LEVEL SECURITY;`).join(' ')}`,
        }
  );

  return items;
}

/** The catalog lookup that answers "is this object here", per object class. */
const FOOTPRINT_LOOKUP: Readonly<Record<FootprintKind, string>> = {
  table: `SELECT to_regclass($1)::text IS NOT NULL AS present`,
  type: `SELECT to_regtype($1)::text IS NOT NULL AS present`,
  publication: `SELECT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = $1) AS present`,
  slot: `SELECT EXISTS (SELECT 1 FROM pg_replication_slots WHERE slot_name = $1) AS present`,
  role: `SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1) AS present`,
};

/**
 * Reports which parts of Ablo's footprint this database still holds.
 *
 * Read-only by design: it reports and never drops, since removing any of it is a
 * deliberate, confirmed step rather than something the CLI does on its own.
 *
 * It walks {@link ABLO_FOOTPRINT} — the same declaration the setup SQL and the
 * replication runtime read — rather than a list of its own. The list of its own
 * is why this audit spent a generation looking only for tables an earlier Ablo
 * installed, while reporting nothing about the publication, the roles, the
 * bookkeeping table, or the replication slot that Ablo actually leaves behind.
 */
export async function auditTenantSyncInfra(
  sql: postgres.Sql
): Promise<readonly SyncInfraArtifact[]> {
  const artifacts: SyncInfraArtifact[] = [];
  for (const artifact of ABLO_FOOTPRINT) {
    // Tables and types are resolved through the search path; a publication,
    // slot, or role is cluster- or database-wide and has no schema.
    const key =
      artifact.kind === 'table' || artifact.kind === 'type'
        ? `public.${artifact.name}`
        : artifact.name;
    const rows = await sql.unsafe<{ present: boolean | null }[]>(
      FOOTPRINT_LOOKUP[artifact.kind],
      [key] as never[]
    );
    artifacts.push({
      kind: artifact.kind,
      name: artifact.name,
      present: rows[0]?.present === true,
      purpose: artifact.purpose,
      ...(artifact.hazard ? { hazard: artifact.hazard } : {}),
      ...(artifact.retired ? { retired: true } : {}),
    });
  }
  return artifacts;
}

/**
 * Resolve one of the two scoped connection strings from the environment, or exit
 * with the precise fix. `register` needs both; `scan` needs the
 * replication one. They are separate secrets that must never substitute for each
 * other, so the lookup and its remediation live together, one branch per
 * credential.
 */
function requireScopedUrl(kind: 'replication' | 'write', verb: string): string {
  if (kind === 'replication') {
    // As of 0.32.0 the replication credential comes only from
    // ABLO_REPLICATION_DATABASE_URL. The deprecated `DATABASE_URL` fallback was
    // removed: reading a scoped string from the generic `DATABASE_URL` risked
    // validating against the app's own database. (`--apply` still uses
    // `DATABASE_URL` for its one-time admin input — a separate, honest job.)
    const resolved = readProjectReplicationUrlWithSource();
    if (resolved) return resolved.url;
    console.error(
      pc.red('  No replication connection found (checked process env, .env.local, .env).') +
        pc.dim(
          ` Set ${pc.bold('ABLO_REPLICATION_DATABASE_URL')} to the ${ABLO_REPLICATION_ROLE} connection ` +
            `printed by ${pc.bold('ablo connect')}, then re-run ${pc.bold(`ablo connect ${verb}`)}.`
        )
    );
    process.exit(1);
  }

  // The writer URL is a separately scoped secret — never substitute the
  // replication URL for it.
  const dbUrl = readProjectWriteDatabaseUrl();
  if (dbUrl) return dbUrl;
  console.error(
    pc.red('  No ABLO_WRITE_DATABASE_URL found (checked process env, .env.local, .env).') +
      pc.dim(
        ` Set it to the ${ABLO_WRITE_ROLE} connection printed by ${pc.bold('ablo connect')}, ` +
          `then re-run ${pc.bold(`ablo connect ${verb}`)}. The replication credential is never reused for DML.`
      )
  );
  process.exit(1);
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
  kind: 'replication' | 'write' = 'replication'
): Promise<LocalProbeOutcome> {
  // Bounded dial, mirroring the engine's own preflight: a black-holed host
  // must surface as a dial failure, not pin the command forever.
  const sql = postgres(dbUrl, { max: 1, prepare: false, connect_timeout: 10, onnotice: () => {} });
  let items: readonly CheckItem[];
  try {
    items =
      kind === 'replication' ? await probeReadiness(sql) : await probeDirectWriteReadiness(sql);
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
 * `--check`: report readiness for the database Ablo has registered for this
 * plane, checked from Ablo's own infrastructure — the network replication and
 * direct writes actually run from. It needs only `ABLO_API_KEY`: Ablo holds the
 * scoped credentials, so there is no connection string to wire or keep. A
 * database that isn't connected yet has nothing to check — run
 * `ablo connect apply` first.
 */
async function runCheck(): Promise<void> {
  console.log(
    `\n  ${brand('ablo')} ${pc.dim('connect check')}  ${pc.dim('direct-write + WAL readiness')}\n`
  );

  const apiKey = resolveApiKey();
  if (!apiKey) {
    console.error(
      pc.red('  No API key found.') +
        pc.dim(
          ` Run ${pc.bold('ablo login')} (or set ${pc.bold('ABLO_API_KEY')}), then re-run ${pc.bold('ablo connect check')}.`
        )
    );
    process.exit(1);
  }

  const apiUrl = apiBaseUrl();
  const result = await requestRemoteValidation({ apiUrl, apiKey });

  if (!result.ok) {
    if (result.code === 'no_data_source_registered') {
      console.error(
        `  ${pc.yellow('—')} No database is connected to this plane yet, so there's nothing to check.\n` +
          pc.dim(
            `  Connect one with ${pc.bold('ablo connect apply')}, then re-run ${pc.bold('ablo connect check')}.\n`
          )
      );
      process.exit(1);
    }
    console.error(pc.red(`  The check failed: ${result.message}`));
    if (result.code === 'forbidden') {
      console.error(
        pc.dim(
          `  Checking a connected database needs a ${pc.bold('secret')} key (sk_…). Run ${pc.bold('ablo login')} for one.`
        )
      );
    }
    console.error();
    process.exit(1);
  }

  if (!result.reachable) {
    console.error(
      `  ${pc.red('✗')} Ablo's infrastructure can't reach your database${result.reason ? ` ${pc.dim(`(${result.reason})`)}` : ''}.`
    );
    console.error(
      pc.dim(
        `  Direct needs a route Ablo's servers can dial — public allowlist, PrivateLink, peering,\n` +
          `  or VPN. Only when no inbound route can exist, use the signed ${pc.bold('dataSource()')} endpoint fallback.\n`
      )
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
      `  ${pc.green('✓')} Ready — checked from Ablo's infrastructure. Ablo can apply scoped DML and settle it from WAL.\n`
    );
    process.exit(0);
  }
  const count = result.failures.length;
  console.log(
    `  ${pc.red(`${count} item${count === 1 ? '' : 's'} to fix`)} ${pc.dim(`— apply the fixes above, then re-run ${pc.bold('ablo connect check')}.`)}\n`
  );
  process.exit(1);
}

/**
 * Register the replication connection (`ABLO_REPLICATION_DATABASE_URL`) as this
 * project's data source: the engine replicates it
 * on the next sync. Validates readiness first (registering a database that can't
 * stream is a silent dead end), then `POST /api/v1/datasources { connectionString }`
 * authed by the project key — the org is derived server-side from the key, never
 * sent in the body.
 */
async function runRegister(args: ConnectArgs): Promise<void> {
  const dbUrl = requireScopedUrl('replication', 'register');
  const writeDbUrl = requireScopedUrl('write', 'register');
  const apiKey = resolveApiKey();
  if (!apiKey) {
    console.error(
      pc.red('  Not logged in.') +
        pc.dim(
          ` Run ${pc.bold('ablo login')} (or set ${pc.bold('ABLO_API_KEY')}) so Ablo knows which project to register this database for.`
        )
    );
    process.exit(1);
  }

  console.log(
    `\n  ${brand('ablo')} ${pc.dim('connect register')}  ${pc.dim('register a direct DataSource')}\n`
  );

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
        `  registration unless replication and direct DML are both ready.\n`
    );
  }
  if (failures > 0) {
    console.log(
      `\n  ${pc.red(`${failures} item${failures === 1 ? '' : 's'} to fix`)} ${pc.dim('— direct registration requires both scoped roles. Fix the above, then re-run.')}\n`
    );
    process.exit(1);
  }

  const apiUrl = apiBaseUrl();
  const registered = await registerDirectDataSource({
    apiUrl,
    apiKey,
    replicationUrl: dbUrl,
    writeUrl: writeDbUrl,
    route: args.route,
  });
  process.exit(registered ? 0 : 1);
}

async function runScan(): Promise<void> {
  const dbUrl = requireScopedUrl('replication', 'scan');
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

  console.log(
    `\n  ${brand('ablo')} ${pc.dim('connect scan')}  ${pc.dim("what Ablo has in this database")}\n`
  );
  const present = artifacts.filter((a) => a.present);
  if (present.length === 0) {
    console.log(`  ${pc.green('✓')} Nothing of Ablo's is in this database.\n`);
    process.exit(0);
  }

  // Current objects are what a connected database is SUPPOSED to hold, so they
  // are reported, not flagged. Retired ones are the leftovers — no current Ablo
  // creates them, so their presence is always something to clean up.
  const current = present.filter((a) => !a.retired);
  const retired = present.filter((a) => a.retired);

  if (current.length > 0) {
    console.log(`  ${pc.dim("What Ablo's setup put here:")}\n`);
    for (const artifact of current) {
      console.log(`  ${pc.green('•')} ${artifact.kind} ${pc.bold(artifact.name)}`);
      console.log(`      ${pc.dim(artifact.purpose)}`);
      // The slot is the one object whose cost of being left behind is the
      // database's, not Ablo's — so it is said out loud rather than filed
      // under a name the reader would have to already understand.
      if (artifact.hazard) console.log(`      ${pc.yellow(artifact.hazard)}`);
    }
    console.log('');
  }

  if (retired.length > 0) {
    console.log(`  ${pc.dim('Left by an older version of Ablo — safe to remove:')}\n`);
    for (const artifact of retired) {
      console.log(`  ${pc.yellow('!')} ${artifact.kind} ${pc.bold(artifact.name)}`);
      console.log(`      ${pc.dim(artifact.purpose)}`);
    }
    console.log(
      `\n  ${pc.dim('Nothing is dropped for you — removing any of it is your call. Once this ')}` +
        `${pc.dim("database is disconnected, none of it is read again.")}\n`
    );
  }

  process.exit(retired.length > 0 ? 1 : 0);
}

export async function connect(argv: readonly string[]): Promise<void> {
  // `deregister` is the inverse of `register`; it forwards to the disconnect
  // implementation (lazy-imported, mirroring how `apply` reaches connectApply)
  // rather than duplicating it.
  if (argv[0] === 'deregister') {
    const { disconnect } = await import('./disconnect');
    await disconnect(argv.slice(1));
    return;
  }

  let args: ConnectArgs;
  try {
    args = parseConnectArgs(argv);
  } catch (err) {
    console.error(pc.red(`  ${err instanceof Error ? err.message : String(err)}`));
    process.exit(1);
  }

  if (args.apply || args.rotate) {
    const { runConnectApply } = await import('./connectApply');
    await runConnectApply(args);
    return;
  }
  if (args.check) {
    await runCheck();
    return;
  }
  if (args.register) {
    await runRegister(args);
    return;
  }
  if (args.scan) {
    await runScan();
    return;
  }

  // Bare `ablo connect`, no subcommand. The seamless path — plain-language plan,
  // confirm, apply — is fully built inside `apply` and carries every property
  // the SQL wall was standing in for: two scoped roles rather than one omnipotent
  // one, an admin credential used once and never persisted, a footprint that
  // `connect scan` audits and `connect deregister` removes. What reads as
  // enterprise ceremony is the wall of DDL, and that is a presentation default,
  // not the security model — `apply` already hides its own SQL behind
  // `--show-sql` on the same principle. So bare `connect` runs `apply` WHEN it is
  // safe to, and prints the recipe otherwise:
  //
  //   - no reachable credential          → recipe (there is nothing to apply with)
  //   - no TTY and no explicit `--yes`   → recipe (an agent or CI job, with no
  //                                        human to see the confirm — the one
  //                                        case where auto-applying is reckless)
  //   - `--manual`                       → recipe (asked for it)
  //   - otherwise                        → apply (a person, at a database Ablo
  //                                        can reach; `apply` still confirms)
  //
  // `apply` owns the confirm and its own non-TTY guard, so this decides only
  // whether the seamless path is even offered, never whether it runs unattended.
  const credentialReachable = (args.url ?? readProjectAdminDatabaseUrl()) != null;
  const canConfirm = process.stdout.isTTY || args.yes;
  if (!args.manual && credentialReachable && canConfirm) {
    const { runConnectApply } = await import('./connectApply');
    await runConnectApply(args);
    return;
  }
  printConnectRecipe(args);
}

/**
 * Usage text for `ablo connect --help`. Kept beside the parser (and exported
 * so the CLI dispatcher can print it) so the two never drift.
 */
export const CONNECT_USAGE = `  ablo connect — connect your own database

  Your database stays the source of truth. Ablo writes through a narrowly scoped
  login you create, watches what actually commits, and confirms each write back.

  Usage:
    npx ablo connect                      Set it up for you when Ablo can reach your database; otherwise print the SQL
    npx ablo connect --manual             Print the exact setup SQL instead of running it
    npx ablo connect register             Register the logins after running the SQL yourself
    npx ablo connect deregister           Disconnect this project's database — Ablo stops reading and writing it
    npx ablo connect check                Confirm the connected database is ready, from Ablo's side (needs only ABLO_API_KEY)
    npx ablo connect rotate               New passwords for both logins, then re-register
    npx ablo connect scan                 List anything Ablo ever set up in your database (read-only, never drops)

  Running it: bare \`ablo connect\` sets everything up for you — creating the two
  scoped logins, sharing your tables, and registering — whenever it finds a
  database it can reach (\`--url\`, else DATABASE_URL) and a terminal to confirm in.
  With no reachable database, no terminal (an agent or CI run) unless you pass
  \`--yes\`, or \`--manual\`, it prints the SQL for you to run yourself. \`apply\` is
  kept as an explicit spelling of the same thing.

  Modifiers:
    --url <admin-conn>   Admin connection used once to set up (else DATABASE_URL); never stored
    --tables a,b,c       Publish only these tables (default: all tables)
    --role <name>        Name the replication role (default: ablo_replicator)
    --write-role <name>  Name the DML role (default: ablo_writer)
    --route <route>      public-allowlist | privatelink | peering | vpn
    --manual             Print the setup SQL instead of running it
    --yes                Set up without the confirmation (non-interactive)
    --show-sql           Show the exact statements before running them

  apply registers with Ablo directly; the admin credential is used only on this
  machine and never persisted. Your app holds only ABLO_API_KEY.`;
