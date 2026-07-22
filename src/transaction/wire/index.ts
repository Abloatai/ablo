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
export { listEnvelopeSchema, listEnvelope } from './listEnvelope.js';
export type { ListEnvelope } from './listEnvelope.js';

// The `GET /v1/logs` feed — the two arms, their envelope, and the cursor that
// carries a position in each.
export { claimEventSchema } from './claimEvent.js';
export type { ClaimEvent } from './claimEvent.js';
export { feedEventSchema, logListResponseSchema } from './feedEvent.js';
export type { FeedEvent, LogListResponse } from './feedEvent.js';
export {
  feedCursorSchema,
  parseFeedCursor,
  formatFeedCursor,
  feedCursorAdvanced,
  FEED_CURSOR_START,
  FEED_CURSOR_FORMAT,
  FEED_CURSOR_EXAMPLE,
} from './feedCursor.js';
export type { FeedCursor } from './feedCursor.js';
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

// Commit settlement backbone. The transport receipt, server execution cache,
// and normalized client acknowledgement are different envelopes composed from
// this one discriminated settlement vocabulary.
export {
  COMMIT_CORRELATION_ID_MAX_LENGTH,
  correlationIdSchema,
  commitStatusSchema,
  commitWaitSchema,
  commitSettlementSchema,
  commitReceiptSchema,
  rejectedCommitReceiptSchema,
  mutationResultPayloadSchema,
  mutationResultMessageSchema,
  commitAckSchema,
  mutationCommitResultSchema,
  // The request side of the same boundary — one definition, which the published
  // OpenAPI reference derives from rather than describing separately.
  commitOperationControlShape,
  commitOperationBodySchema,
  commitRequestSchema,
} from './commit.js';
export type {
  CommitOperationBody,
  CommitRequest,
  CorrelationId,
  CommitStatus,
  CommitWait,
  CommitSettlement,
  CommitReceiptWire,
  RejectedCommitReceiptWire,
  MutationResultPayload,
  MutationResultMessageWire,
  CommitAck,
  MutationCommitResultInput,
  MutationCommitResult,
} from './commit.js';

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
} from './delta.js';
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
} from './delta.js';

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
} from './claims.js';
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
} from './claims.js';

// The model read routes' responses — the envelope around a row, which is
// protocol, around `data`, which is the caller's schema.
export {
  modelReadResponseSchema,
  modelListResponseSchema,
} from './modelResponses.js';
export type { ModelReadResponse, ModelListResponse } from './modelResponses.js';

// The account routes' responses — projects, the deployed schema, the commit
// log, usage. What the server, the CLI, and the MCP server agree on.
export {
  projectResponseSchema,
  projectListResponseSchema,
  provisionedKeySchema,
  provisionKeyResponseSchema,
  conflictAxisWireSchema,
  schemaModelResponseSchema,
  schemaReadResponseSchema,
  logOpSchema,
  LOG_OP_BY_ACTION,
  logEventSchema,
  usageBucketSchema,
  usageReportResponseSchema,
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
  ControlKey,
  ControlKeyListResponse,
  KeyMintedResponse,
  KeyRevokedResponse,
} from './accountResponses.js';

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
} from './auth.js';
export type {
  EphemeralKeyUser,
  EphemeralKeyRequest,
  CapabilityRequest,
} from './auth.js';
