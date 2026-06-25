import { z } from 'zod';
import { syncGroupInputSchema } from '../schema/roles.js';

/**
 * Coordination wire schema — the ONE canonical source for the three layers
 * that keep humans and agents from clobbering each other on a shared row.
 * See `packages/sync-engine/docs/coordination.md` ("The model — three layers,
 * one decision") for the conceptual model. The layers, outer-to-inner:
 *
 *   1. PRESENCE       (observation)    — who is working where; NEVER enforces.
 *   2. PESSIMISTIC    (claims/leases)  — `claim_begin`/`claim_abandon`;
 *                                        mutual exclusion between participants.
 *   3. OPTIMISTIC     (stale-context)  — `readAt` + `onStale` write-guard;
 *                                        last-writer-wins lost-update detection.
 *
 * Both the SDK (`types/streams.ts`) and the sync-server (`hub/types.ts`,
 * `presence/*`) derive their TypeScript types from THESE schemas via
 * `z.infer`, instead of re-declaring overlapping shapes. That collapses the
 * field drift this surface accreted — e.g. the SDK's claim view dropping
 * `status`/`error`, `onStale` declared 5×, `ClaimStatus` declared 2× — into
 * a single definition that the wire ingest can also validate at runtime.
 */

// ─────────────────────────────────────────────────────────────────────────
//  Shared primitives
// ─────────────────────────────────────────────────────────────────────────

/** A line/column span within a text-bearing field (slide body, doc, cell). */
export const targetRangeSchema = z.object({
  startLine: z.number(),
  endLine: z.number(),
  startColumn: z.number().optional(),
  endColumn: z.number().optional(),
});
export type TargetRange = z.infer<typeof targetRangeSchema>;

export const participantKindSchema = z.enum(['user', 'agent', 'system']);
export type ParticipantKind = z.infer<typeof participantKindSchema>;

/**
 * Wire-tolerant participant kind for INGEST. The claim/presence streams
 * historically labelled a non-agent participant `'human'`, while the
 * capability/identity/lease surfaces all say `'user'` — the same participant,
 * two dialects. This normalizes the legacy `'human'` to the canonical `'user'`
 * on read so every consumer switches on ONE vocabulary. Producers emit
 * canonical {@link participantKindSchema} values; this only forgives an older
 * frame still carrying `'human'`. Additive — never widens the output union.
 */
export const wireParticipantKindSchema = z.preprocess(
  (value) => (value === 'human' ? 'user' : value),
  participantKindSchema,
);

/**
 * Resolve a peer's kind from an inbound presence/claim frame. Prefers the
 * server-stamped `participantKind` (normalized via
 * {@link wireParticipantKindSchema}); frames from servers that predate the
 * field fall back to the lossy `isAgent` boolean — which can say 'agent' or
 * 'user' but never 'system' (the flatten this field exists to remove).
 */
export function participantKindFromWire(
  wireKind: unknown,
  isAgent: boolean | undefined,
): ParticipantKind {
  const parsed = wireParticipantKindSchema.safeParse(wireKind);
  if (parsed.success) return parsed.data;
  return isAgent ? 'agent' : 'user';
}

/**
 * The peer-visible explanation a claim/claim carries, lifted from its opaque
 * `meta.description`. One place for the `typeof meta?.description === 'string'`
 * unfold that the claim/claim/presence surfaces each re-implemented — callers
 * with an explicit `description` field still prefer it (`explicit ?? fromMeta`).
 */
export function descriptionFromMeta(
  meta: Record<string, unknown> | undefined | null,
): string | undefined {
  return typeof meta?.description === 'string' ? meta.description : undefined;
}

/**
 * What a claim / claim / activity points at. The common locator shared by
 * all three layers — an entity, optionally narrowed to a path, range, or
 * field, with opaque app metadata.
 */
export const targetRefSchema = z.object({
  entityType: z.string(),
  entityId: z.string(),
  path: z.string().optional(),
  range: targetRangeSchema.optional(),
  field: z.string().optional(),
  meta: z.record(z.string(), z.unknown()).optional(),
});
export type TargetRef = z.infer<typeof targetRefSchema>;

// ─────────────────────────────────────────────────────────────────────────
//  Layer 3 — OPTIMISTIC stale-context (the write-guard)
// ─────────────────────────────────────────────────────────────────────────

