import { z } from 'zod';
import { syncGroupInputSchema } from '../schema/roles.js';

/**
 * The wire schemas for coordination — the shapes that keep humans and agents
 * from overwriting each other on a shared row. Coordination works in three
 * layers, from outermost to innermost:
 *
 *   1. Presence (observation): who is working where. It reports, never blocks.
 *   2. Claims (pessimistic leases): `claim_begin` / `claim_abandon` grant one
 *      participant exclusive intent on a target while others wait.
 *   3. Stale-context (optimistic): a `readAt` watermark plus an `onStale` write
 *      guard that catches a lost update when the row moved after you read it.
 *
 * These Zod schemas are the single definition of each shape. Both the client
 * SDK and the server derive their TypeScript types from them with `z.infer`
 * rather than re-declaring the shapes, and the server validates inbound frames
 * against them at runtime.
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
 * Parses a participant kind from an inbound frame, tolerating an older wire
 * dialect. Some presence and claim frames label a non-agent participant
 * `'human'`, while the rest of the surface uses `'user'` for the same
 * participant. This normalizes `'human'` to `'user'` on read so every consumer
 * switches on one vocabulary. Producers emit the canonical
 * {@link participantKindSchema} values, and the output union is never widened.
 */
export const wireParticipantKindSchema = z.preprocess(
  (value) => (value === 'human' ? 'user' : value),
  participantKindSchema,
);

/**
 * Resolves a peer's kind from an inbound presence or claim frame. It prefers
 * the server-stamped `participantKind` (normalized through
 * {@link wireParticipantKindSchema}). A frame from an older server that omits
 * that field falls back to the `isAgent` boolean, which can tell 'agent' from
 * 'user' but can never report 'system'.
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
 * Reads the peer-visible description a claim or presence frame carries in its
 * opaque `meta.description`. This is the single place that unpacks that field.
 * A caller that has an explicit `description` should prefer it
 * (`explicit ?? fromMeta`).
 */
export function descriptionFromMeta(
  meta: Record<string, unknown> | undefined | null,
): string | undefined {
  return typeof meta?.description === 'string' ? meta.description : undefined;
}

/**
 * What a coordination event points at — the locator shared by all three
 * layers. It names an entity, optionally narrowed to a path, range, or field,
 * and carries opaque application metadata.
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
//  Layer 3 — optimistic stale-context (the write guard)
// ─────────────────────────────────────────────────────────────────────────

/**
 * How the server treats a write whose snapshot watermark (`readAt`) is older
 * than the target row's latest change. There are three dispositions:
 *   • `notify`    — hold the write and return a {@link StaleNotification}
 *                   carrying the current value, so the actor (agent or human)
 *                   can resolve it.
 *   • `reject`    — throw `AbloStaleContextError`, the default when `readAt`
 *                   is present.
 *   • `overwrite` — apply the write blindly, last write wins, with no signal.
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
 * The advisory returned to a committer whose write hit a stale-context
 * conflict under `onStale: 'notify'` — it reports that the value the committer
 * reasoned against changed while they were away. Rather than throwing, the
 * server hands back the conflicting field's current value as data so the
 * actor — an agent or a human — can reconcile and re-commit. A claim is the
 * prospective form of the same idea (coordinate before acting); this
 * notification is the in-flight form (here is what changed, you resolve). It
 * rides on the commit acknowledgement alongside `lastSyncId`; an empty or
 * absent array means nothing the committer depended on moved.
 *
 * Only `onStale: 'notify'` produces this. The conflicting operation was held,
 * not written, and the actor reconciles against `currentValues` and
 * re-commits. `reject` throws instead, and `overwrite` proceeds silently —
 * neither notifies.
 */
