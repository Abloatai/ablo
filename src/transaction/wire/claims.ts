/**
 * The request bodies for the claim routes.
 *
 * A claim is a lease over a row, so these cross the same boundary the commit
 * body does and belong here for the same reason: one definition site, which the
 * server validates against and the published OpenAPI reference derives from.
 *
 * Before this existed both claim routes cast `JSON.parse` output to a
 * hand-written interface, so an untrusted body reached the coordinator
 * unvalidated and the reference described the shape from memory.
 */

import { z } from 'zod';
import {
  targetRangeSchema,
  publicClaimStatusSchema,
  wireParticipantKindSchema,
  claimRecordSchema,
  modelClaimSchema,
  claimHeartbeatAckPayloadSchema,
  wireClaimSummarySchema,
} from '../coordination/schema.js';

/** The row a claim points at, when it is not already given by the URL. */
export const claimTargetSchema = z.object({
  model: z.string().optional(),
  id: z.string().nullish(),
  path: z.string().optional(),
  range: targetRangeSchema.optional(),
  field: z.string().optional(),
  /** Several named parts at once — see {@link targetRefSchema}. */
  fields: z.array(z.string()).readonly().optional(),
  meta: z.record(z.string(), z.unknown()).optional(),
});
export type ClaimTargetBody = z.infer<typeof claimTargetSchema>;

/**
 * `POST /v1/claims` and `POST /v1/models/{model}/{id}/claim`.
 *
 * Every field is optional: on the model-scoped route the target comes from the
 * URL, and a bare claim means "I'm editing this row".
 */
export const claimRequestSchema = z.object({
  claimId: z.string().optional(),
  target: claimTargetSchema.nullish(),
  reason: z.string().optional(),
  /** Defaults to `editing`. Shown to other participants holding the row. */
  description: z.string().optional(),
  meta: z.record(z.string(), z.unknown()).optional(),
  /** Lease length in the same grammar as a heartbeat: `'5m'` or `30000`. */
  ttl: z.union([z.string(), z.number()]).nullish(),
  /**
   * Join the fair wait line when the row is already held, instead of failing.
   * The response carries `{ status: 'queued', position }` and the grant arrives
   * later on the caller's stream.
   */
  queue: z.boolean().optional(),
});
export type ClaimRequest = z.infer<typeof claimRequestSchema>;

/**
 * `POST /v1/models/{model}/{id}/claim/heartbeat`.
 *
 * An empty body is a plain "still working" beat. `ttl` extends the lease;
 * `claimId` names the exact lease instead of "my claim on this row".
 */
export const claimHeartbeatRequestSchema = z.object({
  claimId: z.string().optional(),
  ttl: z.union([z.string(), z.number()]).nullish(),
  /** Progress carried on the beat — becomes the claim's peer-visible
   *  `meta.progress`. Last beat wins, and it goes with the lease. */
  details: z.record(z.string(), z.unknown()).optional(),
});
export type ClaimHeartbeatRequest = z.infer<typeof claimHeartbeatRequestSchema>;

/**
 * The query string on `GET /v1/models/{model}`.
 *
 * Values arrive as strings, so this describes the wire spelling rather than the
 * parsed result — which is what a caller and the reference both need.
 */
export const listQuerySchema = z.object({
  limit: z.string().optional(),
  order_by: z.string().optional(),
  order: z.enum(['asc', 'desc']).optional(),
  /** Keyset cursor: the id of the last row from the previous page. */
  starting_after: z.string().optional(),
});
export type ListQuery = z.infer<typeof listQuerySchema>;

/**
 * A claim's current state, as returned by `GET /v1/claims/{claimId}`.
 *
 * This is the polling shape, and only the polling shape. Acquiring a claim
 * answers with {@link claimAcquireResponseSchema}, whose two arms are spelled
 * differently — that route was documented against this schema for a while, and
 * the reference described a response the server has never sent.
 *
 * This is the shape that makes queued grants reachable without a socket: the
 * caller enqueues, receives `queued`, heartbeats to stay in line, and polls
 * until `status` becomes `active`, at which point `fenceToken` is present and
 * the work can begin.
 *
 * Two properties are load-bearing and easy to get wrong from the outside:
 *
 * **`position` is advisory.** A privileged caller can reorder the wait line, so
 * a position can go UP between polls. Only `status` is authoritative — a client
 * that asserts monotonic position will fail in production, not in review.
 *
 * **`fenceToken` appears at grant, never at enqueue.** It orders by acquisition
 * rather than by arrival, which is what the fence watermark depends on; a token
 * handed out while queued would break that ordering.
 *
 * There is deliberately no `readAt` here. A watermark records the state a
 * writer reasoned against, and a caller that has just been granted a claim has
 * not read anything yet — it reads next. Stamping one at grant would assert a
 * premise the caller never established, so the holder gets its watermark from
 * its own read, the same way the socket path takes it from a local snapshot.
 */
export const claimStateSchema = claimRecordSchema
  .pick({ position: true, expiresAt: true, fenceToken: true })
  .partial()
  .extend({
    object: z.literal('claim'),
    /** The claim named, rather than the claim as a resource — which is why this
     *  is `claimId` and not the record's `id`. */
    claimId: z.string(),
    /**
     * Widened from the record's two observable states to all five.
     *
     * A poll is the one surface that can arrive after the claim ended: the
     * caller holds an id and asks what became of it, so `committed`, `expired`,
     * and `canceled` are answers this route must be able to give. A peer's
     * listing cannot see them, because a terminal claim has already left the
     * set being listed.
     */
    status: publicClaimStatusSchema,
  });
