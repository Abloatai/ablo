/**
 * What Ablo costs, expressed as arithmetic rather than as a table someone
 * retypes. This module owns the price: the tiers, the rate card the meter is
 * charged against, and the functions that turn a month of usage into a bill.
 * The published pricing page, the plan seeds, and the runtime caps all derive
 * from here; nothing restates it.
 *
 * The shape has three parts, and each one exists because a different cost does.
 *
 *   - A monthly floor per tier. Serving an organization costs money before it
 *     sends a single request: a lane of the commit engine, a replication reader
 *     per registered source, and the log it appends to. The floor pays for that
 *     standing capacity, and usage is charged against it rather than added to
 *     it. An organization pays the greater of the two, never both.
 *   - A metered rate on `ops`, the one number that collapses commits, reads,
 *     and claim creates. Marginal service is cheap enough that a second axis
 *     would buy precision nobody wants: at the measured 79.5 microseconds of
 *     CPU per delta, a vCPU-hour serves roughly 45 million of them. The cost
 *     that scales is the log those operations leave behind, and it scales with
 *     all three of them together.
 *   - A concurrent-connection cap, which is a limit and not a meter. A held
 *     socket is a real reservation whether or not it is busy, so it is bounded
 *     rather than billed.
 *
 * The allowance a tier advertises is DERIVED, never stored: "the floor covers
 * 49.5M operations" is {@link opsForUsd} applied to the floor. Storing it
 * alongside the floor is how a published price silently stops matching the
 * invoice, because raising one number does not fail anything that pins the
 * other.
 *
 * Storage is deliberately absent from {@link billableAxisSchema}. It is a real
 * recurring cost and it is quoted per tier as a ceiling, but no per-organization
 * bytes sampler emits it yet, and pricing a dimension nothing measures would be
 * a claim the invoice cannot support. Add the axis when the sampler ships.
 */

import { z } from 'zod';
import { meterEventSchema, planTierSchema, rateBracketSchema } from './wire/pricing.js';
import type { MeterEvent, PlanTier, RateBracket } from './wire/pricing.js';

export { meterEventSchema, planTierSchema, rateBracketSchema };
export type { MeterEvent, PlanTier, RateBracket };

/**
 * The version of the pricing contract: the tiers, the rate card, and the way a
 * bill is computed from them. Date-based, and changed only when a customer
 * could observe the difference. It is emitted into the generated pricing
 * documentation so a stale copy is identifiable on sight.
 */
export const PRICING_VERSION = '2026-07-27';

/**
 * Resolve a stored plan string (`stripe_subscription.plan`) to a tier.
 *
 * Anything unrecognized resolves to `free` rather than throwing, so an unknown
 * plan degrades to the safest caps instead of taking down the request path.
 *
 * There are deliberately no aliases. A name this enum does not carry belongs to
 * some other product's tier vocabulary, and translating it here is how one
 * product's subscription came to grant another product's entitlements. The
 * caller filters to plans this contract names; see `resolveOrgTier`.
 */
export function toPlanTier(plan: string | null | undefined): PlanTier {
  const raw = (plan ?? 'free').trim().toLowerCase();
  return planTierSchema.catch('free').parse(raw);
}

/**
 * The axes a bill is actually computed from: `ops` is metered, `connections` is
 * capped. Storage is quoted but not billed, so it is not here.
 */
export const billableAxisSchema = z.enum(['ops', 'connections']);
export type BillableAxis = z.infer<typeof billableAxisSchema>;

/** Which billable axis each meter rolls into. `null` is recorded but unpriced. */
export const METER_EVENT_AXIS: Record<MeterEvent, BillableAxis | null> = {
  'api.commit_ops': 'ops',
  'api.model_reads': 'ops',
  'api.claim_creates': 'ops',
  'api.bootstraps': null,
};

/** How each meter reads on an invoice line and in the pricing table. */
export const METER_EVENT_LABEL: Record<MeterEvent, string> = {
  'api.commit_ops': 'commit operations',
  'api.model_reads': 'model reads',
  'api.claim_creates': 'claim creates',
  'api.bootstraps': 'bootstraps',
};

/** The meters a customer is charged for, in declaration order. */
export const BILLABLE_METER_EVENTS: readonly MeterEvent[] = (
  meterEventSchema.options as readonly MeterEvent[]
).filter((event) => METER_EVENT_AXIS[event] !== null);

export const planFeatureSchema = z.enum([
  'sso',
  'auditExport',
  'cmek',
  'privateNetworking',
  'customCaps',
]);
export type PlanFeature = z.infer<typeof planFeatureSchema>;