/**
 * Mode applied when a write's snapshot watermark (`readAt`) is older than the
 * target row's latest delta. Three dispositions, split by the non-coercion
 * convention (see docs/concurrency-convention.md):
 *   • `notify`    — NON-COERCIVE: hold the write, return a `StaleNotification`
 *                   with the current value; the actor (agent or human) resolves.
 *   • `reject`    — coercive escape hatch: throw `AbloStaleContextError`
 *                   (default when `readAt` is present).
 *   • `overwrite` — coercive escape hatch: apply blindly last-writer-wins, no
 *                   signal.
 */
export const onStaleModeSchema = z.enum(['reject', 'overwrite', 'notify']);
export type OnStaleMode = z.infer<typeof onStaleModeSchema>;

/**
 * The optimistic guard carried on a commit operation. `readAt` is the
 * snapshot watermark from `context.capture` (null/absent ⇒ unguarded write).
 * `bypass` is the explicit, recorded override of a *foreign* pessimistic
 * claim — see the claim layer below.
 */
export const writeGuardSchema = z.object({
  readAt: z.number().nullish(),
  onStale: onStaleModeSchema.nullish(),
  bypass: z.boolean().optional(),
});
export type WriteGuard = z.infer<typeof writeGuardSchema>;

/**
 * The advisory signal returned to a committer whose write hit a stale-context
 * conflict under `onStale: 'notify'` — the engine's answer to "the typed value
 * you reasoned against changed while you were away."
 *
 * Philosophy: NON-COERCION. The engine's job is to surface the truthful current
 * state and let the intelligent actor — agent OR human — decide what to do; it
 * does NOT force an outcome. The two *forcing* dispositions are `reject`
 * (force-abort, discards the work) and `overwrite` (force-clobber). This
 * notification is the non-coercive path: instead of throwing, the server hands
 * back the conflicting field's *current* value as data so the actor can solve
 * it. The CLAIM is the prospective form of the same principle (coordinate
 * before acting); this notification is the in-flight form (here's what changed,
 * you resolve). Both an agent reasoning over the change and a human watching the
 * row are valid resolvers. (Cf. CoAgent/MTPO, arXiv:2606.15376, which bets the
 * resolver is specifically an LLM; Ablo's bet is the same non-coercion, actor
 * left to agent or human.) Rides on the commit ack alongside `lastSyncId`; an
 * empty/absent array means no premise moved.
 *
 * Only `notify` produces this: the conflicting op was HELD (not written), and
 * the actor reconciles against `currentValues` and re-commits. (`reject` throws,
 * `overwrite` is silent — neither notifies.)
 */
export const staleNotificationSchema = z.object({
  /** Stripe-style object tag — every returned object names its type. */
  object: z.literal('stale_notification').optional(),
  /** Model name of the conflicting row. */
  model: z.string(),
  /** Row id. */
  id: z.string(),
  /** The watermark the committer reasoned against (its `readAt`). */
  readAt: z.number(),
  /**
   * Newest delta id on the row — the committer's new watermark. Re-capture
   * context at/after this id to reconcile.
   */
  observedSyncId: z.number(),
  /**
   * Fields whose concurrent change collided with this write (intersection of
   * the committer's written columns and a newer delta's `changed_fields`).
   * Empty ⇒ a whole-entity change (CREATE/DELETE/legacy delta).
   */
  conflictingFields: z.array(z.string()),
  /**
   * Post-conflict live values of `conflictingFields` — the part a plain stale
   * error never carried. Lets the LLM self-heal without a round-trip read.
   */
  currentValues: z.record(z.string(), z.unknown()),
  /** Who wrote the conflicting delta. */
  writtenBy: z.object({
    kind: participantKindSchema,
    id: z.string(),
  }),
  /**
   * Set when this notification is for a GROUP read-dependency (e.g. `deck:abc`,
   * `slide:s1`) rather than a single row — "something in the group you read
   * changed." For a group notification `conflictingFields`/`currentValues` are
   * empty (the change could span many rows); re-read the group at
   * `observedSyncId` to reconcile. Absent ⇒ a row-scoped notification.
   */
  group: z.string().optional(),
});
export type StaleNotification = z.infer<typeof staleNotificationSchema>;

