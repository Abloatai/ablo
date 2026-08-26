import { AbloValidationError } from '../../errors.js';
import { outboxEventSchema, type OutboxEvent } from './contract.js';

/** Decode the versioned routing envelope without turning absence into `[]`. */
export function decodeOutboxEventEnvelope(
  eventVersion: unknown,
  syncGroups: unknown,
  cursor: unknown,
): { readonly version: 1 | 2; readonly syncGroups?: readonly string[] } {
  const version = eventVersion == null
    ? (Array.isArray(syncGroups) ? 2 : 1)
    : Number(eventVersion);
  if (version !== 1 && version !== 2) {
    throw new AbloValidationError(
      `Endpoint outbox event at cursor ${String(cursor)} has unsupported event version ${String(eventVersion)}.`,
      { code: 'source_event_invalid' },
    );
  }
  if (version === 2 && !Array.isArray(syncGroups)) {
    throw new AbloValidationError(
      `Endpoint outbox event at cursor ${String(cursor)} is version 2 but has no durable sync_groups.`,
      { code: 'source_event_invalid' },
    );
  }
  return version === 2
    ? { version, syncGroups: syncGroups as readonly string[] }
    : { version };
}

/** Canonical snake_case database row → versioned source event decoder. */
export function decodeDatabaseOutboxEvent(row: Readonly<Record<string, unknown>>): OutboxEvent {
  const envelope = decodeOutboxEventEnvelope(row.event_version, row.sync_groups, row.cursor);
  return outboxEventSchema.parse({
    ...envelope,
    id: row.id,
    model: row.model,
    entityId: row.entity_id,
    type: row.type,
    data: typeof row.data === 'string' ? JSON.parse(row.data) : row.data ?? null,
    organizationId: row.organization_id ?? null,
    clientTxId: row.client_tx_id ?? null,
    correlationId: row.correlation_id ?? null,
    transactionId: row.transaction_id ?? null,
    occurredAt: row.occurred_at != null ? Number(row.occurred_at) : null,
    cursor: String(row.cursor),
  });
}
