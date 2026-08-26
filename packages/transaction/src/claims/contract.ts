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
import { durationSchema, parseDurationMs } from '../utils/duration.js';
import { listEnvelopeSchema } from '../wire/listEnvelope.js';
import {
  publicClaimStatusSchema,
  wireParticipantKindSchema,
  claimRecordSchema,
  modelClaimSchema,
  claimHeartbeatAckPayloadSchema,
  wireClaimSummarySchema,
} from '../coordination/schema.js';

/**
 * How long a lease runs when the caller does not ask for a length.
 *
 * One definition for both ends: the server stamps `expiresAt` with it, and the
 * client's auto-heartbeat derives its cadence from it, so a claim that names no
 * TTL beats comfortably inside the window the server actually granted.
 */
export const DEFAULT_CLAIM_TTL_MS = 60_000;

/**
 * A lease length on the wire, in the SDK's one duration grammar: a
 * unit-suffixed string (`'500ms'`, `'30s'`, `'5m'`, `'24h'`) or a bare number of
 * **seconds** — the same reading `ttlSeconds` has everywhere else in the API.
 *
 * It used to be `z.union([z.string(), z.number()])`, and the units lived only in
 * the route's private parser, which read a bare number as MILLISECONDS. So the
 * SDK computed its heartbeat cadence from one grammar while the server granted a
 * lease under another, and `ttl: 300` meant five minutes to the client and three
 * hundred milliseconds to the server. Publishing the grammar is what makes that
 * class of disagreement impossible: there is now one pattern, emitted into the
 * contract, and one parser behind it.
 */
export const claimTtlSchema = durationSchema;

/**
 * A wire TTL as milliseconds — the single reading of the grammar above.
 *
 * The server calls this rather than carrying its own parser. An absent TTL takes
 * {@link DEFAULT_CLAIM_TTL_MS}; anything present has already been validated by
 * {@link claimTtlSchema} at the boundary, so a malformed duration is a 400 at the
 * door rather than a silent one-minute lease that lapses mid-work.
 */
export function claimTtlMs(
  ttl: z.infer<typeof claimTtlSchema> | null | undefined,
): number {
  return ttl == null ? DEFAULT_CLAIM_TTL_MS : parseDurationMs(ttl);
}

