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
} from '../errors.js';
export type { ErrorCode, WireErrorCode } from '../errors.js';
