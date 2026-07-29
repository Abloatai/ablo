/**
 * Creates a limited Postgres role so a connection can pass the server's
 * row-level-security check. The server refuses connections made as a superuser,
 * or as any role with the BYPASSRLS attribute, because row-level security — the
 * mechanism that keeps one tenant from reading another's rows — cannot be
 * enforced over such a connection; the rejection carries the code
 * `database_role_cannot_enforce_rls`. Many managed-Postgres dashboards hand out
 * exactly such a role in their default connection string.
 *
 * Rather than ask you to hand-write `CREATE ROLE` SQL, this module creates the
 * scoped role on your own machine, using the credential already in your
 * `DATABASE_URL` — the same access the migrate command uses to run schema
 * changes. That owner credential is never sent anywhere; the generated password
 * for the new role is written to your environment file and never printed.
 */

import { randomBytes, pbkdf2Sync, createHmac, createHash } from 'crypto';
import postgres from 'postgres';

export const DEFAULT_SCOPED_ROLE = 'ablo_app';

export interface RoleSafety {
  readonly role: string;
  readonly superuser: boolean;
  readonly bypassRls: boolean;
  /** True when the server would reject this connection because its role can bypass row-level security. */
  readonly unsafe: boolean;
}

/** Inspects the currently connected role and reports whether the server would accept it, mirroring the server's own safety check. */
export async function detectRoleSafety(sql: postgres.Sql): Promise<RoleSafety> {
  const rows = await sql<
    { rolname: string; rolsuper: boolean; rolbypassrls: boolean }[]
  >`SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`;
  const row = rows[0];
  if (!row) return { role: 'unknown', superuser: false, bypassRls: false, unsafe: false };
  return {
    role: row.rolname,
    superuser: row.rolsuper,
    bypassRls: row.rolbypassrls,
    unsafe: row.rolsuper || row.rolbypassrls,
  };
}

/** Generates a URL-safe random password for the scoped role. Callers write it to the environment file; it is never printed. */
export function generateRolePassword(): string {
  return randomBytes(24).toString('base64url');
}

/**
 * Computes the client-side SCRAM-SHA-256 verifier for a password, in the format
 * PostgreSQL stores it (RFC 5803:
 * `SCRAM-SHA-256$<iterations>:<salt>$<StoredKey>:<ServerKey>`) — the same value
 * `psql`'s `\\password` sends. Putting this verifier in a `CREATE ROLE ...
 * PASSWORD` clause, rather than the plaintext, keeps the password out of the
 * server's statement log, which would otherwise record the statement verbatim.
 */
export function scramSha256Verifier(password: string, iterations = 4096): string {
  const salt = randomBytes(16);
  const saltedPassword = pbkdf2Sync(password, salt, iterations, 32, 'sha256');
  const clientKey = createHmac('sha256', saltedPassword).update('Client Key').digest();
  const storedKey = createHash('sha256').update(clientKey).digest();
  const serverKey = createHmac('sha256', saltedPassword).update('Server Key').digest();
  return `SCRAM-SHA-256$${iterations}:${salt.toString('base64')}$${storedKey.toString('base64')}:${serverKey.toString('base64')}`;
}

/**
 * Returns the SQL statements that create the scoped role and grant it the
 * privileges it needs, as an array a caller can run or display. Safe to run
 * more than once: if the role already exists, its password is rotated instead
 * of raising an error. The password clause carries the client-side SCRAM
 * verifier rather than the plaintext.
 */
