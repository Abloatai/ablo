/**
 * What `GET /v1/logs` returns: one envelope, two arms.
 *
 * The feed answers two questions that a caller without a socket cannot
 * otherwise ask — "what changed" and "who is working on what" — and it answers
 * them through one endpoint, one envelope, and one cursor grammar rather than
 * growing a second feed with its own pagination dialect beside the first.
 *
 * The arms stay separately sequenced. A claim is a lease, not a settled fact,
 * and putting one into the log that clients materialize rows from — and that
 * WAL-echo promotion and compaction operate over — would make a claim-churn
 * storm indistinguishable from committed change. They share a reading, not a
 * sequence; {@link FeedCursor} is what carries both positions.
 */

import { z } from 'zod';
import { logEventSchema, type LogEvent } from './accountResponses.js';
import { claimEventSchema, type ClaimEvent } from './claimEvent.js';
import { listEnvelopeSchema, type ListEnvelope } from './listEnvelope.js';

/**
 * One entry, from either source. Discriminated on `object`, so a consumer
 * reading an arm it does not know still parses the page and can skip the entry
 * — which is what lets the claim arm be added to a running feed at all.
 */
export const feedEventSchema = z.discriminatedUnion('object', [
  logEventSchema,
  claimEventSchema,
]);
export type FeedEvent = LogEvent | ClaimEvent;

/** `GET /v1/logs` — the canonical list envelope over the feed. */
export const logListResponseSchema = listEnvelopeSchema(feedEventSchema);
export type LogListResponse = ListEnvelope<FeedEvent>;

/**
 * The claim arm has no producer yet: claim transitions are broadcast today and
 * recorded nowhere, so there is no sequence to read `seq` from. Until that log
 * exists the route emits only `log_event`s, and there is deliberately NO
 * request parameter for selecting arms — a knob that cannot be honoured is how
 * a contract comes to describe a server that does not exist.
 *
 * What is here is the definition the producer will fill: the union parses
 * today's pages unchanged, and the cursor already carries the second position.
 */

