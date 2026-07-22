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
import {
  ledgerBlocker,
  publishedTableBlockers,
  ownershipRemediation,
  formatUnresolvedOwnership,
} from './connectOwnership';
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
  readonly key: 'own' | 'wal' | 'publication' | 'replication-role' | 'write-role' | 'grants';
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
 * The recovery instruction for a rotation that re-keyed the database but never
 * completed registration — whatever ended it (a registration refusal, a network
 * failure, or the operator cancelling mid-run). One constant so the failure
 * path and the interrupt path can never tell the operator two different
 * stories.
 */
export const ROTATE_STRANDED_CREDENTIALS_NOTICE =
  'The new passwords are set in your database, but Ablo could not be updated with them.\n' +
  'Ablo still holds the previous password, which no longer works — writes will fail until\n' +
  'you re-run `ablo connect rotate` (each run is idempotent and rotates a fresh password).';

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
    notice: ROTATE_STRANDED_CREDENTIALS_NOTICE,
  };
}

/** Build the password clause for a role, either the SCRAM verifier or an escaped plaintext literal. */
export function passwordClause(password: string, mode: PasswordMode): string {
  return mode === 'scram-verifier' ? scramSha256Verifier(password) : password.replace(/'/g, "''");
}

/**
 * Create a role, or — only when re-keying is the point — set its password.
 *
 * The distinction is load-bearing and used not to be. This once recovered from
 * `duplicate_object` by running `ALTER ROLE … PASSWORD` unconditionally, which
 * is idempotent in the sense of not erroring and destructive in the sense that
 * matters: any second `apply` against a database silently re-keyed a role
 * another connection was still authenticating with. Because the secret store is
 * per-plane, each plane then held its own now-wrong copy of one role's password,
 * and the failure surfaced later and elsewhere as a rejected credential.
 *
 * So `apply` creates and otherwise leaves the role alone, and `rotate` — the
 * verb whose whole purpose is a new password — is the only thing that re-keys.
 * Postgres has no `CREATE ROLE IF NOT EXISTS`, so the guard is an explicit
 * `pg_roles` check rather than an exception handler. Attributes are never
 * re-asserted on an existing role: that trips managed-Postgres permission walls,
 * and the server-side probe audits the live attributes anyway.
 */
function idempotentRole(
  role: string,
  attributes: string,
  clause: string,
  rotate: boolean,
): string {
  const lines = [
    'DO $$ BEGIN',
    `  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role.replace(/'/g, "''")}') THEN`,
    `    CREATE ROLE ${quoteIdent(role)} WITH ${attributes} LOGIN PASSWORD '${clause}';`,
  ];
  if (rotate) {
    lines.push('  ELSE', `    ALTER ROLE ${quoteIdent(role)} WITH LOGIN PASSWORD '${clause}';`);
  }
  lines.push('  END IF;', 'END $$;');
  return lines.join('\n');
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
  /**
   * Re-key roles that already exist. `apply` leaves an existing role's password
   * alone — another connection may be authenticating with it — so only `rotate`,
   * whose whole purpose is a new password, passes this.
   */
  readonly rotate?: boolean;
  readonly credentials: ApplyCredentials;
  /** Omit the write-ahead-log step when the cluster is already `wal_level = logical`. */
  readonly walAlreadyLogical?: boolean;
  /** Shapes the write-ahead-log step's guidance; managed providers show a
   *  console/setting action instead of an `ALTER SYSTEM` that can't run. */
  readonly provider?: DbProvider;
  /** The publication's live membership. When given, the publish step reconciles it
   *  to `--tables` (declarative); when omitted, it falls back to create-if-absent. */
  readonly existingPublication?: PublicationState;
  /** Inherit-grants that let this admin manage tables an earlier integration's role
   *  owns, run first so the publish and grant steps apply cleanly. See connectOwnership. */
  readonly inheritGrants?: readonly string[];
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
              title: 'Let Ablo see your changes as they happen',
              detail: 'lets Ablo read your changes as they happen (needs a restart to take effect)',
              sql: [`ALTER SYSTEM SET wal_level = 'logical';`],
            }
          : {
              key: 'wal',
              title: 'Let Ablo see your changes as they happen',
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
      ? 'already sharing exactly these tables — nothing to change'
      : tables.length > 0
        ? `a live feed of the ${tables.length} table${tables.length === 1 ? '' : 's'} you chose`
        : 'a live feed of your tables';

  // When an earlier integration's role owns your tables, grant this admin
  // inheritance of that role first — so the publish and grant steps, which
  // Postgres reserves for the owner, apply cleanly. Runs before everything else.
  const ownStep: readonly ApplyStep[] =
    input.inheritGrants && input.inheritGrants.length > 0
      ? [
          {
            key: 'own',
            title: 'Let this admin manage tables owned by another role',
            detail:
              'your admin inherits the owning role so the steps below apply — reversible, no ownership change',
            sql: input.inheritGrants,
          },
        ]
      : [];

  return [
    ...ownStep,
    ...walStep,
    {
      key: 'publication',
      title: 'Publish your tables to Ablo',
      detail: publicationDetail,
      sql: publicationSql,
    },
    {
      key: 'replication-role',
      title: 'Create the read-only login Ablo reads with',
      detail: `${role} — it can follow your changes and read, nothing else`,
      sql: [
        idempotentRole(
          role,
          'REPLICATION',
          input.credentials.replicationClause,
          input.rotate === true,
        ),
      ],
    },
    {
      key: 'write-role',
      title: 'Create the login Ablo writes with',
      detail: `${writeRole} — writes rows through Ablo; where a table has row-level-security policies, they govern its writes too (it can't bypass them)`,
      sql: [
        idempotentRole(
          writeRole,
          'NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT',
          input.credentials.writeClause,
          input.rotate === true,
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

/** A host that fronts the database through a connection pooler. */
export interface PooledHost {
  readonly provider: DbProvider;
  /** The direct host, when it can be derived from the pooled one. */
  readonly direct?: string;
}

/**
 * Whether a host reaches the database through a CONNECTION POOLER rather than
 * the database itself. This matters because a pooler is not a smaller version
 * of the database — it terminates the session, so logical replication and the
 * setup that establishes it cannot run over it at all.
 *
 * The failure is worth naming because of how it presents: a pooler commonly
 * refuses the connection as `password authentication failed`, which sends a
 * reader to check credentials that are perfectly correct.
 */
export function detectPooler(hostOrTarget: string): PooledHost | null {
  const host = hostOrTarget.toLowerCase();
  const provider = detectProvider(host);
  // Neon encodes it in the endpoint id, so the direct host is the same name
  // with the marker removed — a fix the reader can apply without a lookup.
  if (provider === 'neon' && host.includes('-pooler')) {
    return { provider, direct: hostOrTarget.replace(/-pooler/i, '') };
  }
  // Supabase's pooler is a separate host entirely (`aws-0-<region>.pooler.…`),
  // so there is no direct host to derive from it.
  if (host.includes('pooler.supabase')) return { provider: 'supabase' };
  // RDS Proxy fronts the instance under a `.proxy-` subdomain.
  if (host.includes('.proxy-') && provider === 'rds') return { provider };
  return null;
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

  // 1b. Ownership preflight. The plan publishes and grants on your tables and the
  // idempotency ledger — operations Postgres reserves for each object's owner. When
  // a relation is owned by a role this admin reaches only through a non-inheriting
  // membership (the common managed-Postgres shape), apply grants the admin that
  // inheritance itself, as the first stage of the plan, so the run proceeds with no
  // manual step. Only ownership it genuinely can't take over stops the run.
  const ledger = await ledgerBlocker(admin).catch(() => null);
  const foreignTables = await publishedTableBlockers(admin, args.tables).catch(() => []);
  const { inheritGrants, unresolved } = ownershipRemediation(
    [...(ledger ? [ledger] : []), ...foreignTables],
    capability.rolname
  );
  if (unresolved.length > 0) {
    await admin.end({ timeout: 2 });
    console.error(formatUnresolvedOwnership(unresolved, capability.rolname, target));
    process.exit(1);
  }

  // 1c. Decide the write-ahead-log step from reality, not hope: read the current
  // wal_level (a SHOW every role can run) and identify the provider. When it is
  // already logical, the step drops out entirely; when it isn't, the plan and the
  // follow-up both speak the provider's language instead of printing an
  // ALTER SYSTEM that a managed host can't run.
  const provider = detectProvider(target);
  const walReady = (await currentWalLevel(admin)) === 'logical';

  // Rotation guards a LIVE source, so nothing may be re-keyed unless the run
  // can plausibly reach registration: a database that isn't sharing changes
  // would be re-keyed and then stopped at the readiness gate, stranding
  // credentials Ablo doesn't hold while the current ones still work. Refuse
  // up front instead — the database is untouched and writes keep flowing on
  // the existing password until this is fixed.
  if (rotating && !walReady) {
    await admin.end({ timeout: 2 });
    console.error(
      `  ${pc.yellow('!')} Your database isn't sharing changes with Ablo right now, so the roles were ${pc.bold('not')} re-keyed\n` +
        `    (re-keying here would break the working credentials before Ablo could take the new ones).\n` +
        `    ${logicalReplicationGuidance(provider)}.\n` +
        `\n  Then re-run:  ${pc.cyan(`npx ablo ${verb}`)}\n`
    );
    process.exit(1);
  }

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
      rotate: rotating,
      credentials: {
        replicationClause: passwordClause(replicationPassword, mode),
        writeClause: passwordClause(writePassword, mode),
      },
      walAlreadyLogical: walReady,
      provider,
      existingPublication,
      inheritGrants,
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
        pc.dim(`  Nothing applied. Run ${pc.bold('ablo connect --manual')} to see the setup SQL.\n`)
      );
      process.exit(0);
    }
  }

  // 4. Apply. From the first ALTER ROLE until registration lands, a rotate has
  // the database on passwords Ablo doesn't hold yet — a cancel in that window
  // (Ctrl-C, a closed terminal sending SIGTERM) strands a live source on dead
  // credentials with no explanation. The handler makes even that exit tell the
  // operator exactly how to recover; `apply` has no live source to strand.
  const onRotateInterrupt = (): void => {
    console.error(`\n\n  ${pc.red(ROTATE_STRANDED_CREDENTIALS_NOTICE.split('\n').join('\n  '))}\n`);
    process.exit(130);
  };
  if (rotating) {
    process.once('SIGINT', onRotateInterrupt);
    process.once('SIGTERM', onRotateInterrupt);
  }
  try {
    await executePlan(admin, steps, () => buildPlan('plaintext'));
  } catch (err) {
    await admin.end({ timeout: 2 }).catch(() => undefined);
    const pg = (err ?? {}) as PgErrorLike;
    console.error(
      pc.red(`\n  Setup stopped: ${pg.message ?? String(err)}`) +
        pc.dim(`  Every step is safe to re-run.\n`)
    );
    if (rotating) {
      // The plan may have re-keyed a role before stopping — same recovery.
      console.error(`  ${pc.red(ROTATE_STRANDED_CREDENTIALS_NOTICE.split('\n').join('\n  '))}\n`);
    }
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
      `  ${pc.yellow('!')} One step left — your database isn't sharing changes with Ablo yet.\n` +
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
    if (!rotating) {
      console.log(`\n  ${pc.dim('Resolve, then re-run')}  ${pc.cyan(`npx ablo ${verb}`)}\n`);
      process.exit(1);
    }
    // A rotate has already re-keyed the roles, so stopping here would strand a
    // live source on credentials Ablo doesn't hold — over findings this machine
    // may simply be unable to judge. Registration is the authority (the engine
    // re-validates from its own network); let it decide, and its failure path
    // already carries the recovery notice.
    console.log(
      `\n  ${pc.dim('Continuing to registration — Ablo re-checks these from its own network.')}\n`
    );
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
  // The stranded-credential window is over: from here the outcome itself says
  // whether recovery is needed, so the interrupt handler must not speak again.
  process.off('SIGINT', onRotateInterrupt);
  process.off('SIGTERM', onRotateInterrupt);
  const outcome = postRegistrationOutcome({ rotating, registered });
  if (outcome.notice) {
    console.error(`\n  ${pc.red(outcome.notice.split('\n').join('\n  '))}\n`);
  }
  process.exit(outcome.exitCode);
}
