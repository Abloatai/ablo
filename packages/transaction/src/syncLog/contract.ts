/**
 * Canonical sync-log identity and position contracts shared by client/server.
 *
 * ## A log position means ONE thing
 *
 * It is an ordinal in `sync_deltas`: a point in the single, totally ordered
 * log. Nothing else. Every number in this engine that answers "how far along"
 * is this type, and there is one definition of it, below.
 *
 * What varies is never the meaning. It is **who is making the claim**, and the
 * owner belongs in the field name, never in a second type:
 *
 * | Owner                              | Claims                                    |
 * | ---------------------------------- | ----------------------------------------- |
 * | `current_settled_sync_id()`        | nothing at or below is still in flight    |
 * | `getCommittedSyncId`               | committed, without waiting for the barrier|
 * | `sync_broadcast_cursors.published_through` | the fan-out published through     |
 * | `log_subscriptions.position`       | this participant was served through, in
 *                                        the area the same row names            |
 * | `Client.lastSentSyncId`            | this socket was offered through           |
 * | `Client.lastAckedSyncId`           | this socket confirmed through             |
 * | `LogPosition.applied`              | the client processed on arrival through   |
 * | `LogPosition.persisted`            | the client durably holds through, in
 *                                        DELIVERED order, not numeric order       |
 * | `RowWatermarks`                    | this one row reflects the log through     |
 * | `sync_state_checkpoint.up_to_sync_id` | the checkpoint folded through          |
 *
 * ## The comparison that is not safe
 *
 * `current_settled_sync_id` takes a per-plane advisory lock but reads the
 * GLOBAL sequence, so its value moves for writers in other planes. Every other
 * owner above is scoped: to a plane, a project, a recipient, or a row. "The
 * head of the log" and "how far I have been served" are therefore different
 * questions, and a scoped cursor sitting below the global head is the normal
 * resting state, not a gap.
 *
 * Treating one as the other is what left every client permanently short of its
 * own head, re-taking the plane lock on every catch-up poll
 * (docs/plans/delivery-verify-at-read.md). Before comparing two positions, say
 * out loud which owner each belongs to.
 *
 * ## The owner is a relation, not just a name
 *
 * This doc did its job on the NUMBER and could not do it for the relation that
 * holds one. `log_subscriptions.position` is the durable answer to "where is
 * this participant, in this area" (ADR 0036) — one record per
 * `(participant, area)`, with no connection axis, from which delivery and
 * liveness are projected. The two `Client` fields above are deliberately NOT
 * folded into it: they are an in-flight socket's frame accounting, which is why
 * they name a socket rather than a participant.
 *
 * The rest of the table is ENGINE-owned and stays separate on purpose. The
 * fan-out's progress, the compaction checkpoint and the settled head answer a
 * different question from "where is this participant", and collapsing them
 * would recreate the exact comparison this doc warns about.
 */

import { z } from 'zod';

/**
 * A point in the sync log. The one definition; every other position name in
 * the codebase derives from this one rather than restating the primitive.
 */
export const logPositionSchema = z.number().int().nonnegative();
export type LogPosition = z.infer<typeof logPositionSchema>;

export const clientMutationIdSchema = z.string().min(1).max(255);
export type ClientMutationId = z.infer<typeof clientMutationIdSchema>;

export const sourceCorrelationIdSchema = z.string().min(1).max(255);
export type SourceCorrelationId = z.infer<typeof sourceCorrelationIdSchema>;

export const sourceChangeIdSchema = z.string().min(1).max(512);
export type SourceChangeId = z.infer<typeof sourceChangeIdSchema>;

export const replicationLsnSchema = z.string().regex(/^[0-9A-Fa-f]+\/[0-9A-Fa-f]+$/);
export type ReplicationLSN = z.infer<typeof replicationLsnSchema>;

export const commitDispatchMarkerSchema = z.strictObject({
  kind: z.literal('sync_deltas'),
  organizationId: z.string().min(1),
  branchId: z.string().min(1),
  firstSyncId: logPositionSchema,
  lastSyncId: logPositionSchema,
}).superRefine((value, ctx) => {
  if (value.firstSyncId <= 0 || value.lastSyncId < value.firstSyncId) {
    ctx.addIssue({ code: 'custom', message: 'invalid delta position range' });
  }
});
export type CommitDispatchMarker = z.infer<typeof commitDispatchMarkerSchema>;
