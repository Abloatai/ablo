/**
 * The `@abloatai/ablo/coordination` entry point. It re-exports the wire
 * schemas and inferred types for the three coordination layers: presence (who
 * is currently active), claims (taking exclusive hold of a target before
 * writing it), and stale-context guards (rejecting a write that was based on an
 * out-of-date read). The definitions themselves live in the sibling schema
 * module.
 *
 * Exports are listed by name rather than re-exported wholesale, so every symbol
 * that becomes part of this package's public API is a deliberate choice.
 */

// Runtime schemas + helpers.
export {
  // Shared primitives
  targetRangeSchema,
  participantKindSchema,
  wireParticipantKindSchema,
  participantKindFromWire,
  descriptionFromMeta,
  claimDescription,
  DEFAULT_CLAIM_DESCRIPTION,
  targetRefSchema,
  // Layer 3 — optimistic stale-context
  onStaleModeSchema,
  writeGuardSchema,
  staleNotificationSchema,
  readDependencySchema,
  trackDependencySchema,
  // Layer 2 — pessimistic claim / claim-lease
  claimStatusSchema,
  wireClaimStatusSchema,
  wireClaimSummarySchema,
  claimErrorSchema,
  wireClaimSchema,
  claimRejectionSchema,
  // The rest of the claim frames, each the validation boundary for one
  // server-sent event — see WS_INBOUND_FRAMES for where they are applied.
  claimLostSchema,
  claimAcquiredSchema,
  claimGrantedSchema,
  claimQueuedSchema,
  claimQueueSchema,
  claimQueueEntrySchema,
  claimExpiredSchema,
  claimEventReasonSchema,
  modelTargetSchema,
  // The one claim record, and the peer-visible projection of it.
  claimRecordSchema,
  heldClaimStatusSchema,
  modelClaimSchema,
  claimBeginPayloadSchema,
  claimAbandonPayloadSchema,
  claimReorderPayloadSchema,
  claimHeartbeatPayloadSchema,
  claimHeartbeatAckPayloadSchema,
  claimHeartbeatBatchPayloadSchema,
  claimHeartbeatBatchAckPayloadSchema,
  // Read interest — area-of-interest navigation
  updateSubscriptionPayloadSchema,
  subscriptionAckPayloadSchema,
  // Commit operation — carries the optimistic write-guard
  commitOperationTypeSchema,
  commitOperationSchema,
  // Layer 1 — presence
  presenceKindSchema,
  presenceActivitySchema,
  presenceUpdateSchema,
  presenceUpdatePayloadSchema,
  // Deprecated alias, removed in 0.36.0 — this line publishes it.
  // eslint-disable-next-line @typescript-eslint/no-deprecated
  presenceUpdateFrameSchema,
} from './schema.js';

// Conflict-policy runtime — the engine detects a conflict, and the policy
// decides what to do about it. These are re-exported here so that server-side
// code can reach both the coordination vocabulary and its default conflict
// resolution from this one subpath, without importing the full client from the
// package root.
export { defaultPolicy, capabilityPreemptPolicy, interpretConflictAxis } from '../policy/types.js';
export type {
  Conflict,
  ConflictAxis,
  ConflictDecision,
  ConflictKind,
  ConflictOperation,
  ConflictPolicy,
  StaleContextConflict,
  ClaimHeldConflict,
} from '../policy/types.js';

// Inferred types, one per schema (plus the standalone aliases).
export type {
  // Shared primitives
  TargetRange,
  ParticipantKind,
  TargetRef,
  // Layer 3 — optimistic stale-context
  OnStaleMode,
  WriteGuard,
  StaleNotification,
  ReadDependency,
  TrackDependency,
  // Layer 2 — pessimistic claim / claim-lease
  ClaimStatus,
  WireClaimStatus,
  WireClaimSummary,
  ClaimError,
  WireClaim,
  ClaimRejection,
  ClaimLost,
  ClaimAcquired,
  ClaimGranted,
  ClaimQueued,
  ClaimQueue,
  ClaimQueueEntry,
  ClaimExpired,
  ClaimEventReason,
  ModelTarget,
  ClaimRecord,
  HeldClaimStatus,
  ModelClaim,
  ClaimBeginPayload,
  ClaimAbandonPayload,
  ClaimReorderPayload,
  ClaimHeartbeatPayload,
  ClaimHeartbeatAckPayload,
  ClaimHeartbeatBatchPayload,
  ClaimHeartbeatBatchAckPayload,
  // Read interest — area-of-interest navigation
  UpdateSubscriptionPayload,
  SubscriptionAckPayload,
  // Commit operation — carries the optimistic write-guard
  CommitOperationType,
  CommitOperation,
  AnyCommitOperation,
  // Layer 1 — presence
  PresenceKind,
  PresenceActivity,
  PresenceUpdate,
  PresenceUpdatePayload,
  // eslint-disable-next-line @typescript-eslint/no-deprecated
  PresenceUpdateFrame,
} from './schema.js';

// In-process observation events. These are behavior-facing projections, not
// duplicate wire declarations; the wire contracts remain in schema.ts.
export type {
  ClaimEvent,
  ClaimCounterparty,
  ConflictEvent,
  CoordinationObserver,
} from './events.js';

// The conflict rule itself — whether two claims on one row collide. It is the
// protocol's decision, not the server's deployment of it, so it lives here and
// every claim authority imports it.
export { targetsConflict } from './targetConflict.js';

// The locator itself — what a claim points at, and the projections that keep
// its three entity spellings (`entityType`/`entityId`, `model`/`id`,
// `type`/`id`) saying the same thing while they coexist.
export type {
  ClaimTargetDetails,
  ClaimTargetSource,
  EntityLocator,
} from './locator.js';
export {
  isTargetTuple,
  subTarget,
  wireTarget,
  modelTarget,
  streamTarget,
} from './locator.js';
