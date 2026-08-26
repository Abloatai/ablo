/**
 * The wire contract for the sync protocol: the HTTP envelope shapes and the
 * write-path frames, with no dependency on the client runtime. A server — a
 * route handler, an edge function — can import the envelope producers here
 * without pulling in the full sync client.
 *
 * It has two halves, used across every endpoint:
 *   - Error responses — {@link errorEnvelope}, {@link ErrorEnvelope}, and
 *     {@link statusForType} turn any thrown value into the uniform
 *     `{ type, code, param, message, doc_url, request_id }` body.
 *   - List responses — {@link listEnvelope} and {@link ListEnvelope} stamp the
 *     uniform `{ object: 'list', data, has_more, next_cursor }` collection.
 *
 * The {@link AbloError} hierarchy, {@link docUrlForCode}, and the wire-parsing
 * helpers are re-exported too, so a single import lets a route throw the right
 * typed error and serialize it back out.
 */
export {
  errorEnvelopeSchema,
  errorEnvelope,
  statusForType,
  INTERNAL_ERROR_PUBLIC_MESSAGE,
} from './errorEnvelope.js';
export type { ErrorEnvelope } from './errorEnvelope.js';
export {
  listEnvelopeSchema,
  listEnvelope,
  CURSOR_PARAM,
  CURSOR_PARAM_ALIAS,
  CURSOR_PARAM_NAMES,
} from './listEnvelope.js';
export type { ListEnvelope } from './listEnvelope.js';

// The `GET /v1/logs` feed — the two arms, their envelope, and the cursor that
// carries a position in each.
export { claimEventSchema } from '../claims/eventContract.js';
export type { ClaimEvent } from '../claims/eventContract.js';
export {
  feedEventSchema,
  logListResponseSchema,
  logQuerySchema,
} from '../observation/feedContract.js';
export type { FeedEvent, LogListResponse, LogQuery } from '../observation/feedContract.js';

// The same feed's delivery verdict — how much of what it recorded could reach
// anyone. Read by `ablo doctor`.
export { logDeliveryResponseSchema, deliverySampleSchema } from '../observation/deliveryContract.js';
export type { LogDeliveryResponse, DeliverySample } from '../observation/deliveryContract.js';
export {
  feedCursorSchema,
  parseFeedCursor,
  formatFeedCursor,
  feedCursorAdvanced,
  FEED_CURSOR_START,
  FEED_CURSOR_FORMAT,
  FEED_CURSOR_EXAMPLE,
} from '../observation/cursor.js';
export type { FeedCursor } from '../observation/cursor.js';
export { bootstrapReasonSchema } from './bootstrapReason.js';
export type { BootstrapReason } from './bootstrapReason.js';

// The write-path frame contract: the message shapes shared by the client and
// the server. The runtime Zod validators sit beside the interfaces and are
// pinned to them, and they gate every operation and payload on both commit
// transports.
export {
  commitOperationSchema,
  wireCommitOperationSchema,
  commitPayloadSchema,
  commitMessageSchema,
} from './frames.js';

// Protocol versioning: the single integer the client and server compare to
// confirm they can speak to each other, plus the WebSocket close code used to
// reject a mismatch. See protocolVersion.ts for the changelog and deploy rules.
export {
  PROTOCOL_VERSION,
  MIN_SUPPORTED_PROTOCOL_VERSION,
  DEFAULT_PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
  WS_CLOSE_PROTOCOL_VERSION,
  PROTOCOL_VERSION_HEADER,
  protocolVersionProblem,
  resolveProtocolVersion,
} from './protocolVersion.js';
export type {
  SupportedProtocolVersion,
  ProtocolVersionProblem,
} from './protocolVersion.js';
export type {
  CommitOperation,
  WireCommitOperation,
  CommitMessage,
  MutationResultMessage,
} from './frames.js';

