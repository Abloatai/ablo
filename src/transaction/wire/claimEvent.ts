/**
 * A claim transition, as an entry in the log feed.
 *
 * `claimRecordSchema` answers "what is true about this lease right now"; this
 * answers "what happened to it, and when". It is the fourth projection of that
 * record and is built like the other three — a `.pick` off the record, never a
 * second object — so a field added to a claim reaches this feed or fails to
 * compile.
 *
 * The transition IS the state entered, so the vocabulary is
 * {@link publicClaimStatusSchema} rather than a parallel set of verbs. An event
 * saying `active` means exactly what `active` means to a caller polling
 * `GET /v1/claims/{claimId}` — the same five states, widened from the record's
 * two for the same reason the polling shape widens them: an observer can arrive
 * after the claim ended, and `committed`, `expired`, and `canceled` are answers
 * this feed must be able to give. A claim that vanishes without one of them is
 * indistinguishable from a claim that was never made.
 *
 * Two fields are deliberately dropped from the projection, and the coverage
 * assertion below names both so neither can be dropped by forgetting:
 *
 * **`id`** — spelled `claimId` here, because this event names a claim it is not
 * itself. The same distinction the record's own comment draws.
 *
 * **`meta`** — the record calls it "presence, not a checkpoint: it dies with
 * the lease." A heartbeat's last-beat-wins progress is a live reading, and
 * writing it into a durable event would preserve, forever, whichever beat
 * happened to land last. The feed records that the lease ended, not what its
 * holder was mid-sentence about when it did.
 */

import { z } from 'zod';
import {
  claimRecordSchema,
  publicClaimStatusSchema,
  type ClaimRecord,
} from '../coordination/schema.js';
import type { AssertExact } from '../types/assertExact.js';

export const claimEventSchema = claimRecordSchema
  .omit({ id: true, meta: true })
  .partial({
    /** Absent while queued — the token is minted at grant, never at enqueue. */
    fenceToken: true,
    /** Absent once held — a holder has no place in the line. */
    position: true,
  })
  .extend({
    object: z.literal('claim_event'),
    /**
     * Position in the claim-event sequence. NOT a fence token: fence tokens
     * order by acquisition and are minted only at grant, so they cannot
     * position an enqueue, a release, or an expiry. Conflating the two would
     * break the monotonicity `claim_fence_watermark` depends on.
     */
    seq: z.number().int().nonnegative(),
    /**
     * When the transition happened, ISO-8601.
     *
     * The claim family carries epoch milliseconds everywhere else and says so
     * emphatically. This one field breaks with that on purpose: it shares an
     * envelope with {@link logEventSchema}, whose `at` is ISO, and a consumer
     * sorting the merged `data` array by `at` must not be comparing two
     * encodings. Uniformity within the envelope beats uniformity within the
     * family, because the envelope is what gets iterated.
     */
    at: z.string(),
    /** The claim named, rather than the claim as a resource. */
    claimId: z.string(),
    /** The state entered. Widened from the record's two — see the preamble. */
    status: publicClaimStatusSchema,
  })
  .readonly();
export type ClaimEvent = z.infer<typeof claimEventSchema>;

/**
 * The feed's view covers the record. A field added to a claim is either carried
 * into the feed or deliberately dropped by the `.omit` above — never missing
 * because nobody remembered the fourth projection.
 */
const _claimEventCoversRecord: AssertExact<
  Exclude<keyof ClaimEvent, 'object' | 'seq' | 'at' | 'claimId'>,
  Exclude<keyof ClaimRecord, 'id' | 'meta'>
> = true;
void _claimEventCoversRecord;
