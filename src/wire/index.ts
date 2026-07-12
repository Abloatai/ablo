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
export { errorEnvelope, statusForType } from './errorEnvelope.js';
export type { ErrorEnvelope } from './errorEnvelope.js';
export { listEnvelope } from './listEnvelope.js';
export type { ListEnvelope } from './listEnvelope.js';
export { bootstrapReasonSchema } from './bootstrapReason.js';
export type { BootstrapReason } from './bootstrapReason.js';

// The write-path frame contract: the message shapes shared by the client and
// the server. The runtime Zod validators sit beside the interfaces and are
// pinned to them, and they gate every operation and payload on both commit
// transports.
export {
  commitOperationSchema,
  commitPayloadSchema,
  commitRequestMessageSchema,
  commitResultMessageSchema,
  legacyCommitOperationSchema,
  legacyCommitPayloadSchema,
} from './frames.js';

// Protocol versioning: the single integer the client and server compare to
// confirm they can speak to each other, plus the WebSocket close code used to
// reject a mismatch. See protocolVersion.ts for the changelog and deploy rules.
export {
  PROTOCOL_VERSION,
  MIN_SUPPORTED_PROTOCOL_VERSION,
  WS_CLOSE_PROTOCOL_VERSION,
  PROTOCOL_VERSION_HEADER,
  protocolVersionProblem,
} from './protocolVersion.js';
export type {
  CommitOperation,
  MutationMessage,
  CommitMessage,
  MutationResultMessage,
  CommitRequestMessage,
  CommitResultMessage,
  LegacyCommitOperation,
  LegacyCommitMessage,
  LegacyMutationResultMessage,
} from './frames.js';

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
  AbloServerError,
  AbloStaleContextError,
  AbloClaimedError,
  CapabilityError,
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
export type { ErrorCode, WireErrorCode } from '../errors.js';

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