// Commit lifecycle backbone. The transport receipt, server execution cache,
// and normalized client acknowledgement are different envelopes composed from
// this one discriminated status vocabulary.
export {
  COMMIT_CORRELATION_ID_MAX_LENGTH,
  correlationIdSchema,
  commitTimestampSchema,
  queuedStatusSchema,
  confirmedStatusSchema,
  rejectedStatusSchema,
  queuedCommitStatusSchema,
  confirmedCommitStatusSchema,
  rejectedCommitStatusSchema,
  commitStatusSchema,
  commitWaitSchema,
  commitReceiptSchema,
  commitOperationOutcomeSchema,
  commitOperationResultSchema,
  rejectedCommitReceiptSchema,
  mutationResultPayloadSchema,
  mutationResultMessageSchema,
  commitAckSchema,
  mutationCommitResultSchema,
  // The request side of the same boundary — one definition, which the published
  // OpenAPI reference derives from rather than describing separately.
  commitOperationControlShape,
  modelOperationActionSchema,
  normalizeStorageOperationAction,
  commitOperationBodySchema,
  commitActorSchema,
  commitAttemptSchema,
  commitClaimReferenceSchema,
  commitRecordOperationSchema,
  commitReceiptEvidenceSchema,
  commitRequestSchema,
  commitRecordSchema,
  commitRecordWhereSchema,
  commitRecordListOptionsSchema,
  commitRecordListSchema,
} from '../commit/contract.js';
export type {
  ModelOperationAction,
  CommitOperationBody,
  CommitOperationResult,
  CommitActor,
  CommitAttempt,
  CommitClaimReference,
  CommitRecordOperation,
  CommitReceiptEvidence,
  CommitRequest,
  CommitRecord,
  CommitRecordWhere,
  CommitRecordListOptions,
  CommitRecordList,
  CorrelationId,
  CommitStatus,
  CommitStatusValue,
  CommitWait,
  CommitReceiptWire,
  RejectedCommitReceiptWire,
  MutationResultPayload,
  MutationResultMessageWire,
  CommitAck,
  MutationCommitResultInput,
  MutationCommitResult,
} from '../commit/contract.js';
export {
  effectiveAuthoritySchema,
} from '../auth/capability.js';
export type { EffectiveAuthority } from '../auth/capability.js';

// The read-path delta contract: the shape the server broadcasts to clients as the
// payload of a `delta` or `sync_response` frame, together with the shared
// participant vocabulary it carries. Both ends derive their delta type from these
// schemas, so the client and server cannot drift apart.
export {
  participantKindSchema,
  confirmationStateSchema,
  syncDeltaActionSchema,
  wireDeltaDataSchema,
  participantRefSchema,
  syncDeltaWireCoreSchema,
  clientSyncDeltaSchema,
  serverSyncDeltaSchema,
  deltaSchema,
} from '../observation/contract.js';
export type {
  ParticipantKind,
  ConfirmationState,
  SyncDeltaAction,
  WireDeltaData,
  ParticipantRef,
  SyncDeltaWireCore,
  ClientSyncDelta,
  ServerSyncDelta,
  Delta,
} from '../observation/contract.js';

// The error surface a wire consumer needs to throw, classify, and serialize.
export {
  AbloError,
  AbloAuthenticationError,
  AbloPermissionError,
  AbloValidationError,
  AbloRateLimitError,
  AbloIdempotencyError,
  AbloConnectionError,
  AbloNotFoundError,
  AbloServerError,
  AbloStaleContextError,
  AbloContentionError,
  AbloClaimedError,
  CapabilityError,
  AbloSessionError,
  SyncSessionError,
  docUrlForCode,
  translateHttpError,
  errorFromWire,
  toAbloError,
  ERROR_CONTRACT_VERSION,
  // The table mapping each error code to its HTTP status and retryable flag —
  // plain data a server can use to resolve a code's canonical status the same
  // way the client's error serializer does.
  errorCodeSpec,
} from '../errors.js';
export type { ErrorCode, WireErrorCode, RequiredCapability } from '../errors.js';