export const staleNotificationSchema = z.object({
  /** Names this object's type; every returned object carries such a tag. */
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
   * The live values of `conflictingFields` after the conflict — the piece a
   * plain stale error omits. It lets the actor reconcile without a follow-up read.
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
 * A read that a commit declares it depended on, so the server can ask "did
 * anything I looked at change?" — broader than the write-target check, which
 * only validates the rows being written. The server re-runs stale detection
 * against each declared read at its `readAt`; a moved premise fires the entry's
 * `onStale` disposition (default `reject`) across the whole batch (`notify`
 * holds every write and notifies, `reject` aborts, `overwrite` proceeds
 * silently). A dependency comes at one of two granularities:
 *
 *   • Row   — `{ model, id, readAt, fields? }`: did this specific row, or these
 *             specific fields, change?
 *   • Group — `{ group, readAt }`: did anything in this sync group change?
 *             `group` is a sync-group key such as `deck:abc` or `slide:s1`, the
 *             same unit a participant watches and claims.
 *
 * See `packages/sync-engine/docs/concurrency-convention.md` (§4) for the
 * governing convention and the receive → reconcile loop.
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
//  Layer 2 — pessimistic claims and leases
// ─────────────────────────────────────────────────────────────────────────

/**
 * The lifecycle of a claim. When absent on the wire it means `'active'` (an
 * additive back-compat default). The server stamps `'active'` on `claim_begin`
 * and emits one terminal frame — `committed`, `canceled`, or `expired` — as the
 * claim ends, so contenders learn how it resolved, not merely that it vanished.
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
 * A declared, pending-mutation claim — the unit broadcast inside a presence
 * frame's `activeClaims`. The client supplies the descriptive `targetRef`
 * fields, an explanatory `reason`, and a chosen `claimId`; the server stamps
 * `declaredAt` and `expiresAt` and may set `status` and `error`. Those last
 * two are optional, so one shape serves both the server, which sets them, and
 * the leaner SDK view, which reads a claim without them.
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
 * The point-to-point notification sent to a holder whose lease ended without
 * a successful commit. This remains a wire-shaped target because it arrives
 * directly from the WebSocket; the schema is the single validation boundary
 * before the event reaches public `claims.onLost` listeners.
 */
export const claimLostSchema = z.object({
  claimId: z.string(),
  reason: z.enum(['expired', 'preempted']),
  target: targetRefSchema,
});
export type ClaimLost = z.infer<typeof claimLostSchema>;

/**
 * What a {@link ModelClaim} points at — the target locator as SDK callers see
 * it, keyed by `model` and `id` rather than the wire schema's `entityType` and
 * `entityId`. This is the public `ModelTarget` shape.
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
 * A claim as SDK callers and the HTTP claim routes see it
 * (`ablo.<model>.claim.state`, `/v1/claims`) — the resolved, peer-readable view
 * of one active or queued claim. The client's `ModelClaim` type derives from
 * this shape.
 *
 * `expiresAt` is epoch milliseconds (a number), the same encoding as the
 * WebSocket {@link WireClaim}, so one timestamp representation spans the wire,
 * the SDK, HTTP, and errors — there is no ISO string anywhere.
 * `participantKind` is parsed through {@link wireParticipantKindSchema}, so a
 * legacy `'human'` frame normalizes to `'user'`.
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
 * The `claim_begin` payload a client sends. It carries the descriptive target
 * and reason, an optional duration hint, and the opt-in fair-queue flag. The
 * server stamps the lifecycle and timestamp fields, so they are not part of
 * this inbound shape — this is exactly what the server validates on ingest.
 */
export const claimBeginPayloadSchema = targetRefSchema.extend({
  claimId: z.string(),
  reason: z.string(),
  /** Hint for `expiresAt`; the server caps it. */
  estimatedMs: z.number().optional(),
  /**
   * Opt into the fair wait queue. When the target is already held, the server
   * enqueues this claim in FIFO order and replies `claim_queued`, then
   * `claim_granted` later, instead of `claim_rejected`. A client that sets this
   * must be ready to handle the grant.
   */
  queue: z.boolean().optional(),
});
export type ClaimBeginPayload = z.infer<typeof claimBeginPayloadSchema>;

/**
 * The `claim_abandon` payload a client sends. `entityType` and `entityId` let
 * the server dequeue a claim that is still waiting (not yet held) from the FIFO
 * line; abandoning a claim that is already held needs only `claimId`.
 */
export const claimAbandonPayloadSchema = z.object({
  claimId: z.string(),
  entityType: z.string().optional(),
  entityId: z.string().optional(),
});
export type ClaimAbandonPayload = z.infer<typeof claimAbandonPayloadSchema>;

/**
 * The `claim_reorder` payload a client sends. A privileged participant, such as
 * a supervisor over its sub-agents, re-ranks the FIFO wait queue for an entity:
 * `order` lists waiters by `heldBy` and `claimId` in the desired priority, and
 * any waiter not listed keeps its relative order behind those that are. The
 * server gates who may call this and drops an unauthorized sender. Where
 * `claim_abandon` acts on the caller's own entry, a reorder acts on other
 * participants' queue positions — which is why it is gated.
 */
export const claimReorderPayloadSchema = z.object({
  entityType: z.string(),
  entityId: z.string(),
  order: z.array(z.object({ heldBy: z.string(), claimId: z.string() })),
});
export type ClaimReorderPayload = z.infer<typeof claimReorderPayloadSchema>;

// ─────────────────────────────────────────────────────────────────────────
//  Heartbeat — the async / long-running-work surface of a claim.
//
//  A claim's TTL is crash cleanup, not a work-duration estimate. Work that
//  outlives it — an agent run, a background worker's job — keeps its lease by
//  BEATING: request `claim_heartbeat`, reply `claim_heartbeat_ack`. One field
//  set serves every shape; the single and batched payloads are both derived
//  from it, and the WebSocket frame and HTTP routes are two encodings of the
//  same messages. Everything long-running-work-related on the wire lives in
//  this block.
// ─────────────────────────────────────────────────────────────────────────

/**
 * The one field set behind every heartbeat message. The single-claim payload
 * refines it; the batched payload picks from it — there is deliberately no
 * second shape to keep in sync.
 */
const claimHeartbeatFieldsSchema = z.object({
  claimId: z.string().optional(),
  entityType: z.string().optional(),
  entityId: z.string().optional(),
  /** Requested extension from now; the server clamps it, and an extension
   *  never shortens a lease. */
  ttlMs: z.number().positive().optional(),
  /**
   * Lightweight progress the beat carries along ("42/100 pages") — stored
   * as the claim's `meta.progress` (last beat wins) and peer-visible via
   * `claim.state` while the lease is held. This is presence, not a
   * checkpoint: it dies with the lease. Crash-recoverable progress belongs
   * in the data itself — write a row, and every subscriber already sees it.
   */
  details: z.record(z.string(), z.unknown()).optional(),
});

/**
 * The `claim_heartbeat` payload a client sends to extend a lease it holds (or
 * refresh its slot in the wait queue) past the liveness window — the
 * work-duration signal for long-running holders, distinct from the connection
 * keepalive.
 *
 * The claim is identified either way: by `claimId`, or — since a claim is
 * singular per (actor, entity) — by the full `entityType`/`entityId` target
 * ("my claim on this row"). At least one of the two must be present. The
 * target also lets the server resolve without a scan and is required to
 * refresh a *queued* claim (a waiter is not in the holder set the server
 * would otherwise search).
 */
export const claimHeartbeatPayloadSchema = claimHeartbeatFieldsSchema.refine(
  (payload) =>
    payload.claimId !== undefined ||
    (payload.entityType !== undefined && payload.entityId !== undefined),
  {
    message:
      'a heartbeat must identify its claim — pass claimId, or entityType and entityId together',
  },
);
export type ClaimHeartbeatPayload = z.infer<typeof claimHeartbeatPayloadSchema>;

/**
 * The server's reply to a `claim_heartbeat`. For a socketless worker the
 * heartbeat reply is the only inbound signal path, so it carries the lease's
 * fate rather than a bare ok: `held` (extended to `expiresAt`), `queued`
 * (slot refreshed; `position` is the current place in line), or `lost` (the
 * lease expired and the queue moved on — the worker should abandon or
 * re-queue, and any write it still attempts is caught by its `readAt` guard).
 */
export const claimHeartbeatAckPayloadSchema = z.object({
  claimId: z.string(),
  status: z.enum(['held', 'queued', 'lost']),
  expiresAt: z.number().optional(),
  position: z.number().optional(),
  /**
   * How many participants are waiting in line behind a held lease — the
   * cooperative-yield pressure signal (present on `held`). A worker that can
   * checkpoint may choose to release early when others wait. Hard
   * cancellation needs no extra field: a preempted, expired, or revoked
   * lease answers the next beat with `lost`.
   */
  queueDepth: z.number().optional(),
});
export type ClaimHeartbeatAckPayload = z.infer<typeof claimHeartbeatAckPayloadSchema>;

/**
 * The batched heartbeat — one request extends every lease the caller holds
 * on its plane (the socketless twin of the WebSocket keepalive, which renews
 * all held leases on every ping). For a worker holding many rows this is one
 * round trip per cadence instead of one per claim. Queued slots are not
 * batch-refreshed: a waiter knows its target and beats it directly.
 */
export const claimHeartbeatBatchPayloadSchema = claimHeartbeatFieldsSchema.pick(
  { ttlMs: true },
);
export type ClaimHeartbeatBatchPayload = z.infer<
  typeof claimHeartbeatBatchPayloadSchema
>;

/** Reply to a batched heartbeat: one ack entry per lease that was extended. */
export const claimHeartbeatBatchAckPayloadSchema = z.object({
  results: z.array(claimHeartbeatAckPayloadSchema),
});
export type ClaimHeartbeatBatchAckPayload = z.infer<
  typeof claimHeartbeatBatchAckPayloadSchema
>;

// ─────────────────────────────────────────────────────────────────────────
//  Read interest — area-of-interest navigation (update_subscription)
// ─────────────────────────────────────────────────────────────────────────

/**
 * The `update_subscription` payload a client sends. It replaces the
 * connection's read interest with the complete set of sync groups — the read
 * counterpart to a claim, with no write lock and no TTL. Each entry is a
 * {@link syncGroupInputSchema} (`'default'` or a branded `kind:id`), so a
 * malformed group is rejected on ingest rather than silently indexed. The
 * element type is strict because this is untrusted client input.
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
 * Any commit operation on the wire — the runtime-validated ingest contract.
 * Commit operations carry replace (last-write-wins) semantics, guarded by the
 * optimistic write guard. It is a distinct alias from {@link CommitOperation}
 * so the server's ingest boundary reads as "any op on the wire", even though
 * the two shapes are identical.
 */
export type AnyCommitOperation = CommitOperation;

// ─────────────────────────────────────────────────────────────────────────
//  Layer 1 — presence (observation only; it never enforces)
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
