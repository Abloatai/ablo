/**
 * Generate the published OpenAPI reference from the wire schemas.
 *
 *   npx tsx scripts/generate-openapi.mts           # write
 *   npx tsx scripts/generate-openapi.mts --check   # fail if the file is stale
 *
 * Emits `docs/ablo/public/openapi.json`, served as a static asset at
 * `/openapi.json` — the document a non-TypeScript client is generated from.
 *
 * Until this existed, that file was hand-committed and nothing regenerated it,
 * so it drifted from `abloOpenApi()` without anything noticing: it described a
 * `/v1/usage` the reference does not emit, and omitted `GET /v1/claims/{claimId}`
 * — the poll a queued caller learns its grant from. A client built from the
 * published contract would have had no way to wait its turn.
 *
 * That is the failure this file removes. The reference derives from the same Zod
 * schemas the server validates against, and `--check` fails CI when the emitted
 * document and the committed one disagree, exactly as the error reference does.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, relative, resolve } from 'node:path';
// Straight from the definition site, and run under `--conditions=@ablo/source`
// so it reads `packages/transaction/src` rather than a `dist` that may lag the
// schemas by a build — which would publish a contract for the previous commit.
import { abloOpenApi } from '@abloatai/transaction/schema/openapi';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const target = resolve(repoRoot, 'docs/ablo/public/openapi.json');
const packageManifest = JSON.parse(
  readFileSync(resolve(repoRoot, 'packages/ablo/package.json'), 'utf8'),
) as { version: string };

/**
 * The hosted API, and localhost beside it.
 *
 * Both entries are load-bearing for the reader this file is written for: the
 * `/api` suffix is where every `/v1` route actually lives, and a generated
 * client that drops it 404s on its first call.
 */
const rendered = `${JSON.stringify(
  {
    ...abloOpenApi({ title: 'Ablo API', version: packageManifest.version }),
    servers: [
      { url: 'https://api.abloatai.com/api', description: 'Production' },
      { url: 'http://localhost:8787/api', description: 'Local development' },
    ],
  },
  null,
  2,
)}\n`;

const check = process.argv.includes('--check');
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
      `[openapi] ${shown} is stale — run \`npm run generate:openapi\` in packages/ablo and commit the result.`,
    );
    process.exit(1);
  }
  console.log(`[openapi] ${shown} matches the wire schemas`);
} else {
  writeFileSync(target, rendered);
  const paths = Object.keys((JSON.parse(rendered) as { paths: object }).paths).length;
  console.log(`[openapi] generated ${shown} — ${paths} paths`);
}