export function scopedRoleStatements(input: {
  readonly database: string;
  readonly role?: string;
  readonly password: string;
  /**
   * How the password is written into the SQL. `scram-verifier` (the default)
   * sends the client-side hash, so the plaintext never reaches the server's
   * statement log. Some managed providers intercept role statements and reject
   * a verifier, asking for a plaintext password instead; `plaintext` is the
   * fallback for those, still sent over TLS.
   */
  readonly passwordMode?: 'scram-verifier' | 'plaintext';
}): readonly string[] {
  const role = input.role ?? DEFAULT_SCOPED_ROLE;
  const q = (id: string): string => `"${id.replace(/"/g, '""')}"`;
  const pw =
    (input.passwordMode ?? 'scram-verifier') === 'scram-verifier'
      ? scramSha256Verifier(input.password)
      : input.password.replace(/'/g, "''");
  return [
    `DO $$ BEGIN
  CREATE ROLE ${q(role)} LOGIN PASSWORD '${pw}'
    NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
EXCEPTION WHEN duplicate_object THEN
  -- Rerun: rotate ONLY the password. Re-asserting attributes here trips
  -- managed-Postgres permission walls (Neon: "permission denied to alter
  -- role" for attribute changes by non-superusers); the attributes were set
  -- at creation, and the server-side probe still audits the live role.
  ALTER ROLE ${q(role)} WITH LOGIN PASSWORD '${pw}';
END $$;`,
    `GRANT CREATE, CONNECT ON DATABASE ${q(input.database)} TO ${q(role)};`,
    `GRANT CREATE, USAGE ON SCHEMA public TO ${q(role)};`,
  ];
}

/** Returns a copy of the connection URL with the username and password replaced by the scoped role's credentials, leaving host, database, and query parameters intact. */
export function rewriteDatabaseUrl(ownerUrl: string, role: string, password: string): string {
  const url = new URL(ownerUrl);
  url.username = role;
  url.password = password;
  return url.toString();
}

export interface ScopedRoleResult {
  readonly role: string;
  /** The full replacement DATABASE_URL (contains the generated password). */
  readonly databaseUrl: string;
}

/**
 * Creates the scoped role — or rotates its password if it already exists —
 * using the owner connection from the local machine. Returns the replacement
 * connection URL; the caller is responsible for saving it to the environment
 * file and should not print it, since it contains the generated password.
 */
export async function createScopedRole(
  ownerUrl: string,
  options?: { readonly role?: string },
): Promise<ScopedRoleResult> {
  const role = options?.role ?? DEFAULT_SCOPED_ROLE;
  const password = generateRolePassword();
  const database = new URL(ownerUrl).pathname.replace(/^\//, '') || 'postgres';
  const sql = postgres(ownerUrl, { max: 1, prepare: false, onnotice: () => {} });
  try {
    try {
      for (const statement of scopedRoleStatements({ database, role, password })) {
        await sql.unsafe(statement);
      }
    } catch (err) {
      // Some managed providers intercept role statements and reject a SCRAM
      // verifier outright. Retry with a plaintext password over TLS for that
      // specific refusal; any other error is genuine and propagates.
      const message = err instanceof Error ? err.message : String(err);
      if (!/plaintext password/i.test(message)) throw err;
      for (const statement of scopedRoleStatements({ database, role, password, passwordMode: 'plaintext' })) {
        await sql.unsafe(statement);
      }
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
  return { role, databaseUrl: rewriteDatabaseUrl(ownerUrl, role, password) };
}

import pc from 'picocolors';
import { confirm, isCancel } from '@clack/prompts';
import { writeFileSync, existsSync, readFileSync, appendFileSync } from 'fs';
import { resolve } from 'path';

/**
 * Checks the configured `DATABASE_URL` and, when it connects as a superuser or
 * a BYPASSRLS role the server would reject, offers to create the limited role
 * for the developer. Everything runs on the local machine using the credential
 * already in `DATABASE_URL`; that credential is never sent anywhere, and the new
 * role's password is written to the environment file, not printed. In a
 * non-interactive session (no terminal) it explains the situation and returns
 * the URL unchanged rather than prompting. Returns the connection URL to use
 * from then on — the freshly scoped one if the role was created, otherwise the
 * original. {@link createScopedRole} does the actual work.
 */
export async function ensureScopedRoleInteractive(dbUrl: string): Promise<string> {
  let safety;
  try {
    const sql = postgres(dbUrl, { max: 1, prepare: false, onnotice: () => {} });
    try {
      safety = await detectRoleSafety(sql);
    } finally {
      await sql.end({ timeout: 5 });
    }
  } catch {
    return dbUrl; // unreachable DB — let the migration produce the real error
  }
  if (!safety.unsafe) return dbUrl;

  const why = safety.superuser ? 'a superuser role' : 'an admin role that bypasses row-level security';
  // Lead with the plain-language reason, then head off the two misreadings this
  // prompt tends to trigger: that Ablo wants the owner credential, or that
  // ownership is being handed over. Neither is true — the role is created
  // locally, and Ablo only ever sees the limited role's password.
  console.log(
    `\n  ${pc.yellow('!')} Your ${pc.bold('DATABASE_URL')} connects as ${pc.bold(safety.role)} — ${why}.\n` +
      `    Ablo enforces tenant isolation with row-level security (so one org can never\n` +
      `    read another's rows), and a role that bypasses RLS would silently defeat that —\n` +
      `    so the server won't accept it (${pc.bold('database_role_cannot_enforce_rls')}).\n\n` +
      `    The fix runs ${pc.bold('entirely on this machine')}, with the credential already in\n` +
      `    your DATABASE_URL. It does ${pc.bold('NOT')} send that credential to Ablo and does\n` +
      `    ${pc.bold('NOT')} transfer ownership of anything — it just creates a limited role\n` +
      `    (${pc.bold(DEFAULT_SCOPED_ROLE)}: NOSUPERUSER, NOBYPASSRLS) for your app to connect as,\n` +
      `    and repoints DATABASE_URL at it.`,
  );

  // CI / agents (no TTY): don't block, don't guess — point at the recipe.
  if (!process.stdout.isTTY) {
    console.log(
      pc.dim(
        `    Run \`npx ablo migrate\` in an interactive terminal to create it automatically,\n` +
          `    or apply the manual recipe: https://docs.abloatai.com/quickstart#scoped-role`,
      ),
    );
    return dbUrl;
  }

  const proceed = await confirm({
    message: `Create the limited role ${DEFAULT_SCOPED_ROLE} here and repoint DATABASE_URL at it? (Ablo never sees your ${safety.role} credential)`,
    initialValue: true,
  });
  if (isCancel(proceed) || !proceed) {
    console.log(pc.dim('    Skipped — see https://docs.abloatai.com/quickstart#scoped-role for the manual recipe.'));
    return dbUrl;
  }

  const { role, databaseUrl } = await createScopedRole(dbUrl);
  const where = persistDatabaseUrl(databaseUrl);
  console.log(
    `  ${pc.green('✓')} Created the limited role ${pc.bold(role)} and updated ${pc.bold('DATABASE_URL')} in ${pc.bold(where)}.\n` +
      pc.dim(`    Your ${safety.role} credential never left this machine; the new password was written, not printed.`),
  );
  return databaseUrl;
}

/**
 * Writes the new `DATABASE_URL` back to wherever the project keeps it: the
 * environment file that already defines it (`.env.local`, then `.env`);
 * otherwise it appends to `.env.local`, creating it with `0600` permissions,
 * and ensures the file is listed in `.gitignore`. This is the `DATABASE_URL`
 * counterpart to how `wireEnvLocal` handles the API key. Returns the name of the
 * file it wrote.
 */
export function persistDatabaseUrl(databaseUrl: string, cwd: string = process.cwd()): string {
  // Quoted, because a connection string carries `&` between query parameters
  // (`?sslmode=verify-full&channel_binding=require`) and an env file is not only
  // read by a framework's parser — people `source` it. Unquoted, the shell reads
  // that `&` as a background-job operator and refuses the whole file with a
  // parse error, taking every other variable in it down too. Every dotenv reader
  // strips surrounding quotes, and `readProjectEnvValue` below already does.
  const line = `DATABASE_URL="${databaseUrl}"`;
  for (const name of ['.env.local', '.env']) {
    const path = resolve(cwd, name);
    if (!existsSync(path)) continue;
    const content = readFileSync(path, 'utf8');
    if (/^DATABASE_URL=/m.test(content)) {
      writeFileSync(path, content.replace(/^DATABASE_URL=.*$/m, line));
      return name;
    }
  }
  const envLocal = resolve(cwd, '.env.local');
  if (existsSync(envLocal)) {
    const content = readFileSync(envLocal, 'utf8');
    appendFileSync(envLocal, `${content.endsWith('\n') || content.length === 0 ? '' : '\n'}${line}\n`);
  } else {
    writeFileSync(envLocal, `${line}\n`, { mode: 0o600 });
  }
  const gitignorePath = resolve(cwd, '.gitignore');
  const gitignore = existsSync(gitignorePath) ? readFileSync(gitignorePath, 'utf8') : '';
  if (!/^(\.env\.local|\.env\*|\.env\.\*|\.env.*)$/m.test(gitignore)) {
    writeFileSync(
      gitignorePath,
      `${gitignore.endsWith('\n') || gitignore.length === 0 ? gitignore : `${gitignore}\n`}.env.local\n`,
    );
  }
  return '.env.local';
}

/**
 * The variables the replication credential is read from — exactly one: the
 * canonical `ABLO_REPLICATION_DATABASE_URL`. The deprecated `DATABASE_URL` alias
 * was read here through 0.31.x and removed in 0.32.0 — reading a scoped string
 * from the generic `DATABASE_URL` risked validating against the app's own
 * database. `DATABASE_URL` keeps its own honest job: the DDL credential, for
 * `ablo migrate` and for `--apply` (see {@link readProjectAdminDatabaseUrl}).
 */
export const REPLICATION_URL_VARS = ['ABLO_REPLICATION_DATABASE_URL'] as const;

/**
 * Resolve the replication credential and report which variable it came from —
 * `process.env` first, then the framework env files the app would load
 * (`.env.local`, `.env`), since the CLI runs via `npx` without the app's env
 * loader and must read those files itself.
 */
export function readProjectReplicationUrlWithSource(
  cwd: string = process.cwd(),
): { url: string; variable: (typeof REPLICATION_URL_VARS)[number] } | null {
  for (const variable of REPLICATION_URL_VARS) {
    const value = process.env[variable];
    if (value) return { url: value, variable };
  }
  for (const variable of REPLICATION_URL_VARS) {
    const value = readProjectEnvValue(variable, cwd);
    if (value) return { url: value, variable };
  }
  return null;
}

/**
 * The variable the app's own database connection is read from — exactly one
 * name, so a message can be built from it rather than restating it. The
 * `ABLO_DATABASE_URL` alias that `check`, `pull`, and `init` read alongside it
 * is gone: a second name for one credential works in some commands and not
 * others, which is worse than not having it.
 */
export const ADMIN_URL_VAR = 'DATABASE_URL' as const;

/**
 * The app's own `DATABASE_URL` — the credential that runs DDL. Every caller
 * that wants the unscoped connection the app itself holds comes here:
 * `migrate` applies its statements through it, `check` and `pull` introspect
 * through it, and `--apply` / `--rotate` provision through it when `--url`
 * isn't given (used once, transiently, never persisted or registered).
 *
 * Deliberately NOT the replication chain: the scoped replicator role is
 * SELECT-only, so it cannot `CREATE ROLE` or `CREATE TABLE`. Reading it here
 * would fail later with a confusing message — which is precisely what happened.
 * `migrate` reached the replication chain through a `readProjectDatabaseUrl`
 * alias whose name hid which variable it read; when the deprecated
 * `DATABASE_URL` entry left `REPLICATION_URL_VARS` in 0.32.0, `migrate` stopped
 * seeing `DATABASE_URL` at all while still naming it in the failure. The alias
 * is gone. Each credential is now reached by a function that names it.
 */
export function readProjectAdminDatabaseUrl(cwd: string = process.cwd()): string | null {
  return process.env[ADMIN_URL_VAR] ?? readProjectEnvValue(ADMIN_URL_VAR, cwd);
}

/**
 * Resolve the separately scoped direct-write role URL used by `ablo connect`.
 * Keeping it distinct from `DATABASE_URL` prevents the REPLICATION role from
 * accidentally becoming Ablo's DML credential (or the writer from gaining
 * REPLICATION). Like the rest of the CLI, this reads framework env files when
 * invoked through `npx`.
 */
export function readProjectWriteDatabaseUrl(cwd: string = process.cwd()): string | null {
  const fromEnv = process.env.ABLO_WRITE_DATABASE_URL;
  if (fromEnv) return fromEnv;
  return readProjectEnvValue('ABLO_WRITE_DATABASE_URL', cwd);
}

function readProjectEnvValue(variable: string, cwd: string): string | null {
  return readProjectEnvVariable(variable, cwd, false)?.value ?? null;
}

/** A named value from the process environment or the project env files.
 *
 * This is intentionally explicit: callers choose the variable name before any
 * file is read. It lets an inspection command such as `whoami --key-env
 * ABLO_API_KEY_LIVE` examine a candidate key without sourcing the whole file
 * (where a database URL containing `&` is shell syntax) and without letting an
 * ambient file silently choose a target.
 */
export function readProjectEnvVariable(
  variable: string,
  cwd: string = process.cwd(),
  includeProcess: boolean = true,
): { value: string; source: ApiKeySource } | null {
  if (includeProcess && process.env[variable]) {
    return { value: process.env[variable], source: 'env' };
  }
  for (const filename of ['.env.local', '.env']) {
    const path = resolve(cwd, filename);
    if (!existsSync(path)) continue;
    const match = new RegExp(`^${variable}=(.+)$`, 'm').exec(readFileSync(path, 'utf8'));
    if (match?.[1]) {
      return {
        value: match[1].trim().replace(/^["']|["']$/g, ''),
        source: filename as '.env.local' | '.env',
      };
    }
  }
  return null;
}

/** Where a resolved `ABLO_API_KEY` came from — for clear "which key did push use?" errors. */
export type ApiKeySource = 'env' | '.env.local' | '.env';

/**
 * Resolves `ABLO_API_KEY` the way a framework would: `process.env` first, then
 * the environment files a framework loads (`.env.local`, then `.env`). Run
 * through `npx`, the CLI has no framework env loader, so a key placed in
 * `.env.local` — where the SDK reads it at runtime — is invisible to
 * `process.env`; reading the files here keeps the CLI from falling back to the
 * stored login credential and using a different key than the app does. Returns
 * the key together with the source it came from, so a caller can name that
 * source in an error, or `null` when no key is set.
 *
 * Prefer {@link resolveEffectiveApiKey} over calling this directly: it is the
 * single resolution chain that `push`, `dev`, and `status` share, which keeps
 * the key reported by diagnostics identical to the key used to deploy.
 */
export function readProjectApiKey(
  cwd: string = process.cwd(),
): { key: string; source: ApiKeySource } | null {
  const found = readProjectEnvVariable('ABLO_API_KEY', cwd);
  return found ? { key: found.value, source: found.source } : null;
}
