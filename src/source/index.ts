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
  type SourceCommitParams,
  type SourceScope,
  type SourceEventsResult,
  type SourceEventsHandler,
  type SourceAuthorizeContext,
  type SourceHandlerContext,
  type SourceModelHandlers,
  type SourceCommitHandler,
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
} from './signing.js';

export {
  dataSource,
  type DataSourceOptions,
} from './factory.js';

export {
  createPushQueue,
  InMemoryPushQueueStorage,
  STANDARD_WEBHOOKS_RETRY_SCHEDULE,
  type PushQueue,
  type PushQueueItem,
  type PushQueueOptions,
  type PushQueueStorage,
} from './pushQueue.js';

// The reverse-channel connector — an outbound transport for the load, list, and
// commit leg, and the dial-out counterpart to `createPushQueue`. It lets you serve
// a Data Source from localhost or a private network that has no public inbound
// URL. See `connectorProtocol.ts` for the frames it exchanges.
export {
  createSourceConnector,
  DEFAULT_RECONNECT_SCHEDULE,
  type SourceConnector,
  type SourceConnectorOptions,
  type ConnectorWebSocket,
  type ConnectorWebSocketFactory,
  type ConnectorStatus,
} from './connector.js';
export {
  SOURCE_CONNECTOR_PROTOCOL_VERSION,
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
} from './connectorProtocol.js';

// The Data Source adapter interface and its Zod contract, with per-ORM implementations.
export {
  type DataSourceAdapter,
  type AdapterReadRequest,
  type AdapterCommitResult,
  type Row as AdapterRow,
} from './adapter.js';
export {
  operationSchema,
  operationTypeSchema,
  changeSetSchema,
  outboxEventSchema,
  eventsPageSchema,
  migrationSchema,
  adapterCapabilitiesSchema,
  type Operation,
  type ChangeSet,
  type OutboxEvent,
  type EventsPage,
  type Migration,
  type AdapterCapabilities,
} from './contract.js';
export { prismaDataSource, type PrismaLike, type PrismaDataSourceOptions } from './adapters/prisma.js';
export { adapterTableMigrations } from './migrations.js';
