import type postgres from 'postgres';
import { idempotencyLedgerMigrations } from '../../source/index.js';
import { ABLO_PUBLICATION, ABLO_REPLICATION_ROLE, ABLO_WRITE_ROLE } from '../../footprint.js';
export { ABLO_PUBLICATION, ABLO_REPLICATION_ROLE, ABLO_WRITE_ROLE };

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
    // The consumer needs the old row for updates/deletes, including routing fields.
    ...qualifiedTables.map((table) => `ALTER TABLE ${table} REPLICA IDENTITY FULL;`),
    // 3. A least-privilege role: it can stream replication and SELECT the
    // published tables, including the initial snapshot of RLS-protected tables.
    // Logical decoding already exposes every published row independently of
    // RLS, so the reader needs the ordinary SELECT snapshot to match that same
    // scope. How it gets there depends on what this admin may grant.
    `CREATE ROLE ${quoteIdent(role)} WITH NOSUPERUSER ${canGrantBypassRls ? 'BYPASSRLS ' : ''}NOCREATEDB NOCREATEROLE ${canGrantBypassRls ? 'REPLICATION NOINHERIT' : 'NOREPLICATION INHERIT'} LOGIN PASSWORD '<password>';`,
    `GRANT USAGE ON SCHEMA ${quoteIdent(schema)} TO ${quoteIdent(role)};`,
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