// Protocol timing constants — the 30-second ping cadence and the lease window
// derived from it, shared by the client heartbeat and the server keepalive,
// claim leasing, and presence expiry (see protocol.ts) — plus the WebSocket
// subprotocols used during the authenticated handshake.
export {
  PING_INTERVAL_MS,
  LEASE_TTL_MS,
  WS_BEARER_SUBPROTOCOL_PREFIX,
  WS_SYNC_SUBPROTOCOL,
} from './protocol.js';

// The claim routes' half of the boundary — requests and responses both, beside
// the commit body for the same reason: the server answers in these shapes, the
// client reads them back through the same schemas, and the OpenAPI reference
// derives from them rather than describing them from memory.
export {
  // The lease grammar and its one reading. The server parses TTLs with
  // `claimTtlMs` rather than carrying a second parser — which is how a bare
  // number came to mean seconds on one side and milliseconds on the other.
  DEFAULT_CLAIM_TTL_MS,
  claimTtlSchema,
  claimTtlMs,
  claimTargetSchema,
  claimRequestSchema,
  claimHeartbeatRequestSchema,
  listQuerySchema,
  claimListQuerySchema,
  claimStateSchema,
  claimAcquiredResponseSchema,
  claimQueuedResponseSchema,
  claimAcquireResponseSchema,
  claimHeartbeatReplySchema,
  claimHeartbeatBatchReplySchema,
  claimListResponseSchema,
  claimReorderRequestSchema,
  claimReorderReplySchema,
  claimReleaseReplySchema,
} from '../claims/contract.js';
export type {
  ClaimTargetBody,
  ClaimRequest,
  ClaimHeartbeatRequest,
  ListQuery,
  ClaimListQuery,
  ClaimState,
  ClaimAcquiredResponse,
  ClaimQueuedResponse,
  ClaimAcquireResponse,
  ClaimHeartbeatReply,
  ClaimHeartbeatBatchReply,
  ClaimListResponse,
  ClaimReorderRequest,
  ClaimReorderReply,
  ClaimReleaseReply,
} from '../claims/contract.js';

// Where those routes live. The paths are contract in the same sense the bodies
// are: a caller that builds one by hand is restating a shape the server owns.
export { CLAIM_ROUTES, claimOnModelPath, claimHeartbeatOnModelPath, claimReorderOnModelPath, claimByIdPath, claimHeartbeatByIdPath } from '../claims/routes.js';
export type { ClaimRouteTarget } from '../claims/routes.js';

// The model read routes' responses — the envelope around a row, which is
// protocol, around `data`, which is the caller's schema.
export {
  modelReadResponseSchema,
  modelListResponseSchema,
  modelListEvidenceSchema,
} from './modelResponses.js';
export type {
  ModelReadResponse,
  ModelListResponse,
  ModelListEvidence,
} from './modelResponses.js';

// What a model is made of — the artifact's own field and relation shapes, which
// the schema read reports and every other layer derives its types from.
export {
  fieldTypeSchema,
  fieldMetaSchema,
  relationTypeSchema,
  relationMetaSchema,
} from './modelShape.js';
export type {
  FieldType,
  FieldMeta,
  RelationType,
  RelationMeta,
} from './modelShape.js';

// The model write routes' body — the record in `data`, the guards beside it.
export { modelMutationRequestSchema } from './modelMutations.js';
export type { ModelMutationRequest } from './modelMutations.js';

