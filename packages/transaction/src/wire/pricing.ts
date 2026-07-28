/**
 * The pricing vocabulary that crosses the wire: the tier names, the meter
 * names, and the shape of one rate-card step. Account responses carry these,
 * so they live in the dependency-free wire layer; the pricing contract
 * (`../pricing.ts`) derives the rate card, the plans, and the bill arithmetic
 * from them and re-exports them for its consumers.
 */
import { z } from 'zod';

export const planTierSchema = z.enum(['free', 'scale', 'enterprise']);
export type PlanTier = z.infer<typeof planTierSchema>;

/**
 * Every meter the engine records, over any transport. This is the closed set
 * behind the loose `eventName` strings that `UsageRecorder` and the quota gate
 * pass around.
 *
 * Recording and pricing are separate questions. A meter exists so usage can be
 * gated and attributed; whether it reaches an invoice is `METER_EVENT_AXIS`.
 * Bootstraps are recorded and quota-gated but deliberately unpriced: a bootstrap
 * is what a client does once to become useful, and charging for it would price
 * the act of connecting.
 */
export const meterEventSchema = z.enum([
  'api.commit_ops',
  'api.model_reads',
  'api.claim_creates',
  'api.bootstraps',
]);
export type MeterEvent = z.infer<typeof meterEventSchema>;

/**
 * One step of the rate card. `throughOps` is the cumulative ceiling the rate
 * applies up to, and `null` marks the final, unbounded step. Rates are marginal:
 * crossing a ceiling reprices the operations above it, never the ones below.
 */
export const rateBracketSchema = z.object({
  throughOps: z.number().int().positive().nullable(),
  usdPerMillionOps: z.number().nonnegative(),
});
export type RateBracket = z.infer<typeof rateBracketSchema>;
