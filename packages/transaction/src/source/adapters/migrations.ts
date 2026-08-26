/**
 * The canonical table-creation SQL every ORM adapter ships for its own infrastructure
 * tables: `ablo_idempotency`, whose legacy-named `client_tx_id` column stores the
 * scoped server correlation, and (for endpoint wrappers only) `ablo_outbox`, the
 * transactional outbox the `events()` feed reads. Direct wrappers install only
 * the ledger migration because WAL is their authoritative feed.
 *
 * These are infrastructure tables, not model tables, and they exist only on your
 * own database when you run a Data Source. Ablo's hosted storage does not use them;
 * it records changes in its own `sync_deltas` log instead.
 */

import type { Migration } from './migration.js';
import { endpointOutboxMigrations } from '../outbox/index.js';

export { endpointOutboxMigrations } from '../outbox/index.js';

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
function quoteIdent(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function qualified(schema: string, relation: string): string {
  return `${quoteIdent(schema)}.${quoteIdent(relation)}`;
}

function addColumnIfAbsent(schema: string, column: string, definition: string): string {
  const ledger = qualified(schema, 'ablo_idempotency');
  return `DO $$
DECLARE ledger regclass := to_regclass(${quoteLiteral(ledger)});
BEGIN
  IF ledger IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pg_attribute
    WHERE attrelid = ledger AND attname = '${column}' AND attnum > 0 AND NOT attisdropped
  ) THEN
    ALTER TABLE ${ledger} ADD COLUMN ${quoteIdent(column)} ${definition};
  END IF;
END $$;`;
}

/** The idempotency ledger shared by direct and endpoint mutation wrappers. New
 *  rows carry a bounded `expires_at` (set by the adapter at write time) so the
 *  customer can prune them; the `infinity` column default is only a fallback for
 *  a row inserted without one. */
export function idempotencyLedgerMigrations(schema = 'public'): readonly Migration[] {
  const ledger = qualified(schema, 'ablo_idempotency');
  return [
    {
      name: 'ablo_idempotency',
      up: `CREATE TABLE IF NOT EXISTS ${ledger} (
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
      up: addColumnIfAbsent(schema, 'request_hash', 'TEXT'),
    },
    {
      name: 'ablo_idempotency_permanent_retention',
      up: addColumnIfAbsent(schema, 'expires_at', `TIMESTAMPTZ NOT NULL DEFAULT 'infinity'`),
    },
  ];
}

/** Full endpoint adapter migrations (ledger + outbox). */
export function adapterTableMigrations(schema = 'public'): readonly Migration[] {
  return [...idempotencyLedgerMigrations(schema), ...endpointOutboxMigrations(schema)];
}
