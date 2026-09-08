import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { build } from 'esbuild';

// Resolve the built package exports exactly as a consumer does, without the
// workspace source condition, Node polyfills, aliases, or externalized imports.
for (const name of ['humans', 'transaction']) {
  const manifest = JSON.parse(readFileSync(new URL(`../../${name}/package.json`, import.meta.url)));
  assert.ok(manifest.dependencies.events, `${name} must ship its emitter dependency`);
}
const result = await build({
  stdin: { contents: "export * from '@abloatai/ablo/react';", resolveDir: process.cwd() },
  bundle: true,
  platform: 'browser',
  format: 'esm',
  write: false,
  metafile: true,
});
assert.ok(Object.keys(result.metafile.inputs).some(path => path.endsWith('/events/events.js')));
console.log('Built React entry bundles for browsers without consumer polyfills.');
