/**
 * The `ablo connect` setup engine: the primitives that both the recipe printer
 * (`connect.ts`, which prints the SQL and drives the CLI) and the applier
 * (`connectApply.ts`, which runs it for you under `--apply`) share.
 *
 * Keeping them here rather than in `connect.ts` is what lets the applier reach
 * them without importing the command module back — `connect.ts` lazy-imports
 * the applier, so a runtime edge in the other direction would close an import
 * cycle. The grants, role names, and readiness checks live in exactly one
 * place, so the recipe you run, the applier that runs it, and the checklist
 * that verifies it can never quietly disagree.
 */

import pc from 'picocolors';
import type postgres from 'postgres';
import { z } from 'zod';
import { idempotencyLedgerMigrations } from '@ablo/transaction/source';

// The names of the objects the recipe creates come from the footprint, which is
// also what the audit reads — so an object this setup starts creating cannot
// become one the audit fails to look for. Imported as well as re-exported: a
// bare `export … from` re-exports without binding the names in this module,
// and the SQL builders below use all three.
import {
  ABLO_PUBLICATION,
  ABLO_REPLICATION_ROLE,
  ABLO_WRITE_ROLE,
} from '@ablo/transaction/footprint';
import { detectPooler } from './connectApply';

export { ABLO_PUBLICATION, ABLO_REPLICATION_ROLE, ABLO_WRITE_ROLE };

/** The host a connection string addresses, for naming it back to the reader. */
function hostLabel(connectionString: string): string {
  try {
    return new URL(connectionString).hostname || 'this host';
  } catch {
    return 'this host';
  }
}

export const DIRECT_DATA_SOURCE_ROUTES = [
  'public-allowlist',
  'privatelink',
  'peering',
  'vpn',
] as const;
export type DirectDataSourceRoute = (typeof DIRECT_DATA_SOURCE_ROUTES)[number];

export function quoteIdent(id: string): string {
  return `"${id.replace(/"/g, '""')}"`;
}

/** A Postgres string literal (single quotes doubled). */
function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Grant the writer USAGE + SELECT on exactly the sequences the published tables
 * own — their SERIAL / identity columns — rather than every sequence in the
 * schema. The owned sequences are resolved from the catalog at apply time, so a
 * new identity column on one of the same tables is covered without widening the
 * grant to sequences that belong to tables you did not publish.
 */
function scopedSequenceGrant(tables: readonly string[], writeRole: string): string {
  const names = tables.map(quoteLiteral).join(', ');
  return `DO $$
DECLARE seq regclass;
BEGIN
  FOR seq IN
    SELECT DISTINCT d.objid::regclass
    FROM pg_depend d
    JOIN pg_class s ON s.oid = d.objid AND s.relkind = 'S'
    JOIN pg_class t ON t.oid = d.refobjid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE d.deptype IN ('a', 'i') AND n.nspname = 'public' AND t.relname IN (${names})
  LOOP
    EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE %s TO ${quoteIdent(writeRole)}', seq);
  END LOOP;
END $$;`;
}

