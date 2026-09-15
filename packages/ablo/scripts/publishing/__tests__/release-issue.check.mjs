import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

for (const script of ['release.sh', 'sync-mirror.sh']) {
  for (const value of ['', 'ABL-70', 'https://example.com/ABL-70']) {
    test(`${script} rejects missing or invalid release issue: ${value}`, () => {
      const path = fileURLToPath(new URL(`../../${script}`, import.meta.url));
      const result = spawnSync('bash', [path, 'prepare'], {
        encoding: 'utf8', env: { ...process.env, RELEASE_LINEAR_URL: value },
      });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /RELEASE_LINEAR_URL must name the actual release issue/);
    });
  }
}
