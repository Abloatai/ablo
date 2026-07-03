/**
 * `@abloatai/ablo/wire` — the canonical HTTP/frame WIRE CONTRACT, with no
 * client-runtime (mobx / react / IndexedDB) dependency, so a server-side
 * consumer — a Next.js route handler, an edge function — can import the
 * envelope producers without pulling in the whole sync client.
 *
 * Two halves, both Stripe-shaped and used across every Ablo surface:
 *   - ERROR egress — {@link errorEnvelope} / {@link ErrorEnvelope} /
 *     {@link statusForType} turn any thrown value into
 *     `{ type, code, param, message, doc_url, request_id }`.
 *   - LIST egress — {@link listEnvelope} / {@link ListEnvelope} stamp the
 *     uniform `{ object: 'list', data, has_more, next_cursor }` collection.
 *
 * The {@link AbloError} hierarchy + {@link docUrlForCode} + the wire-PARSE
 * helpers are re-exported so a route can THROW the right typed error and
 * SERIALIZE it through a single import.
 */
export { errorEnvelope, statusForType } from './errorEnvelope.js';
export type { ErrorEnvelope } from './errorEnvelope.js';
export { listEnvelope } from './listEnvelope.js';
export type { ListEnvelope } from './listEnvelope.js';

// Commit-path frame contract — the canonical write-path message shapes shared
// by the SDK client, the sync-server, and any `@abloatai/ablo/server` host.
// The runtime Zod validators live beside the interfaces (z.infer-bound so the
// two cannot drift) — the per-op / per-payload ingest gates for both commit
// transports.
export { commitOperationSchema, commitPayloadSchema } from './frames.js';

// Protocol versioning — the one integer client and server compare to know
// they can speak, plus the typed WS rejection close code. See the module's
// changelog + deploy contract.
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
} from './frames.js';

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
  // The code→{httpStatus,retryable} registry table — dependency-free data a
  // server needs to resolve a code's canonical status exactly like the SDK's
  // wire producer does (pinned by the sync-server envelope parity test).
  errorCodeSpec,
} from '../errors.js';
export type { ErrorCode, WireErrorCode } from '../errors.js';

// Protocol timing constants — the 30s ping cadence + the 3×-ping claim/
// presence lease window shared by the SDK heartbeat, the Hub keepalive,
// the claim coordinator, and the presence reaper (see protocol.ts) — plus
// the WS auth-handshake subprotocols shared by SyncWebSocket and the Hub.
export {
  PING_INTERVAL_MS,
  LEASE_TTL_MS,
  WS_BEARER_SUBPROTOCOL_PREFIX,
  WS_SYNC_SUBPROTOCOL,
} from './protocol.js';
