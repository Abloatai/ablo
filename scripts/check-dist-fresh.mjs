/**
 * Dist freshness guard — kills the recurring "verified green, but dist is
 * stale" footgun. Jest runs against src/ (moduleNameMapper), so a green
 * suite says NOTHING about what dependent packages actually consume: the
 * built dist/. This check compares the newest source mtime against the
 * newest build output and fails with the exact rebuild command when the
 * build is older than the code.
 *
 * Wired as `pretest` so every local/CI test run asserts the contract.
 * Escape hatch for machines that cannot run the build right now:
 *   ABLO_SKIP_DIST_CHECK=1 npm test
 */

import { readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = new URL('..', import.meta.url).pathname;

if (process.env.ABLO_SKIP_DIST_CHECK === '1') {
  console.warn('[check-dist-fresh] skipped via ABLO_SKIP_DIST_CHECK=1 — dist may be stale.');
  process.exit(0);
}

/** Newest mtime (ms) of files under `dir` matching `keep`, recursing. */
function newest(dir, keep) {
  let max = 0;
  let maxFile = '';
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '__tests__') continue;
      const sub = newest(path, keep);
      if (sub.max > max) ({ max, maxFile } = sub);
      continue;
    }
    if (!keep(entry.name)) continue;
    const mtime = statSync(path).mtimeMs;
    if (mtime > max) {
      max = mtime;
      maxFile = path;
    }
  }
  return { max, maxFile };
}

const isSource = (name) =>
  (name.endsWith('.ts') || name.endsWith('.tsx')) &&
  !name.endsWith('.test.ts') &&
  !name.endsWith('.d.ts');
const isBuilt = (name) => name.endsWith('.js') || name.endsWith('.cjs');

const srcDir = join(root, 'src');
const distDir = join(root, 'dist');

if (!existsSync(distDir)) {
  console.error(
    '[check-dist-fresh] dist/ is MISSING — dependent packages cannot resolve ' +
      '@abloatai/ablo at all. Run: npm run build  (in packages/sync-engine)',
  );
  process.exit(1);
}

const src = newest(srcDir, isSource);
const lib = newest(distDir, isBuilt);

// 2s slack absorbs same-build mtime jitter (tsc writes outputs while later
// sources are still being stat'd by watchers/formatters).
const SLACK_MS = 2_000;

if (src.max > lib.max + SLACK_MS) {
  console.error(
    '[check-dist-fresh] dist/ is STALE.\n' +
      `  newest source: ${relative(root, src.maxFile)} (${new Date(src.max).toISOString()})\n` +
      `  newest output: ${relative(root, lib.maxFile)} (${new Date(lib.max).toISOString()})\n` +
      '  Dependent packages consume dist/, so green tests here do not cover them.\n' +
      '  Run: npm run build   (or tsc -p tsconfig.build.json && npm run build:cli)',
  );
  process.exit(1);
}

// The CLI bundle is built by a SEPARATE tool (tsup) and silently survives
// `tsc`-only rebuilds — check it on its own so `ablo` never ships old code.
const cli = join(distDir, 'cli.cjs');
if (existsSync(cli) && src.max > statSync(cli).mtimeMs + SLACK_MS) {
  console.error(
    '[check-dist-fresh] dist/cli.cjs is STALE (lib output is fresh, the tsup ' +
      'bundle is not). Run: npm run build:cli',
  );
  process.exit(1);
}

console.log('[check-dist-fresh] dist is fresh.');
