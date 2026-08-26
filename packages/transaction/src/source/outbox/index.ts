/**
 * Endpoint transactional-outbox subsystem.
 *
 * Start here, then descend into contract, envelope, migrations, or retention.
 * ORM adapters depend on this boundary; the subsystem never depends on them.
 */
export {
  outboxEventSchema,
  eventsPageSchema,
  type OutboxEvent,
  type EventsPage,
} from './contract.js';
export { decodeDatabaseOutboxEvent, decodeOutboxEventEnvelope } from './envelope.js';
export { endpointOutboxMigrations } from './migrations.js';
export { ENDPOINT_OUTBOX_PRUNE_BATCH_SIZE } from './retention.js';
