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
import { datasourceSummarySchema, readinessFailureSchema } from '@abloatai/transaction/wire';
import { tryControlPlane } from './controlPlane';
import { describeRemoteFailure } from './remoteValidation';
import { idempotencyLedgerMigrations } from '@abloatai/transaction/source';

// The names of the objects the recipe creates come from the footprint, which is
// also what the audit reads — so an object this setup starts creating cannot
// become one the audit fails to look for. Imported as well as re-exported: a
// bare `export … from` re-exports without binding the names in this module,
// and the SQL builders below use all three.
import {
  ABLO_PUBLICATION,
  ABLO_REPLICATION_ROLE,
  ABLO_WRITE_ROLE,
} from '@abloatai/transaction/footprint';
import { detectPooler } from './dbProvider';

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
function scopedSequenceGrant(
  tables: readonly string[],
  writeRole: string,
  schema: string
): string {
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
    WHERE d.deptype IN ('a', 'i') AND n.nspname = ${quoteLiteral(schema)} AND t.relname IN (${names})
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
/**
 * How the reader comes to see every published row during the initial snapshot.
 *
 * Logical decoding streams what committed regardless of row-level security, but
 * the snapshot that precedes it is an ordinary SELECT, and a policy that reads a
 * session variable the reader never sets matches nothing. The reader would come
 * up, report success, and sync an empty database while live changes arrived on
 * top of it — a failure that certifies itself as complete.
 *
 * BYPASSRLS is the direct answer and the one Postgres intends. It is also
 * unavailable on the most common managed Postgres there is: on Amazon RDS and
 * Aurora the attribute belongs to `rdsadmin`, so neither the master user nor
 * `rds_superuser` can pass it on, and `CREATE ROLE ... BYPASSRLS` fails with
 * "permission denied to create role". Owning the tables is no way out either,
 * because a table set to FORCE ROW LEVEL SECURITY applies its policies to the
 * owner too.
 *
 * So where the attribute cannot be granted, the reader is named in a policy of
 * its own instead. This is narrower than BYPASSRLS rather than a concession to
 * it: SELECT only, one role, one table at a time, and visible in `pg_policies`
 * where a reviewer can see what was granted — instead of an attribute that
 * silently exempts its holder from every policy in the database.
 */
export function replicationBypassSql(input: {
  readonly role: string;
  readonly tables: readonly string[];
  readonly schema: string;
  readonly canGrantBypassRls: boolean;
}): readonly string[] {
  if (input.canGrantBypassRls) return [];

  // Only for a named set. Without one the publication is FOR ALL TABLES, and
  // writing policies onto tables Ablo was never told about would be reaching
  // into whatever else shares the database.
  return input.tables.flatMap((table) => {
    const qualified = `${quoteIdent(input.schema)}.${quoteIdent(table)}`;
    const policy = quoteIdent(`${input.role}_snapshot`);
    return [
      // CREATE POLICY has no IF NOT EXISTS, and every step here is safe to
      // re-run, so the drop carries the idempotency.
      `DROP POLICY IF EXISTS ${policy} ON ${qualified};`,
      `CREATE POLICY ${policy} ON ${qualified} FOR SELECT TO ${quoteIdent(input.role)} USING (true);`,
    ];
  });
}

export function connectSetupSql(input: {
  readonly tables?: readonly string[];
  readonly role?: string;
  readonly writeRole?: string;
  readonly schema?: string;
  readonly publication: string;
  /**
   * Whether the admin running this can hand out BYPASSRLS. False on Amazon RDS
   * and Aurora, where the attribute belongs to `rdsadmin` alone, so the reader
   * is given explicit SELECT policies instead. See replicationBypassSql.
   */
  readonly canGrantBypassRls?: boolean;
}): readonly string[] {
  const role = input.role && input.role.length > 0 ? input.role : ABLO_REPLICATION_ROLE;
  const writeRole =
    input.writeRole && input.writeRole.length > 0 ? input.writeRole : ABLO_WRITE_ROLE;
  const tables = input.tables ?? [];
  const schema = input.schema ?? 'public';
  const publication = input.publication;
  const canGrantBypassRls = input.canGrantBypassRls !== false;
  const qualifiedTables = tables.map((table) => `${quoteIdent(schema)}.${quoteIdent(table)}`);
  const publicationTarget =
    tables.length > 0 ? `FOR TABLE ${qualifiedTables.join(', ')}` : 'FOR ALL TABLES';

  const tableList = qualifiedTables.join(', ');
  const scoped = tables.length > 0;

  const applicationGrant = scoped
    ? `GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE ${tableList} TO ${quoteIdent(writeRole)};`
    : `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${quoteIdent(schema)} TO ${quoteIdent(writeRole)};`;

  // The replication role reads the published tables for the initial snapshot.
  // Scoped to exactly those tables when you name them — no access to the rest of
  // the schema, and no default-privilege grant reaching future tables. Only
  // "all tables" mode (no --tables) grants schema-wide, matching its publication.
  const replicationReadGrants = scoped
    ? [`GRANT SELECT ON TABLE ${tableList} TO ${quoteIdent(role)};`]
    : [
        `GRANT SELECT ON ALL TABLES IN SCHEMA ${quoteIdent(schema)} TO ${quoteIdent(role)};`,
        `ALTER DEFAULT PRIVILEGES IN SCHEMA ${quoteIdent(schema)} GRANT SELECT ON TABLES TO ${quoteIdent(role)};`,
      ];

  // The writer needs each published table's owned sequences (SERIAL / identity
  // columns). Scoped to those tables' sequences when you name them.
  const writerSequenceGrants = scoped
    ? [scopedSequenceGrant(tables, writeRole, schema)]
    : [`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA ${quoteIdent(schema)} TO ${quoteIdent(writeRole)};`];

  const ledger = idempotencyLedgerMigrations(schema).map((migration) => migration.up);

  return [
    // 1. Turn on logical decoding. Requires a restart (it's not reloadable).
    `ALTER SYSTEM SET wal_level = 'logical';`,
    // 2. Publish the tables Ablo should read.
    `CREATE PUBLICATION ${quoteIdent(publication)} ${publicationTarget};`,
    // 3. A least-privilege role: it can stream replication and SELECT the
    // published tables, including the initial snapshot of RLS-protected tables.
    // Logical decoding already exposes every published row independently of
    // RLS, so the reader needs the ordinary SELECT snapshot to match that same
    // scope. How it gets there depends on what this admin may grant.
    `CREATE ROLE ${quoteIdent(role)} WITH NOSUPERUSER ${canGrantBypassRls ? 'BYPASSRLS ' : ''}NOCREATEDB NOCREATEROLE ${canGrantBypassRls ? 'REPLICATION NOINHERIT' : 'NOREPLICATION INHERIT'} LOGIN PASSWORD '<password>';`,
    ...replicationReadGrants,
    ...replicationBypassSql({ role, tables, schema, canGrantBypassRls }),
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
    `GRANT USAGE ON SCHEMA ${quoteIdent(schema)} TO ${quoteIdent(writeRole)};`,
    applicationGrant,
    ...writerSequenceGrants,
    ...(scoped
      ? []
      : [
          // "All tables" mode only: keep future tables/sequences writable so the
          // publication doesn't outgrow the grant.
          `ALTER DEFAULT PRIVILEGES IN SCHEMA ${quoteIdent(schema)} GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${quoteIdent(writeRole)};`,
          `ALTER DEFAULT PRIVILEGES IN SCHEMA ${quoteIdent(schema)} GRANT USAGE, SELECT ON SEQUENCES TO ${quoteIdent(writeRole)};`,
        ]),
    // 5. Direct uses the durable replay ledger but deliberately no outbox.
    ...ledger,
    `REVOKE ALL ON TABLE ${quoteIdent(schema)}.${quoteIdent('ablo_idempotency')} FROM PUBLIC;`,
    `GRANT SELECT, INSERT, UPDATE ON TABLE ${quoteIdent(schema)}.${quoteIdent('ablo_idempotency')} TO ${quoteIdent(writeRole)};`,
    `REVOKE DELETE ON TABLE ${quoteIdent(schema)}.${quoteIdent('ablo_idempotency')} FROM ${quoteIdent(writeRole)};`,
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
  desiredTables: readonly string[],
  opts: { readonly schema?: string; readonly publication: string }
): PublicationReconcile {
  const pub = quoteIdent(opts.publication);
  const schema = opts.schema ?? 'public';
  const qualified = (table: string): string => `${quoteIdent(schema)}.${quoteIdent(table)}`;
  const desiredAll = desiredTables.length === 0;
  const target = desiredAll
    ? 'FOR ALL TABLES'
    : `FOR TABLE ${desiredTables.map(qualified).join(', ')}`;

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
    sql: [`ALTER PUBLICATION ${pub} SET TABLE ${desiredTables.map(qualified).join(', ')};`],
    added,
    removed,
    recreated: false,
  };
}

/** Read the current membership of `ablo_publication` so a re-run can reconcile it. */
export async function readPublicationState(
  sql: postgres.Sql,
  opts: { readonly schema?: string; readonly publication: string }
): Promise<PublicationState> {
  const publication = opts.publication;
  const schema = opts.schema ?? 'public';
  const pubRows = await sql.unsafe<{ puballtables: boolean }[]>(
    `SELECT puballtables FROM pg_publication WHERE pubname = $1`,
    [publication] as never[]
  );
  const pubRow = pubRows[0];
  if (!pubRow) return { exists: false, allTables: false, tables: [] };
  if (pubRow.puballtables) return { exists: true, allTables: true, tables: [] };
  const tableRows = await sql.unsafe<{ tablename: string }[]>(
    `SELECT tablename FROM pg_publication_tables WHERE pubname = $1 AND schemaname = $2 ORDER BY tablename`,
    [publication, schema] as never[]
  );
  return { exists: true, allTables: false, tables: tableRows.map((r) => r.tablename) };
}

interface WalLevelRow {
  setting: string;
}
interface RoleReplRow {
  rolreplication: boolean;
  rolsuper: boolean;
  rolbypassrls: boolean;
}
interface PublicationRow {
  puballtables: boolean;
}
/** A published table and its non-FULL REPLICA IDENTITY. This consumer folds
 * complete rows, so a key-only DEFAULT/INDEX identity is insufficient when
 * Postgres omits an unchanged large/TOASTed value from an UPDATE. */
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
  opts: {
    readonly publication: string;
    readonly schema?: string;
    /**
     * The tables Ablo actually coordinates — its schema's models. When given,
     * the replica-identity check considers only these.
     *
     * A publication may legitimately carry tables Ablo neither reads nor writes:
     * `FOR ALL TABLES` sweeps in whatever else shares the database, and an agent
     * framework's own tables were enough to refuse a connect outright, over a
     * design their owner never chose and could not act on. Ablo has no standing
     * to require a replica identity on a table it does not coordinate, so the
     * check follows what it coordinates rather than what the publication happens
     * to include. Omitted, every published table is checked (the `connect check`
     * reading, where no schema is in hand).
     */
    readonly coordinatedTables?: readonly string[];
    /**
     * The role that carries REPLICATION on this provider, when the attribute
     * itself is withheld. On Amazon RDS and Aurora the capability arrives
     * through membership in `rds_replication` and `rolreplication` stays false,
     * so reading the attribute alone reports a working reader as broken.
     */
    readonly replicationGrantRole?: string | null;
  }
): Promise<readonly CheckItem[]> {
  const publication = opts.publication;
  const schema = opts.schema ?? 'public';
  const coordinated =
    opts.coordinatedTables && opts.coordinatedTables.length > 0
      ? new Set(opts.coordinatedTables)
      : null;
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

  // 3. The connected role must be able to stream replication. Three ways to
  //    hold that: the attribute, superuser, or membership in the role a managed
  //    provider lends it through. The third is not a technicality — on RDS and
  //    Aurora it is the ONLY way, because the attribute belongs to `rdsadmin`
  //    and `rds_replication` does not carry `rolreplication` either. Reading the
  //    attribute alone calls a correctly configured reader broken, which is
  //    worse than a wrong answer: it invites someone to "fix" what already works.
  const roleRows = await sql.unsafe<RoleReplRow[]>(
    `SELECT rolreplication, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`
  );
  const role = roleRows[0];
  const grantRole = opts.replicationGrantRole ?? null;
  const viaGrant = grantRole
    ? (
        await sql.unsafe<{ member: boolean }[]>(
          `SELECT EXISTS (
             SELECT 1 FROM pg_roles r
             WHERE r.rolname = $1 AND pg_has_role(current_user, r.oid, 'MEMBER')
           ) AS member`,
          [grantRole] as never[]
        )
      )[0]?.member === true
    : false;
  const hasReplication = Boolean(role && (role.rolreplication || role.rolsuper)) || viaGrant;
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
    // A table hides rows from the snapshot when row security is active for this
    // role AND nothing admits it. `row_security_active` answers only the first
    // half: it stays true for a reader that a permissive policy lets read
    // everything, which is exactly how the reader is set up where the provider
    // withholds BYPASSRLS. Checking it alone reports 59 tables as hiding rows
    // the reader can, in fact, read every one of.
    //
    // So the tables that actually hide rows are those with row security active
    // and no unrestricted SELECT policy naming this role.
    const rlsRows = await sql.unsafe<{ table_name: string }[]>(
      `SELECT DISTINCT pt.tablename AS table_name
         FROM pg_publication_tables pt
         JOIN pg_namespace n ON n.nspname = pt.schemaname
         JOIN pg_class c ON c.relnamespace = n.oid AND c.relname = pt.tablename
        WHERE pt.pubname = $1 AND pt.schemaname = $2
          AND row_security_active(c.oid)
          AND NOT EXISTS (
            SELECT 1 FROM pg_policies p
             WHERE p.schemaname = pt.schemaname
               AND p.tablename = pt.tablename
               AND p.permissive = 'PERMISSIVE'
               AND p.cmd IN ('ALL', 'SELECT')
               AND p.qual = 'true'
               -- Membership, not containment: pg_policies.roles is name[], while
               -- ARRAY['public'] is text[]. Postgres has no name[] @> text[] operator, so
               -- the containment spelling fails at execution rather than at parse time:
               -- the probe threw instead of reporting, which reads as an unreachable
               -- database rather than a readable one.
               AND ('public' = ANY(p.roles) OR current_user = ANY(p.roles))
          )
        ORDER BY table_name`,
      [publication, schema] as never[]
    );
    const rlsRelevant = coordinated
      ? rlsRows.filter((row) => coordinated.has(row.table_name))
      : rlsRows;
    items.push(
      rlsRelevant.length === 0
        ? { ok: true, label: 'the initial snapshot can read every published row' }
        : {
            ok: false,
            label: `${rlsRelevant.length} published table${rlsRelevant.length === 1 ? '' : 's'} hide historical rows behind RLS`,
            fix:
              `ALTER ROLE current_user WITH BYPASSRLS;\n` +
              `Where the provider reserves that attribute (Amazon RDS, Aurora), give the reader a policy instead:\n` +
              `CREATE POLICY <reader>_snapshot ON <table> FOR SELECT TO <reader> USING (true);\n` +
              `Logical replication already exposes every published row; either lets the ordinary initial SELECT read that same scope.`,
          }
    );

    const badRows = await sql.unsafe<BadReplicaIdentityRow[]>(
      `SELECT c.relname AS table_name, c.relreplident
         FROM pg_publication_tables pt
         JOIN pg_class c ON c.relname = pt.tablename
         JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = pt.schemaname
        WHERE pt.pubname = $1 AND pt.schemaname = $2
          AND c.relreplident <> 'f'`,
      [publication, schema] as never[]
    );
    const relevant = coordinated
      ? badRows.filter((row) => coordinated.has(row.table_name))
      : badRows;
    items.push(
      relevant.length === 0
        ? { ok: true, label: `all published tables use REPLICA IDENTITY FULL` }
        : {
            ok: false,
            label: `${relevant.length} published table${relevant.length === 1 ? '' : 's'} cannot replicate UPDATE/DELETE`,
            fix: relevant
              .map(
                (r) =>
                  `${r.table_name}: ALTER TABLE ${quoteIdent(schema)}.${quoteIdent(r.table_name)} REPLICA IDENTITY FULL;`
              )
              .join('\n'),
          }
    );
  }

  return items;
}

