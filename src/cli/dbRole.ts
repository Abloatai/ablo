/**
 * Scoped-role bootstrap — the CLI side of the RLS gate.
 *
 * Ablo's server refuses BYPASSRLS/superuser connections
 * (`database_role_cannot_enforce_rls`) because row-level security would be
 * unenforceable — and Neon/Supabase dashboard connection strings use exactly
 * such a role (Neon's `neondb_owner` is `neon_superuser`, which includes
 * BYPASSRLS). That gate is non-negotiable; making the user hand-write
 * `CREATE ROLE` SQL to cross it is not.
 *
 * The reconciliation: the CLI creates the scoped role FROM THE USER'S
 * MACHINE, with the credential already sitting in their `DATABASE_URL` —
 * the same trust context `ablo migrate` already uses to run DDL. The owner
 * credential never reaches Ablo's servers (product decision 2026-06-10:
 * Ablo never wields owner credentials, even transiently); the user never
 * opens a SQL editor. The generated password is written to the env file and
 * never printed.
 */

import { randomBytes, pbkdf2Sync, createHmac, createHash } from 'crypto';
import postgres from 'postgres';

export const DEFAULT_SCOPED_ROLE = 'ablo_app';

export interface RoleSafety {
  readonly role: string;
  readonly superuser: boolean;
  readonly bypassRls: boolean;
  /** True when the server-side RLS gate would reject this connection. */
  readonly unsafe: boolean;
}

/** Introspect the CONNECTED role the way the server's safety probe does. */
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

/** URL-safe generated password — never printed, only written to the env file. */
export function generateRolePassword(): string {
  return randomBytes(24).toString('base64url');
}

/**
 * Client-side SCRAM-SHA-256 verifier (RFC 5803 / PG `auth-password` format:
 * `SCRAM-SHA-256$<iter>:<salt>$<StoredKey>:<ServerKey>`) — what `psql`'s
 * `\\password` computes. Sending the VERIFIER instead of the plaintext in the
 * PASSWORD clause keeps the password out of the server's statement logs
 * (`log_statement` would otherwise capture `CREATE ROLE ... PASSWORD '...'`
 * verbatim — Vault tolerates that; psql does not, and neither do we).
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
 * The exact statements the docs recipe prescribes, as data (testable, and
 * shown to the user on request). Idempotent across reruns: an existing role
 * gets its password rotated instead of erroring. The PASSWORD clause carries
 * the client-side SCRAM verifier, never the plaintext.
 */
export function scopedRoleStatements(input: {
  readonly database: string;
  readonly role?: string;
  readonly password: string;
  /**
   * `scram-verifier` (default) sends the client-side hash — the plaintext
   * never reaches the server's statement log. Some managed providers
   * intercept role DDL and refuse verifiers (Neon's control plane: "Neon
   * only supports being given plaintext passwords") — `plaintext` is the
   * detected fallback, still over TLS (the same posture Vault's database
   * secrets engine ships with).
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

/** Same host/db/params, scoped user+password — pure and unit-testable. */
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
 * Create (or rotate) the scoped role using the owner connection, from the
 * user's machine. Returns the replacement URL; the caller owns persisting it
 * (env file) and MUST NOT print it.
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
      // Managed providers that intercept role DDL (Neon) refuse SCRAM
      // verifiers outright. Fall back to plaintext-over-TLS for exactly that
      // refusal — anything else is a real error and propagates.
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
 * The CLI side of the server's RLS gate. Neon/Supabase dashboard connection
 * strings use the database OWNER role (BYPASSRLS) — Ablo's server refuses
 * those (`database_role_cannot_enforce_rls`) because row-level security
 * would be unenforceable. Instead of making the user hand-write SQL, offer
 * to create the scoped role HERE, from their machine, with the credential
 * they already configured — the owner string never reaches Ablo's servers,
 * and the generated password is written to the env file, never printed.
 *
 * Returns the URL the migration (and the app) should use from now on.
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
  // Lead with the plain-language WHY, then pre-empt the two misreads this prompt
  // reliably triggers (especially for AI agents): that Ablo wants your owner
  // credential, or that "ownership" is being handed over. Neither is true — the
  // role is created locally and Ablo only ever sees the limited role's password.
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
 * Update DATABASE_URL where the user keeps it: the env file that already
 * defines it (.env.local, then .env), else append to .env.local (0600) and
 * make sure it's gitignored. Mirrors \`wireEnvLocal\`'s behavior for keys.
 */
export function persistDatabaseUrl(databaseUrl: string, cwd: string = process.cwd()): string {
  const line = `DATABASE_URL=${databaseUrl}`;
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
 * Resolve the project's DATABASE_URL the way the app will: process env
 * first, then the env files frameworks load (`.env.local`, `.env`). The CLI
 * runs via `npx` without the app's env loader, so it reads the files itself.
 */
export function readProjectDatabaseUrl(cwd: string = process.cwd()): string | null {
  const fromEnv = process.env.DATABASE_URL ?? process.env.ABLO_DATABASE_URL;
  if (fromEnv) return fromEnv;
  for (const name of ['.env.local', '.env']) {
    const path = resolve(cwd, name);
    if (!existsSync(path)) continue;
    const match = readFileSync(path, 'utf8').match(/^DATABASE_URL=(.+)$/m);
    if (match?.[1]) return match[1].trim().replace(/^["']|["']$/g, '');
  }
  return null;
}

/** Where a resolved `ABLO_API_KEY` came from — for clear "which key did push use?" errors. */
export type ApiKeySource = 'env' | '.env.local' | '.env';

/**
 * Resolve `ABLO_API_KEY` the way the app's framework does — `process.env` first,
 * then the env files frameworks load (`.env.local`, then `.env`). `npx ablo …`
 * runs WITHOUT Next/Vite's env loader, so a key a developer put in `.env.local`
 * (the natural place — it's where the SDK reads it at runtime) is invisible to
 * `process.env`. Without this, `push`/`dev` silently fall back to the stored
 * `ablo login` sandbox key and use the WRONG key (the reported "my production
 * key in .env.local is never used" bug). Returns the key + which source it came
 * from (so the caller can say so in an error), or `null` if none is set.
 */
export function readProjectApiKey(
  cwd: string = process.cwd(),
): { key: string; source: ApiKeySource } | null {
  if (process.env.ABLO_API_KEY) return { key: process.env.ABLO_API_KEY, source: 'env' };
  for (const name of ['.env.local', '.env'] as const) {
    const path = resolve(cwd, name);
    if (!existsSync(path)) continue;
    const match = readFileSync(path, 'utf8').match(/^ABLO_API_KEY=(.+)$/m);
    if (match?.[1]) return { key: match[1].trim().replace(/^["']|["']$/g, ''), source: name };
  }
  return null;
}