/**
 * Returns the setup SQL as an array of statements, so it can be both printed as a
 * recipe and asserted in tests. Precisely: the runtime roles own nothing and run
 * no DDL on your tables — the writer applies row DML, the replicator only reads.
 * This provisioning, which you run once with your own admin credential, creates
 * exactly one Ablo bookkeeping table (`ablo_idempotency`) and nothing else; it
 * never alters, owns, or migrates your application tables.
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

  const tableList = tables.map(quoteIdent).join(', ');
  const scoped = tables.length > 0;

  const applicationGrant = scoped
    ? `GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE ${tableList} TO ${quoteIdent(writeRole)};`
    : `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${quoteIdent(writeRole)};`;

  // The replication role reads the published tables for the initial snapshot.
  // Scoped to exactly those tables when you name them — no access to the rest of
  // the schema, and no default-privilege grant reaching future tables. Only
  // "all tables" mode (no --tables) grants schema-wide, matching its publication.
  const replicationReadGrants = scoped
    ? [`GRANT SELECT ON TABLE ${tableList} TO ${quoteIdent(role)};`]
    : [
        `GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${quoteIdent(role)};`,
        `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO ${quoteIdent(role)};`,
      ];

  // The writer needs each published table's owned sequences (SERIAL / identity
  // columns). Scoped to those tables' sequences when you name them.
  const writerSequenceGrants = scoped
    ? [scopedSequenceGrant(tables, writeRole)]
    : [`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${quoteIdent(writeRole)};`];

  const ledger = idempotencyLedgerMigrations().map((migration) => migration.up);

  return [
    // 1. Turn on logical decoding. Requires a restart (it's not reloadable).
    `ALTER SYSTEM SET wal_level = 'logical';`,
    // 2. Publish the tables Ablo should read.
    `CREATE PUBLICATION ${quoteIdent(ABLO_PUBLICATION)} ${publicationTarget};`,
    // 3. A least-privilege role: it can stream replication and SELECT the
    // published tables, nothing more.
    `CREATE ROLE ${quoteIdent(role)} WITH REPLICATION LOGIN PASSWORD '<password>';`,
    ...replicationReadGrants,
    // 4. A distinct DML role: no replication, role administration, ownership,
    // schema creation, or DDL. It runs NOBYPASSRLS with row_security on, so on a
    // table that HAS row-level-security policies they govern its writes and it
    // can't bypass them; on a table without policies there is nothing to apply
    // and the table grants alone bound it.
    `CREATE ROLE ${quoteIdent(writeRole)} WITH LOGIN PASSWORD '<write-password>' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT;`,
    `ALTER ROLE ${quoteIdent(writeRole)} SET row_security = on;`,
    // Every Postgres database GRANTs TEMP on itself to PUBLIC out of the box,
    // and PUBLIC grants reach every role regardless of NOINHERIT — so without
    // this revoke the writer holds create/temp authority Ablo's write gate
    // refuses, on a completely stock database. Database-level only: the
    // schema-level CREATE the customer's own roles may rely on is never
    // touched here (that stays a checklist fix they apply knowingly). Object
    // owners keep their privileges implicitly; re-grant TEMPORARY to your own
    // roles that need it.
    `-- required: removes the create/temp defaults every login inherits, so the writer stays DML-only
DO $$ BEGIN
  EXECUTE format('REVOKE TEMPORARY, CREATE ON DATABASE %I FROM PUBLIC', current_database());
END $$;`,
    `GRANT USAGE ON SCHEMA public TO ${quoteIdent(writeRole)};`,
    applicationGrant,
    ...writerSequenceGrants,
    ...(scoped
      ? []
      : [
          // "All tables" mode only: keep future tables/sequences writable so the
          // publication doesn't outgrow the grant.
          `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${quoteIdent(writeRole)};`,
          `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ${quoteIdent(writeRole)};`,
        ]),
    // 5. Direct uses the durable replay ledger but deliberately no outbox.
    ...ledger,
    `REVOKE ALL ON TABLE public.ablo_idempotency FROM PUBLIC;`,
    `GRANT SELECT, INSERT, UPDATE ON TABLE public.ablo_idempotency TO ${quoteIdent(writeRole)};`,
    `REVOKE DELETE ON TABLE public.ablo_idempotency FROM ${quoteIdent(writeRole)};`,
    // The writer emits a transactional marker on your WAL so Ablo can correlate
    // the committed row back to the originating write and confirm it — this
    // EXECUTE grant is what makes that confirmation possible. Granted by lookup
    // across every pg_logical_emit_message variant instead of one literal
    // signature: PostgreSQL 17 adds an optional fourth `flush` parameter, so the
    // historical three-argument form no longer exists there and a signature-
    // pinned GRANT fails on an otherwise healthy database.
    `-- required: grants the writer Ablo's WAL write-confirmation marker function
DO $$
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

/** The current membership of `ablo_publication`, read from the catalog. */
export interface PublicationState {
  readonly exists: boolean;
  /** A `FOR ALL TABLES` publication — its membership can't be narrowed with SET TABLE. */
  readonly allTables: boolean;
  /** Public-schema tables currently published (empty for a FOR ALL TABLES publication). */
  readonly tables: readonly string[];
}

/** The statements plus the human-readable diff to bring the publication in line with `--tables`. */
export interface PublicationReconcile {
  readonly sql: readonly string[];
  readonly added: readonly string[];
  readonly removed: readonly string[];
  /** True when the change flips publication mode (all-tables ⇄ scoped), so it's a drop+recreate. */
  readonly recreated: boolean;
}

