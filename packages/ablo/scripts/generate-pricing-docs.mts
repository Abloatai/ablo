/**
 * Generate the pricing reference from the pricing contract.
 *
 *   npx tsx scripts/generate-pricing-docs.mts
 *
 * Emits into the Blume docs project at `docs/ablo/`:
 *   - docs/ablo/docs/pricing.mdx     the published page
 *   - docs/ablo/public/pricing.json  the machine-readable card, served at
 *                                    `/pricing.json` for the marketing site and
 *                                    any tooling that quotes a price
 *
 * The contract in `@abloatai/transaction` is the single source of truth, so
 * never hand-edit pricing.mdx. `check-pricing-docs.mts` fails CI if these
 * outputs drift from it.
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { PRICING_VERSION } from '@abloatai/transaction';
import { renderPricingJson, renderPricingMdx } from './pricing-docs-lib.mts';

const siteRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../docs/ablo');

writeFileSync(resolve(siteRoot, 'docs', 'pricing.mdx'), renderPricingMdx());
writeFileSync(resolve(siteRoot, 'public', 'pricing.json'), renderPricingJson());

console.log(
  `[pricing] generated docs/ablo/docs/pricing.mdx + docs/ablo/public/pricing.json — contract ${PRICING_VERSION}`,
);
