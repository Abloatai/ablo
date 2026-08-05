/**
 * The body of a model-scoped write — `POST /v1/models/{model}`,
 * `PATCH /v1/models/{model}/{id}`, `DELETE /v1/models/{model}/{id}`.
 *
 * The record travels in `data`, and everything else is a control field beside
 * it rather than inside it. That separation is the point: a row with a column
 * called `claim` or `readAt` is not a reason for a write to stop being guarded,
 * and a flat body would make the two indistinguishable.
 *
 * This lived in `routes/commit.ts` and the published reference described these
 * routes as taking a bare row — so a client built from the document sent the
 * record flat, and every field of it went missing at once. The failure surfaced
 * as `not_null_violation` from the column, which reads as a schema problem
 * rather than an envelope one. One definition, derived, is what stops that:
 * the server validates against this and the reference is generated from it.
 */

import { z } from 'zod';
import {
  onStaleModeSchema,
  MAX_READ_SET_ENTRIES,
  readDependencyListSchema,
  readSetProjectionEntryCount,
  readSetWatermarkSchema,
  trackDependencyListSchema,
} from '../coordination/schema.js';

export const modelMutationRequestSchema = z.object({
  /** The record. Its shape is your schema's; everything around it is protocol. */
  data: z.record(z.string(), z.unknown()).nullish(),
  /**
   * The row id.
   *
   * On `POST` this is where it comes from, and it is **yours to choose** —
   * Ablo mints none. Derive it as UUID v5 of `"<model>:<Idempotency-Key>"` in
   * namespace `aa4ba6d4-bf0b-5b38-9c45-116f79a6e548` and a retry after a lost
   * response inserts the same id, colliding with the original rather than
   * writing a second row — with no server state to consult, so it holds across
   * instances and outlives any idempotency record.
   *
   * On `PATCH` and `DELETE` the path names the row and this is redundant.
   */
  id: z.string().nullish(),
  /** The claim this write is made under — a claim id you hold. */
  claim: z.string().nullish(),
  /** What to do when the row moved since `readAt`. Defaults to rejecting. */
  onStale: onStaleModeSchema.nullish(),
  /**
   * The watermark this write's decision was made against — the `stamp` from
   * the read. Ablo rejects the write if the row moved in between, which is
   * what makes read → decide → write safe without a lock across the deciding.
   */
  readAt: readSetWatermarkSchema.nullish(),
  /** Commit-lifetime dependencies checked with the single model operation. */
  reads: readDependencyListSchema.nullish(),
  /** Durable dependencies registered with the single model operation. */
  track: trackDependencyListSchema.nullish(),
  /**
   * The fencing token from the claim's grant. Closes the window `readAt` alone
   * cannot: a lease that lapsed and whose successor came and went.
   */
  fenceToken: z.number().nullish(),
  /** @compat HTTP idempotency belongs in the `Idempotency-Key` header. */
  idempotencyKey: z.string().optional(),
}).refine((value) => readSetProjectionEntryCount(value) <= MAX_READ_SET_ENTRIES, {
  path: ['reads'],
  message: `reads and track may contain at most ${MAX_READ_SET_ENTRIES} entries combined`,
});
export type ModelMutationRequest = z.infer<typeof modelMutationRequestSchema>;
