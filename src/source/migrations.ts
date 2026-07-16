/**
 * The table-creation SQL every ORM adapter ships for its own infrastructure
 * tables: `ablo_idempotency`, whose legacy-named `client_tx_id` column stores the
 * scoped server correlation, and (for endpoint wrappers only) `ablo_outbox`, the
 * transactional outbox the `events()` feed reads. Direct wrappers install only
 * the ledger migration because WAL is their authoritative feed.
 *
 * These are infrastructure tables, not model tables, and they exist only on your
 * own database when you run a Data Source. Ablo's hosted storage does not use them;
 * it records changes in its own `sync_deltas` log instead.
 */

import type { Migration } from './contract.js';

/**
 * Add a column to `ablo_idempotency` only when it is genuinely missing.
 *
 * `ADD COLUMN IF NOT EXISTS` performs its ownership check before the existence
 * short-circuit, so on a ledger owned by another role the no-op re-run still
 * errors "must be owner of table ablo_idempotency" — the setup's re-run promise
 * breaks. `pg_attribute` is readable regardless of table ownership, so this DO
 * block resolves the ledger through the search path and runs the `ALTER` only
 * when the column is absent — a true no-op on a table that already has it.
 */
function addColumnIfAbsent(column: string, definition: string): string {
  return `DO $$
DECLARE ledger regclass := to_regclass('ablo_idempotency');
BEGIN
  IF ledger IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pg_attribute
    WHERE attrelid = ledger AND attname = '${column}' AND attnum > 0 AND NOT attisdropped
  ) THEN
    ALTER TABLE ablo_idempotency ADD COLUMN ${column} ${definition};
  END IF;
END $$;`;
}

/** The idempotency ledger shared by direct and endpoint mutation wrappers. New
 *  rows carry a bounded `expires_at` (set by the adapter at write time) so the
 *  customer can prune them; the `infinity` column default is only a fallback for
 *  a row inserted without one. */
export function idempotencyLedgerMigrations(): readonly Migration[] {
  return [
    {
      name: 'ablo_idempotency',
      up: `CREATE TABLE IF NOT EXISTS ablo_idempotency (
  client_tx_id TEXT PRIMARY KEY,
  response     JSONB NOT NULL,
  request_hash TEXT,
  expires_at   TIMESTAMPTZ NOT NULL DEFAULT 'infinity',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);`,
    },
    {
      name: 'ablo_idempotency_request_hash',
      // Nullable only for rows created by older adapter versions. New writes
      // always populate it; replaying a legacy NULL row fails closed because
      // the adapter cannot prove that the intent matches.
      //
      // The column already exists on any current table (the CREATE above
      // includes it), so this only matters when upgrading a pre-existing
      // ledger. `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` checks ownership
      // BEFORE it evaluates IF NOT EXISTS, so on a ledger that predates the
      // setup — owned by another role — the no-op still errors "must be owner".
      // Guard on the catalog (readable regardless of ownership) so the ALTER
      // runs only when the column is genuinely absent, keeping re-runs safe.
      up: addColumnIfAbsent('request_hash', 'TEXT'),
    },
    {
      name: 'ablo_idempotency_permanent_retention',
      up: addColumnIfAbsent('expires_at', `TIMESTAMPTZ NOT NULL DEFAULT 'infinity'`),
    },
  ];
}

/** Endpoint-only transactional outbox and its correlation columns. */
export function endpointOutboxMigrations(): readonly Migration[] {
  return [
    {
      name: 'ablo_outbox',
      up: `CREATE TABLE IF NOT EXISTS ablo_outbox (
  cursor          BIGSERIAL PRIMARY KEY,
  id              TEXT NOT NULL UNIQUE,
  model           TEXT NOT NULL,
  entity_id       TEXT NOT NULL,
  type            TEXT NOT NULL,
  data            JSONB,
  organization_id TEXT,
  client_tx_id    TEXT,
  correlation_id  TEXT,
  transaction_id  TEXT,
  occurred_at     BIGINT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);`,
    },
    {
      name: 'ablo_outbox_correlation',
      up: `ALTER TABLE ablo_outbox
  ADD COLUMN IF NOT EXISTS correlation_id TEXT;
ALTER TABLE ablo_outbox
  ADD COLUMN IF NOT EXISTS transaction_id TEXT;`,
    },
  ];
}

/** Full endpoint adapter migrations (ledger + outbox). */
export function adapterTableMigrations(): readonly Migration[] {
  return [...idempotencyLedgerMigrations(), ...endpointOutboxMigrations()];
}
