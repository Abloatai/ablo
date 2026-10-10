// Isolate existing single-add versus batch-add cost; no production patch.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { execFileSync } from 'node:child_process';

const dir = fileURLToPath(new URL('.', import.meta.url));
mkdirSync(`${dir}.generated`, { recursive: true });
await build({
  stdin: { contents: `
    export { InstanceCache } from '../../packages/humans/src/local/InstanceCache.ts';
    export { createTestContext } from '../../packages/humans/src/local/testing/mocks/MockSyncContext.ts';
    export { getActiveRegistry } from '../../packages/humans/src/local/ModelRegistry.ts';
  `, resolveDir: dir, loader: 'ts' },
  outfile: `${dir}.generated/hotpath.cjs`, bundle: true, platform: 'node',
  format: 'cjs', conditions: ['@ablo/source'],
});
const { InstanceCache, createTestContext, getActiveRegistry } = createRequire(import.meta.url)(`${dir}.generated/hotpath.cjs`);

function run(n, batch, countScans = false, skipCleanup = false) {
  const context = createTestContext();
  const pool = new InstanceCache({ maxSize: n + 1, useWeakRefs: false }, getActiveRegistry());
  const models = Array.from({ length: n }, (_, i) => pool.createFromData(
    { __typename: 'Item', id: `probe-${i}`, title: `item-${i}`, status: 'todo' },
    undefined, { deferObservability: true },
  ));
  assert.ok(models.every(Boolean));
  const originalNow = Date.now;
  let scans = 0, scannedEntries = 0;
  // Diagnostic ablation only: skipping expiry is NOT a safe production fix.
  if (skipCleanup) pool.cleanupTracking = () => {};
  if (countScans) {
    // Ponytail: a fixed clock proves the worst-case sub-second burst work,
    // not elapsed performance. Real-clock runs below provide timings.
    const now = Date.now();
    Date.now = () => now;
    const cleanup = pool.cleanupTracking.bind(pool);
    pool.cleanupTracking = () => { scans++; scannedEntries += pool.recentAdditions.size; cleanup(); };
  }
  try {
    const start = performance.now();
    if (batch) pool.addBatch(models);
    else for (const model of models) pool.add(model);
    const elapsedMs = performance.now() - start;
    assert.equal(pool.size, n);
    for (const model of models) assert.equal(pool.peek(model.id), model);
    if (countScans && !batch) {
      assert.equal(scans, n - 100);
      assert.equal(scannedEntries, n * (n + 1) / 2 - 5050);
    }
    return { elapsedMs, scans, scannedEntries, verifiedRows: n };
  } finally {
    Date.now = originalNow;
    pool.stopGC(); pool.clear(); context.cleanup();
  }
}

const results = {
  sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim(),
  node: process.version, arch: process.arch, date: new Date().toISOString(),
  note: 'Actual pool operations, unique preconstructed rows, no observers/eviction/WeakRefs. Batch comparison is not a semantics-equivalent replacement for arbitrary single adds. Fixed-clock structural probes excluded from timing samples.',
  workloads: [],
};
for (const n of [1000, 4000, 8000]) {
  run(n, false); run(n, true);
  const singleMs = [], batchMs = [], noCleanupMs = [];
  for (let sample = 0; sample < 7; sample++) {
    if (sample % 2 === 0) { singleMs.push(run(n, false).elapsedMs); batchMs.push(run(n, true).elapsedMs); }
    else { batchMs.push(run(n, true).elapsedMs); singleMs.push(run(n, false).elapsedMs); }
    noCleanupMs.push(run(n, false, false, true).elapsedMs);
  }
  const structural = run(n, false, true);
  const median = xs => [...xs].sort((a, b) => a - b)[3];
  const result = { n, singleMs, batchMs, noCleanupMs, singleMedianMs: median(singleMs), batchMedianMs: median(batchMs), noCleanupMedianMs: median(noCleanupMs), scans: structural.scans, scannedEntries: structural.scannedEntries };
  results.workloads.push(result);
  console.log(JSON.stringify(result));
}
writeFileSync(`${dir}hotpath-results.json`, JSON.stringify(results, null, 2) + '\n');
