import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../..', import.meta.url));
assert(process.argv[2], 'usage: pack-resource-assets.mjs <output-directory>');
const destination = resolve(process.argv[2]);
const read = name => JSON.parse(readFileSync(`${root}/packages/${name}/package.json`, 'utf8'));
assert.equal(read('resource-adapter').dependencies['@abloatai/transaction'], read('transaction').version,
  'The adapter must pin the released transaction SDK');
mkdirSync(destination, { recursive: true });
const manifest = {};
for (const [name, asset] of [['transaction', 'transaction.tgz'], ['resource-adapter', 'adapter.tgz']]) {
  const output = execFileSync('npm', ['pack', '--json', '--pack-destination', destination], {
    cwd: `${root}/packages/${name}`, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'],
  });
  const [{ filename }] = JSON.parse(output);
  renameSync(`${destination}/${filename}`, `${destination}/${asset}`);
  manifest[asset] = createHash('sha256').update(readFileSync(`${destination}/${asset}`)).digest('hex');
}
execFileSync('python3', [`${root}/packages/ablo/scripts/verify-resource-recovery.py`, `${destination}/adapter.tgz`], {
  stdio: 'inherit',
});
writeFileSync(`${destination}/manifest.json`, JSON.stringify(manifest, null, 2) + '\n');
console.log(`Resource release assets: ${destination}`);
