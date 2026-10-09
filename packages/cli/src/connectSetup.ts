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

// The names of the objects the recipe creates come from the footprint, which is
// also what the audit reads — so an object this setup starts creating cannot
// become one the audit fails to look for. Imported as well as re-exported: a
// bare `export … from` re-exports without binding the names in this module,
// and the SQL builders below use all three.
import { ABLO_PUBLICATION, ABLO_REPLICATION_ROLE, ABLO_WRITE_ROLE, quoteIdent, detectPooler } from '@abloatai/transaction/server/postgresSetup';
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
  /** Suppress success prose when the caller owns machine-readable stdout. */
  readonly quiet?: boolean;
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
    if (!opts.quiet) {
      console.log(
        `\n  ${pc.green('✓')} Registered${body.host ? ` ${pc.dim(body.host)}` : ''}${body.id ? ` ${pc.dim(`(${body.id})`)}` : ''} as a direct DataSource (${statusNote}).\n` +
          `  Your database is connected. Reads follow its replication stream; writes go through Ablo\n` +
          `  and land in your own tables. Rows that already exist load automatically — no manual\n` +
          `  backfill or row updates. Check their progress with ${pc.cyan('ablo connect check')}.\n`
      );
    }
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
