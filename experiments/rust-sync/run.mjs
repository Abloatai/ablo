import assert from 'node:assert/strict';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { cpus, totalmem, release } from 'node:os';
import { performance } from 'node:perf_hooks';
import { build } from 'esbuild';

const dir = fileURLToPath(new URL('.', import.meta.url));
process.chdir(dir);
mkdirSync('.generated', { recursive: true });
await build({ absWorkingDir: dir, entryPoints: ['flow.ts'], outfile: '.generated/flow.cjs', bundle: true, platform: 'node', format: 'cjs', conditions: ['@ablo/source'], logLevel: 'warning' });
const require = createRequire(import.meta.url);
process.env.ABLO_PROFILE_DRAIN = 'false';
const { deduplicateDeltas, fullFlow, boundaryChecks } = require('./.generated/flow.cjs');
const baselineOnly = process.argv.includes('--baseline-only');
const checkOnly = process.argv.includes('--check');
const samples = 7, rows = 8000, frameSize = 1300, frameCount = 40;

function rng(seed) { return () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; }; }
function delta(id, i = id) {
  return { id, actionType: 'U', modelName: 'Item', modelId: `row-${i % rows}`, data: { id: `row-${i % rows}`, title: `updated-${i}`, status: 'todo', organizationId: 'org-bench', createdBy: 'user-bench' }, syncGroups: ['org-bench'], createdAt: '2026-09-30T00:00:00.000Z', transactionId: `tx-${Math.floor(i / 10)}` };
}
function frame(n, mode, offset = rows + 1) {
  const result = Array.from({ length: n }, (_, i) => delta(offset + i, offset + i));
  if (mode === 'replay') {
    const random = rng(offset);
    for (let i = 0; i < n; i += 10) result.push({ ...result[i], data: { ...result[i].data } });
    // Shuffle original and replay deliveries; stable first-delivery semantics still apply.
    for (let i = result.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [result[i], result[j]] = [result[j], result[i]]; }
  }
  return result;
}
function summary(values, count) {
  const sorted = [...values].sort((a, b) => a - b), medianMs = sorted[Math.floor(sorted.length / 2)];
  return { samplesMs: values, medianMs, minMs: sorted[0], maxMs: sorted.at(-1), inputDeltasPerSecond: count * 1000 / medianMs };
}

class RustWorker {
  constructor() {
    this.process = spawn('./target/release/dedupe', [], { stdio: ['pipe', 'pipe', 'inherit'] });
    this.buffer = Buffer.alloc(0);
    this.process.stdout.on('data', chunk => { this.buffer = Buffer.concat([this.buffer, chunk]); this.drain(); });
    this.process.on('error', error => this.pending?.reject(error));
    this.process.on('exit', code => { this.pending?.reject(new Error(`Rust worker exited: ${code}`)); });
  }
  drain() {
    if (!this.pending || this.buffer.length < 12) return;
    const count = this.buffer.readUInt32LE(0), size = 12 + (count === 0xffffffff ? 0 : count * 4);
    if (this.buffer.length < size) return;
    const { resolve, input } = this.pending;
    const output = count === 0xffffffff ? input : Array.from({ length: count }, (_, i) => input[this.buffer.readUInt32LE(12 + i * 4)]);
    const kernelMs = Number(this.buffer.readBigUInt64LE(4)) / 1e6;
    this.buffer = this.buffer.subarray(size); this.pending = null;
    resolve({ output, kernelMs });
  }
  run(input, repeats = 1) {
    assert.equal(this.pending, null);
    const bytes = Buffer.allocUnsafe(8 + input.length * 8);
    bytes.writeUInt32LE(input.length, 0); bytes.writeUInt32LE(repeats, 4);
    input.forEach((d, i) => bytes.writeDoubleLE(d.id, 8 + i * 8));
    return new Promise((resolve, reject) => {
      this.pending = { resolve, reject, input };
      this.process.stdin.write(bytes, error => { if (error) reject(error); });
    });
  }
  close() { this.process.stdin.end(); }
}

