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

/** The permanent ledger shared by direct and endpoint mutation wrappers. */
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
      up: `ALTER TABLE ablo_idempotency
  ADD COLUMN IF NOT EXISTS request_hash TEXT;`,
    },
    {
      name: 'ablo_idempotency_permanent_retention',
      up: `ALTER TABLE ablo_idempotency
  ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ NOT NULL DEFAULT 'infinity';`,
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
