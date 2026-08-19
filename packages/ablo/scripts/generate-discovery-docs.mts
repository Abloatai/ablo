/**
 * Generate the public discovery descriptors from the sources that already own
 * what they say.
 *
 *   npx tsx scripts/generate-discovery-docs.mts           # write
 *   npx tsx scripts/generate-discovery-docs.mts --check   # fail if stale
 *
 * Emits into the Blume docs project at `docs/ablo/`:
 *   - public/.well-known/apis.json        the APIs.json index (apisjson.org),
 *                                         also served at `/apis.json`
 *   - public/.well-known/api-onboarding   the API Onboarding Descriptor
 *                                         (apicommons.org/onboarding)
 *
 * Run this after `generate:openapi`: the index quotes the published contract's
 * title, description, and host, so it reads that file rather than rebuilding
 * it. `--check` fails CI when either output drifts from its sources, exactly as
 * the OpenAPI and pricing references do.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, relative, resolve } from 'node:path';
import {
  APIS_JSON_PATH,
  ONBOARDING_PATH,
  parsePublishedOpenApi,
  renderApisJson,
  renderOnboardingDescriptor,
} from './discovery-docs-lib.mts';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const siteRoot = resolve(repoRoot, 'docs/ablo');

/**
 * The landing promise line, which is the one-sentence answer to "what is this"
 * everywhere it is asked. Its definition site is the blockquote under the H1 of
 * `packages/ablo/docs/index.md`, which `build:docs` lifts into this
 * frontmatter; `docs/ablo/blume.config.ts` reads it the same way for the site
 * description and `llms.txt`. Read it here rather than restate it.
 */
function landingPromise(): string {
  const mdx = readFileSync(resolve(siteRoot, 'docs/index.mdx'), 'utf8');
  const described = mdx.match(/^description: (".*")$/m);
  if (!described) {
    throw new Error(
      'docs/ablo/docs/index.mdx carries no description — run `npm run build:docs` first.',
    );
  }
  return JSON.parse(described[1]) as string;
}

const openapi = parsePublishedOpenApi(
  readFileSync(resolve(siteRoot, 'public/openapi.json'), 'utf8'),
);

const outputs = [
  { path: APIS_JSON_PATH, rendered: renderApisJson(openapi, landingPromise()) },
  { path: ONBOARDING_PATH, rendered: renderOnboardingDescriptor(openapi) },
] as const;

const check = process.argv.includes('--check');
let stale = false;

for (const { path, rendered } of outputs) {
  const target = resolve(siteRoot, 'public', path);
  const shown = relative(repoRoot, target);

  if (check) {
    const onDisk = (() => {
      try {
        return readFileSync(target, 'utf8');
      } catch {
        return null;
      }
    })();
    if (onDisk !== rendered) {
      console.error(
        `[discovery] ${shown} is stale — run \`npm run generate:discovery\` in packages/ablo and commit the result.`,
      );
      stale = true;
    } else {
      console.log(`[discovery] ${shown} matches its sources`);
    }
    continue;
  }

  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, rendered);
  console.log(`[discovery] generated ${shown}`);
}

if (stale) process.exit(1);