/**
 * A read DEPENDENCY declared on a commit — the STORM "did anything I looked at
 * change?" layer (vs. the write-target check that only validates the rows being
 * written). The server re-runs stale detection against each declared read at
 * `readAt`; a moved premise fires the entry's `onStale` disposition (default
 * `reject`) over the WHOLE batch (`notify` holds every write + notifies;
 * `reject` aborts; `overwrite` proceeds silently). Two granularities, choice:
 *
 *   • ROW   — `{ model, id, readAt, fields? }`: did this specific row (optionally
 *             these fields) change? The literal STORM/per-object premise.
 *   • GROUP — `{ group, readAt }`: did ANYTHING in this sync group change? `group`
 *             is a sync-group key like `deck:abc` or `slide:s1` — the same unit a
 *             human/agent watches and claims. Coarser, and more Ablo-native.
 */
export const readDependencySchema = z.union([
  z.object({
    model: z.string(),
    id: z.string(),
    readAt: z.number(),
    fields: z.array(z.string()).optional(),
    onStale: onStaleModeSchema.optional(),
  }),
  z.object({
    group: z.string(),
    readAt: z.number(),
    onStale: onStaleModeSchema.optional(),
  }),
]);
export type ReadDependency = z.infer<typeof readDependencySchema>;

// ─────────────────────────────────────────────────────────────────────────
//  Layer 2 — PESSIMISTIC claim / claim-lease
// ─────────────────────────────────────────────────────────────────────────

/**
 * Lifecycle of an claim — the Stripe `PaymentIntent.status` shape. Absent on
 * the wire ⇒ `'active'` (additive back-compat). The server stamps `'active'`
 * on `claim_begin` and emits a single terminal frame (`committed` /
 * `canceled` / `expired`) as the claim ends, so contenders learn *how* it
 * resolved, not merely that it vanished.
 */
export const claimStatusSchema = z.enum([
  'active',
  'committed',
  'expired',
  'canceled',
]);
export type ClaimStatus = z.infer<typeof claimStatusSchema>;

const wireClaimBaseSchema = targetRefSchema.extend({
  claimId: z.string(),
  /** Human-readable phase: 'editing' | 'reviewing' | 'forecasting' … */
  reason: z.string(),
  /** Server-stamped declaration time (epoch ms). */
  declaredAt: z.number(),
  /** Server-computed TTL deadline (epoch ms). Readers treat as advisory. */
  expiresAt: z.number(),
  status: claimStatusSchema.optional(),
});

export const wireClaimSummarySchema = wireClaimBaseSchema.pick({
  claimId: true,
  reason: true,
  declaredAt: true,
  expiresAt: true,
  entityType: true,
  entityId: true,
  field: true,
  meta: true,
});
export type WireClaimSummary = z.infer<typeof wireClaimSummarySchema>;

/** Why a claim ended in a non-success terminal state. */
export const claimErrorSchema = z.object({
  code: z.string(),
  message: z.string().optional(),
  /** Participant already holding the target (conflict rejections). */
  heldBy: z.string().optional(),
  heldByClaimId: z.string().optional(),
  heldByExpiresAt: z.number().optional(),
  /** Rich holder context for conflict rejections. Additive: older frames omit it. */
  heldByClaim: wireClaimSummarySchema.optional(),
  /** Optional conflict-policy explanation. Additive: older frames omit it. */
  policyReason: z.string().optional(),
});
export type ClaimError = z.infer<typeof claimErrorSchema>;

/**
 * A declared pending-mutation claim — the unit broadcast in presence
 * `activeClaims`. Clients supply the descriptive `targetRef` fields, an
 * explanatory `reason`, and a chosen `claimId`; the SERVER stamps `declaredAt` /
 * `expiresAt` and may set `status` / `error`.
 *
 * `status` and `error` are OPTIONAL: this single shape serves both the
 * server (which sets them) and the SDK view (which historically omitted
 * them). The superset is structurally assignable wherever the leaner view
 * was used, so the two prior copies collapse into this one without breaking
 * SDK consumers.
 */
export const wireClaimSchema = wireClaimBaseSchema.extend({
  error: claimErrorSchema.optional(),
});
export type WireClaim = z.infer<typeof wireClaimSchema>;

export const claimRejectionSchema = z.object({
  claimId: z.string(),
  reason: z.string(),
  target: targetRefSchema.optional(),
  heldBy: z.string().optional(),
  heldByClaimId: z.string().optional(),
  heldByExpiresAt: z.number().optional(),
  heldByClaim: wireClaimSummarySchema.optional(),
  policyReason: z.string().optional(),
});
export type ClaimRejection = z.infer<typeof claimRejectionSchema>;

