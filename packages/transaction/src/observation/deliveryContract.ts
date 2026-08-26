/**
 * What `GET /v1/logs/delivery` answers: of the changes this plane recorded,
 * how many could reach anyone.
 *
 * The engine already knows. A delta whose `sync_groups` is empty is an upstream
 * invariant violation — `buildDeltaSyncGroups` guarantees at least one group —
 * so the fan-out excludes it from delivery, counts it, and warns. All three land
 * on Ablo's side of the boundary. The row is in the customer's database, the
 * commit confirmed, every configuration check green, and nobody is told. This
 * response moves that fact to the side the person debugging it is standing on.
 *
 * Counts and one sample, never row data: `model` and `id` are what the warning
 * already names, and they are what turns "realtime is broken" into a row to look
 * at.
 */

import { z } from 'zod';

/** The model and row of one undeliverable change — enough to find it, no more. */
export const deliverySampleSchema = z.object({
  model: z.string(),
  id: z.string(),
  at: z.string(),
});
export type DeliverySample = z.infer<typeof deliverySampleSchema>;

/**
 * `GET /v1/logs/delivery` — the plane's fan-out verdict over a fixed recent
 * window.
 *
 * `recorded` and `unroutable` are the verdict and always present. `sample` is
 * optional in the reader's stance the rest of this surface takes: a deployment
 * that omits it must still be readable, because refusing to parse would refuse
 * the diagnosis along with it.
 */
export const logDeliveryResponseSchema = z.object({
  object: z.literal('log_delivery').optional(),
  /** The window the counts cover, so a reader never hardcodes it. */
  window_seconds: z.number(),
  /** Deltas this plane recorded in the window. */
  recorded: z.number(),
  /** Of those, the ones excluded from delivery for having no sync group. */
  unroutable: z.number(),
  /** The most recent undeliverable change, when there is one. */
  sample: deliverySampleSchema.nullable().optional(),
});
export type LogDeliveryResponse = z.infer<typeof logDeliveryResponseSchema>;