/**
 * Bring `ablo_publication` in line with the declared `--tables` — the same
 * declarative model Debezium's `publication.autocreate.mode = filtered` uses: the
 * publication is kept equal to the capture set instead of accreting a stale table
 * list from an earlier connect.
 *
 * A scoped→scoped change is one transactional `ALTER PUBLICATION … SET TABLE`. SET
 * replaces the whole membership, and because we always pass the complete desired
 * list — never a hand-picked subset — the "SET forgot a table" footgun can't apply.
 * A mode flip (`FOR ALL TABLES` ⇄ scoped) can't be ALTERed, so it's a drop+recreate.
 * Newly published tables only stream once the engine snapshots them on
 * (re)registration; this customer-side statement is the whole of the CLI's job.
 */
export function reconcilePublicationPlan(
  current: PublicationState,
  desiredTables: readonly string[]
): PublicationReconcile {
  const pub = quoteIdent(ABLO_PUBLICATION);
  const desiredAll = desiredTables.length === 0;
  const target = desiredAll
    ? 'FOR ALL TABLES'
    : `FOR TABLE ${desiredTables.map(quoteIdent).join(', ')}`;

  if (!current.exists) {
    return {
      sql: [`CREATE PUBLICATION ${pub} ${target};`],
      added: desiredAll ? [] : [...desiredTables],
      removed: [],
      recreated: false,
    };
  }

  // A mode flip can't be ALTERed: SET TABLE is rejected on a FOR ALL TABLES
  // publication, and a scoped one can't be widened to all-tables. Drop + recreate.
  if (current.allTables !== desiredAll) {
    return {
      sql: [`DROP PUBLICATION IF EXISTS ${pub};`, `CREATE PUBLICATION ${pub} ${target};`],
      added: desiredAll ? [] : desiredTables.filter((t) => !current.tables.includes(t)),
      removed: current.allTables ? [] : current.tables.filter((t) => !desiredTables.includes(t)),
      recreated: true,
    };
  }

  if (desiredAll) {
    // Already FOR ALL TABLES and still want all — nothing to reconcile.
    return { sql: [], added: [], removed: [], recreated: false };
  }

  const added = desiredTables.filter((t) => !current.tables.includes(t));
  const removed = current.tables.filter((t) => !desiredTables.includes(t));
  if (added.length === 0 && removed.length === 0) {
    return { sql: [], added: [], removed: [], recreated: false };
  }
  return {
    sql: [`ALTER PUBLICATION ${pub} SET TABLE ${desiredTables.map(quoteIdent).join(', ')};`],
    added,
    removed,
    recreated: false,
  };
}

/** Read the current membership of `ablo_publication` so a re-run can reconcile it. */
export async function readPublicationState(sql: postgres.Sql): Promise<PublicationState> {
  const pubRows = await sql.unsafe<{ puballtables: boolean }[]>(
    `SELECT puballtables FROM pg_publication WHERE pubname = $1`,
    [ABLO_PUBLICATION] as never[]
  );
  const pubRow = pubRows[0];
  if (!pubRow) return { exists: false, allTables: false, tables: [] };
  if (pubRow.puballtables) return { exists: true, allTables: true, tables: [] };
  const tableRows = await sql.unsafe<{ tablename: string }[]>(
    `SELECT tablename FROM pg_publication_tables WHERE pubname = $1 AND schemaname = 'public' ORDER BY tablename`,
    [ABLO_PUBLICATION] as never[]
  );
  return { exists: true, allTables: false, tables: tableRows.map((r) => r.tablename) };
}

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

/** One validated readiness item, ready to render as a checklist line. */
export interface CheckItem {
  readonly ok: boolean;
  readonly label: string;
  /** Shown indented under a failed item — the precise fix. */
  readonly fix?: string;
}

/**
 * Probes the connected database for the four readiness invariants and returns one
 * {@link CheckItem} per check. It takes an already-open `sql` handle rather than a
 * connection URL, so callers control connection handling and the checks can run
 * against a real Postgres in tests.
 */
