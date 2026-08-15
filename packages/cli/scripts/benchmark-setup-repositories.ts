import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import {
  SETUP_CONTRACT_VERSION,
  setupRepositoryBenchmarkCaseSchema,
  setupRepositoryBenchmarkResultSchema,
  type SetupRepositoryBenchmarkCase,
  type SetupRepositoryBenchmarkResult,
} from '../src/setup/contracts';
import { discoverSetupPlan } from '../src/setup/discover';

const packageRoot = resolve(import.meta.dirname, '..');
const corpusPath = join(packageRoot, 'evals/benchmarks/real-repositories.json');
const cases = setupRepositoryBenchmarkCaseSchema.array().parse(
  JSON.parse(readFileSync(corpusPath, 'utf8')),
);

function checkoutEnvironmentName(caseId: string): string {
  return `ABLO_SETUP_BENCHMARK_${caseId.replaceAll('-', '_').toUpperCase()}_ROOT`;
}

function checkout(testCase: SetupRepositoryBenchmarkCase): string {
  const environmentName = checkoutEnvironmentName(testCase.caseId);
  const supplied = process.env[environmentName];
  if (supplied) return realpathSync(resolve(supplied));

  const parent = mkdtempSync(join(tmpdir(), `ablo-setup-benchmark-${testCase.caseId}-`));
  const root = join(parent, 'repository');
  mkdirSync(root);
  const canonicalRoot = realpathSync(root);
  execFileSync('git', ['init', '--quiet'], { cwd: canonicalRoot, stdio: 'ignore' });
  execFileSync('git', ['remote', 'add', 'origin', testCase.repository.url], { cwd: canonicalRoot, stdio: 'ignore' });
  execFileSync('git', ['fetch', '--quiet', '--depth', '1', 'origin', testCase.repository.commit], {
    cwd: canonicalRoot,
    stdio: 'ignore',
    timeout: 120_000,
  });
  execFileSync('git', ['checkout', '--quiet', '--detach', 'FETCH_HEAD'], { cwd: canonicalRoot, stdio: 'ignore' });
  return canonicalRoot;
}

function git(root: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

async function evaluate(testCase: SetupRepositoryBenchmarkCase): Promise<SetupRepositoryBenchmarkResult> {
  const root = checkout(testCase);
  const commit = git(root, 'rev-parse', 'HEAD');
  const dirty = git(root, 'status', '--porcelain=v1', '--untracked-files=all');
  const plan = await discoverSetupPlan({ root });
  const selectedRoot = plan.target.applicationRoot
    ? relative(root, plan.target.applicationRoot).replaceAll('\\', '/') || '.'
    : '<unresolved>';
  const persistence = plan.facts.find(({ key }) => key === 'application.persistenceCandidates')?.value;
  const coordinationAdoption = plan.facts.find(
    ({ key }) => key === 'application.coordinationAdoption',
  )?.value;
  const mutationSites = plan.facts.find(({ key }) => key === 'application.directMutationSites')?.value;
  const mutationPaths = Array.isArray(mutationSites)
    ? mutationSites.flatMap((site) => typeof site === 'object' && site !== null && 'path' in site && typeof site.path === 'string' ? [site.path] : [])
    : [];
  const checks: SetupRepositoryBenchmarkResult['checks'] = [];
  const check = (id: string, passed: boolean, detail: string): void => {
    checks.push({ id, status: passed ? 'pass' : 'fail', detail });
  };

  check('pinned_commit', commit === testCase.repository.commit, `Expected ${testCase.repository.commit}; observed ${commit}.`);
  check('pristine_checkout', dirty === '', dirty === '' ? 'Discovery left the checkout pristine.' : 'The checkout is dirty after discovery.');
  check('application_root', selectedRoot === testCase.expectations.applicationRoot, `Expected "${testCase.expectations.applicationRoot}"; selected "${selectedRoot}".`);
  const persistenceValues = Array.isArray(persistence) ? persistence.filter((value): value is string => typeof value === 'string') : [];
  for (const expected of testCase.expectations.persistenceIncludes) {
    check(`persistence:${expected}`, persistenceValues.includes(expected), `Observed persistence: ${persistenceValues.join(', ') || 'none'}.`);
  }
  for (const path of testCase.expectations.requiredMutationPaths) {
    check(`mutation_path:${path}`, mutationPaths.includes(path), mutationPaths.includes(path) ? `Found ${path}.` : `Did not find ${path}.`);
  }
  for (const prefix of testCase.expectations.forbiddenMutationPathPrefixes) {
    const leaked = mutationPaths.filter((path) => path.startsWith(prefix));
    check(`scope_excludes:${prefix}`, leaked.length === 0, leaked.length === 0 ? `No ${prefix} paths leaked into mutation hints.` : `${leaked.length} ${prefix} path(s) leaked into mutation hints.`);
  }
  check(
    `coordination_adoption:${testCase.expectations.coordinationAdoption}`,
    coordinationAdoption === testCase.expectations.coordinationAdoption,
    `Expected ${testCase.expectations.coordinationAdoption}; observed ${String(coordinationAdoption)}.`,
  );

  return setupRepositoryBenchmarkResultSchema.parse({
    schemaVersion: SETUP_CONTRACT_VERSION,
    kind: 'ablo_setup_repository_benchmark_result',
    caseId: testCase.caseId,
    repositoryUrl: testCase.repository.url,
    commit,
    checks,
    outcome: checks.some(({ status }) => status === 'fail') ? 'failed' : 'passed',
  });
}

const results: SetupRepositoryBenchmarkResult[] = [];
for (const testCase of cases) results.push(await evaluate(testCase));
process.stdout.write(`${JSON.stringify({ results }, null, 2)}\n`);
if (results.some(({ outcome }) => outcome === 'failed')) process.exitCode = 1;
