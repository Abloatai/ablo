/**
 * Pure renderers for the pricing reference, shared by the generator
 * (generate-pricing-docs.mts, writes to disk) and the drift guard
 * (check-pricing-docs.mts, compares against disk). String in, string out, so
 * the check can prove the committed page matches the pricing contract without
 * touching anything.
 *
 * Every number on the page comes from the contract, including the worked
 * examples: the bills in the last table are `monthlyBillUsd` applied to volumes
 * read off the rate card's own ceilings. Change a rate and the examples move
 * with it, because there is nowhere to type a bill by hand.
 */
import {
  BILLABLE_METER_EVENTS,
  ERROR_CODES,
  METER_EVENT_AXIS,
  METER_EVENT_LABEL,
  OPS_RATE_CARD,
  PLANS,
  PLAN_FEATURE_LABEL,
  PLAN_ORDER,
  PRICING_VERSION,
  meterEventSchema,
  monthlyBillUsd,
  monthlyOpsAllowance,
  planFeatureSchema,
  type MeterEvent,
  type PlanFeature,
  type PlanTier,
} from '@abloatai/transaction';

/** The codes a limit surfaces as, pinned to the error registry: naming one the
 *  registry does not carry is a compile error rather than a broken doc link. */
const QUOTA_CODE = 'quota_exceeded' satisfies keyof typeof ERROR_CODES;
const CONNECTION_CODE = 'connection_limit_exceeded' satisfies keyof typeof ERROR_CODES;

/** `1000000` reads as `1M`, `49500000` as `49.5M`. Compact beats exact in a
 *  pricing table, and the machine-readable figure is in pricing.json. */
function formatOps(ops: number): string {
  const scale = (n: number, suffix: string): string => {
    const value = ops / n;
    const text = Number.isInteger(value) ? String(value) : value.toFixed(1);
    return `${text}${suffix}`;
  };
  if (ops >= 1_000_000_000) return scale(1_000_000_000, 'B');
  if (ops >= 1_000_000) return scale(1_000_000, 'M');
  if (ops >= 1_000) return scale(1_000, 'K');
  return String(ops);
}

/** Cents only where there are cents: `$99`, `$2,000`, `$0.60`. */
function formatUsd(usd: number): string {
  const whole = Number.isInteger(usd);
  return `$${usd.toLocaleString('en-US', {
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: 2,
  })}`;
}

/** A rate is always quoted to the cent, so `$2.00` and `$0.60` line up. */
function formatRate(usd: number): string {
  return `$${usd.toFixed(2)}`;
}

/** The volume band a bracket covers, as it reads in the rate card. */
function bracketBand(index: number): string {
  const bracket = OPS_RATE_CARD[index];
  if (bracket === undefined) return '';
  const floor = index === 0 ? 0 : OPS_RATE_CARD[index - 1]?.throughOps ?? 0;
  if (bracket.throughOps === null) return `Above ${formatOps(floor)}`;
  if (floor === 0) return `First ${formatOps(bracket.throughOps)}`;
  return `${formatOps(floor)} to ${formatOps(bracket.throughOps)}`;
}

/**
 * The volumes the worked examples use: one below the first ceiling, every
 * ceiling on the card, and one clearly past the last. Derived so the examples
 * keep straddling the brackets after the card is retuned.
 */
function exampleVolumes(): number[] {
  const ceilings = OPS_RATE_CARD.map((b) => b.throughOps).filter(
    (c): c is number => c !== null,
  );
  const last = ceilings[ceilings.length - 1] ?? 1_000_000;
  return [1_000_000, ...ceilings, last * 2];
}

/** What a tier bills at a volume, including the case where the tier refuses it. */
function billCell(tier: PlanTier, ops: number): string {
  const plan = PLANS[tier];
  if (plan.contractPriced) return 'Contract';
  if (plan.hardCapOps !== null && ops > plan.hardCapOps) return 'Over the cap';
  const bill = monthlyBillUsd(tier, ops);
  return bill === null ? 'Contract' : formatUsd(bill);
}

function allowanceCell(tier: PlanTier): string {
  const allowance = monthlyOpsAllowance(tier);
  return allowance === null ? 'Committed' : formatOps(allowance);
}

function floorCell(tier: PlanTier): string {
  const plan = PLANS[tier];
  if (plan.monthlyMinimumUsd === null) return 'Contract';
  if (plan.monthlyMinimumUsd === 0) return formatUsd(0);
  return plan.contractPriced
    ? `From ${formatUsd(plan.monthlyMinimumUsd)}`
    : formatUsd(plan.monthlyMinimumUsd);
}

