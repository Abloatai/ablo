/**
 * Lock settings for schema-change (DDL) statements. When a schema push alters a
 * table, these values control how quickly the change gives up on a contended
 * lock and how many times it retries. The command-line `ablo migrate` and the
 * host that applies a schema push both resolve their lock behavior through this
 * module, so tuning the environment variables below changes both paths the same
 * way.
 *
 * The defaults follow the standard safe-migration recipe: a short `lock_timeout`
 * so a blocked `ALTER` aborts quickly instead of parking an `ACCESS EXCLUSIVE`
 * lock request at the head of the queue — which would freeze every other query
 * on that table behind it — paired with a bounded retry-and-backoff on the
 * resulting timeout.
 *
 * The environment variables are read each time a resolver is called, not once
 * at import, so a long-running process or a test that changes them sees the
 * update: `ABLO_SCHEMA_LOCK_TIMEOUT` and `ABLO_SCHEMA_LOCK_ATTEMPTS`. The older
 * `ABLO_DDL_*` names are also accepted.
 */

/** The Postgres SQLSTATE `55P03` (`lock_not_available`), raised when a statement
 *  gives up waiting for a lock after `lock_timeout`. This is the one DDL failure
 *  worth retrying; any other error is a genuine problem. */
export const PG_LOCK_NOT_AVAILABLE = '55P03';

const DEFAULT_LOCK_TIMEOUT = '5s';
const DEFAULT_MAX_LOCK_ATTEMPTS = 5;

/** The subset of environment variables the resolvers in this module read. It is
 *  passed in explicitly so tests can supply their own values. */
export type DdlLockEnv = Readonly<Record<string, string | undefined>>;

/** `lock_timeout` for the DDL transaction (a Postgres duration string). */
export function resolveDdlLockTimeout(env: DdlLockEnv = process.env): string {
  return env.ABLO_SCHEMA_LOCK_TIMEOUT ?? env.ABLO_DDL_LOCK_TIMEOUT ?? DEFAULT_LOCK_TIMEOUT;
}

/** How many times the whole DDL transaction is attempted on `55P03` lock
 *  contention. Always ≥ 1; a malformed value falls back to the default
 *  instead of silently disabling retries. */
export function resolveDdlMaxLockAttempts(env: DdlLockEnv = process.env): number {
  const raw = env.ABLO_SCHEMA_LOCK_ATTEMPTS ?? env.ABLO_DDL_LOCK_ATTEMPTS;
  if (raw === undefined) return DEFAULT_MAX_LOCK_ATTEMPTS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return DEFAULT_MAX_LOCK_ATTEMPTS;
  return Math.max(1, Math.floor(parsed));
}

/** Backoff before retry N (1-based): capped exponential + a little jitter so
 *  two contending migrators don't re-collide in lockstep. */
export function ddlLockRetryBackoffMs(attempt: number): number {
  return Math.min(60_000, 10 * 2 ** attempt) + Math.floor(Math.random() * 50);
}