/** The row a claim points at, when it is not already given by the URL. */
export const claimTargetSchema = z.object({
  model: z.string().optional(),
  id: z.string().nullish(),
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
  /** Lease length in the same grammar as a heartbeat — see {@link claimTtlSchema}. */
  ttl: claimTtlSchema.nullish(),
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
  /** Extends the lease by this much from now — see {@link claimTtlSchema}. */
  ttl: claimTtlSchema.nullish(),
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
  /**
   * Keyset cursor: the opaque `next_cursor` the previous page returned. It
   * encodes the sort position it was issued for, so it is not a row id and is
   * refused against a different `order_by`/`order`.
   */
  cursor: z.string().optional(),
  /** @deprecated The pre-0.53.0 spelling of `cursor`. Send `cursor`. */
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
  .pick({ id: true, position: true, expiresAt: true, fenceToken: true })
  .partial({ position: true, expiresAt: true, fenceToken: true })
  .extend({
    object: z.literal('claim'),
    /**
     * Widened from the record's two observable states to all five.
     *
     * A poll is the one surface that can arrive after the claim ended: the
     * caller holds an id and asks what became of it, so the terminal statuses
     * are answers this route must be able to give. A peer's listing cannot see
     * them, because a terminal claim has already left the set being listed.
     *
     * `expired` and `canceled` are answered for a few minutes after the fact,
     * long enough for a straggler poll and no longer — the ClaimLog is the
     * record, this is a courtesy. Past that window the claim is genuinely gone
     * and the route answers 404 `claim_not_found`.
     *
     * `committed` is declared and not yet answered: it needs the release path
     * to know that a write settled under the lease, which the commit path does
     * not hand back today. A caller must therefore treat the terminal statuses
     * as a set rather than switching exhaustively on the two it sees.
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
  status: z.literal('active'),
  /**
   * The lease's own fields, in the same place the poll puts them.
   *
   * They are also inside `claim`, which is the peer-visible view and carries
   * far more — actor, target, description, delegation. Mirroring the two that a
   * holder actually acts on is what lets one reader handle both answers: a
   * client that had to look in `claim.fenceToken` here and `fenceToken` on the
   * poll is reading one resource through two shapes, which is the defect this
   * response pair was just unified to remove.
   */
  fenceToken: z.number().int().optional(),
  expiresAt: z.number().int().optional(),
  claim: modelClaimSchema,
});
export type ClaimAcquiredResponse = z.infer<typeof claimAcquiredResponseSchema>;

/**
 * The same two routes, **202** — the row was already held and `queue: true`
 * put you in line. The grant arrives later on the caller's stream, or through
 * `GET /v1/claims/{claimId}`.
 *
 * Shaped as a claim resource, exactly like the 201, because that is what it is:
 * a queue entry is a lease in a different state — the reason one `DELETE`
 * serves both, and the reason the poll can move one to the other. It once
 * withheld `object` and `id` on the argument that a queued claim is not yet a
 * created resource, which read as principled and cost a caller the ability to
 * treat the two answers as one type.
 */
export const claimQueuedResponseSchema = z.object({
  id: z.string(),
  object: z.literal('claim'),
  status: z.literal('queued'),
  position: z.number().int().nonnegative(),
  heldBy: z.string().optional(),
  expiresAt: z.number().int().optional(),
  heldByClaim: wireClaimSummarySchema.optional(),
});
export type ClaimQueuedResponse = z.infer<typeof claimQueuedResponseSchema>;

/**
 * Either answer to a claim acquire — one resource, two states, told apart by
 * `status`.
 *
 * A real discriminated union, which it could not be while the arms disagreed
 * about what the handle was called (`id` on the 201, `claimId` on the 202) and
 * only one of them said `object`. `claimRecordSchema.id` states the rule both
 * now follow: `id` where the claim IS the resource, `claimId` where some other
 * object names one.
 */
export const claimAcquireResponseSchema = z.discriminatedUnion('status', [
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
 * One list in the shape every other list has, because holders and waiters are
 * the same resource in two states: each entry carries `status`, and a `queued`
 * one carries its `position`. Holders come first, then the wait line in order.
 *
 * It used to answer `{ claims[], queue[] }` — a bespoke envelope on the endpoint
 * a coordination client touches most, which cost a generated client a
 * special-cased model to read the one call it makes constantly.
 *
 * Waiters appear only when the request names both a `model` and an `id`: a wait
 * line belongs to one row, so an unscoped listing has none to report.
 */
export const claimListResponseSchema = listEnvelopeSchema(modelClaimSchema);
export type ClaimListResponse = z.infer<typeof claimListResponseSchema>;

/**
 * `POST /v1/models/{model}/{id}/claim/reorder` — re-rank the wait line.
 *
 * `claimId` rather than `id` here by the rule in {@link claimRecordSchema}: an
 * entry in this list names a claim, it is not one. The server parsed this body
 * by hand — `JSON.parse(raw) as { order?: … }`, a cast onto an inline shape at a
 * wire boundary — until it had a schema to parse against.
 */
export const claimReorderRequestSchema = z.object({
  order: z
    .array(z.object({ heldBy: z.string(), claimId: z.string() }))
    .readonly()
    .optional(),
});
export type ClaimReorderRequest = z.infer<typeof claimReorderRequestSchema>;

/** The reorder reply. */
export const claimReorderReplySchema = z.object({
  object: z.literal('claim_reorder'),
  reordered: z.boolean(),
});
export type ClaimReorderReply = z.infer<typeof claimReorderReplySchema>;

/**
 * `DELETE /v1/claims/{claimId}` and `DELETE /v1/models/{model}/{id}/claim`.
 *
 * `released` distinguishes "your lease is gone because this call ended it" from
 * "there was nothing of yours to end" — both are success, and a caller
 * retrying a release deserves to know which happened. The two routes answered
 * `{ ok: true }` and `{ ok, released }`: two shapes, neither written down, and
 * `ok` restating the status code.
 */
export const claimReleaseReplySchema = z.object({
  object: z.literal('claim_release'),
  released: z.boolean(),
});
export type ClaimReleaseReply = z.infer<typeof claimReleaseReplySchema>;
