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
