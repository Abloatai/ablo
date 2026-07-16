/**
 * `ablo connect apply` runs the read-path setup for you instead of printing
 * SQL to copy. It connects with the admin credential (from `--url`, or
 * `DATABASE_URL`), creates the two scoped roles and the publication, turns on
 * logical decoding where it can, and registers both scoped connection strings
 * with Ablo directly — then proves it worked by reconnecting as the replication
 * role and running the readiness checklist. The admin credential is used once
 * and discarded; nothing is written to your `.env`, so your app keeps only
 * `ABLO_API_KEY`.
 *
 * Two principles shape it:
 *
 *   1. It reads like a plain-language plan, not SQL. The confirmation shows what
 *      Ablo will set up in ordinary words; the exact statements are available on
 *      request (`--show-sql`) rather than shown by default, because raw DDL reads
 *      as risky even when every statement is safe and reversible.
 *   2. The grants come from one source. The privilege statements are taken
 *      verbatim from {@link connectSetupSql} — the same recipe `ablo connect`
 *      prints and tests assert — so the applied grants can never quietly drift
 *      from the documented ones. `apply` only swaps the three statements that
 *      must differ to run unattended: it makes the role and publication creation
 *      idempotent (safe to re-run) and substitutes a real, generated password
 *      for the recipe's `<password>` placeholder.
 */

import pc from 'picocolors';
import postgres from 'postgres';
import { confirm, isCancel } from '@clack/prompts';
import {
  ABLO_PUBLICATION,
  ABLO_REPLICATION_ROLE,
  ABLO_WRITE_ROLE,
  connectSetupSql,
  probeReadiness,
  quoteIdent,
  reconcilePublicationPlan,
  readPublicationState,
  registerDirectDataSource,
  type CheckItem,
  type PublicationState,
} from './connectSetup';
import type { ConnectArgs } from './connect';
import {
  generateRolePassword,
  scramSha256Verifier,
  rewriteDatabaseUrl,
  readProjectAdminDatabaseUrl,
} from './dbRole';
import { resolveApiKey } from './config';
import { apiBaseUrl } from './push';
import { brand } from './theme';

/** How a role's password is written into the SQL — mirrors {@link scopedRoleStatements}. */
export type PasswordMode = 'scram-verifier' | 'plaintext';

/**
 * A single stage of the apply plan. `title`/`detail` are the plain-language
 * summary a person reads; `sql` is what actually runs. `kind` lets the runner
 * treat the write-ahead-log stage specially — it is the one stage a managed
 * provider may refuse, and the only one that can need a restart.
 */
export interface ApplyStep {
  readonly key: 'wal' | 'publication' | 'replication-role' | 'write-role' | 'grants';
  readonly title: string;
  readonly detail: string;
  readonly sql: readonly string[];
}

/** The password material for the two roles, already turned into a SQL literal. */
export interface ApplyCredentials {
  readonly replicationClause: string;
  readonly writeClause: string;
}

/**
 * The exit code and, for `rotate`, the recovery notice after the registration
 * attempt. Rotation is the one flow where a registration failure *after* the
 * `ALTER ROLE` is dangerous: the database already holds the new password Ablo
 * doesn't have yet, so writes break until it's reconciled. We can't roll the
 * password back (the CLI connects as admin and never held the role's old one),
 * and we can't register-then-swap (Ablo validates a credential by connecting with
 * it, so it must exist in the database first). So the safe shape is to refuse a
 * success exit and tell the operator to re-run `rotate` — itself idempotent,
 * generating a fresh password each run. `apply` needs no such notice: a failed
 * first registration leaves nothing that was working broken.
 */
export function postRegistrationOutcome(input: {
  readonly rotating: boolean;
  readonly registered: boolean;
}): { readonly exitCode: 0 | 1; readonly notice: string | null } {
  if (input.registered) return { exitCode: 0, notice: null };
  if (!input.rotating) return { exitCode: 1, notice: null };
  return {
    exitCode: 1,
    notice:
      'The new passwords are set in your database, but Ablo could not be updated with them.\n' +
      'Ablo still holds the previous password, which no longer works — writes will fail until\n' +
      'you re-run `ablo connect rotate` (each run is idempotent and rotates a fresh password).',
  };
}

