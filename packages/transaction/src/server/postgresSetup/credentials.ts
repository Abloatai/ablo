import { randomBytes, pbkdf2Sync, createHmac, createHash } from 'node:crypto';

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

/** Returns a copy of the connection URL with the username and password replaced by the scoped role's credentials, leaving host, database, and query parameters intact. */
export function rewriteDatabaseUrl(ownerUrl: string, role: string, password: string): string {
  const url = new URL(ownerUrl);
  url.username = role;
  url.password = password;
  return url.toString();
}
