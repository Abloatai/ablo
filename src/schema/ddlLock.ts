/**
 * Safe-DDL LOCKING knobs — the ONE reader for how a schema change acquires
 * (and retries for) table locks, shared by BOTH executors of the provision
 * plan:
 *
 *   - `ablo migrate` (cli/migrate.ts) — the customer runs the DDL themselves
 *   - the hosted executor (`apps/sync-server/src/schema/ddlExec.ts`)
 *
 * The two used to carry copy-pasted constants and had already drifted: the
 * server honored `ABLO_SCHEMA_LOCK_ATTEMPTS` while the CLI hardcoded 5, so an
 * operator tuning the knob got it applied by hosted push but silently ignored
 * by `ablo migrate`. Both now resolve through here.
 *
 * The settings themselves are the battle-tested ones every mature migration
 * tool uses (GitLab `with_lock_retries`, Strong Migrations, Doctolib
 * `safe-pg-migrations`): a LOW `lock_timeout` so a blocked ALTER aborts fast
 * instead of parking an ACCESS EXCLUSIVE request at the head of the lock
 * queue (which would freeze every query on that table behind it), plus a
 * bounded retry-with-backoff on the `55P03` abort.
 *
 * Env knobs (read at CALL time, not import time, so tests and long-lived
 * processes see updates): `ABLO_SCHEMA_LOCK_TIMEOUT` / `ABLO_SCHEMA_LOCK_ATTEMPTS`
 * — the older `ABLO_DDL_*` names are still honored so existing setups don't
 * break.
 */

/** Postgres SQLSTATE `lock_not_available` — a `lock_timeout` abort. The ONE
 *  retryable DDL failure; everything else is a real error. */
export const PG_LOCK_NOT_AVAILABLE = '55P03';

const DEFAULT_LOCK_TIMEOUT = '5s';
const DEFAULT_MAX_LOCK_ATTEMPTS = 5;

/** The env subset the resolvers read — injectable for tests. */
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