// The account routes' responses — projects, the deployed schema, the commit
// log, usage. What the server, the CLI, and the MCP server agree on.
export {
  projectResponseSchema,
  projectListResponseSchema,
  provisionedKeySchema,
  provisionKeyResponseSchema,
  schemaModelResponseSchema,
  schemaReadResponseSchema,
  logOpSchema,
  LOG_OP_BY_ACTION,
  logEventSchema,
  usageBucketSchema,
  usageReportResponseSchema,
  meterUsageSchema,
  billingSummarySchema,
  usageSummaryResponseSchema,
  controlKeySchema,
  controlKeyListResponseSchema,
  keyMintedResponseSchema,
  keyRevokedResponseSchema,
} from './accountResponses.js';
export type {
  ProjectResponse,
  ProjectListResponse,
  ProvisionedKey,
  ProvisionKeyResponse,
  SchemaModelResponse,
  SchemaReadResponse,
  LogOp,
  LogEvent,
  UsageBucket,
  UsageReportResponse,
  MeterUsage,
  BillingSummary,
  UsageSummaryResponse,
  ControlKey,
  ControlKeyListResponse,
  KeyMintedResponse,
  KeyRevokedResponse,
} from './accountResponses.js';

// The datasource routes' responses — the `ablo connect` surface: register,
// validate, locate, list, deregister. What the server, the CLI, and the
// dashboard agree on.
export {
  READINESS_ITEMS,
  READINESS_ADVISORY_ITEMS,
  isReadinessItem,
  readinessFailureSchema,
  readinessAdvisorySchema,
  datasourceSummarySchema,
  datasourceListResponseSchema,
  datasourceValidationResponseSchema,
  datasourceLocationResponseSchema,
  datasourceResnapshotResponseSchema,
  datasourceDisconnectedResponseSchema,
} from './dataSourceResponses.js';
export type {
  ReadinessItem,
  ReadinessAdvisoryItem,
  ReadinessFailure,
  ReadinessAdvisory,
  DatasourceSummary,
  DatasourceListResponse,
  DatasourceValidationResponse,
  DatasourceLocationResponse,
  DatasourceResnapshotResponse,
  DatasourceDisconnectedResponse,
} from './dataSourceResponses.js';

// The inbound socket surface: every frame the server can send, and how each
// one's payload is validated.
export {
  WS_INBOUND_FRAMES,
  wsInboundEnvelopeSchema,
  isKnownInboundFrame,
  isSchemaValidatedFrame,
} from './inboundFrames.js';
export type {
  InboundFrameContract,
  InboundFrameType,
  InboundFramePayload,
  SchemaValidatedFrameType,
  WsInboundEnvelope,
} from './inboundFrames.js';

// Credential minting — the first call any caller makes, so the contract cannot
// omit it. Response side lives in `auth/schemas.ts`.
export {
  ephemeralKeyUserSchema,
  ephemeralKeyRequestSchema,
  capabilityRequestSchema,
  capabilityMintResponseSchema,
} from './auth.js';
export type {
  EphemeralKeyUser,
  EphemeralKeyRequest,
  CapabilityRequest,
  CapabilityMintResponse,
} from './auth.js';

// How a rate limit is stated on a response, so a caller can pace itself rather
// than discover the ceiling by hitting it. The field names and their Structured
// Fields spellings live in one module because every producer — the engine's
// per-key limiter and the public docs surfaces both — has to spell them the
// same way for a client to read either.
export {
  RATE_LIMIT_HEADER,
  RATE_LIMIT_POLICY_HEADER,
  RETRY_AFTER_HEADER,
  rateLimitField,
  rateLimitPolicyField,
  rateLimitHeaders,
} from './rateLimit.js';
export type { QuotaPolicy, ServiceLimit, RateLimitSignal } from './rateLimit.js';

// What a caller can rely on about this surface not moving under it: the path
// segment the routes live under, the header carrying the contract date, and the
// two standard fields a withdrawal is announced on. The published OpenAPI
// description renders `API_LIFECYCLE` rather than restating it.
export {
  API_PATH_VERSION,
  API_VERSION_HEADER,
  API_DEPRECATION_HEADER,
  API_SUNSET_HEADER,
  API_DEPRECATION_NOTICE_DAYS,
  API_LIFECYCLE,
} from './apiLifecycle.js';
