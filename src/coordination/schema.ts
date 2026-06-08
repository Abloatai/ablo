import { z } from 'zod';

/**
 * Coordination wire schema — the ONE canonical source for the three layers
 * that keep humans and agents from clobbering each other on a shared row.
 * See `packages/sync-engine/docs/coordination.md` ("The model — three layers,
 * one decision") for the conceptual model. The layers, outer-to-inner:
 *
 *   1. PRESENCE       (observation)    — who is working where; NEVER enforces.
 *   2. PESSIMISTIC    (claims/leases)  — `intent_begin`/`intent_abandon`;
 *                                        mutual exclusion between participants.
 *   3. OPTIMISTIC     (stale-context)  — `readAt` + `onStale` write-guard;
 *                                        last-writer-wins lost-update detection.
 *
 * Both the SDK (`types/streams.ts`) and the sync-server (`hub/types.ts`,
 * `presence/*`) derive their TypeScript types from THESE schemas via
 * `z.infer`, instead of re-declaring overlapping shapes. That collapses the
 * field drift this surface accreted — e.g. the SDK's intent view dropping
 * `status`/`error`, `onStale` declared 5×, `IntentStatus` declared 2× — into
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
 * What a claim / intent / activity points at. The common locator shared by
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
 * target row's latest delta. `'reject'` is the default whenever `readAt` is
 * present. `'flag'` and `'merge'` are reserved — the wire accepts them, the
 * server does not yet enforce them.
 */
export const onStaleModeSchema = z.enum(['reject', 'force', 'flag', 'merge']);
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

// ─────────────────────────────────────────────────────────────────────────
//  Layer 2 — PESSIMISTIC claim / intent-lease
// ─────────────────────────────────────────────────────────────────────────

/**
 * Lifecycle of an intent — the Stripe `PaymentIntent.status` shape. Absent on
 * the wire ⇒ `'active'` (additive back-compat). The server stamps `'active'`
 * on `intent_begin` and emits a single terminal frame (`committed` /
 * `canceled` / `expired`) as the claim ends, so contenders learn *how* it
 * resolved, not merely that it vanished.
 */
export const intentStatusSchema = z.enum([
  'active',
  'committed',
  'expired',
  'canceled',
]);
export type IntentStatus = z.infer<typeof intentStatusSchema>;

/** Why a claim ended in a non-success terminal state. */
export const intentErrorSchema = z.object({
  code: z.string(),
  message: z.string().optional(),
  /** Participant already holding the target (conflict rejections). */
  heldBy: z.string().optional(),
  heldByIntentId: z.string().optional(),
  heldByExpiresAt: z.number().optional(),
});
export type IntentError = z.infer<typeof intentErrorSchema>;

/**
 * A declared pending-mutation intent — the unit broadcast in presence
 * `activeIntents`. Clients supply the descriptive `targetRef` fields, an
 * `action`, and a chosen `intentId`; the SERVER stamps `declaredAt` /
 * `expiresAt` and may set `status` / `error`.
 *
 * `status` and `error` are OPTIONAL: this single shape serves both the
 * server (which sets them) and the SDK view (which historically omitted
 * them). The superset is structurally assignable wherever the leaner view
 * was used, so the two prior copies collapse into this one without breaking
 * SDK consumers.
 */
export const intentClaimSchema = targetRefSchema.extend({
  intentId: z.string(),
  /** Verb the agent expects: 'update' | 'create' | 'editing' | 'reviewing' … */
  action: z.string(),
  /** Server-stamped declaration time (epoch ms). */
  declaredAt: z.number(),
  /** Server-computed TTL deadline (epoch ms). Readers treat as advisory. */
  expiresAt: z.number(),
  status: intentStatusSchema.optional(),
  error: intentErrorSchema.optional(),
});
export type IntentClaim = z.infer<typeof intentClaimSchema>;

/**
 * `intent_begin` payload (client → server). The descriptive target + action,
 * plus an optional duration hint and the opt-in fair-queue flag. The server
 * stamps the lifecycle/timestamp fields, so they are NOT part of the inbound
 * shape — this is exactly what the WS ingest validates.
 */
export const intentBeginPayloadSchema = targetRefSchema.extend({
  intentId: z.string(),
  action: z.string(),
  /** Hint for `expiresAt`; the server caps it. */
  estimatedMs: z.number().optional(),
  /**
   * Opt into the fair wait queue: when the target is already held, the server
   * enqueues this claim (FIFO) and replies `intent_queued` → later
   * `intent_granted`, instead of `intent_rejected`. Clients that set this MUST
   * handle the grant.
   */
  queue: z.boolean().optional(),
});
export type IntentBeginPayload = z.infer<typeof intentBeginPayloadSchema>;

/**
 * `intent_abandon` payload (client → server). `entityType`/`entityId` are
 * carried so the server can DEQUEUE a still-*waiting* (not held) intent from
 * the FIFO line — the held-intent path needs only `intentId`. (The previous
 * wire type omitted these two even though the handler reads them; the schema
 * documents what the code actually uses.)
 */
export const intentAbandonPayloadSchema = z.object({
  intentId: z.string(),
  entityType: z.string().optional(),
  entityId: z.string().optional(),
});
export type IntentAbandonPayload = z.infer<typeof intentAbandonPayloadSchema>;

/**
 * `intent_reorder` payload (client → server). A privileged participant (e.g. a
 * supervisor over its sub-agents) re-ranks the FIFO wait queue for an entity:
 * `order` lists waiters by `heldBy`+`intentId` in the desired priority. Waiters
 * not listed keep their relative order behind the listed ones. The server gates
 * who may call this; an unauthorized sender is dropped. Unlike `intent_abandon`
 * (acts on the caller's own entry), reorder acts on OTHER participants' queue
 * positions — hence the authorization gate.
 */
export const intentReorderPayloadSchema = z.object({
  entityType: z.string(),
  entityId: z.string(),
  order: z.array(z.object({ heldBy: z.string(), intentId: z.string() })),
});
export type IntentReorderPayload = z.infer<typeof intentReorderPayloadSchema>;

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
 * `activeIntents` are the observation surface for the other two layers —
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
  activeIntents: z.array(intentClaimSchema).optional(),
  delegatedFrom: z.string().nullish(),
});
export type PresenceUpdateFrame = z.infer<typeof presenceUpdateFrameSchema>;
