/**
 * `@abloatai/ablo/source` — the Data Source barrel.
 *
 * Pure re-exports only: the implementation lives in cohesive leaf modules so
 * sibling source/* files (`pushQueue.ts`, `adapter.ts`, `contract.ts`, the ORM
 * adapters) import the leaves directly instead of routing a runtime circular
 * dependency through this barrel.
 *
 *   - `types.ts`   — shared wire/handler types + `sourceEventForOperation`
 *   - `signing.ts` — Standard Webhooks request signing/verification
 *   - `factory.ts` — the `abloSource()` / `dataSource()` endpoint factory
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
  type DataSourcePrimitive,
  type DataSourceWhere,
  type DataSourceListQuery,
  type DataSourceListPage,
  type DataSourceListResult,
  type DataSourceRequestContext,
  type DataSourceOperation,
  type DataSourceDelta,
  type DataSourceEvent,
  type DataSourceEventForOperationOptions,
  type DataSourceCommitResult,
  type DataSourceCommitParams,
  type DataSourceScope,
  type DataSourceEventsResult,
  type DataSourceEventsHandler,
  type DataSourceAuthorizeContext,
  type DataSourceHandlerContext,
  type DataSourceModelHandlers,
  type DataSourceCommitHandler,
  type DataSourceApiKey,
  type DataSourceLoadRequest,
  type DataSourceListRequest,
  type DataSourceCommitRequest,
  type DataSourceEventsRequest,
  type DataSourceRequest,
  type DataSourceResponse,
} from './types.js';

export {
  ABLO_SOURCE_HEADERS,
  SourceSignatureError,
  signAbloSourceRequest,
  verifyAbloSourceRequest,
  type SourceSignatureOptions,
  type SourceSignatureVerificationOptions,
  type SourceSignatureVerificationResult,
  type DataSourceSignatureOptions,
  type DataSourceSignatureVerificationOptions,
  type DataSourceSignatureVerificationResult,
} from './signing.js';

export {
  abloSource,
  dataSource,
  type AbloSourceOptions,
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

// ── Reverse-channel connector (outbound transport for the commit/load/list leg) ──
// The dial-out counterpart to `createPushQueue`. Lets a customer serve Data
// Source `commit`/`load`/`list` from localhost or a locked-down VPC with no
// public inbound URL — see `connector-protocol.ts`.
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
} from './connector-protocol.js';

// ── Data Source adapter interface (Zod contract + one interface, per-ORM packages) ──
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