/** How each feature reads on the pricing page. */
export const PLAN_FEATURE_LABEL: Record<PlanFeature, string> = {
  sso: 'Single sign-on',
  auditExport: 'Audit log export',
  cmek: 'Customer-managed encryption keys',
  privateNetworking: 'Private networking',
  customCaps: 'Custom limits',
};

/**
 * The rate card, validated as a card rather than as three unrelated objects:
 * ceilings ascend, rates never increase as volume grows, and exactly one
 * unbounded step closes it. A malformed card fails at module load, which is the
 * only moment it can fail safely.
 */
const rateCardSchema = z
  .array(rateBracketSchema)
  .min(1)
  .superRefine((brackets, ctx) => {
    let previousCeiling = 0;
    let previousRate = Number.POSITIVE_INFINITY;
    brackets.forEach((bracket, index) => {
      const isLast = index === brackets.length - 1;
      if (isLast !== (bracket.throughOps === null)) {
        ctx.addIssue({
          code: 'custom',
          message: `bracket ${index}: only the final bracket may be unbounded`,
        });
        return;
      }
      if (bracket.throughOps !== null) {
        if (bracket.throughOps <= previousCeiling) {
          ctx.addIssue({
            code: 'custom',
            message: `bracket ${index}: ceiling ${bracket.throughOps} does not exceed ${previousCeiling}`,
          });
        }
        previousCeiling = bracket.throughOps;
      }
      if (bracket.usdPerMillionOps > previousRate) {
        ctx.addIssue({
          code: 'custom',
          message: `bracket ${index}: rate rises with volume`,
        });
      }
      previousRate = bracket.usdPerMillionOps;
    });
  });

/**
 * The published rate card for sync operations. These numbers are the tunable
 * knob; the bracket structure is the contract.
 */
export const OPS_RATE_CARD: readonly RateBracket[] = rateCardSchema.parse([
  { throughOps: 50_000_000, usdPerMillionOps: 2.0 },
  { throughOps: 500_000_000, usdPerMillionOps: 1.2 },
  { throughOps: null, usdPerMillionOps: 0.6 },
]);

/**
 * A tier. `null` on a floor, a cap, or a quota means negotiated rather than
 * unlimited, and the runtime treats it as "no typed default, use the operator's
 * configured value".
 */
export const planDefinitionSchema = z.object({
  tier: planTierSchema,
  label: z.string(),
  /** One line on the pricing page saying who the tier is for. */
  summary: z.string(),
  /**
   * The monthly floor in USD. Usage is charged against it, not added to it, so
   * an organization pays this or its metered usage, whichever is greater.
   * `null` means the floor is set in the contract.
   */
  monthlyMinimumUsd: z.number().nonnegative().nullable(),
  /**
   * A hard monthly stop on operations. Set only where the tier is not billed at
   * all: Free is capped rather than metered, so exceeding it is refused instead
   * of invoiced. `null` on every metered tier.
   */
  hardCapOps: z.number().int().positive().nullable(),
  /**
   * A hard daily stop, which is a burst guard rather than an allowance. A month
   * of operations is a comfortable month of building and about ten minutes of
   * one agent at full rate, so a monthly cap alone lets a runaway loop erase the
   * whole month before anyone notices. The daily figure is what turns that into
   * a floor on how fast the month can be spent. `null` on metered tiers, which
   * are billed rather than stopped.
   */
  hardCapOpsPerDay: z.number().int().positive().nullable(),
  /** Quoted ceiling on stored data, in GiB. Not billed. `null` is negotiated. */
  storageGib: z.number().positive().nullable(),
  /** Hard concurrent-connection cap, the real Free to Scale boundary. */
  maxConcurrentConnections: z.number().int().positive().nullable(),
  /** True when the terms are set in a contract rather than published in full. */
  contractPriced: z.boolean(),
  features: z.array(planFeatureSchema),
});
export type PlanDefinition = z.infer<typeof planDefinitionSchema>;

export const PLANS = z
  .object({
    free: planDefinitionSchema,
    scale: planDefinitionSchema,
    enterprise: planDefinitionSchema,
  })
  .parse({
    free: {
      tier: 'free',
      label: 'Free',
      summary: 'Build against the real engine without a card.',
      monthlyMinimumUsd: 0,
      hardCapOps: 1_000_000,
      hardCapOpsPerDay: 100_000,
      storageGib: 1,
      maxConcurrentConnections: 25,
      contractPriced: false,
      features: [],
    },
    scale: {
      tier: 'scale',
      label: 'Scale',
      summary: 'Production traffic, metered above a monthly floor.',
      monthlyMinimumUsd: 99,
      hardCapOps: null,
      hardCapOpsPerDay: null,
      storageGib: 50,
      maxConcurrentConnections: 1_000,
      contractPriced: false,
      features: ['auditExport'],
    },
    enterprise: {
      tier: 'enterprise',
      label: 'Enterprise',
      summary: 'Committed volume, private networking, and an uptime guarantee.',
      monthlyMinimumUsd: 2_000,
      hardCapOps: null,
      hardCapOpsPerDay: null,
      storageGib: null,
      maxConcurrentConnections: null,
      contractPriced: true,
      features: ['sso', 'auditExport', 'cmek', 'privateNetworking', 'customCaps'],
    },
  }) satisfies Record<PlanTier, PlanDefinition>;