export async function probeReadiness(
  sql: postgres.Sql,
  opts: { readonly publication?: string } = {}
): Promise<readonly CheckItem[]> {
  const publication = opts.publication ?? ABLO_PUBLICATION;
  const items: CheckItem[] = [];

  // 1. wal_level must be 'logical'.
  // `SHOW wal_level` returns a column named `wal_level`, not `setting`, so reading
  // `.setting` off it is always undefined and every database looks like "unknown".
  // `pg_settings` exposes the value in a `setting` column, matching {@link WalLevelRow}.
  const walRows = await sql.unsafe<WalLevelRow[]>(
    `SELECT setting FROM pg_settings WHERE name = 'wal_level'`
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
        }
  );

  // 2. The Ablo publication must exist.
  const pubRows = await sql.unsafe<PublicationRow[]>(
    `SELECT puballtables FROM pg_publication WHERE pubname = $1`,
    [publication] as never[]
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
        }
  );

  // 3. The connected role must have REPLICATION (superuser implies it).
  const roleRows = await sql.unsafe<RoleReplRow[]>(
    `SELECT rolreplication, rolsuper FROM pg_roles WHERE rolname = current_user`
  );
  const role = roleRows[0];
  const hasReplication = Boolean(role && (role.rolreplication || role.rolsuper));
  items.push(
    hasReplication
      ? {
          ok: true,
          label: `the replication role can stream replication ${pc.dim('(REPLICATION)')}`,
        }
      : {
          ok: false,
          label: `the replication role lacks the ${pc.bold('REPLICATION')} attribute`,
          fix:
            `ALTER ROLE current_user WITH REPLICATION;\n` +
            `On RDS: GRANT rds_replication TO <your_role>;`,
        }
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
      [publication] as never[]
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
                  `${r.table_name}: add a PRIMARY KEY, or ALTER TABLE ${quoteIdent(r.table_name)} REPLICA IDENTITY FULL;`
              )
              .join('\n'),
          }
    );
  }

  return items;
}

/**
 * The registration endpoint for a given API base URL. The server mounts every
 * route under `/api`, so the full path is `/api/v1/datasources` — the same path
 * `ablo connect register` posts to. A bare `/v1/datasources` matches no
 * route and comes back as the server's global "Not found".
 */
