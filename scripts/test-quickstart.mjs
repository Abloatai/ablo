/**
 * Quickstart loop test — installs the REAL packed artifact into a fresh
 * project and walks the exact path a new developer walks. Green unit suites
 * say nothing about this path: jest runs from src/ with the monorepo's
 * node_modules, so "CLI crashes at startup in a fresh project" (inlined jiti,
 * top-level customer-ORM imports) is invisible to every other test. This
 * script is the only thing standing between those bugs and `npx ablo`.
 *
 * TIER 1 (always, offline): pack → fresh project → install tarball →
 *   `ablo` boots, `init --yes` scaffolds, keyless `dev --no-watch` fails
 *   GRACEFULLY (exit 1 + "ablo login" guidance, never a stack trace).
 *
 * TIER 2 (opt-in, networked): ABLO_QUICKSTART_LIVE=1 with ABLO_API_KEY (or a
 *   stored login) additionally runs the real `dev --no-watch` push and
 *   asserts `.env.local` + `.gitignore` wiring.
 *
 * Run: npm run test:quickstart        (tier 1)
 *      ABLO_QUICKSTART_LIVE=1 npm run test:quickstart
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgRoot = dirname(dirname(fileURLToPath(import.meta.url)));
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

let tarball = '';
check('npm pack produces the artifact', () => {
  const out = run('npm', ['pack', '--pack-destination', work], { cwd: pkgRoot });
  tarball = join(work, out.trim().split('\n').pop());
  expect(existsSync(tarball), `tarball missing: ${tarball}`);
});

check('fresh project installs the tarball', () => {
  run('git', ['init', '-q'], { cwd: proj });
  writeFileSync(join(proj, 'package.json'), JSON.stringify({ name: 'quickstart-app', type: 'module' }));
  run('npm', ['i', tarball, '--no-audit', '--no-fund'], { cwd: proj });
  // The published name is @abloatai/ablo; the monorepo tarball carries
  // @abloatai/ablo. Alias it the way the mirror-publish does.
  mkdirSync(join(proj, 'node_modules', '@abloatai'), { recursive: true });
  symlinkSync(join('..', '@ablo', 'sync-engine'), join(proj, 'node_modules', '@abloatai', 'ablo'));
});

const cli = join(proj, 'node_modules', '@ablo', 'sync-engine', 'dist', 'cli.cjs');
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
  run('node', [cli, 'init', '--yes', '--framework', 'vanilla', '--auth', 'apikey', '--storage', 'direct', '--no-login', '--no-install', '--no-pull'], {
    cwd: proj,
    env: keylessEnv,
  });
  for (const f of ['ablo/schema.ts', 'ablo/index.ts']) {
    expect(existsSync(join(proj, f)), `init did not create ${f}`);
  }
});

check('keyless `ablo dev --no-watch` fails GRACEFULLY with login guidance', () => {
  let out = '';
  let code = 0;
  try {
    out = run('node', [cli, 'dev', '--no-watch'], { cwd: proj, env: keylessEnv });
  } catch (err) {
    code = err.status ?? 1;
    out = `${err.stdout ?? ''}${err.stderr ?? ''}`;
  }
  expect(code !== 0, 'keyless dev must exit non-zero');
  expect(/ablo login/.test(out), `failure must point at \`ablo login\`, got:\n${out.slice(0, 400)}`);
  expect(!/at .*\(.*:\d+:\d+\)/.test(out), `keyless dev printed a STACK TRACE:\n${out.slice(0, 600)}`);
});

check('`ablo status` runs keyless without crashing', () => {
  const out = run('node', [cli, 'status'], { cwd: proj, env: keylessEnv });
  expect(/Not logged in|mode/.test(out), `status output unrecognizable:\n${out.slice(0, 300)}`);
});

// ── Tier 2 (opt-in): the real push against the hosted sandbox ───────────────
if (process.env.ABLO_QUICKSTART_LIVE === '1') {
  const liveEnv = { ...process.env }; // real config dir / ABLO_API_KEY
  check('LIVE: `ablo dev --no-watch` pushes the schema', () => {
    const out = run('node', [cli, 'dev', '--no-watch'], { cwd: proj, env: liveEnv });
    expect(/schema (pushed|unchanged)/.test(out), `push did not succeed:\n${out.slice(-600)}`);
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
