/**
 * The table-creation SQL every ORM adapter ships for its own infrastructure
 * tables: `ablo_idempotency`, which dedupes commits by `clientTxId`, and
 * `ablo_outbox`, the transactional outbox the `events()` feed reads. Defining it in
 * one place keeps the Prisma adapter, the Drizzle adapter, and `ablo migrate` in
 * agreement on the exact shape.
 *
 * These are infrastructure tables, not model tables, and they exist only on your
 * own database when you run a Data Source. Ablo's hosted storage does not use them;
 * it records changes in its own `sync_deltas` log instead.
 */

import type { Migration } from './contract.js';

/** Returns the adapter's table-creation migrations. The SQL is idempotent, guarded by `IF NOT EXISTS`. */
export function adapterTableMigrations(): readonly Migration[] {
  return [
    {
      name: 'ablo_idempotency',
      up: `CREATE TABLE IF NOT EXISTS ablo_idempotency (
  client_tx_id TEXT PRIMARY KEY,
  response     JSONB NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);`,
    },
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
  occurred_at     BIGINT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);`,
    },
  ];
}
