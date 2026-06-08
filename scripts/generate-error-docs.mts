/**
 * Generate the error reference from the canonical registry.
 *
 *   npx tsx scripts/generate-error-docs.mts
 *
 * Emits into the Mintlify docs project:
 *   - docs/ablo/errors.mdx   human reference (one anchor per code; the target
 *                            of every error's `doc_url`)
 *   - docs/ablo/errors.json  machine spec consumed by tooling / SDKs
 *
 * The registry is the single source of truth — never hand-edit errors.mdx.
 * `check-error-docs.mts` fails CI if these outputs drift from the registry.
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { renderErrorsJson, renderErrorsMdx, totalCodeCount, wireCodeCount } from './error-docs-lib.mts';

const docsDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../../docs/ablo');

writeFileSync(resolve(docsDir, 'errors.mdx'), renderErrorsMdx());
writeFileSync(resolve(docsDir, 'errors.json'), renderErrorsJson());

const total = totalCodeCount();
const wire = wireCodeCount();
console.log(
  `[errors] generated docs/ablo/errors.mdx + errors.json — ${total} codes (${wire} wire, ${total - wire} client)`,
);
