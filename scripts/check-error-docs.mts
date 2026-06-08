/**
 * Drift guard for the generated error reference.
 *
 *   npx tsx scripts/check-error-docs.mts   (npm run lint:errors)
 *
 * Re-renders the docs from the registry in memory and compares against the
 * committed files. Exits non-zero if they differ — i.e. someone changed
 * ERROR_CODES without running `npm run generate:errors`. This is what keeps
 * the docs / OpenAPI / SDK from silently lying about the contract.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { renderErrorsJson, renderErrorsMdx } from './error-docs-lib.mts';

const docsDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../../docs/ablo');

const checks: { file: string; expected: string }[] = [
  { file: 'errors.mdx', expected: renderErrorsMdx() },
  { file: 'errors.json', expected: renderErrorsJson() },
];

let stale = false;
for (const { file, expected } of checks) {
  let actual: string;
  try {
    actual = readFileSync(resolve(docsDir, file), 'utf8');
  } catch {
    console.error(`[errors] MISSING docs/ablo/${file} — run \`npm run generate:errors\``);
    stale = true;
    continue;
  }
  if (actual !== expected) {
    console.error(`[errors] STALE docs/ablo/${file} — run \`npm run generate:errors\` and commit the result`);
    stale = true;
  }
}

if (stale) process.exit(1);
console.log('[errors] docs/ablo/errors.{mdx,json} are in sync with the registry');