function meteredTiers(): PlanTier[] {
  return PLAN_ORDER.filter((tier) => PLANS[tier].hardCapOps === null && !PLANS[tier].contractPriced);
}

export function renderPricingMdx(): string {
  const lines: string[] = [];
  const push = (...text: string[]): void => {
    lines.push(...text);
  };

  push('---');
  push('title: "Pricing"');
  push(
    'description: "A monthly floor, and metered sync operations charged against it. Generated from the pricing contract, so every number here is the one the invoice uses."',
  );
  push('sidebar:');
  push('  icon: receipt');
  push('---');
  push('');
  push(`Pricing version: \`${PRICING_VERSION}\`.`);
  push('');
  push(
    'You pay a monthly floor, or your metered usage, whichever is greater. Usage is charged **against** the floor rather than added to it, so an organization on Scale that sends nothing pays the floor, and one that sends four times the floor pays four times the floor. There is no separate subscription line.',
  );
  push('');

  push('## Tiers');
  push('');
  push('| | Monthly | Operations included | Per day | Connections | Storage |');
  push('| --- | --- | --- | --- | --- | --- |');
  for (const tier of PLAN_ORDER) {
    const plan = PLANS[tier];
    push(
      `| **${plan.label}** | ${floorCell(tier)} | ${allowanceCell(tier)} | ${
        plan.hardCapOpsPerDay === null ? 'No limit' : formatOps(plan.hardCapOpsPerDay)
      } | ${
        plan.maxConcurrentConnections === null
          ? 'Committed'
          : plan.maxConcurrentConnections.toLocaleString('en-US')
      } | ${plan.storageGib === null ? 'Committed' : `${plan.storageGib} GiB`} |`,
    );
  }
  push('');
  for (const tier of PLAN_ORDER) {
    push(`**${PLANS[tier].label}.** ${PLANS[tier].summary}`);
    push('');
  }
  push(
    `On ${PLANS.free.label}, ${formatOps(
      PLANS.free.hardCapOps ?? 0,
    )} operations is a hard stop: requests past it are refused rather than billed, so there is no way to run up a bill without a card. On every paid tier the figure is what the floor already covers at the rate card below, and operations past it are metered.`,
  );
  push('');
  push(
    `The daily figure on ${PLANS.free.label} is a burst guard rather than an allowance. A month of operations is roughly ten minutes of one agent running flat out, so without it a single runaway loop could spend the month in an afternoon. Paid tiers have no daily limit, because they are metered rather than stopped.`,
  );
  push('');

  // Declaration order from the contract, not the order tiers happen to mention
  // them in, so adding a feature to a tier never reshuffles the table.
  const features = (planFeatureSchema.options as readonly PlanFeature[]).filter((feature) =>
    PLAN_ORDER.some((tier) => PLANS[tier].features.includes(feature)),
  );
  if (features.length > 0) {
    push('| Included | ' + PLAN_ORDER.map((tier) => PLANS[tier].label).join(' | ') + ' |');
    push('| --- | ' + PLAN_ORDER.map(() => '---').join(' | ') + ' |');
    for (const feature of features) {
      push(
        `| ${PLAN_FEATURE_LABEL[feature]} | ` +
          PLAN_ORDER.map((tier) => (PLANS[tier].features.includes(feature) ? 'Yes' : 'No')).join(
            ' | ',
          ) +
          ' |',
      );
    }
    push('');
  }

  push('## What counts as an operation');
  push('');
  push('One number covers everything the engine does on your behalf.');
  push('');
  push('| Meter | Counts |');
  push('| --- | --- |');
  const meterCounts: Record<MeterEvent, string> = {
    'api.commit_ops': 'One per operation inside a commit. A commit that writes 500 rows counts 500.',
    'api.model_reads': 'One per read request served by the engine.',
    'api.claim_creates': 'One per claim taken. Releasing a claim is free.',
    'api.bootstraps': 'Recorded, never charged. Connecting a client is free.',
  };
  for (const meter of BILLABLE_METER_EVENTS) {
    push(`| ${METER_EVENT_LABEL[meter]} | ${meterCounts[meter]} |`);
  }
  push('');
  push(
    'A commit counts the same whether it arrived over HTTP or over the WebSocket. The transport is not part of the price.',
  );
  push('');
  push('Three rules decide whether a request is counted at all:');
  push('');
  push('1. Only successful requests count. A rejected or failed request is never metered.');
  push(
    '2. A retry with the same `Idempotency-Key` counts once. The key the SDK puts on a commit is the same key the meter deduplicates on.',
  );
  push('3. Reads a client answers from its own local copy never reach the engine, so they never count.');
  push('');

  push('## Rate card');
  push('');
  push(
    'Rates are marginal. Crossing a band reprices the operations above it and leaves the ones below it alone.',
  );
  push('');
  push('| Monthly operations | Per million |');
  push('| --- | --- |');
  OPS_RATE_CARD.forEach((bracket, index) => {
    push(`| ${bracketBand(index)} | ${formatRate(bracket.usdPerMillionOps)} |`);
  });
  push('');

  push('## What a month costs');
  push('');
  const billed = meteredTiers();
  push('| Monthly operations | ' + billed.map((tier) => PLANS[tier].label).join(' | ') + ' |');
  push('| --- | ' + billed.map(() => '---').join(' | ') + ' |');
  push(
    '| ' +
      formatOps(PLANS.free.hardCapOps ?? 1_000_000) +
      ' | ' +
      billed.map((tier) => billCell(tier, PLANS.free.hardCapOps ?? 1_000_000)).join(' | ') +
      ' |',
  );
  for (const ops of exampleVolumes()) {
    if (ops === (PLANS.free.hardCapOps ?? 1_000_000)) continue;
    push(`| ${formatOps(ops)} | ` + billed.map((tier) => billCell(tier, ops)).join(' | ') + ' |');
  }
  push('');
  push(
    `${PLANS.enterprise.label} is priced in the contract, starting at ${formatUsd(
      PLANS.enterprise.monthlyMinimumUsd ?? 0,
    )} a month, with committed volume, limits, and an uptime guarantee.`,
  );
  push('');

  push('## Quoted but not billed');
  push('');
  push(
    'Storage is a ceiling on each tier, not a meter. Concurrent connections are a cap, not a meter: a held socket is a reservation, so it is bounded rather than charged for. Neither appears on an invoice.',
  );
  push('');

  push('## Watching usage');
  push('');
  push(
    'Every metered response carries its own accounting, so you can see the position without opening a dashboard.',
  );
  push('');
  push('```http');
  push('X-Usage-Limit: 50000000');
  push('X-Usage-Used: 12480311');
  push('X-Usage-Remaining: 37519689');
  push('X-Usage-Reset: 2026-08-01T00:00:00.000Z');
  push('```');
  push('');
  push(
    `Ablo emails the organization at 80 percent of a limit and again when it is reached. Past the limit the engine returns [\`${QUOTA_CODE}\`](/errors#${QUOTA_CODE}), and past the connection cap [\`${CONNECTION_CODE}\`](/errors#${CONNECTION_CODE}). Both are retryable, once the period rolls over, the limit is raised, or other connections drain.`,
  );
  push('');
  push(
    'Requests authenticated by a browser session are never counted against a quota. Only API key traffic is metered and gated.',
  );
  push('');

  return lines.join('\n');
}

