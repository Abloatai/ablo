/**
 * pack:check — tarball hygiene gate (run per-PR in ci.yml "sdk-packaging").
 *
 * Packs the package into a temp dir (running the real prepack/postpack
 * lifecycle) and asserts:
 *   1. the PACKED package.json contains no '@ablo/source' export condition
 *      (the CI-source-resolution failure class must never ship to npm);
 *   2. the DEV package.json still contains it (postpack restored);
 *   3. the prepack backup file neither lingers in the tree nor shipped
 *      in the tarball;
 *   4. internal design notes do not ship with the public SDK.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const packageDir = process.cwd();
const packageJsonPath = join(packageDir, 'package.json');
const backupPath = join(packageDir, 'package.json.prepack-backup');
const CONDITION = '@ablo/source';

/** @param {string} message */
const fail = (message) => {
  console.error(`[pack:check] FAIL: ${message}`);
  process.exit(1);
};

/**
 * Does the `exports` tree carry the `@ablo/source` condition anywhere?
 * Only `exports` is the shipping hazard (it resolves a consumer's import to
 * raw ./src/*.ts). `scripts` legitimately reference it via `tsx --conditions`
 * and are inert for consumers, so a raw whole-file substring scan false-fails.
 * @param {string} pkgJsonText
 */
const exportsCarryCondition = (pkgJsonText) => {
  const exportsTree = JSON.parse(pkgJsonText).exports ?? {};
  const walk = (node) => {
    if (node === null || typeof node !== 'object' || Array.isArray(node)) return false;
    return Object.entries(node).some(([key, value]) => key === CONDITION || walk(value));
  };
  return walk(exportsTree);
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

  // 1. packed package.json's exports must be free of the condition
  execFileSync('tar', ['-xzf', tarballPath, '-C', workDir, 'package/package.json']);
  const packedPkg = readFileSync(join(workDir, 'package', 'package.json'), 'utf8');
  if (exportsCarryCondition(packedPkg)) {
    fail(`packed package.json exports still carry the '${CONDITION}' condition`);
  }

  // 2. dev tree's exports must still have it (postpack restored)
  const devPkg = readFileSync(packageJsonPath, 'utf8');
  if (!exportsCarryCondition(devPkg)) {
    fail(`dev package.json exports lost the '${CONDITION}' condition — postpack did not restore`);
  }

  // 3a. no backup file left behind
  if (existsSync(backupPath)) {
    fail('package.json.prepack-backup left in the working tree');
  }

  // 4. The CLI lives in its own package now. A bundle reappearing in an SDK
  //    package would silently hand every consumer 13+ MB back.
  if (report.files.some((f) => f.path === 'dist/cli.cjs')) {
    fail('dist/cli.cjs shipped in the SDK tarball — the CLI belongs to packages/cli');
  }
  const shippedTestSource = report.files.find(
    (file) =>
      file.path.includes('/__tests__/') ||
      file.path.includes('/local/testing/') ||
      /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file.path)
  );
  if (shippedTestSource) {
    fail(`test-only source shipped in the SDK tarball: ${shippedTestSource.path}`);
  }
  const shippedInternalDoc = report.files.find((file) =>
    file.path.startsWith('docs/internal/')
  );
  if (shippedInternalDoc) {
    fail(`internal design note shipped in the SDK tarball: ${shippedInternalDoc.path}`);
  }

  console.log(
    `[pack:check] OK: ${report.filename} is '${CONDITION}'-free, internal-doc-free, CLI-bundle-free, dev tree intact`
  );
} finally {
  rmSync(workDir, { recursive: true, force: true });
}
