import type { Migration } from '../adapters/migration.js';

function quoteIdent(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function qualified(schema: string, relation: string): string {
  return `${quoteIdent(schema)}.${quoteIdent(relation)}`;
}

/** Schema for the endpoint-only, versioned transactional outbox. */
export function endpointOutboxMigrations(schema = 'public'): readonly Migration[] {
  const outbox = qualified(schema, 'ablo_outbox');
  return [
    {
      name: 'ablo_outbox',
      up: `CREATE TABLE IF NOT EXISTS ${outbox} (
  cursor          BIGSERIAL PRIMARY KEY,
  id              TEXT NOT NULL UNIQUE,
  model           TEXT NOT NULL,
  entity_id       TEXT NOT NULL,
  type            TEXT NOT NULL,
  data            JSONB,
  event_version    SMALLINT NOT NULL DEFAULT 1,
  sync_groups      TEXT[],
  organization_id TEXT,
  client_tx_id    TEXT,
  correlation_id  TEXT,
  transaction_id  TEXT,
  occurred_at     BIGINT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ablo_outbox_event_envelope_valid CHECK (
    (event_version = 1 AND sync_groups IS NULL) OR
    (event_version = 2 AND sync_groups IS NOT NULL)
  )
);`,
    },
    {
      name: 'ablo_outbox_add_correlation',
      up: `ALTER TABLE ${outbox}
  ADD COLUMN IF NOT EXISTS correlation_id TEXT;
ALTER TABLE ${outbox}
  ADD COLUMN IF NOT EXISTS transaction_id TEXT;`,
    },
    {
      name: 'ablo_outbox_add_event_version_and_sync_groups',
      up: `ALTER TABLE ${outbox}
  ADD COLUMN IF NOT EXISTS event_version SMALLINT NOT NULL DEFAULT 1;
ALTER TABLE ${outbox}
  ADD COLUMN IF NOT EXISTS sync_groups TEXT[];
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = to_regclass(${quoteLiteral(outbox)})
       AND conname = 'ablo_outbox_event_envelope_valid'
  ) THEN
    ALTER TABLE ${outbox}
      ADD CONSTRAINT ablo_outbox_event_envelope_valid CHECK (
        (event_version = 1 AND sync_groups IS NULL) OR
        (event_version = 2 AND sync_groups IS NOT NULL)
      ) NOT VALID;
  END IF;
END $$;`,
    },
  ];
}
