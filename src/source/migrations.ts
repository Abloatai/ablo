/**
 * The table-creation SQL every ORM adapter ships for its OWN infrastructure tables —
 * `ablo_idempotency` (dedupe by clientTxId) and `ablo_outbox` (transactional
 * outbox the `events()` feed reads). Defined ONCE here so the Prisma adapter, the
 * Drizzle adapter, and `ablo migrate` can never disagree on the shape (they used
 * to inline their own copies, which had already drifted in whitespace).
 *
 * These are NOT model tables and are NOT emitted by the hosted provisioner
 * (`generateProvisionPlan`) — the hosted path uses `sync_deltas` directly. They
 * exist only on a customer's own database in Data Source mode.
 */

import type { Migration } from './contract.js';

/** Canonical adapter-owned table-creation SQL. Idempotent (`IF NOT EXISTS`). */
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