await boundaryChecks();
let worker;
if (!baselineOnly) {
  execFileSync('cargo', ['test', '--release', '--offline'], { stdio: 'inherit' });
  execFileSync('cargo', ['build', '--release', '--offline'], { stdio: 'inherit' });
  worker = new RustWorker();
  worker.pending = null;
}
try {
  let parityCases = 0;
  {
    const edgeCases = [[], [1], [3, 1, 2, 3], [3, 0, 3], [3, -0, 3], [3, -1, 3], [1.5, 1.25, 1.5], [Number.MAX_SAFE_INTEGER, 2 ** 53, Number.MAX_SAFE_INTEGER], [Number.MAX_VALUE, 1, Number.MAX_VALUE]];
    const random = rng(42);
    for (let i = 0; i < 300; i++) edgeCases.push(Array.from({ length: Math.floor(random() * 2000) }, () => Math.floor(random() * 400) + (i % 3 === 0 ? -10 : 1)));
    for (const ids of edgeCases) {
      const input = ids.map((id, i) => ({ ...delta(id, i), actionType: ['I', 'U', 'D', 'C', 'G', 'S', 'A', 'V'][i % 8], metadata: { retained: i } }));
      const snapshot = structuredClone(input), expected = deduplicateDeltas(input);
      const oracle = ids.some(id => id <= 0) ? input : [...new Map([...input].reverse().map(d => [d.id, d])).values()].sort((a, b) => a.id - b.id);
      assert.deepEqual(expected, oracle);
      const output = worker ? (await worker.run(input)).output : expected;
      assert.deepEqual(output, expected);
      output.forEach((d, i) => assert.equal(d, expected[i]));
      assert.equal(output === input, expected === input);
      assert.deepEqual(input, snapshot);
      parityCases++;
    }
    // Invalid binary requests fail closed; this does not replace the JS wire validator.
    for (const invalid of worker ? [NaN, Infinity, -Infinity] : []) {
      const bytes = Buffer.alloc(16); bytes.writeUInt32LE(1, 0); bytes.writeUInt32LE(1, 4); bytes.writeDoubleLE(invalid, 8);
      assert.notEqual(spawnSync('./target/release/dedupe', { input: bytes }).status, 0);
    }
    console.log(`${worker ? 'Rust differential parity' : 'JS reference parity only'}: ${parityCases} cases passed; JS boundary checks passed.`);
  }
  if (checkOnly) process.exitCode = 0;
  else {
    const results = {
      machine: { date: new Date().toISOString(), node: process.version, arch: process.arch, v8: process.versions.v8, rust: baselineOnly ? 'unavailable' : execFileSync('rustc', ['--version'], { encoding: 'utf8' }).trim(), cargo: baselineOnly ? 'unavailable' : execFileSync('cargo', ['--version'], { encoding: 'utf8' }).trim(), cpu: cpus()[0].model, cpus: cpus().length, totalMemoryBytes: totalmem(), kernel: release(), sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() },
      config: { samples, rows, frameSize, frameCount, jsReferenceCases: parityCases, rustParityCases: worker ? parityCases : 0, warmupCalls: 30, seed: 42 }, kernels: [], flows: [],
    };
    for (const size of [1300, 50000]) for (const mode of ['ordered', 'replay']) {
      const input = frame(size, mode), repeats = size === 1300 ? 500 : 20;
      const js = [], rust = [], ipc = [];
      for (let i = 0; i < 30; i++) { deduplicateDeltas(input); if (worker) await worker.run(input); }
      for (let s = 0; s < samples; s++) {
        const runJs = () => { const start = performance.now(); let result; for (let i = 0; i < repeats; i++) result = deduplicateDeltas(input); js.push((performance.now() - start) / repeats); assert.ok(result.length); };
        // Alternate execution order to reduce thermal/order bias.
        if (s % 2 === 0) runJs();
        if (worker) {
          rust.push((await worker.run(input, repeats)).kernelMs / repeats);
          const start = performance.now();
          for (let i = 0; i < 30; i++) await worker.run(input);
          ipc.push((performance.now() - start) / 30);
        }
        if (s % 2 !== 0) runJs();
      }
      results.kernels.push({ mode, size, inputCount: input.length, repeats, js: summary(js, input.length), ...(worker && { rust: summary(rust, input.length), rustWithIPC: summary(ipc, input.length) }) });
      console.log(`${mode} ${input.length}: JS median ${summary(js, input.length).medianMs.toFixed(4)} ms`);
    }
    for (const mode of ['ordered', 'replay']) {
      const frames = Array.from({ length: frameCount }, (_, i) => frame(frameSize, mode, rows + 1 + i * frameSize));
      const wire = frames.map(f => JSON.stringify(f));
      await fullFlow(wire, rows); // Full workload warmup, excluded.
      const values = [];
      for (let i = 0; i < samples; i++) values.push((await fullFlow(wire, rows)).wallMs);
      // The production profiler reads its flag at module load. Reload the bundle
      // for the attribution run, keeping timing runs uninstrumented.
      delete require.cache[require.resolve('./.generated/flow.cjs')];
      process.env.ABLO_PROFILE_DRAIN = 'true';
      const profiledFlow = require('./.generated/flow.cjs').fullFlow;
      process.env.ABLO_PROFILE_DRAIN = 'false';
      const attribution = await profiledFlow(wire, rows, true);
      const count = frames.reduce((n, f) => n + f.length, 0);
      results.flows.push({ mode, inputCount: count, wireBytes: wire.reduce((n, w) => n + Buffer.byteLength(w), 0), timing: summary(values, count), attribution });
      console.log(`${mode} full headless receive flow: median ${summary(values, count).medianMs.toFixed(2)} ms`);
    }
    results.memory = { nodeProcessPeakRssKiB: process.resourceUsage().maxRSS, rustWorkerStatus: worker ? readFileSync(`/proc/${worker.process.pid}/status`, 'utf8').split('\n').filter(s => /^(VmHWM|VmRSS):/.test(s)) : null, note: 'Process high-water RSS, including harness and full workloads; Rust holds IDs only while Node owns payloads. Not equivalent engine footprints.' };
    writeFileSync(baselineOnly ? 'baseline-results.json' : 'results.json', JSON.stringify(results, null, 2) + '\n');
  }
} finally { worker?.close(); }
