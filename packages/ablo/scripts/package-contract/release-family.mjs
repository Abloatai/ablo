import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

export function checkReleaseFamily(root) {
  const read = path => JSON.parse(readFileSync(new URL(path, root), 'utf8'));
  const names = ['ablo', 'transaction', 'humans', 'cli'];
  const packages = names.map(name => read(`packages/${name}/package.json`));
  const version = packages[0].version;
  const family = new Set(packages.map(pkg => pkg.name));
  assert(read('.changeset/config.json').fixed.some(group =>
    group.length === family.size && group.every(name => family.has(name))), 'Ablo packages must form one fixed release group');
  for (const pkg of packages) {
    assert.equal(pkg.version, version, `${pkg.name} release version drifted`);
    for (const [name, range] of Object.entries(pkg.dependencies ?? {})) {
      if (family.has(name)) assert.equal(range, version, `${pkg.name} must pin ${name} exactly`);
    }
  }
  assert.equal(packages[3].peerDependencies['@abloatai/ablo'], version, 'CLI must declare exact SDK compatibility');
}