/** Build the password clause for a role, either the SCRAM verifier or an escaped plaintext literal. */
export function passwordClause(password: string, mode: PasswordMode): string {
  return mode === 'scram-verifier' ? scramSha256Verifier(password) : password.replace(/'/g, "''");
}

/**
 * An idempotent role creation: create it, or — on a re-run — rotate only the
 * password. Re-asserting attributes on an existing role trips managed-Postgres
 * permission walls, and the server-side probe audits the live attributes anyway.
 */
function idempotentRole(role: string, attributes: string, clause: string): string {
  return `DO $$ BEGIN
  CREATE ROLE ${quoteIdent(role)} WITH ${attributes} LOGIN PASSWORD '${clause}';
EXCEPTION WHEN duplicate_object THEN
  ALTER ROLE ${quoteIdent(role)} WITH LOGIN PASSWORD '${clause}';
END $$;`;
}

/**
 * Turn the canonical recipe from {@link connectSetupSql} into an executable,
 * idempotent, real-password plan. Every privilege statement is taken verbatim
 * from the recipe; only the write-ahead-log switch, the publication, and the two
 * role creations are replaced — the statements that must be idempotent and carry
 * a real password to run unattended.
 *
 * Pure and deterministic, so a test can assert the plan reuses exactly the
 * recipe's grants and swaps exactly the three heads.
 */
export function connectApplyPlan(input: {
  readonly tables?: readonly string[];
  readonly role?: string;
  readonly writeRole?: string;
  readonly credentials: ApplyCredentials;
  /** Omit the write-ahead-log step when the cluster is already `wal_level = logical`. */
  readonly walAlreadyLogical?: boolean;
  /** Shapes the write-ahead-log step's guidance; managed providers show a
   *  console/setting action instead of an `ALTER SYSTEM` that can't run. */
  readonly provider?: DbProvider;
  /** The publication's live membership. When given, the publish step reconciles it
   *  to `--tables` (declarative); when omitted, it falls back to create-if-absent. */
  readonly existingPublication?: PublicationState;
}): readonly ApplyStep[] {
  const role = input.role && input.role.length > 0 ? input.role : ABLO_REPLICATION_ROLE;
  const writeRole =
    input.writeRole && input.writeRole.length > 0 ? input.writeRole : ABLO_WRITE_ROLE;
  const tables = input.tables ?? [];
  const provider = input.provider ?? 'generic';

  // The canonical recipe. We keep every statement except the three we must
  // replace to run unattended, identified by their leading verb so a change to
  // the recipe's wording surfaces in the drift test rather than silently.
  const recipe = connectSetupSql({ tables, role, writeRole });
  const isWal = (s: string): boolean => s.startsWith('ALTER SYSTEM SET wal_level');
  const isPublication = (s: string): boolean => s.startsWith('CREATE PUBLICATION');
  const isRoleCreate = (s: string): boolean => s.startsWith('CREATE ROLE ');
  const grants = recipe.filter((s) => !isWal(s) && !isPublication(s) && !isRoleCreate(s));

  const publicationTarget =
    tables.length > 0 ? `FOR TABLE ${tables.map(quoteIdent).join(', ')}` : 'FOR ALL TABLES';

  // The write-ahead-log step: nothing to do when the cluster is already
  // logical; a plain SQL statement on self-hosted; a console/setting action
  // (no SQL) on managed providers that reject ALTER SYSTEM.
  const walStep: readonly ApplyStep[] = input.walAlreadyLogical
    ? []
    : [
        provider === 'generic'
          ? {
              key: 'wal',
              title: 'Turn on logical replication',
              detail: 'lets Ablo read your changes as they happen (needs a restart to take effect)',
              sql: [`ALTER SYSTEM SET wal_level = 'logical';`],
            }
          : {
              key: 'wal',
              title: 'Turn on logical replication',
              detail: logicalReplicationGuidance(provider),
              sql: [],
            },
      ];

  // With live state, reconcile the publication to exactly `--tables` (declarative,
  // Debezium-"filtered" style). Without it — the pure/fresh-DB path — create it if
  // absent; a re-run against a matching publication is then a no-op.
  const reconcile = input.existingPublication
    ? reconcilePublicationPlan(input.existingPublication, tables)
    : null;
  const publicationSql = reconcile
    ? reconcile.sql
    : [
        `DO $$ BEGIN
  CREATE PUBLICATION ${quoteIdent(ABLO_PUBLICATION)} ${publicationTarget};
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;`,
      ];
  const publicationDetail =
    reconcile?.sql.length === 0
      ? 'already publishing exactly these tables — nothing to change'
      : tables.length > 0
        ? `a read stream of the ${tables.length} table${tables.length === 1 ? '' : 's'} you chose`
        : 'a read stream of your tables';

  return [
    ...walStep,
    {
      key: 'publication',
      title: 'Publish your tables to Ablo',
      detail: publicationDetail,
      sql: publicationSql,
    },
    {
      key: 'replication-role',
      title: 'Create a read-only replication role',
      detail: `${role} — it can stream changes and read, nothing more`,
      sql: [idempotentRole(role, 'REPLICATION', input.credentials.replicationClause)],
    },
    {
      key: 'write-role',
      title: 'Create a scoped writer role',
      detail: `${writeRole} — writes rows through Ablo; where a table has row-level-security policies, they govern its writes too (it can't bypass them)`,
      sql: [
        idempotentRole(
          writeRole,
          'NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT',
          input.credentials.writeClause
        ),
      ],
    },
    {
      key: 'grants',
      title: 'Grant each role exactly what it needs',
      detail:
        'read access for the reader, row writes for the writer — no ownership, no schema changes',
      sql: grants,
    },
  ];
}

/** Whether the currently-connected role can create other roles (needed to run the plan). */
interface AdminCapabilityRow {
  readonly rolname: string;
  readonly rolsuper: boolean;
  readonly rolcreaterole: boolean;
}

interface PgErrorLike {
  readonly message?: string;
}

/** A statement that a managed provider refused because it wanted a plaintext password, not a verifier. */
function isPlaintextRefusal(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /plaintext password/i.test(message);
}

/** Print the plan as a short, scannable checklist — titles only, SQL only if asked. */
function printPlan(steps: readonly ApplyStep[], showSql: boolean): void {
  console.log(`  This sets up your database for Ablo:\n`);
  for (const step of steps) {
    console.log(`    ${pc.green('•')} ${step.title}`);
    if (showSql) {
      for (const statement of step.sql) {
        for (const line of statement.split('\n')) console.log(`        ${pc.dim(line)}`);
      }
    }
  }
  console.log(
    pc.dim(
      `\n  Your admin password stays on this machine.${showSql ? '' : ' (--show-sql for the exact statements)'}\n`
    )
  );
}

/** Look up whether the connected admin role can create the scoped roles. */
async function adminCanCreateRoles(sql: postgres.Sql): Promise<AdminCapabilityRow | null> {
  const rows = await sql.unsafe<AdminCapabilityRow[]>(
    `SELECT rolname, rolsuper, rolcreaterole FROM pg_roles WHERE rolname = current_user`
  );
  return rows[0] ?? null;
}

export interface LedgerOwnershipRow {
  readonly owner: string;
  readonly is_owner: boolean;
  readonly is_superuser: boolean;
}

/**
 * The decision behind {@link unmanageableLedgerOwner}, split from the query so
 * it is testable without a live connection: the blocking owner when a
 * pre-existing ledger row is owned by another role and the admin is not a
 * superuser, otherwise null (no ledger, already the owner, or superuser — all
 * cases the plan can proceed through).
 */
export function ledgerBlockedBy(row: LedgerOwnershipRow | undefined): string | null {
  if (!row || row.is_owner || row.is_superuser) return null;
  return row.owner;
}

/**
 * The owner of a pre-existing `ablo_idempotency` the connected admin can neither
 * manage nor take over — or null when there is no such obstacle.
 *
 * A ledger carried over from an earlier Ablo integration may be owned by a
 * different role. The setup grants the writer access to it and (on an upgrade)
 * alters it, both of which Postgres reserves for the table's owner; and only the
 * owner or a superuser can reassign ownership. So when the ledger exists and the
 * admin is neither its owner nor a superuser, the plan cannot succeed — better
 * to stop with the fix than to fail partway through role creation.
 */
async function unmanageableLedgerOwner(sql: postgres.Sql): Promise<string | null> {
  const rows = await sql.unsafe<LedgerOwnershipRow[]>(
    `SELECT pg_get_userbyid(c.relowner) AS owner,
            c.relowner = r.oid AS is_owner,
            r.rolsuper AS is_superuser
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_roles r ON r.rolname = current_user
      WHERE c.relkind = 'r'
        AND c.relname = 'ablo_idempotency'
        AND n.nspname = 'public'`
  );
  return ledgerBlockedBy(rows[0]);
}

/** A published table's ownership as seen from the connected admin. */
export interface TableOwnershipRow {
  /** Schema-qualified, quoted relation, e.g. `public.documents`. */
  readonly relation: string;
  readonly owner: string;
  /**
   * Whether the admin can act as the owner for grants — true when it owns the
   * table OR is an INHERITing member of the owning role (`pg_has_role(…,
   * 'USAGE')`). A plain NOINHERIT membership is false: the admin would have to
   * `SET ROLE` first, which the plan doesn't, so the grant fails.
   */
  readonly can_manage: boolean;
  readonly is_superuser: boolean;
}

/**
 * The published tables the connected admin can't grant on — the `{relation,
 * owner}` list, empty when the admin can manage them all (or is a superuser).
 * Split from the query so it is testable without a live connection.
 */
export function tableOwnershipBlockers(
  rows: readonly TableOwnershipRow[]
): readonly { relation: string; owner: string }[] {
  return rows
    .filter((row) => !row.can_manage && !row.is_superuser)
    .map((row) => ({ relation: row.relation, owner: row.owner }));
}

/**
 * Published tables the connected admin can neither grant on nor take over. The
 * setup grants the writer role DML on every published table, which Postgres
 * reserves for the table's owner — so a table left owned by an earlier
 * integration's role the admin can't act as (a legacy `app` role reached only
 * through a NOINHERIT membership, say) stops the plan partway through the grants
 * with a bare `must be owner of table …`. Detect it first so the CLI can name
 * the tables and the one-line reassignment fix. "Can act as owner" is
 * `pg_has_role(current_user, owner, 'USAGE')`, so an admin that INHERITs the
 * owning role — the common managed-Postgres case — is correctly left to proceed.
 * Scoped to `--tables` when given; otherwise every public base table the "all
 * tables" grant reaches.
 */
async function unmanageablePublishedTableOwners(
  sql: postgres.Sql,
  tables: readonly string[]
): Promise<readonly { relation: string; owner: string }[]> {
  const scoped = tables.length > 0;
  const rows = await sql.unsafe<TableOwnershipRow[]>(
    `SELECT format('%I.%I', n.nspname, c.relname) AS relation,
            pg_get_userbyid(c.relowner) AS owner,
            pg_has_role(current_user, c.relowner, 'USAGE') AS can_manage,
            r.rolsuper AS is_superuser
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_roles r ON r.rolname = current_user
      WHERE c.relkind = 'r'
        AND n.nspname = 'public'
        AND c.relname <> 'ablo_idempotency'
        ${scoped ? 'AND c.relname = ANY($1)' : ''}`,
    (scoped ? [tables] : []) as never[]
  );
  return tableOwnershipBlockers(rows);
}

export type DbProvider = 'neon' | 'supabase' | 'rds' | 'generic';

/**
 * Best-effort provider identification from the admin host. Enough to give the
 * right logical-replication instructions: the managed providers don't accept
 * `ALTER SYSTEM SET wal_level`, so printing it for them — as the recipe did for
 * a `neon.tech` host — is a statement that can't work.
 */
export function detectProvider(hostOrTarget: string): DbProvider {
  const host = hostOrTarget.toLowerCase();
  if (host.includes('neon.tech')) return 'neon';
  if (
    host.includes('supabase.co') ||
    host.includes('supabase.com') ||
    host.includes('pooler.supabase')
  ) {
    return 'supabase';
  }
  if (host.includes('rds.amazonaws.com') || host.includes('.rds.')) return 'rds';
  return 'generic';
}

/** How to reach `wal_level = logical` on each provider, in one plain sentence. */
export function logicalReplicationGuidance(provider: DbProvider): string {
  switch (provider) {
    case 'neon':
      return `enable logical replication in your Neon project settings — it can't be set over SQL`;
    case 'supabase':
      return `raise wal_level to logical in your Supabase project's database settings`;
    case 'rds':
      return `set rds.logical_replication = 1 in the instance's parameter group, then reboot`;
    case 'generic':
      return `run the ALTER SYSTEM above, then restart Postgres — wal_level is not reloadable`;
  }
}

/** The cluster's current `wal_level`, or '' when it can't be read. `SHOW` is
 *  permitted for every role, so this works even where `ALTER SYSTEM` does not. */
async function currentWalLevel(sql: postgres.Sql): Promise<string> {
  try {
    const rows = await sql.unsafe<{ wal_level: string }[]>(`SHOW wal_level`);
    return rows[0]?.wal_level ?? '';
  } catch {
    return '';
  }
}

/**
 * Run every step against the admin connection. On self-hosted Postgres the
 * write-ahead-log step's `ALTER SYSTEM` is best-effort — a managed provider that
 * refuses it is not fatal here, because whether replication is actually ready is
 * decided by reading `wal_level`, not by whether this statement ran. A verifier
 * the provider rejects is retried once as plaintext over TLS, matching
 * {@link createScopedRole}.
 */
async function executePlan(
  sql: postgres.Sql,
  steps: readonly ApplyStep[],
  rebuildPlaintext: () => readonly ApplyStep[]
): Promise<void> {
  let plaintextSteps: readonly ApplyStep[] | null = null;
  for (const step of steps) {
    for (const statement of step.sql) {
      try {
        await sql.unsafe(statement);
      } catch (err) {
        if (step.key === 'wal') {
          // Best-effort: a provider that rejects ALTER SYSTEM changes nothing
          // here — readiness is judged by the wal_level read, not this statement.
          continue;
        }
        if (
          (step.key === 'replication-role' || step.key === 'write-role') &&
          isPlaintextRefusal(err)
        ) {
          plaintextSteps ??= rebuildPlaintext();
          const retry = plaintextSteps.find((s) => s.key === step.key);
          if (retry) {
            for (const alt of retry.sql) await sql.unsafe(alt);
            continue;
          }
        }
        throw err;
      }
    }
  }
}

/**
 * `ablo connect apply` (and `rotate`): create — or, for `rotate`, re-key —
 * the two scoped roles, the publication, and (where allowed) the logical-decoding
 * setting, then register both scoped connection strings with Ablo directly.
 *
 * The admin credential comes from `--url`, or `DATABASE_URL` as a fallback. It is
 * used on this machine only and is never persisted or sent anywhere. Nothing is
 * written to your `.env`: the generated role passwords go straight to Ablo's
 * control plane (encrypted) via registration, and your app keeps holding only
 * `ABLO_API_KEY`. That is what makes "registering the database is the whole
 * switch" literally true — and what keeps a replication-only credential from ever
 * landing in the generic `DATABASE_URL` your ORM reads.
 */
export async function runConnectApply(args: ConnectArgs): Promise<void> {
  const rotating = args.rotate;
  const verb = rotating ? 'connect rotate' : 'connect apply';

  const adminUrl = args.url ?? readProjectAdminDatabaseUrl();
  if (!adminUrl) {
    console.error(
      pc.red('  No admin connection string.') +
        pc.dim(
          ` Pass ${pc.bold('--url <admin-conn>')} (or set ${pc.bold('DATABASE_URL')}) and re-run.`
        )
    );
    process.exit(1);
  }
  // Show which database we resolved, and how — the admin credential is used once
  // here and then discarded, so the operator should see exactly what it points at
  // before confirming. (When it came from DATABASE_URL, that's job 1: a one-time
  // admin input, not a credential Ablo keeps.)
  const adminSource = args.url ? '--url' : 'DATABASE_URL';
  let target = 'your database';
  try {
    const parsed = new URL(adminUrl);
    target = `${parsed.host}${parsed.pathname === '/' ? '' : parsed.pathname}`;
  } catch {
    /* keep the generic label if the URL doesn't parse */
  }

  // Registration needs the project key. Resolve it before touching the database,
  // so we never provision roles we then can't hand to Ablo.
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
    `\n  ${brand('ablo')} ${pc.dim(verb)}  ${pc.dim(rotating ? 're-key the scoped roles' : 'set up your database for Ablo')}\n`
  );
  console.log(
    `  ${pc.dim('→')} ${pc.bold(target)}${adminSource === 'DATABASE_URL' ? pc.dim('  (admin via DATABASE_URL)') : ''}\n`
  );

  // 1. Confirm the admin credential can actually create/alter roles.
  const admin = postgres(adminUrl, {
    max: 1,
    prepare: false,
    connect_timeout: 10,
    onnotice: () => {
      // Swallow postgres NOTICE chatter (role already exists, etc.) — the plan narrates its own steps.
    },
  });
  let capability: AdminCapabilityRow | null;
  try {
    capability = await adminCanCreateRoles(admin);
  } catch (err) {
    await admin.end({ timeout: 2 }).catch(() => undefined);
    const pg = (err ?? {}) as PgErrorLike;
    console.error(pc.red(`  Couldn't connect: ${pg.message ?? String(err)}`));
    process.exit(1);
  }
  if (!capability || !(capability.rolsuper || capability.rolcreaterole)) {
    await admin.end({ timeout: 2 });
    console.error(
      pc.red(`  ${capability?.rolname ?? 'This role'} can't create roles.`) +
        pc.dim(` Point ${pc.bold('--url')} at your owner/admin connection and re-run.`)
    );
    process.exit(1);
  }

  // 1b. A ledger left by an earlier Ablo integration may be owned by another
  // role. The plan grants the writer access to it — which Postgres reserves for
  // the owner — so stop now with the fix rather than fail partway through.
  const blockingOwner = await unmanageableLedgerOwner(admin).catch(() => null);
  if (blockingOwner) {
    await admin.end({ timeout: 2 });
    console.error(
      pc.red(
        `\n  ${pc.bold('ablo_idempotency')} already exists on ${target}, owned by ${pc.bold(blockingOwner)}, ` +
          `but you connected as ${pc.bold(capability.rolname)}.`
      ) +
        `\n  Ablo's setup grants the writer role access to this ledger, and Postgres reserves that\n` +
        `  for the table's owner. Either re-run pointing ${pc.bold('--url')} at ${pc.bold(blockingOwner)}'s connection,\n` +
        `  or drop the existing ledger so Ablo recreates it under this admin — it holds only\n` +
        `  idempotency replay records, safe to drop when no commit is in flight:\n` +
        `      ${pc.cyan('DROP TABLE ablo_idempotency;')}\n`
    );
    process.exit(1);
  }

  // 1b-2. The setup grants the writer role DML on each published table, which
  // Postgres reserves for the table's owner. A table left owned by an earlier
  // integration's role (not this admin) would otherwise stop the plan partway
  // through the grants with a bare `must be owner of table …`, so surface it now
  // with the one-line reassignment fix instead.
  const foreignTables = await unmanageablePublishedTableOwners(admin, args.tables).catch(() => []);
  if (foreignTables.length > 0) {
    await admin.end({ timeout: 2 });
    const list = foreignTables.map((t) => `${t.relation} (owned by ${t.owner})`).join('\n      ');
    const alters = foreignTables
      .map((t) => `ALTER TABLE ${t.relation} OWNER TO ${quoteIdent(capability.rolname)};`)
      .join(' ');
    const plural = foreignTables.length === 1;
    console.error(
      pc.red(
        `\n  ${pc.bold(String(foreignTables.length))} published table${plural ? '' : 's'} ` +
          `${plural ? 'is' : 'are'} owned by another role, but you connected as ${pc.bold(capability.rolname)}:`
      ) +
        `\n      ${list}\n` +
        `\n  Ablo grants the writer role access to your published tables, and Postgres reserves that\n` +
        `  for the table's owner. Reassign them to your admin — metadata only, your rows and RLS\n` +
        `  policies are untouched, and it works when your admin is a member of the owning role:\n` +
        `      ${pc.cyan(alters)}\n` +
        `  Or re-run pointing ${pc.bold('--url')} at the owning role's connection.\n`
    );
    process.exit(1);
  }

  // 1c. Decide the write-ahead-log step from reality, not hope: read the current
  // wal_level (a SHOW every role can run) and identify the provider. When it is
  // already logical, the step drops out entirely; when it isn't, the plan and the
  // follow-up both speak the provider's language instead of printing an
  // ALTER SYSTEM that a managed host can't run.
  const provider = detectProvider(target);
  const walReady = (await currentWalLevel(admin)) === 'logical';

  // 1d. Read the publication's live membership so the plan can reconcile it to
  // exactly `--tables`. A pre-existing publication from an earlier connect with a
  // different table set is the common cause of a "writer not ready" rejection: the
  // writer gets granted on the new tables while the publication still points at the
  // old ones. Reconciling keeps the two in step (see reconcilePublicationPlan).
  const existingPublication = await readPublicationState(admin).catch(
    (): PublicationState => ({ exists: false, allTables: false, tables: [] })
  );
  const pubReconcile = reconcilePublicationPlan(existingPublication, args.tables);

  // 2. Generate fresh role passwords and build the plan. Every stage is
  // idempotent, so `rotate` runs the same plan: an existing role has only its
  // password re-keyed.
  const replicationPassword = generateRolePassword();
  const writePassword = generateRolePassword();
  const buildPlan = (mode: PasswordMode): readonly ApplyStep[] =>
    connectApplyPlan({
      tables: args.tables,
      role: args.role,
      writeRole: args.writeRole,
      credentials: {
        replicationClause: passwordClause(replicationPassword, mode),
        writeClause: passwordClause(writePassword, mode),
      },
      walAlreadyLogical: walReady,
      provider,
      existingPublication,
    });
  const steps = buildPlan('scram-verifier');

  // 3. Show the plan in plain language and confirm. When reconciling narrows the
  // publication, surface the removals first — they stop replicating to Ablo, so the
  // operator sees the destructive part before confirming, not after.
  if (pubReconcile.removed.length > 0 || pubReconcile.recreated) {
    console.log(
      `  ${pc.yellow('!')} ${pc.bold(ABLO_PUBLICATION)} already publishes a different set; reconciling to your ${pc.bold('--tables')}:`
    );
    for (const t of pubReconcile.added) console.log(`      ${pc.green('+')} ${t}`);
    for (const t of pubReconcile.removed)
      console.log(`      ${pc.red('-')} ${t} ${pc.dim('(stops replicating to Ablo)')}`);
    if (pubReconcile.recreated && existingPublication.allTables)
      console.log(`      ${pc.red('-')} ${pc.dim('every other table (was FOR ALL TABLES)')}`);
    console.log();
  }
  printPlan(steps, args.showSql);
  if (!args.yes) {
    if (!process.stdout.isTTY) {
      await admin.end({ timeout: 2 });
      console.error(
        pc.dim(`  Re-run with ${pc.bold('--yes')} to apply this in a non-interactive session.\n`)
      );
      process.exit(1);
    }
    const proceed = await confirm({
      message: rotating ? `Re-key Ablo's roles on ${target}?` : `Provision Ablo on ${target}?`,
      initialValue: true,
    });
    if (isCancel(proceed) || !proceed) {
      await admin.end({ timeout: 2 });
      console.log(
        pc.dim(`  Nothing applied. Run ${pc.bold('ablo connect')} to see the manual recipe.\n`)
      );
      process.exit(0);
    }
  }

  // 4. Apply.
  try {
    await executePlan(admin, steps, () => buildPlan('plaintext'));
  } catch (err) {
    await admin.end({ timeout: 2 }).catch(() => undefined);
    const pg = (err ?? {}) as PgErrorLike;
    console.error(
      pc.red(`\n  Setup stopped: ${pg.message ?? String(err)}`) +
        pc.dim(`  Every step is safe to re-run.\n`)
    );
    process.exit(1);
  }
  await admin.end({ timeout: 2 });

  // 5. Build the scoped connection strings in memory — never written to disk.
  const role = args.role && args.role.length > 0 ? args.role : ABLO_REPLICATION_ROLE;
  const writeRole = args.writeRole && args.writeRole.length > 0 ? args.writeRole : ABLO_WRITE_ROLE;
  const replicationUrl = rewriteDatabaseUrl(adminUrl, role, replicationPassword);
  const writeUrl = rewriteDatabaseUrl(adminUrl, writeRole, writePassword);
  console.log(`\n  ${pc.green('✓')} Roles ${rotating ? 're-keyed' : 'created'}.\n`);

  // 6. If logical replication isn't on yet, registration would be refused, so the
  // roles are ready but the source is not. This is an INCOMPLETE setup — exit
  // non-zero so an unattended run can't read it as success — with the one
  // provider-specific step left. Re-running rotates the passwords, so nothing is
  // left stranded.
  if (!walReady) {
    console.error(
      `  ${pc.yellow('!')} One step left — logical replication isn't on yet.\n` +
        `    ${logicalReplicationGuidance(provider)}.\n` +
        `\n  Then re-run:  ${pc.cyan(`npx ablo ${verb}`)}\n`
    );
    process.exit(1);
  }

  // 7. Prove it locally where we can. A machine that can't dial the host says
  // nothing about whether Ablo can — the server re-checks from its own network at
  // registration — so a local dial failure is a note, not a stop.
  const verifier = postgres(replicationUrl, {
    max: 1,
    prepare: false,
    connect_timeout: 10,
    onnotice: () => {
      // Swallow postgres NOTICE chatter — the readiness checklist reports its own findings.
    },
  });
  let items: readonly CheckItem[] | null;
  try {
    items = await probeReadiness(verifier);
  } catch {
    items = null;
    console.log(pc.dim(`  Couldn't verify from here; Ablo will validate from its own network.\n`));
  }
  await verifier.end({ timeout: 2 }).catch(() => undefined);

  const failed = items?.filter((i) => !i.ok) ?? [];
  if (failed.length > 0) {
    for (const item of failed) console.log(`  ${pc.yellow('!')} ${item.label}`);
    console.log(`\n  ${pc.dim('Resolve, then re-run')}  ${pc.cyan(`npx ablo ${verb}`)}\n`);
    process.exit(1);
  }

  // 8. Hand both scoped roles to Ablo directly. Nothing is left in your .env.
  // Registration includes Ablo's server-side read-back, so a success return is
  // proof the new credential works — and on failure we never exit success.
  const apiUrl = apiBaseUrl();
  const registered = await registerDirectDataSource({
    apiUrl,
    apiKey,
    replicationUrl,
    writeUrl,
    route: args.route,
  });
  const outcome = postRegistrationOutcome({ rotating, registered });
  if (outcome.notice) {
    console.error(`\n  ${pc.red(outcome.notice.split('\n').join('\n  '))}\n`);
  }
  process.exit(outcome.exitCode);
}