/**
 * What a {@link ModelClaim} points at — the SDK-facing target locator, keyed by
 * `model`/`id` (the `ablo.<model>` vocabulary) rather than the wire's
 * `entityType`/`entityId`. Structurally the public `ModelTarget`.
 */
export const modelTargetSchema = z
  .object({
    model: z.string(),
    id: z.string(),
    path: z.string().optional(),
    range: targetRangeSchema.optional(),
    field: z.string().optional(),
    meta: z.record(z.string(), z.unknown()).optional(),
  })
  .readonly();
export type ModelTarget = z.infer<typeof modelTargetSchema>;

/**
 * A claim as surfaced to SDK callers and the HTTP claim routes
 * (`ablo.<model>.claim.state`, `/v1/claims`) — the resolved, peer-readable
 * view of one active or queued claim. The ONE canonical shape: the client
 * (`Ablo.ts`) derives its `ModelClaim` from this, and the sync-server's two
 * route copies adopt it once the engine dist is rebuilt.
 *
 * `expiresAt` is **epoch-ms** (a number) here — the same representation as the
 * WS `WireClaim`, so there is ONE timestamp encoding across wire, SDK, HTTP,
 * and errors (Stripe-style integer unix timestamps; no ISO string anywhere).
 * `participantKind` ingests via {@link wireParticipantKindSchema} so a legacy
 * `'human'` frame normalizes to `'user'`.
 */
export const modelClaimSchema = z
  .object({
    id: z.string(),
    actor: z.string(),
    participantKind: wireParticipantKindSchema,
    /** Human-readable phase (`'editing'`). */
    reason: z.string(),
    description: z.string().optional(),
    field: z.string().optional(),
    status: z.enum(['active', 'queued']).optional(),
    position: z.number().optional(),
    expiresAt: z.number(),
    target: modelTargetSchema,
  })
  .readonly();
export type ModelClaim = z.infer<typeof modelClaimSchema>;

/**
 * `claim_begin` payload (client → server). The descriptive target + reason,
 * plus an optional duration hint and the opt-in fair-queue flag. The server
 * stamps the lifecycle/timestamp fields, so they are NOT part of the inbound
 * shape — this is exactly what the WS ingest validates.
 */
export const claimBeginPayloadSchema = targetRefSchema.extend({
  claimId: z.string(),
  reason: z.string(),
  /** Hint for `expiresAt`; the server caps it. */
  estimatedMs: z.number().optional(),
  /**
   * Opt into the fair wait queue: when the target is already held, the server
   * enqueues this claim (FIFO) and replies `claim_queued` → later
   * `claim_granted`, instead of `claim_rejected`. Clients that set this MUST
   * handle the grant.
   */
  queue: z.boolean().optional(),
});
export type ClaimBeginPayload = z.infer<typeof claimBeginPayloadSchema>;

/**
 * `claim_abandon` payload (client → server). `entityType`/`entityId` are
 * carried so the server can DEQUEUE a still-*waiting* (not held) claim from
 * the FIFO line — the held-claim path needs only `claimId`. (The previous
 * wire type omitted these two even though the handler reads them; the schema
 * documents what the code actually uses.)
 */
export const claimAbandonPayloadSchema = z.object({
  claimId: z.string(),
  entityType: z.string().optional(),
  entityId: z.string().optional(),
});
export type ClaimAbandonPayload = z.infer<typeof claimAbandonPayloadSchema>;

/**
 * `claim_reorder` payload (client → server). A privileged participant (e.g. a
 * supervisor over its sub-agents) re-ranks the FIFO wait queue for an entity:
 * `order` lists waiters by `heldBy`+`claimId` in the desired priority. Waiters
 * not listed keep their relative order behind the listed ones. The server gates
 * who may call this; an unauthorized sender is dropped. Unlike `claim_abandon`
 * (acts on the caller's own entry), reorder acts on OTHER participants' queue
 * positions — hence the authorization gate.
 */
export const claimReorderPayloadSchema = z.object({
  entityType: z.string(),
  entityId: z.string(),
  order: z.array(z.object({ heldBy: z.string(), claimId: z.string() })),
});
export type ClaimReorderPayload = z.infer<typeof claimReorderPayloadSchema>;

// ─────────────────────────────────────────────────────────────────────────
//  Read interest — area-of-interest navigation (update_subscription)
// ─────────────────────────────────────────────────────────────────────────

