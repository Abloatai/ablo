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
  targetRefSchema,
  // Layer 3 — optimistic stale-context
  onStaleModeSchema,
  writeGuardSchema,
  staleNotificationSchema,
  readDependencySchema,
  // Layer 2 — pessimistic claim / claim-lease
  claimStatusSchema,
  wireClaimSummarySchema,
  claimErrorSchema,
  wireClaimSchema,
  claimRejectionSchema,
  modelTargetSchema,
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
  // Layer 2 — pessimistic claim / claim-lease
  ClaimStatus,
  WireClaimSummary,
  ClaimError,
  WireClaim,
  ClaimRejection,
  ModelTarget,
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
  PresenceUpdateFrame,
} from './schema.js';
