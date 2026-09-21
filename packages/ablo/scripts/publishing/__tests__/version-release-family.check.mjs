import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const script = fileURLToPath(new URL('../../version-release-family.mjs', import.meta.url));
/** @type {(path: string, value: unknown) => void} */
const writeJson = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
/** @type {(path: string) => { version: string, peerDependencies?: Record<string, string> }} */
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));

/**
 * A two-member fixed group whose CLI pins an exact SDK peer, as the real one does.
 * @param {import('node:test').TestContext} t
 * @param {{ bump: Record<string, string>, sdkPeers?: Record<string, string> }} options
 */
function workspace(t, { bump, sdkPeers = {} }) {
  const root = mkdtempSync(join(tmpdir(), 'release-family-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  /** @type {(dir: string, json: unknown) => void} */
  const pkg = (dir, json) => {
    mkdirSync(join(root, 'packages', dir), { recursive: true });
    writeJson(join(root, 'packages', dir, 'package.json'), json);
  };
  writeJson(join(root, 'package.json'), { name: 'root', private: true, workspaces: ['packages/*'] });
  mkdirSync(join(root, '.changeset'));
  writeJson(join(root, '.changeset/config.json'), {
    changelog: false, commit: false, fixed: [['@abloatai/ablo', '@abloatai/cli']], linked: [],
    access: 'public', baseBranch: 'main', updateInternalDependencies: 'patch', ignore: [],
  });
  writeFileSync(join(root, '.changeset/next.md'), `---\n${Object.entries(bump)
    .map(([name, type]) => `"${name}": ${type}`).join('\n')}\n---\n\nNext release.\n`);
  pkg('ablo', { name: '@abloatai/ablo', version: '0.65.0', peerDependencies: sdkPeers });
  pkg('cli', {
    name: '@abloatai/cli', version: '0.65.0',
    peerDependencies: { '@abloatai/ablo': '0.65.0' },
    peerDependenciesMeta: { '@abloatai/ablo': { optional: true } },
  });
  pkg('outside', { name: 'outside', version: '0.1.0' });
  return root;
}

/** @type {(root: string) => import('node:child_process').SpawnSyncReturns<string>} */
const run = (root) => spawnSync(process.execPath, [script, root], { encoding: 'utf8' });
/** @type {(root: string, dir: string) => ReturnType<typeof readJson>} */
const manifest = (root, dir) => readJson(join(root, 'packages', dir, 'package.json'));

test('a declared minor stays minor and the CLI peer follows it', (t) => {
  const root = workspace(t, { bump: { '@abloatai/ablo': 'minor' } });
  const result = run(root);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(manifest(root, 'ablo').version, '0.66.0');
  assert.equal(manifest(root, 'cli').version, '0.66.0');
  assert.deepEqual(manifest(root, 'cli').peerDependencies, { '@abloatai/ablo': '0.66.0' });
});

test('a declared major is honoured', (t) => {
  const root = workspace(t, { bump: { '@abloatai/ablo': 'major' } });
  assert.equal(run(root).status, 0);
  assert.equal(manifest(root, 'cli').peerDependencies?.['@abloatai/ablo'], '1.0.0');
});

test('an undeclared major from a peer outside the group is refused', (t) => {
  const root = workspace(t, { bump: { outside: 'minor' }, sdkPeers: { outside: '0.1.0' } });
  const result = run(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /no changeset declares a major release/);
  assert.equal(manifest(root, 'cli').peerDependencies?.['@abloatai/ablo'], '1.0.0');
});
