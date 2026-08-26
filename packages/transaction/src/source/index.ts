/**
 * The entry point for the Data Source API, re-exporting the pieces you need from
 * their individual modules:
 *
 *   - `types.ts`   — the shared wire and handler types, plus `sourceEventForOperation`
 *   - `signing.ts` — request signing and verification
 *   - `factory.ts` — the `dataSource()` endpoint factory
 *
 * Import from here; the sibling modules import one another directly.
 */

export {
  sourceEventForOperation,
  ABLO_POSTGRES_COMMIT_ECHO_PREFIX,
  ABLO_SOURCE_CLIENT_TX_ID_MAX_LENGTH,
  ABLO_SOURCE_ECHO_MAX_OPERATIONS,
  ABLO_SOURCE_ECHO_MAX_PAYLOAD_BYTES,
  type SourcePrimitive,
  type SourceWhere,
  type SourceListQuery,
  type SourceListPage,
  type SourceListResult,
  type SourceRequestContext,
  type SourceOperation,
  type SourceDelta,
  type SourceEvent,
  type SourceEventForOperationOptions,
  type SourceCommitResult,
  type SourceCommitEcho,
  type SourceCommitEchoOperation,
  type SourceCommitEchoMarker,
  type SourceCommitParams,
  type SourceScope,
  type SourceEventsResult,
  type SourceEventsHandler,
  type SourceAuthorizeContext,
  type SourceHandlerContext,
  type SourceModelHandlers,
  type SourceCommitHandler,
  type SourceSubjectTransactionBoundary,
  type SourceSubjectTransactionHandler,
  type SourceApiKey,
  type SourceLoadRequest,
  type SourceListRequest,
  type SourceCommitRequest,
  type SourceEventsRequest,
  type SourceRequest,
  type SourceResponse,
} from './types.js';

export {
  ABLO_SOURCE_HEADERS,
  SourceSignatureError,
  signAbloSourceRequest,
  verifyAbloSourceRequest,
  type SourceSignatureOptions,
  type SourceSignatureVerificationOptions,
  type SourceSignatureVerificationResult,
} from './endpoint/signing.js';

export {
  dataSource,
  type DataSourceOptions,
} from './endpoint/factory.js';

export {
  sourceSubjectCreateLockKey,
} from './adapters/subjectAuthorization.js';

export {
  createPushQueue,
  InMemoryPushQueueStorage,
  STANDARD_WEBHOOKS_RETRY_SCHEDULE,
  type PushQueue,
  type PushQueueItem,
  type PushQueueOptions,
  type PushQueueStorage,
} from './delivery/pushQueue.js';

// The reverse-channel connector — an outbound transport for the load, list, and
// commit leg, and the dial-out counterpart to `createPushQueue`. It lets you serve
// a Data Source from localhost or a private network that has no public inbound
// URL. See `connectorProtocol.ts` for the frames it exchanges.
export {
  createSourceConnector,
  DEFAULT_RECONNECT_SCHEDULE,
  SourceConnectorSupersededError,
  type SourceConnector,
  type SourceConnectorOptions,
  type ConnectorWebSocket,
  type ConnectorWebSocketFactory,
  type ConnectorStatus,
} from './connector/client.js';
export {
  SOURCE_CONNECTOR_PROTOCOL_VERSION,
  SOURCE_CONNECTOR_SUPERSEDED_CLOSE_CODE,
  SOURCE_CONNECTOR_WS_PATH,
  WS_SOURCE_SUBPROTOCOL,
  sourceConnectorSubprotocols,
  encodeFrame,
  decodeFrame,
  ConnectorProtocolError,
  connectorFrameSchema,
  type ConnectorFrame,
  type RegisterFrame,
  type ReadyFrame,
  type RequestFrame,
  type ResponseFrame,
  type ErrorFrame,
} from './connector/protocol.js';

// The Data Source adapter interface and its Zod contract, with per-ORM implementations.
export {
  type DataSourceAdapter,
  type MutationAdapter,
  type AdapterReadRequest,
  type AdapterCommitResult,
  type Row as AdapterRow,
} from './adapters/adapter.js';
export {
  adapterBindingSchema,
  databaseAdapterProfileSchema,
  databaseKindSchema,
  memoryAdapterProfile,
  observationProfileSchema,
  postgresAdapterProfile,
  type AdapterBinding,
  type DatabaseAdapterProfile,
  type DatabaseKind,
  type ObservationProfile,
  type PostgresBinding,
} from './adapters/adapterProfile.js';
export { defineDatabaseAdapter } from './adapters/adapterFactory.js';
export {
  operationSchema,
  operationTypeSchema,
  sourceCommitEchoSchema,
  sourceCommitEchoOperationSchema,
  sourceCommitEchoMarkerSchema,
  sourceCommitEchoIntentSchema,
  changeSetSchema,
  adapterCapabilitiesSchema,
  type Operation,
  type ChangeSet,
  type AdapterCapabilities,
  type SourceCommitEchoMarkerWire,
  type SourceCommitEchoIntent,
} from './adapters/contract.js';
export { migrationSchema, type Migration } from './adapters/migration.js';
export {
  endpointOutboxMigrations,
  eventsPageSchema,
  outboxEventSchema,
  type EventsPage,
  type OutboxEvent,
} from './outbox/index.js';
export { prismaDataSource, type PrismaLike, type PrismaDataSourceOptions } from './adapters/prisma.js';
export {
  adapterTableMigrations,
  idempotencyLedgerMigrations,
} from './adapters/migrations.js';
export {
  createKyselyMutationAdapter,
  createKyselyMutationCore,
  kyselyDataSource,
  kyselyDirectMutation,
  kyselyOperationRowId,
  type KyselyCompiledQuery,
  type KyselyDeleteBuilder,
  type KyselyInsertBuilder,
  type KyselyInsertValuesBuilder,
  type KyselyLike,
  type KyselyMutationCore,
  type KyselyReturningExecutable,
  type KyselySelectBuilder,
  type KyselyTransactionBuilder,
  type KyselyUpdateBuilder,
  type KyselyUpdateSetBuilder,
} from './adapters/kysely.js';
export {
  sourceOperationsIntentHash,
  sourceChangeIntentHash,
  assertSourceIdempotencyIntent,
  assertSourceIdempotencyRetention,
  sourceEchoTransactionIdSchema,
  encodeSourceEchoTransactionId,
  decodeSourceEchoTransactionId,
  type SourceEchoTransactionId,
} from './adapters/idempotency.js';
// What Ablo leaves inside a customer's database, declared once — read by the
// setup SQL, the replication runtime, and the audit that reports it back.
export {
  ABLO_FOOTPRINT,
  ABLO_PUBLICATION,
  ABLO_REPLICATION_SLOT,
  ABLO_REPLICATION_ROLE,
  ABLO_WRITE_ROLE,
  ABLO_IDEMPOTENCY_TABLE,
  ABLO_OUTBOX_TABLE,
  REPLICATION_SLOT_NAME,
  isValidReplicationSlotName,
  footprintNamesFor,
  type FootprintArtifact,
  type FootprintKind,
  type FootprintNames,
  type DataSourceIdentity,
} from '../footprint.js';
