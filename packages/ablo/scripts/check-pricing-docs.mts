/**
 * Drift guard for the generated pricing reference.
 *
 *   npx tsx scripts/check-pricing-docs.mts   (npm run lint:pricing)
 *
 * Re-renders the page from the pricing contract in memory and compares against
 * the committed files. Exits non-zero if they differ, which is what a rate or a
 * tier changed without `npm run generate:pricing` looks like. A published price
 * that no longer matches the invoice is the failure this exists to prevent.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { renderPricingJson, renderPricingMdx } from './pricing-docs-lib.mts';

const siteRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../docs/ablo');

const checks: { file: string; expected: string }[] = [
  { file: 'docs/pricing.mdx', expected: renderPricingMdx() },
  { file: 'public/pricing.json', expected: renderPricingJson() },
];

let stale = false;
for (const { file, expected } of checks) {
  let actual: string;
  try {
    actual = readFileSync(resolve(siteRoot, file), 'utf8');
  } catch {
    console.error(`[pricing] MISSING docs/ablo/${file} — run \`npm run generate:pricing\``);
    stale = true;
    continue;
  }
  if (actual !== expected) {
    console.error(
      `[pricing] STALE docs/ablo/${file} — run \`npm run generate:pricing\` and commit the result`,
    );
    stale = true;
  }
}

if (stale) process.exit(1);
console.log(
  '[pricing] docs/ablo/docs/pricing.mdx + docs/ablo/public/pricing.json are in sync with the pricing contract',
);
