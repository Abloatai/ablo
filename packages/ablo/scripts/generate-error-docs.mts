/**
 * Generate the error reference from the canonical registry.
 *
 *   npx tsx scripts/generate-error-docs.mts
 *
 * Emits into the Blume docs project at `docs/ablo/`:
 *   - docs/ablo/docs/errors.mdx     human reference (one anchor per code; the
 *                                   target of every error's `doc_url`)
 *   - docs/ablo/public/errors.json  machine spec consumed by tooling / SDKs,
 *                                   served as a static asset at `/errors.json`
 *
 * The registry is the single source of truth — never hand-edit errors.mdx.
 * `check-error-docs.mts` fails CI if these outputs drift from the registry.
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { renderErrorsJson, renderErrorsMdx, totalCodeCount, wireCodeCount } from './error-docs-lib.mts';

const siteRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../docs/ablo');

writeFileSync(resolve(siteRoot, 'docs', 'errors.mdx'), renderErrorsMdx());
writeFileSync(resolve(siteRoot, 'public', 'errors.json'), renderErrorsJson());

const total = totalCodeCount();
const wire = wireCodeCount();
console.log(
  `[errors] generated docs/ablo/docs/errors.mdx + docs/ablo/public/errors.json — ${total} codes (${wire} wire, ${total - wire} client)`,
);