export type ClaimState = z.infer<typeof claimStateSchema>;

/**
 * `POST /v1/claims` and `POST /v1/models/{model}/{id}/claim`, **201** — the
 * target was free and the lease is yours. The claim is nested rather than
 * flattened because the outer object is the created resource's envelope, and
 * `id` is its identity.
 */
export const claimAcquiredResponseSchema = z.object({
  id: z.string(),
  object: z.literal('claim'),
  claim: modelClaimSchema,
});
export type ClaimAcquiredResponse = z.infer<typeof claimAcquiredResponseSchema>;

/**
 * The same two routes, **202** — the row was already held and `queue: true`
 * put you in line. The grant arrives later on the caller's stream, or through
 * `GET /v1/claims/{claimId}`.
 *
 * There is deliberately no `object` field here: a queued claim is not yet a
 * created resource, and the status code plus `status: 'queued'` already carry
 * the distinction.
 */
export const claimQueuedResponseSchema = z.object({
  status: z.literal('queued'),
  claimId: z.string(),
  position: z.number().int().nonnegative(),
  heldBy: z.string().optional(),
  expiresAt: z.number().int().optional(),
  heldByClaim: wireClaimSummarySchema.optional(),
});
export type ClaimQueuedResponse = z.infer<typeof claimQueuedResponseSchema>;

/**
 * Either answer to a claim acquire. The two arms cannot be a discriminated
 * union — the 201 keys on `object` and the 202 on `status`, and neither field
 * appears in both — so a caller branches on `status === 'queued'`, which is
 * what the HTTP transport does.
 */
export const claimAcquireResponseSchema = z.union([
  claimAcquiredResponseSchema,
  claimQueuedResponseSchema,
]);
export type ClaimAcquireResponse = z.infer<typeof claimAcquireResponseSchema>;

/**
 * `POST /v1/models/{model}/{id}/claim/heartbeat`.
 *
 * `status` never carries `'lost'` in a body: a lease that ended answers with a
 * 409 `claim_lost` instead, which the error mapping raises as
 * `AbloClaimedError` before any of this is read. That is the one way this
 * differs from the WebSocket {@link claimHeartbeatAckPayloadSchema}, whose
 * three-state status includes the loss.
 */
export const claimHeartbeatReplySchema = z.object({
  object: z.literal('claim_heartbeat'),
  claimId: z.string(),
  status: z.enum(['held', 'queued']),
  /** Present on `held`: the extended lease deadline. */
  expiresAt: z.number().int().optional(),
  /** Present on `held`: how many participants wait behind you. */
  queueDepth: z.number().int().nonnegative().optional(),
  /** Present on `queued`: the refreshed place in line. */
  position: z.number().int().nonnegative().optional(),
});
export type ClaimHeartbeatReply = z.infer<typeof claimHeartbeatReplySchema>;

/** `POST /v1/claims/heartbeat` — one ack per lease the batch extended. */
export const claimHeartbeatBatchReplySchema = z.object({
  object: z.literal('list'),
  results: z.array(claimHeartbeatAckPayloadSchema),
});
export type ClaimHeartbeatBatchReply = z.infer<
  typeof claimHeartbeatBatchReplySchema
>;

/**
 * The query string on `GET /v1/claims` — the four questions you may ask about
 * live work, which are the same four the audit log already answers about
 * finished work.
 *
 * The names are audit's names on purpose (`routes/dashboard/audit.ts` filters on
 * `actorId`, `actorKind`, `onBehalfOfId`, `capabilityId`). Asking "everything
 * agent A is doing" and "everything agent A did" should not require learning two
 * vocabularies for one idea; the tense is the only thing that differs.
 *
 * `model` and `id` scope to a row and are the original axis. The other three
 * scope to a participant, and a request may combine them — "what is this agent
 * doing to this invoice" is both.
 *
 * Every value is optional, and an omitted filter is not a filter: a bare request
 * lists everything the caller's organization holds.
 */
export const claimListQuerySchema = z.object({
  model: z.string().optional(),
  id: z.string().optional(),
  field: z.string().optional(),
  /** Who is doing it. Matches the claim's holder. */
  actorId: z.string().optional(),
  /** Narrow to people, to agents, or to system principals. */
  actorKind: wireParticipantKindSchema.optional(),
  /**
   * Who it is being done for. The operations question — "what is running on
   * behalf of this customer right now" — which was answerable only in hindsight
   * until the claim carried its delegation.
   */
  onBehalfOfId: z.string().optional(),
  /** Which grant authorized it. */
  capabilityId: z.string().optional(),
});
export type ClaimListQuery = z.infer<typeof claimListQuerySchema>;

/**
 * `GET /v1/claims` — who holds what, and who waits.
 *
 * `queue` is populated only when the request names both a `model` and an `id`;
 * a wait line belongs to one row, so an unscoped listing has nothing to report
 * and answers with an empty array rather than omitting the field.
 */
export const claimListResponseSchema = z.object({
  object: z.literal('list'),
  claims: z.array(modelClaimSchema).readonly(),
  queue: z.array(modelClaimSchema).readonly(),
});
export type ClaimListResponse = z.infer<typeof claimListResponseSchema>;