export function registerEndpoint(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/api/v1/datasources`;
}

/**
 * The success body of a datasource registration. The server sends more than
 * this; every field is optional and unknown keys are dropped, so the CLI reads
 * exactly what it renders and nothing it doesn't. Parsed rather than cast so a
 * shape that drifts is caught here instead of surfacing as `undefined` deep in
 * the success message.
 */
const DataSourceRegisterSuccess = z.object({
  id: z.string().optional(),
  host: z.string().optional(),
  status: z.string().optional(),
});

/** One entry in the server-side readiness checklist. */
const ReadinessFailure = z.object({
  item: z.string().optional(),
  actual: z.string().optional(),
  fix: z.string().optional(),
});

/**
 * The failure envelope. The engine's canonical error object (`AbloError.toJSON`,
 * the shape `app.onError` emits) spreads its domain `details` at the TOP level, so
 * a readiness rejection arrives as `{ code, message, failures: [...] }` — `failures`
 * and `reason` sit beside `code`, not nested under a `details` key. We read them
 * from the top level and keep `details.failures` / `error.code` as fallbacks for a
 * wrapping proxy or an older deployment that nested them. All optional — a non-JSON
 * or partial body degrades to the HTTP-status message rather than throwing.
 */
const DataSourceRegisterError = z.object({
  code: z.string().optional(),
  message: z.string().optional(),
  // Canonical: top-level, spread from the engine's `details`.
  failures: z.array(ReadinessFailure).optional(),
  reason: z.string().optional(),
  // Fallback: a wrapping proxy or older engine that nested the same payload.
  details: z
    .object({
      failures: z.array(ReadinessFailure).optional(),
      reason: z.string().optional(),
    })
    .optional(),
  error: z.object({ code: z.string().optional(), message: z.string().optional() }).optional(),
});

/** Parse a `Response` body as JSON against `schema`, degrading to `{}` on a
 *  non-JSON or shape-mismatched body — the CLI always has a value to render. */
async function parseJsonBody<T extends z.ZodType>(res: Response, schema: T): Promise<z.infer<T>> {
  const parsed = schema.safeParse(await res.json().catch(() => null));
  return parsed.success ? parsed.data : ({} as z.infer<T>);
}

/**
 * Hand both scoped connection strings to Ablo's control plane
 * (`POST /api/v1/datasources`), authed by the project key — the org is derived
 * server-side from the key, never sent in the body. Ablo stores the credentials
 * encrypted and its infrastructure is the only thing that opens either
 * connection from then on. Prints the outcome and returns whether it registered,
 * so both `--register` and `--apply` can call it and decide their own exit.
 */
export async function registerDirectDataSource(opts: {
  readonly apiUrl: string;
  readonly apiKey: string;
  readonly replicationUrl: string;
  readonly writeUrl: string;
  readonly route: DirectDataSourceRoute;
}): Promise<boolean> {
  let res: Response;
  try {
    res = await fetch(registerEndpoint(opts.apiUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${opts.apiKey}` },
      body: JSON.stringify({
        connection: 'direct',
        connectionString: opts.replicationUrl,
        writeConnectionString: opts.writeUrl,
        route: opts.route,
      }),
    });
  } catch (err) {
    console.error(
      pc.red(
        `\n  Couldn't reach ${opts.apiUrl}: ${err instanceof Error ? err.message : String(err)}\n`
      )
    );
    return false;
  }

  if (res.ok) {
    const body = await parseJsonBody(res, DataSourceRegisterSuccess);
    const statusNote = body.status === 'active' ? `${opts.route}, active` : opts.route;
    console.log(
      `\n  ${pc.green('✓')} Registered${body.host ? ` ${pc.dim(body.host)}` : ''}${body.id ? ` ${pc.dim(`(${body.id})`)}` : ''} as a direct DataSource (${statusNote}).\n` +
        `  Your database is connected. Reads follow its replication stream; writes go through Ablo\n` +
        `  and land in your own tables. Check the connection anytime with ${pc.cyan('ablo connect check')}.\n`
    );
    return true;
  }

  // The server's error envelope is flat: `{ type, code, message, details }`. The
  // nested `error.code` fallback is kept for older or wrapped deployments.
  const body = await parseJsonBody(res, DataSourceRegisterError);
  const code = body.code ?? body.error?.code;
  const message = body.message ?? body.error?.message ?? `HTTP ${res.status}`;
  console.error(pc.red(`\n  Registration failed: ${message}`));
  if (code === 'forbidden') {
    console.error(
      pc.dim(
        `  Registering a database needs a ${pc.bold('secret')} key (sk_…). Run ${pc.bold('ablo login')} for one.`
      )
    );
  } else if (code === 'datasource_connection_unsupported') {
    console.error(
      pc.dim(
        `  This deployment can’t accept connection strings — use a self-hosted/hosted engine, or the signed endpoint fallback.`
      )
    );
  } else if (code === 'database_not_replication_ready' || code === 'data_source_blocked') {
    // The server re-ran the readiness probes from its own side and found failures.
    // It can see a different picture than the local --check — for example a
    // publication added since, or probes running as the replication role rather
    // than yours. The engine spreads these at the top level; `details.failures` is
    // the fallback for a wrapping proxy or an older nested envelope.
    for (const f of body.failures ?? body.details?.failures ?? []) {
      console.error(
        `  ${pc.red('✗')} ${pc.bold(f.item ?? 'item')}${f.actual ? pc.dim(` (${f.actual})`) : ''}`
      );
      if (f.fix)
        for (const line of f.fix.split('\n')) console.error(`      ${pc.red('•')} ${line}`);
    }
    console.error(
      pc.dim(`\n  Apply the fixes, verify with ${pc.bold('ablo connect check')}, then re-run.`)
    );
  } else if (code === 'database_unreachable' || code === 'source_unreachable') {
    const reason = body.reason ?? body.details?.reason;
    if (reason) console.error(pc.dim(`  ${reason}`));
    // A pooled host is the likeliest cause and the one that reads least like
    // itself: a pooler refuses the connection as `password authentication
    // failed`, which sends the reader to audit a password that is correct.
    // Name it before the network advice, because it is a different problem with
    // a one-word fix, and the host is in hand.
    const pooled = detectPooler(opts.replicationUrl);
    if (pooled) {
      console.error(
        `\n  ${pc.yellow('!')} ${pc.bold(hostLabel(opts.replicationUrl))} is a connection pooler, not the database.`
      );
      console.error(
        pc.dim(
          `    A pooler terminates the session, so replication cannot run over it — and it\n` +
            `    refuses the connection in the same words a wrong password would.\n` +
            (pooled.direct
              ? `    Re-run against the direct host: ${pc.bold(pooled.direct)}\n`
              : `    Re-run against the direct database host, not the pooled one.\n`)
        )
      );
    }
    console.error(
      pc.dim(
        `  Ablo's servers must be able to reach this database — a localhost or private-network\n` +
          `  Postgres can't use the direct path. Establish an allowlist, PrivateLink, peering, or VPN.\n` +
          `  Only when no inbound route is possible, register the signed ${pc.bold('dataSource()')} endpoint fallback.`
      )
    );
  }
  console.error();
  return false;
}
