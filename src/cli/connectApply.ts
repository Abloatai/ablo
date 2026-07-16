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
import { existsSync, readFileSync, writeFileSync, appendFileSync } from 'fs';
import { resolve } from 'path';
import {
  ABLO_PUBLICATION,
  ABLO_REPLICATION_ROLE,
  ABLO_WRITE_ROLE,
  connectSetupSql,
  probeReadiness,
  quoteIdent,
  type CheckItem,
  type ConnectArgs,
} from './connect';
import {
  generateRolePassword,
  scramSha256Verifier,
  rewriteDatabaseUrl,
  readProjectDatabaseUrl,
} from './dbRole';
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

/**
 * Persist the two scoped connection strings to the project's environment file,
 * the way {@link persistDatabaseUrl} does for `DATABASE_URL` — replacing an
 * existing assignment or appending, and keeping the file out of git. The
 * passwords are written, never printed.
 */
function persistScopedUrls(
  vars: Readonly<Record<string, string>>,
  cwd: string = process.cwd(),
): string {
  const targets = ['.env.local', '.env'];
  const existing = targets.find((name) => existsSync(resolve(cwd, name)));
  const file = existing ?? '.env.local';
  const path = resolve(cwd, file);
  let content = existsSync(path) ? readFileSync(path, 'utf8') : '';
  for (const [name, value] of Object.entries(vars)) {
    const line = `${name}=${value}`;
    const pattern = new RegExp(`^${name}=.*$`, 'm');
    if (pattern.test(content)) {
      content = content.replace(pattern, line);
    } else {
      content = `${content}${content.endsWith('\n') || content.length === 0 ? '' : '\n'}${line}\n`;
    }
  }
  if (!existsSync(path)) {
    writeFileSync(path, content, { mode: 0o600 });
  } else {
    writeFileSync(path, content);
  }
  const gitignorePath = resolve(cwd, '.gitignore');
  const gitignore = existsSync(gitignorePath) ? readFileSync(gitignorePath, 'utf8') : '';
  if (!/^\.env(\.local|\*|\.\*)?$/m.test(gitignore)) {
    appendFileSync(
      gitignorePath,
      `${gitignore.endsWith('\n') || gitignore.length === 0 ? '' : '\n'}.env.local\n`,
    );
  }
  return file;
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
 * `ablo connect --apply`: create the roles, publication, and (where allowed)
 * logical-replication setting for the developer, then repoint the scoped URLs
 * and verify. Uses the admin credential in `DATABASE_URL`; that credential is
 * never sent anywhere, and the generated role passwords are written to the
 * environment file, not printed.
 */
export async function runConnectApply(args: ConnectArgs): Promise<void> {
  const adminUrl = readProjectDatabaseUrl();
  if (!adminUrl) {
    console.error(
      pc.red('  No DATABASE_URL found.') +
        pc.dim(` Point it at your admin connection and re-run.`),
    );
    process.exit(1);
  }

  console.log(
    `\n  ${brand('ablo')} ${pc.dim('connect --apply')}  ${pc.dim('set up your database for Ablo')}\n`,
  );

  // 1. Confirm the admin credential can actually create roles.
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
        pc.dim(` Point DATABASE_URL at your owner/admin connection and re-run.`),
    );
    process.exit(1);
  }

  // 2. Generate the role passwords and build the plan.
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
      message: `Set this up in ${capability.rolname === 'postgres' ? 'your database' : `your database as ${capability.rolname}`}?`,
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

  // 5. Repoint the scoped connection strings (passwords written, not printed).
  const role = args.role && args.role.length > 0 ? args.role : ABLO_REPLICATION_ROLE;
  const writeRole = args.writeRole && args.writeRole.length > 0 ? args.writeRole : ABLO_WRITE_ROLE;
  const replicationUrl = rewriteDatabaseUrl(adminUrl, role, replicationPassword);
  const writeUrl = rewriteDatabaseUrl(adminUrl, writeRole, writePassword);
  const where = persistScopedUrls({
    DATABASE_URL: replicationUrl,
    ABLO_WRITE_DATABASE_URL: writeUrl,
  });
  console.log(
    `\n  ${pc.green('✓')} Roles created — ${pc.bold('DATABASE_URL')} + ${pc.bold('ABLO_WRITE_DATABASE_URL')} updated in ${pc.bold(where)}.\n`,
  );

  // 6. Prove it: reconnect as the replication role and run the readiness checklist.
  const verifier = postgres(replicationUrl, { max: 1, prepare: false, connect_timeout: 10, onnotice: () => {} });
  let items: readonly CheckItem[];
  try {
    items = await probeReadiness(verifier);
  } catch {
    await verifier.end({ timeout: 2 }).catch(() => undefined);
    console.log(pc.dim(`  Verify when reachable:  `) + pc.cyan('npx ablo connect --check') + '\n');
    process.exit(0);
  }
  await verifier.end({ timeout: 2 });

  const failed = items.filter((i) => !i.ok);
  if (walDeferred) {
    console.log(
      `  ${pc.yellow('!')} One step left — logical replication needs a restart.\n` +
        pc.dim(`    RDS/Aurora: set rds.logical_replication=1, reboot.  Neon: enable it in settings.\n`) +
        `\n  Then:  ${pc.cyan('npx ablo connect --register')}\n`,
    );
    process.exit(0);
  }
  if (failed.length === 0) {
    console.log(`  ${pc.green('✓')} Verified.  Next:  ${pc.cyan('npx ablo connect --register')}\n`);
  } else {
    for (const item of failed) console.log(`  ${pc.yellow('!')} ${item.label}`);
    console.log(`\n  ${pc.dim('Resolve, then')}  ${pc.cyan('npx ablo connect --register')}\n`);
  }
  process.exit(0);
}