/**
 * `update_subscription` payload (client → server). Replaces the connection's
 * connection-level read interest with the COMPLETE set of sync groups — the
 * READ counterpart to a claim (no write-claim, no TTL). Each entry is a
 * {@link syncGroupInputSchema} (`'default'` or a branded `kind:id`), so a
 * malformed group is rejected at ingest instead of being silently indexed.
 * This is untrusted client input, so the element type is strict.
 */
export const updateSubscriptionPayloadSchema = z.object({
  syncGroups: z.array(syncGroupInputSchema),
});
export type UpdateSubscriptionPayload = z.infer<
  typeof updateSubscriptionPayloadSchema
>;

/**
 * `subscription_ack` payload (server → client). Echoes the connection's
 * effective read set after the update (unchanged on rejection — the update is
 * atomic). `error` is present iff `success` is false (e.g. a scoped key
 * requesting a group outside its grant). `syncGroups` is lenient
 * (`z.string()`) here, not branded: it is the server's own echo for display,
 * not untrusted input, and includes base anchors like `org:<id>`.
 */
export const subscriptionAckPayloadSchema = z.object({
  success: z.boolean(),
  syncGroups: z.array(z.string()),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
});
export type SubscriptionAckPayload = z.infer<
  typeof subscriptionAckPayloadSchema
>;

// ─────────────────────────────────────────────────────────────────────────
//  Commit operation — carries the optimistic write-guard (Layer 3)
// ─────────────────────────────────────────────────────────────────────────

export const commitOperationTypeSchema = z.enum([
  'CREATE',
  'UPDATE',
  'DELETE',
  'ARCHIVE',
  'UNARCHIVE',
]);
export type CommitOperationType = z.infer<typeof commitOperationTypeSchema>;

/**
 * A single mutation in a commit batch, as it arrives on the wire. Extends the
 * optimistic `writeGuard` (`readAt`/`onStale`/`bypass`) — the structural link
 * that makes "every write is stale-guarded" legible in the type, not just in
 * prose.
 */
export const commitOperationSchema = writeGuardSchema.extend({
  type: commitOperationTypeSchema,
  model: z.string(),
  id: z.string().nullish(),
  input: z.record(z.string(), z.unknown()).nullish(),
  /** Per-op client tx id, echoed on the broadcast delta. */
  transactionId: z.string().nullish(),
});
export type CommitOperation = z.infer<typeof commitOperationSchema>;

/**
 * Any commit op on the wire — the runtime-validated ingest contract. Commit
 * ops carry replace (last-write-wins) semantics, guarded by the optimistic
 * `writeGuard`. Kept as a distinct alias from {@link CommitOperation} so the
 * ingest boundary in the server reads as "any op on the wire" even though the
 * two are currently structurally identical.
 */
export type AnyCommitOperation = CommitOperation;

// ─────────────────────────────────────────────────────────────────────────
//  Layer 1 — PRESENCE (observation only; never enforces)
// ─────────────────────────────────────────────────────────────────────────

export const presenceKindSchema = z.enum(['enter', 'update', 'leave']);
export type PresenceKind = z.infer<typeof presenceKindSchema>;

/** What a participant is actively working on (agents fill this in). */
export const presenceActivitySchema = targetRefSchema.extend({
  action: z.string(),
  detail: z.string().optional(),
});
export type PresenceActivity = z.infer<typeof presenceActivitySchema>;

/**
 * Full `presence_update` frame as the server broadcasts it. The activity +
 * `activeClaims` are the observation surface for the other two layers —
 * rendered, never acted on as enforcement.
 */
export const presenceUpdateFrameSchema = z.object({
  kind: presenceKindSchema,
  userId: z.string().optional(),
  syncGroups: z.array(z.string()).optional(),
  timestamp: z.number().optional(),
  status: z.string(),
  timezone: z.string().optional(),
  customStatus: z.string().optional(),
  activity: presenceActivitySchema.optional(),
  isAgent: z.boolean().optional(),
  /**
   * Server-stamped canonical kind. Additive — older servers omit it and
   * readers fall back to `isAgent` (see {@link participantKindFromWire}).
   */
  participantKind: wireParticipantKindSchema.optional(),
  activeClaims: z.array(wireClaimSchema).optional(),
  delegatedFrom: z.string().nullish(),
});
export type PresenceUpdateFrame = z.infer<typeof presenceUpdateFrameSchema>;
