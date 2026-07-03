/**
 * `@abloatai/ablo/coordination` — the canonical wire schema for the three
 * coordination layers (presence, pessimistic claims, optimistic stale-context).
 * See `./schema.ts` for the model and the per-layer schemas.
 *
 * Explicit named list (not `export *`): every addition to schema.ts must be a
 * deliberate export decision here, so new symbols don't silently become public
 * API of the published package.
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

// Conflict-policy runtime — the engine detects, the policy decides. Lives in
// `../policy/types.js` (a dependency-free leaf: its only imports are types),
// exported here so a server-side consumer reaches the coordination vocabulary
// AND its default resolution through one leaf subpath instead of the root
// barrel (which would evaluate the whole browser client stack in Node).
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