/** The tiers in the order they are presented, cheapest first. */
export const PLAN_ORDER: readonly PlanTier[] = ['free', 'scale', 'enterprise'];

/** Round to whole cents. Money that is not rounded at the boundary is money
 *  that disagrees with the invoice by a fraction nobody can explain. */
function roundUsd(usd: number): number {
  return Math.round(usd * 100) / 100;
}

/**
 * What a month of `ops` costs at the rate card, before any floor is applied.
 * Marginal across brackets: the first 50 million are charged at the first rate
 * whatever the total turns out to be.
 */
export function usdForOps(ops: number): number {
  if (!Number.isFinite(ops) || ops <= 0) return 0;
  let remaining = ops;
  let previousCeiling = 0;
  let usd = 0;
  for (const bracket of OPS_RATE_CARD) {
    const span =
      bracket.throughOps === null
        ? Number.POSITIVE_INFINITY
        : bracket.throughOps - previousCeiling;
    const charged = Math.min(remaining, span);
    usd += (charged / 1_000_000) * bracket.usdPerMillionOps;
    remaining -= charged;
    if (remaining <= 0) break;
    if (bracket.throughOps !== null) previousCeiling = bracket.throughOps;
  }
  return roundUsd(usd);
}

/**
 * The inverse: how many operations a given spend buys at the rate card. This is
 * what turns a floor into the allowance a tier advertises, which is why the
 * allowance can never drift from the floor.
 */
export function opsForUsd(usd: number): number {
  if (!Number.isFinite(usd) || usd <= 0) return 0;
  let remaining = usd;
  let previousCeiling = 0;
  let ops = 0;
  for (const bracket of OPS_RATE_CARD) {
    const span =
      bracket.throughOps === null
        ? Number.POSITIVE_INFINITY
        : bracket.throughOps - previousCeiling;
    if (bracket.usdPerMillionOps === 0) return Number.POSITIVE_INFINITY;
    const spanCost = (span / 1_000_000) * bracket.usdPerMillionOps;
    if (remaining <= spanCost) {
      return Math.floor(ops + (remaining / bracket.usdPerMillionOps) * 1_000_000);
    }
    ops += span;
    remaining -= spanCost;
    if (bracket.throughOps !== null) previousCeiling = bracket.throughOps;
  }
  return Math.floor(ops);
}

/**
 * The operations a tier includes, as shown on the pricing page. A capped tier
 * shows its cap; a metered tier shows what its floor covers, computed from the
 * floor rather than stored beside it. `null` where the terms are contractual.
 */
export function monthlyOpsAllowance(tier: PlanTier): number | null {
  const plan = PLANS[tier];
  if (plan.hardCapOps !== null) return plan.hardCapOps;
  if (plan.contractPriced || plan.monthlyMinimumUsd === null) return null;
  return opsForUsd(plan.monthlyMinimumUsd);
}

/**
 * The invoice for a month: the floor, or the metered usage, whichever is
 * greater. A capped tier is never billed above its floor because the cap is
 * enforced before the usage exists. `null` where the terms are contractual.
 */
export function monthlyBillUsd(tier: PlanTier, ops: number): number | null {
  const plan = PLANS[tier];
  if (plan.contractPriced || plan.monthlyMinimumUsd === null) return null;
  if (plan.hardCapOps !== null) return plan.monthlyMinimumUsd;
  return roundUsd(Math.max(plan.monthlyMinimumUsd, usdForOps(ops)));
}

/**
 * The daily operations cap for a tier: the typed default the quota gate falls
 * back to when no `plan_limit` row sets one. `null` means the tier is metered
 * rather than stopped.
 */
export function dailyOpsCapForTier(tier: PlanTier): number | null {
  return PLANS[tier].hardCapOpsPerDay;
}

/**
 * The concurrent-connection cap for a tier: the typed default the Hub's
 * resolver falls back to when no `plan_limit` override row exists. `null` means
 * negotiated, which the Hub reads as its configured floor.
 */
export function connectionCapForTier(tier: PlanTier): number | null {
  return PLANS[tier].maxConcurrentConnections;
}
