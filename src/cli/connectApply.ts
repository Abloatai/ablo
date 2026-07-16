/**
 * `ablo connect --apply` runs the read-path setup for you instead of printing
 * SQL to copy. It connects with the admin credential already in `DATABASE_URL`,
 * creates the two scoped roles and the publication, turns on logical decoding
 * where it can, and repoints `DATABASE_URL` / `ABLO_WRITE_DATABASE_URL` at the
 * new least-privilege roles — then proves it worked by reconnecting as the
 * replication role and running the same readiness checklist `--check` runs.
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
 *      from the documented ones. `--apply` only swaps the three statements that
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
  registerDirectDataSource,
  type CheckItem,
  type ConnectArgs,
} from './connect';
import {
  generateRolePassword,
  scramSha256Verifier,
  rewriteDatabaseUrl,
  readProjectAdminDatabaseUrl,
} from './dbRole';
import { resolveApiKey } from './config';
import { DEFAULT_URL } from './push';
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
 * The exit code and, for `--rotate`, the recovery notice after the registration
 * attempt. Rotation is the one flow where a registration failure *after* the
 * `ALTER ROLE` is dangerous: the database already holds the new password Ablo
 * doesn't have yet, so writes break until it's reconciled. We can't roll the
 * password back (the CLI connects as admin and never held the role's old one),
 * and we can't register-then-swap (Ablo validates a credential by connecting with
 * it, so it must exist in the database first). So the safe shape is to refuse a
 * success exit and tell the operator to re-run `--rotate` — itself idempotent,
 * generating a fresh password each run. `--apply` needs no such notice: a failed
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
      'you re-run `ablo connect --rotate` (each run is idempotent and rotates a fresh password).',
  };
}

/** Build the password clause for a role, either the SCRAM verifier or an escaped plaintext literal. */
export function passwordClause(password: string, mode: PasswordMode): string {
  return mode === 'scram-verifier'
    ? scramSha256Verifier(password)
    : password.replace(/'/g, "''");
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
}): readonly ApplyStep[] {
  const role = input.role && input.role.length > 0 ? input.role : ABLO_REPLICATION_ROLE;
  const writeRole =
    input.writeRole && input.writeRole.length > 0 ? input.writeRole : ABLO_WRITE_ROLE;
  const tables = input.tables ?? [];

  // The canonical recipe. We keep every statement except the three we must
  // replace to run unattended, identified by their leading verb so a change to
  // the recipe's wording surfaces in the drift test rather than silently.
  const recipe = connectSetupSql({ tables, role, writeRole });
  const isWal = (s: string): boolean => s.startsWith('ALTER SYSTEM SET wal_level');
  const isPublication = (s: string): boolean => s.startsWith('CREATE PUBLICATION');
  const isRoleCreate = (s: string): boolean => /^CREATE ROLE /.test(s);
  const grants = recipe.filter((s) => !isWal(s) && !isPublication(s) && !isRoleCreate(s));

  const publicationTarget =
    tables.length > 0
      ? `FOR TABLE ${tables.map(quoteIdent).join(', ')}`
      : 'FOR ALL TABLES';

  return [
    {
      key: 'wal',
      title: 'Turn on logical replication',
      detail: 'lets Ablo read your changes as they happen',
      sql: [`ALTER SYSTEM SET wal_level = 'logical';`],
    },
    {
      key: 'publication',
      title: 'Publish your tables to Ablo',
      detail:
        tables.length > 0
          ? `a read stream of the ${tables.length} table${tables.length === 1 ? '' : 's'} you chose`
          : 'a read stream of your tables',
      sql: [
        `DO $$ BEGIN
  CREATE PUBLICATION ${quoteIdent(ABLO_PUBLICATION)} ${publicationTarget};
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;`,
      ],
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
      detail: `${writeRole} — writes rows through Ablo, and is subject to your row-level security`,
      sql: [
        idempotentRole(
          writeRole,
          'NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT',
          input.credentials.writeClause,
        ),
      ],
    },
    {
      key: 'grants',
      title: 'Grant each role exactly what it needs',
      detail: 'read access for the reader, row writes for the writer — no ownership, no schema changes',
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
    pc.dim(`\n  Your admin password stays on this machine.${showSql ? '' : ' (--show-sql for the exact statements)'}\n`),
  );
}

/** Look up whether the connected admin role can create the scoped roles. */
async function adminCanCreateRoles(sql: postgres.Sql): Promise<AdminCapabilityRow | null> {
  const rows = await sql.unsafe<AdminCapabilityRow[]>(
    `SELECT rolname, rolsuper, rolcreaterole FROM pg_roles WHERE rolname = current_user`,
  );
  return rows[0] ?? null;
}

/**
 * Run every step against the admin connection. The write-ahead-log step is the
 * one a managed provider (RDS, Neon) refuses — that is expected, not fatal: we
 * collect it as the single manual follow-up and keep going, because the roles
 * and publication still apply. A verifier the provider rejects is retried once
 * as plaintext over TLS, matching {@link createScopedRole}.
 */
async function executePlan(
  sql: postgres.Sql,
  steps: readonly ApplyStep[],
  rebuildPlaintext: () => readonly ApplyStep[],
): Promise<{ readonly walDeferred: boolean }> {
  let walDeferred = false;
  let plaintextSteps: readonly ApplyStep[] | null = null;
  for (const step of steps) {
    for (const statement of step.sql) {
      try {
        await sql.unsafe(statement);
      } catch (err) {
        if (step.key === 'wal') {
          // Managed providers reject ALTER SYSTEM; that is the expected path, and
          // the readiness re-check afterward reports it as the one thing to do.
          walDeferred = true;
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
  return { walDeferred };
}

/**
 * `ablo connect --apply` (and `--rotate`): create — or, for `--rotate`, re-key —
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
  const verb = rotating ? 'connect --rotate' : 'connect --apply';

  const adminUrl = args.url ?? readProjectAdminDatabaseUrl();
  if (!adminUrl) {
    console.error(
      pc.red('  No admin connection string.') +
        pc.dim(` Pass ${pc.bold('--url <admin-conn>')} (or set ${pc.bold('DATABASE_URL')}) and re-run.`),
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
          ` Run ${pc.bold('ablo login')} (or set ${pc.bold('ABLO_API_KEY')}) so Ablo knows which project to register this database for.`,
        ),
    );
    process.exit(1);
  }

  console.log(
    `\n  ${brand('ablo')} ${pc.dim(verb)}  ${pc.dim(rotating ? 're-key the scoped roles' : 'set up your database for Ablo')}\n`,
  );
  console.log(
    `  ${pc.dim('→')} ${pc.bold(target)}${adminSource === 'DATABASE_URL' ? pc.dim('  (admin via DATABASE_URL)') : ''}\n`,
  );

  // 1. Confirm the admin credential can actually create/alter roles.
  const admin = postgres(adminUrl, { max: 1, prepare: false, connect_timeout: 10, onnotice: () => {} });
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
        pc.dim(` Point ${pc.bold('--url')} at your owner/admin connection and re-run.`),
    );
    process.exit(1);
  }

  // 2. Generate fresh role passwords and build the plan. Every stage is
  // idempotent, so `--rotate` runs the same plan: an existing role has only its
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
    });
  const steps = buildPlan('scram-verifier');

  // 3. Show the plan in plain language and confirm.
  printPlan(steps, args.showSql);
  if (!args.yes) {
    if (!process.stdout.isTTY) {
      await admin.end({ timeout: 2 });
      console.error(
        pc.dim(`  Re-run with ${pc.bold('--yes')} to apply this in a non-interactive session.\n`),
      );
      process.exit(1);
    }
    const proceed = await confirm({
      message: rotating ? `Re-key Ablo's roles on ${target}?` : `Provision Ablo on ${target}?`,
      initialValue: true,
    });
    if (isCancel(proceed) || !proceed) {
      await admin.end({ timeout: 2 });
      console.log(pc.dim(`  Nothing applied. Run ${pc.bold('ablo connect')} to see the manual recipe.\n`));
      process.exit(0);
    }
  }

  // 4. Apply.
  let walDeferred = false;
  try {
    ({ walDeferred } = await executePlan(admin, steps, () => buildPlan('plaintext')));
  } catch (err) {
    await admin.end({ timeout: 2 }).catch(() => undefined);
    const pg = (err ?? {}) as PgErrorLike;
    console.error(
      pc.red(`\n  Setup stopped: ${pg.message ?? String(err)}`) +
        pc.dim(`  Every step is safe to re-run.\n`),
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

  // 6. If logical decoding still needs a restart, replication isn't ready, so
  // registration would be refused. Name the one manual step and stop; re-running
  // rotates the passwords, so nothing is left stranded.
  if (walDeferred) {
    console.log(
      `  ${pc.yellow('!')} One step left — logical replication needs a restart.\n` +
        pc.dim(`    RDS/Aurora: set rds.logical_replication=1, reboot.  Neon: enable it in settings.\n`) +
        `\n  Then re-run:  ${pc.cyan(`npx ablo ${verb}`)}\n`,
    );
    process.exit(0);
  }

  // 7. Prove it locally where we can. A machine that can't dial the host says
  // nothing about whether Ablo can — the server re-checks from its own network at
  // registration — so a local dial failure is a note, not a stop.
  const verifier = postgres(replicationUrl, { max: 1, prepare: false, connect_timeout: 10, onnotice: () => {} });
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
  const apiUrl = (process.env.ABLO_API_URL ?? DEFAULT_URL).replace(/\/+$/, '');
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