export function renderPricingJson(): string {
  const spec = {
    $generated: 'packages/ablo/scripts/generate-pricing-docs.mts',
    version: PRICING_VERSION,
    currency: 'USD',
    billing: 'monthly floor or metered usage, whichever is greater',
    meters: (meterEventSchema.options as readonly MeterEvent[]).map((event) => ({
      event,
      label: METER_EVENT_LABEL[event],
      axis: METER_EVENT_AXIS[event],
    })),
    rateCard: OPS_RATE_CARD.map((bracket) => ({
      throughOps: bracket.throughOps,
      usdPerMillionOps: bracket.usdPerMillionOps,
    })),
    tiers: PLAN_ORDER.map((tier) => {
      const plan = PLANS[tier];
      return {
        tier,
        label: plan.label,
        summary: plan.summary,
        monthlyMinimumUsd: plan.monthlyMinimumUsd,
        contractPriced: plan.contractPriced,
        hardCapOps: plan.hardCapOps,
        hardCapOpsPerDay: plan.hardCapOpsPerDay,
        monthlyOpsAllowance: monthlyOpsAllowance(tier),
        maxConcurrentConnections: plan.maxConcurrentConnections,
        storageGib: plan.storageGib,
        features: plan.features,
      };
    }),
    examples: exampleVolumes().map((ops) => ({
      ops,
      billUsd: Object.fromEntries(
        meteredTiers().map((tier) => [
          tier,
          PLANS[tier].hardCapOps !== null && ops > (PLANS[tier].hardCapOps ?? 0)
            ? null
            : monthlyBillUsd(tier, ops),
        ]),
      ),
    })),
  };
  return JSON.stringify(spec, null, 2) + '\n';
}
