#!/usr/bin/env node
/**
 * Versions the fixed Ablo release group at the bump its changesets declare.
 *
 * Changesets treats a peer dependency as an independent range: when a peer
 * takes a minor, the peer dependent is bumped to major, and the fixed group
 * carries that major to every member. Inside the group the rule is wrong. The
 * CLI's exact SDK peer is a lockstep contract (`package-contract/release-family.mjs`),
 * yet it turned every minor into 1.0.0. So the group's peers on each other are
 * hidden while Changesets versions and pinned to the new version afterwards,
 * and a major that no changeset declares is refused.
 *
 *   node packages/ablo/scripts/version-release-family.mjs [workspace-root]
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import readChangesets from '@changesets/read';
import { getPackages } from '@manypkg/get-packages';

const root = process.argv[2] ?? fileURLToPath(new URL('../../..', import.meta.url));
const changesetBin = createRequire(import.meta.url).resolve('@changesets/cli/bin.js');

/** @typedef {{ version: string, peerDependencies?: Record<string, string> }} Manifest */
/** @type {(path: string) => Manifest} */
const readManifest = (path) => JSON.parse(readFileSync(path, 'utf8'));
/** @type {(path: string, manifest: Manifest) => void} */
const writeManifest = (path, manifest) => writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
/** @type {(version: string) => number} */
const majorOf = (version) => Number(version.split('.')[0]);

/** @type {{ fixed: string[][] }} */
const config = JSON.parse(readFileSync(join(root, '.changeset/config.json'), 'utf8'));
const group = config.fixed.find((names) => names.includes('@abloatai/ablo'));
assert(group, 'Ablo packages must form one fixed release group');
const family = new Set(group);
const members = (await getPackages(root)).packages.filter((pkg) => family.has(pkg.packageJson.name));
const sdk = members.find((pkg) => pkg.packageJson.name === '@abloatai/ablo');
assert(sdk, 'the release group must include the @abloatai/ablo workspace');
const leader = join(sdk.dir, 'package.json');
const declaredMajor = (await readChangesets(root)).some((changeset) =>
  changeset.releases.some((release) => family.has(release.name) && release.type === 'major'));

const previous = readManifest(leader).version;
/** @type {{ manifest: string, names: string[] }[]} */
const hidden = [];
for (const pkg of members) {
  const manifest = join(pkg.dir, 'package.json');
  const json = readManifest(manifest);
  const peers = json.peerDependencies ?? {};
  const names = Object.keys(peers).filter((name) => family.has(name));
  if (names.length === 0) continue;
  for (const name of names) delete peers[name];
  writeManifest(manifest, json);
  hidden.push({ manifest, names });
}

let version = previous;
try {
  execFileSync(process.execPath, [changesetBin, 'version'], { cwd: root, stdio: 'inherit' });
} finally {
  // On failure the version is unchanged, which is exactly the range each hidden
  // peer held, so restoring always leaves the contract intact.
  version = readManifest(leader).version;
  for (const { manifest, names } of hidden) {
    const json = readManifest(manifest);
    const peers = (json.peerDependencies ??= {});
    for (const name of names) peers[name] = version;
    writeManifest(manifest, json);
  }
}

if (majorOf(version) !== majorOf(previous) && !declaredMajor) {
  console.error(
    `error: Changesets moved the release group from ${previous} to ${version}, ` +
      'but no changeset declares a major release',
  );
  process.exit(1);
}
console.log(`versioned the release group ${previous} -> ${version}`);
