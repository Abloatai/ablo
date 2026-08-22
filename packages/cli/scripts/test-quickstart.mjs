/**
 * Quickstart loop test — installs the REAL packed artifacts (SDK + CLI) into
 * a fresh project and walks the exact path a new developer walks. Green unit
 * suites say nothing about this path: jest runs from src/ with the monorepo's
 * node_modules, so "CLI crashes at startup in a fresh project" (inlined jiti,
 * top-level customer-ORM imports, a shim that fails to find the CLI package)
 * is invisible to every other test. This script is the only thing standing
 * between those bugs and `npx ablo`.
 *
 * TIER 1 (always, offline): pack → fresh project → install tarball →
 *   `ablo` boots, `init --yes` scaffolds, keyless `push` fails
 *   GRACEFULLY (exit 1 + "ablo login" guidance, never a stack trace).
 *
 * TIER 2 (opt-in, networked): ABLO_QUICKSTART_LIVE=1 with ABLO_API_KEY (or a
 *   stored login) additionally runs the real `push` push and
 *   asserts `.env.local` + `.gitignore` wiring.
 *
 * Run: npm run test:quickstart        (tier 1)
 *      ABLO_QUICKSTART_LIVE=1 npm run test:quickstart
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const monorepoRoot = dirname(dirname(pkgRoot));
const sdkRoot = join(monorepoRoot, 'packages', 'ablo');
const transactionRoot = join(monorepoRoot, 'packages', 'transaction');
const humansRoot = join(monorepoRoot, 'packages', 'humans');
const failures = [];
let step = '';

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });
}
function check(name, fn) {
  step = name;
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures.push({ name, message: err instanceof Error ? err.message : String(err) });
    console.error(`  ✗ ${name}\n    ${err instanceof Error ? err.message : err}`);
  }
}
function expect(cond, message) {
  if (!cond) throw new Error(message);
}

// ── Arrange: pack the real artifact into a fresh project ────────────────────
const work = mkdtempSync(join(tmpdir(), 'ablo-quickstart-'));
const proj = join(work, 'app');
const emptyConfigDir = join(work, 'ablo-config'); // isolate from ~/.config/ablo
mkdirSync(proj, { recursive: true });
mkdirSync(emptyConfigDir, { recursive: true });

console.log('\nquickstart loop test');
console.log(`  work dir: ${work}`);

let sdkTarball = '';
let transactionTarball = '';
let humansTarball = '';
let cliTarball = '';
check('npm pack produces the complete public runtime', () => {
  const transactionOut = run('npm', ['pack', '--pack-destination', work], { cwd: transactionRoot });
  transactionTarball = join(work, transactionOut.trim().split('\n').pop());
  expect(existsSync(transactionTarball), `transaction tarball missing: ${transactionTarball}`);
  const humansOut = run('npm', ['pack', '--pack-destination', work], { cwd: humansRoot });
  humansTarball = join(work, humansOut.trim().split('\n').pop());
  expect(existsSync(humansTarball), `humans tarball missing: ${humansTarball}`);
  const sdkOut = run('npm', ['pack', '--pack-destination', work], { cwd: sdkRoot });
  sdkTarball = join(work, sdkOut.trim().split('\n').pop());
  expect(existsSync(sdkTarball), `SDK tarball missing: ${sdkTarball}`);
  const cliOut = run('npm', ['pack', '--pack-destination', work], { cwd: pkgRoot });
  cliTarball = join(work, cliOut.trim().split('\n').pop());
  expect(existsSync(cliTarball), `CLI tarball missing: ${cliTarball}`);
});

check('fresh project installs the complete public runtime', () => {
  run('git', ['init', '-q'], { cwd: proj });
  writeFileSync(
    join(proj, 'package.json'),
    JSON.stringify({
      name: 'quickstart-app',
      version: '0.0.0',
      private: true,
      type: 'module',
    }),
  );
  run(
    'npm',
    [
      'install',
      transactionTarball,
      humansTarball,
      sdkTarball,
      cliTarball,
      '--no-audit',
      '--no-fund',
    ],
    { cwd: proj },
  );
  expect(
    existsSync(join(proj, 'node_modules', '@abloatai', 'ablo', 'package.json')),
    'SDK did not land as the CLI dependency',
  );
  expect(
    existsSync(join(proj, 'node_modules', '@abloatai', 'cli', 'package.json')),
    'CLI did not install under its published name',
  );
});

const cli = join(proj, 'node_modules', '@abloatai', 'cli', 'dist', 'cli.cjs');
const keylessEnv = {
  ...process.env,
  ABLO_CONFIG_DIR: emptyConfigDir,
  ABLO_API_KEY: '',
};
delete keylessEnv.ABLO_API_KEY;

// ── Tier 1: the CLI must WORK in a project that has nothing else ────────────
check('`ablo` boots in a bare project (no drizzle/prisma/key installed)', () => {
  const out = run('node', [cli], { cwd: proj, env: keylessEnv });
  expect(/init|dev|login/.test(out), `help output unrecognizable:\n${out.slice(0, 400)}`);
});

check('`ablo init --yes` scaffolds the project', () => {
  run('node', [cli, 'init', '--yes', '--framework', 'vanilla', '--auth', 'apikey', '--no-login', '--no-install', '--no-pull'], {
    cwd: proj,
    env: keylessEnv,
  });
  for (const f of ['ablo/schema.ts', 'ablo/index.ts']) {
    expect(existsSync(join(proj, f)), `init did not create ${f}`);
  }
});

check('keyless `ablo push` fails GRACEFULLY with login guidance', () => {
  // `init --yes --no-login` scaffolds an env file with a placeholder key so a
  // human knows where the real one goes. Remove it so this check runs truly
  // keyless — the state the login guidance exists for.
  rmSync(join(proj, '.env'), { force: true });
  rmSync(join(proj, '.env.local'), { force: true });
  let out = '';
  let code = 0;
  try {
    out = run('node', [cli, 'push'], { cwd: proj, env: keylessEnv });
  } catch (err) {
    code = err.status ?? 1;
    out = `${err.stdout ?? ''}${err.stderr ?? ''}`;
  }
  expect(code !== 0, 'keyless dev must exit non-zero');
  expect(/ablo login/.test(out), `failure must point at \`ablo login\`, got:\n${out.slice(0, 400)}`);
  // Message contract: guidance must name the door — agents parrot this line
  // into READMEs. Branch-first keys have ONE spelling (`sk_`) for every
  // branch, so the old both-kinds rule (the 2026-06-11 live-key incident:
  // a valid sk_live_ holder was told only sk_test_ exists) is closed by
  // construction; what must never return is the retired live/test vocabulary.
  expect(/sk_/.test(out), `keyless guidance must mention the sk_ credential, got:\n${out.slice(0, 400)}`);
  expect(!/sk_(?:test|live)_/.test(out), `keyless guidance resurrects retired live/test spellings:\n${out.slice(0, 400)}`);
  expect(!/at .*\(.*:\d+:\d+\)/.test(out), `keyless dev printed a STACK TRACE:\n${out.slice(0, 600)}`);
});

check('`ablo status` runs keyless without crashing', () => {
  const out = run('node', [cli, 'status'], { cwd: proj, env: keylessEnv });
  expect(/Not logged in|mode/.test(out), `status output unrecognizable:\n${out.slice(0, 300)}`);
});

// ── Tier 2 (opt-in): the real push against the hosted sandbox ───────────────
if (process.env.ABLO_QUICKSTART_LIVE === '1') {
  const liveEnv = { ...process.env }; // real config dir / ABLO_API_KEY
  check('LIVE: `ablo push` pushes the schema', () => {
    // The deploy canary is deliberately root-branch bound. Root branches are
    // production planes even when hosted by the staging deployment, so CI
    // must provide the same explicit confirmation a scripted customer deploy
    // would provide. The key itself remains scoped to `schema:push` only.
    const out = run('node', [cli, 'push', '--yes'], { cwd: proj, env: liveEnv });
    expect(
      /(Activated|No changes — schema already active)/.test(out),
      `push did not succeed:\n${out.slice(-600)}`,
    );
  });
  check('LIVE: ABLO_API_KEY landed in .env.local and is gitignored', () => {
    if (process.env.ABLO_API_KEY) return; // env key → dev intentionally skips the file
    const env = readFileSync(join(proj, '.env.local'), 'utf8');
    expect(/^ABLO_API_KEY=/m.test(env), '.env.local missing ABLO_API_KEY');
    const ignore = readFileSync(join(proj, '.gitignore'), 'utf8');
    expect(/\.env/.test(ignore), '.gitignore does not cover .env.local');
  });
} else {
  console.log('  ○ tier 2 (live push) skipped — set ABLO_QUICKSTART_LIVE=1 to run it');
}

// ── Report ───────────────────────────────────────────────────────────────────
rmSync(work, { recursive: true, force: true });
if (failures.length > 0) {
  console.error(`\n${failures.length} quickstart check(s) FAILED.`);
  process.exit(1);
}
console.log('\nquickstart loop is green.');