/**
 * The failure detail a registration rejection carries beside its envelope: the
 * readiness checklist and the driver's words, as the engine's error `details`.
 * The nested `details` object is a fallback for a wrapping proxy or an older
 * deployment that nested the same payload one level down.
 */
const registerFailureDetailsSchema = z
  .object({
    failures: z.array(readinessFailureSchema).optional(),
    reason: z.string().optional(),
    details: z
      .object({
        failures: z.array(readinessFailureSchema).optional(),
        reason: z.string().optional(),
      })
      .loose()
      .optional(),
  })
  .loose();

/**
 * Hand both scoped connection strings to Ablo's control plane
 * (`POST /v1/datasources`), authed by the project key — the org is derived
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
  readonly schema?: string;
  readonly replicationSlot?: string;
  readonly publication?: string;
}): Promise<boolean> {
  const result = await tryControlPlane({
    path: '/v1/datasources',
    method: 'POST',
    baseUrl: opts.apiUrl,
    apiKey: opts.apiKey,
    body: {
      connection: 'direct',
      connectionString: opts.replicationUrl,
      writeConnectionString: opts.writeUrl,
      route: opts.route,
      ...(opts.schema ? { schema: opts.schema } : {}),
      ...(opts.replicationSlot ? { replicationSlot: opts.replicationSlot } : {}),
      ...(opts.publication ? { publication: opts.publication } : {}),
    },
    responseSchema: datasourceSummarySchema,
  });

  if (result.ok) {
    const body = result.value;
    const statusNote = body.status === 'active' ? `${opts.route}, active` : opts.route;
    console.log(
      `\n  ${pc.green('✓')} Registered${body.host ? ` ${pc.dim(body.host)}` : ''}${body.id ? ` ${pc.dim(`(${body.id})`)}` : ''} as a direct DataSource (${statusNote}).\n` +
        `  Your database is connected. Reads follow its replication stream; writes go through Ablo\n` +
        `  and land in your own tables. Rows that already exist load automatically — no manual\n` +
        `  backfill or row updates. Check their progress with ${pc.cyan('ablo connect check')}.\n`
    );
    return true;
  }

  // The boundary already decoded the envelope into a typed error — code,
  // message, and the engine's domain details all survive on it. What remains
  // here is rendering: the code-specific guidance a refusal deserves.
  const err = result.error;
  const detail = registerFailureDetailsSchema.safeParse(err.details ?? {});
  const failures = detail.success
    ? (detail.data.failures ?? detail.data.details?.failures ?? [])
    : [];
  const reason = detail.success ? (detail.data.reason ?? detail.data.details?.reason) : undefined;
  console.error(pc.red(`\n  Registration failed: ${err.message}`));
  if (err.code === 'forbidden') {
    console.error(
      pc.dim(
        `  Registering a database needs a ${pc.bold('secret')} key (sk_…). Run ${pc.bold('ablo login')} for one.`
      )
    );
  } else if (err.code === 'datasource_connection_unsupported') {
    console.error(
      pc.dim(
        `  This deployment can’t accept connection strings — use a self-hosted/hosted engine, or the signed endpoint fallback.`
      )
    );
  } else if (err.code === 'database_loopback_requires_connector') {
    console.error(`
  ${pc.cyan('Recommended for this localhost-first project')}
    1. ${pc.bold('npx ablo migrate')} ${pc.dim('(once: models + idempotency + outbox)')}
    2. ${pc.bold('npx ablo dev --local')} ${pc.dim('(keep running beside the app)')}

  ${pc.dim('This keeps Postgres private and supports reads, coordinated writes, claims,')}
  ${pc.dim('subscriptions, and confirmations through the signed Data Source connector.')}
  ${pc.yellow('Note:')} ${pc.dim('raw SQL or unrelated ORM writes are not automatically observed without WAL.')}

  ${pc.dim('If every arbitrary database write must be observed, use a secure database-capable')}
  ${pc.dim('tunnel, hosted direct Postgres, PrivateLink, peering, or VPN—not a transaction pooler.')}`);
  } else if (err.code === 'database_not_replication_ready' || err.code === 'data_source_blocked') {
    // The server re-ran the readiness probes from its own side and found failures.
    // It can see a different picture than the local --check — for example a
    // publication added since, or probes running as the replication role rather
    // than yours. Rendered through the same labels `connect check` prints, so
    // the identical failure never reads two ways.
    for (const f of failures) {
      const { label, fix } = describeRemoteFailure(f);
      console.error(`  ${pc.red('✗')} ${pc.bold(label)}`);
      for (const line of fix.split('\n')) console.error(`      ${pc.red('•')} ${line}`);
    }
    console.error(
      pc.dim(`\n  Apply the fixes, verify with ${pc.bold('ablo connect check')}, then re-run.`)
    );
  } else if (err.code === 'database_unreachable' || err.code === 'source_unreachable') {
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
        `  Ablo's servers must be able to reach this database for the direct WAL path.\n` +
          `  For localhost development, run ${pc.bold('ablo dev --local')}. For private deployments,\n` +
          `  establish an allowlist, PrivateLink, peering, or VPN.`
      )
    );
  }
  console.error();
  return false;
}
