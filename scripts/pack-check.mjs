/**
 * pack:check — tarball hygiene gate (run per-PR in ci.yml "sdk-packaging").
 *
 * Packs the package into a temp dir (running the real prepack/postpack
 * lifecycle) and asserts:
 *   1. the PACKED package.json contains no '@ablo/source' export condition
 *      (the CI-source-resolution failure class must never ship to npm);
 *   2. the DEV package.json still contains it (postpack restored);
 *   3. the prepack backup file neither lingers in the tree nor shipped
 *      in the tarball.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageDir = dirname(dirname(fileURLToPath(import.meta.url)));
const packageJsonPath = join(packageDir, 'package.json');
const backupPath = join(packageDir, 'package.json.prepack-backup');
const CONDITION = '@ablo/source';

/** @param {string} message */
const fail = (message) => {
  console.error(`[pack:check] FAIL: ${message}`);
  process.exit(1);
};

const workDir = mkdtempSync(join(tmpdir(), 'ablo-pack-check-'));
try {
  const packOutput = execFileSync(
    'npm',
    ['pack', '--json', '--pack-destination', workDir],
    {
      cwd: packageDir,
      encoding: 'utf8',
      // keep npm's cache out of the user's ~/.npm (sandbox-friendly, matches
      // the previous pack:check behavior)
      env: { ...process.env, npm_config_cache: join(workDir, 'npm-cache') },
    }
  );
  /** @type {Array<{ filename: string, files: Array<{ path: string }> }>} */
  const packReport = JSON.parse(packOutput);
  const [report] = packReport;
  if (!report) fail('npm pack produced no report');

  const tarballPath = join(workDir, report.filename);
  if (!existsSync(tarballPath)) fail(`tarball not found at ${tarballPath}`);

  // 3b. backup must not be in the tarball's file list
  if (report.files.some((f) => f.path.includes('package.json.prepack-backup'))) {
    fail('package.json.prepack-backup shipped in the tarball');
  }

  // 1. packed package.json must be free of the condition
  execFileSync('tar', ['-xzf', tarballPath, '-C', workDir, 'package/package.json']);
  const packedPkg = readFileSync(join(workDir, 'package', 'package.json'), 'utf8');
  if (packedPkg.includes(CONDITION)) {
    fail(`packed package.json still contains '${CONDITION}'`);
  }

  // 2. dev tree must still have it (postpack restored)
  const devPkg = readFileSync(packageJsonPath, 'utf8');
  if (!devPkg.includes(CONDITION)) {
    fail(`dev package.json lost its '${CONDITION}' condition — postpack did not restore`);
  }

  // 3a. no backup file left behind
  if (existsSync(backupPath)) {
    fail('package.json.prepack-backup left in the working tree');
  }

  // 4. the CLI lives in its own package now — a cli bundle reappearing in the
  //    SDK tarball would silently hand every consumer 13+ MB back, and the
  //    bin shim must ship or `npx ablo` dies on install.
  if (report.files.some((f) => f.path === 'dist/cli.cjs')) {
    fail('dist/cli.cjs shipped in the SDK tarball — the CLI belongs to packages/cli');
  }
  if (!report.files.some((f) => f.path === 'bin/ablo.cjs')) {
    fail('bin/ablo.cjs missing from the tarball — `npx ablo` would have no bin');
  }

  console.log(
    `[pack:check] OK: ${report.filename} is '${CONDITION}'-free, CLI-bundle-free, dev tree intact`
  );
} finally {
  rmSync(workDir, { recursive: true, force: true });
}
