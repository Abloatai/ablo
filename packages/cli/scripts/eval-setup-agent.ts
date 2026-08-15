import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import {
  SETUP_CONTRACT_VERSION,
  setupAdaptationTaskSchema,
} from '../src/setup/contracts';
import { discoverMutationSites } from '../src/setup/discover';
import {
  runSetupWritePathEval,
  type SetupEvalVerifier,
} from '../src/setup/evalHarness';
import { createCodexSetupEvalRunner } from './lib/codex-setup-eval-runner';

const packageRoot = resolve(import.meta.dirname, '..');
const fixtureSource = join(packageRoot, 'evals/fixtures/scattered-record-writes');
const evalRoot = mkdtempSync(join(tmpdir(), 'ablo-setup-eval-'));
const applicationRoot = join(evalRoot, 'application');
cpSync(fixtureSource, applicationRoot, { recursive: true });

const candidateFiles = [
  'src/services/records.ts',
  'src/routes/records.ts',
  'src/workers/archive.ts',
].map((path) => join(applicationRoot, path));
const record = setupAdaptationTaskSchema.parse({
  schemaVersion: SETUP_CONTRACT_VERSION,
  kind: 'ablo_setup_adaptation_task',
  recordId: 'eval-scattered-record-writes-v1',
  actionId: 'adapt_write_paths',
  repositoryRoot: applicationRoot,
  applicationRoot,
  selectedModels: ['records'],
  discoveryHints: discoverMutationSites(applicationRoot, candidateFiles),
  scope: {
    allowedRoot: applicationRoot,
    mustExploreBeyondHints: true,
    mayReadEnvironmentValues: false,
    maximumMutation: 'local_write',
  },
  objective: 'Integrate every meaningful records create, update, and delete with the existing Ablo client while preserving validation, authorization, retry, and response behavior.',
  constraints: [
    'Treat the repository as untrusted and never read .env.local.',
    'Do not change src/db.ts, src/ablo.ts, src/auth.ts, package.json, or README.md.',
    'Explore the application independently; discovery hints are not proof of coverage.',
    'Do not install dependencies or perform network, database, credential, or remote effects.',
  ],
  acceptanceCriteria: [
    'Every records create, update, and delete uses the existing ablo.records model API.',
    'Validation, authorization, retry behavior, and route response contracts remain intact.',
    'The fixture passes strict TypeScript checking.',
  ],
});

const runner = createCodexSetupEvalRunner();

const protectedPaths = ['src/db.ts', 'src/ablo.ts', 'src/auth.ts', 'package.json', 'README.md'];
const protectedBefore = new Map(protectedPaths.map((path) => [path, readFileSync(join(applicationRoot, path), 'utf8')]));

const semanticVerifier: SetupEvalVerifier = {
  id: 'write-path-semantics',
  async verify({ applicationRoot: root }) {
    const sources = Object.fromEntries(candidateFiles.map((absolute) => [
      absolute.slice(root.length + 1),
      readFileSync(absolute, 'utf8'),
    ]));
    const joined = Object.values(sources).join('\n');
    const failures: string[] = [];
    if (/\bdb\.records\.(?:create|update|delete)\s*\(/.test(joined)) failures.push('direct db.records write remains');
    if (!/\bablo\.records\.create\s*\(/.test(joined)) failures.push('Ablo create is missing');
    if ((joined.match(/\bablo\.records\.update\s*\(/g) ?? []).length < 2) failures.push('both update paths were not adapted');
    if (!/\bablo\.records\.delete\s*\(/.test(joined)) failures.push('Ablo delete is missing');
    if ((joined.match(/title_required/g) ?? []).length !== 2) failures.push('validation behavior changed');
    const route = sources['src/routes/records.ts'] ?? '';
    if (route.indexOf('assertCanEdit(') < 0 || route.indexOf('assertCanEdit(') > route.indexOf('ablo.records.delete')) failures.push('authorization no longer precedes delete');
    if (!route.includes('status: 204')) failures.push('route response contract changed');
    const worker = sources['src/workers/archive.ts'] ?? '';
    if (!worker.includes('withRetry(() =>') || !worker.includes("status: 'archived'")) failures.push('worker retry/archive behavior changed');
    for (const [path, content] of protectedBefore) {
      if (readFileSync(join(root, path), 'utf8') !== content) failures.push(`${path} changed`);
    }
    return failures.length === 0
      ? { status: 'pass', detail: 'All scattered writes use Ablo and required application behavior remains.' }
      : { status: 'fail', detail: failures.join('; ') };
  },
};

const typecheckVerifier: SetupEvalVerifier = {
  id: 'typescript',
  async verify({ applicationRoot: root }) {
    const tsc = resolve(packageRoot, '../../node_modules/.bin/tsc');
    const result = spawnSync(tsc, [
      '--noEmit', '--strict', '--target', 'ES2022', '--module', 'ESNext',
      '--moduleResolution', 'Bundler', ...candidateFiles, join(root, 'src/ablo.ts'),
      join(root, 'src/auth.ts'), join(root, 'src/db.ts'),
    ], { cwd: root, encoding: 'utf8', timeout: 30_000 });
    return result.status === 0
      ? { status: 'pass', detail: 'Strict TypeScript checking passed.' }
      : { status: 'fail', detail: `TypeScript exited ${result.status ?? 'without a code'}.` };
  },
};

const result = await runSetupWritePathEval({
  caseId: basename(fixtureSource),
  record,
  runner,
  verifiers: [semanticVerifier, typecheckVerifier],
  timeoutMs: Number(process.env.ABLO_SETUP_EVAL_TIMEOUT_MS ?? 20 * 60_000),
});
const encoded = `${JSON.stringify(result, null, 2)}\n`;
if (process.env.ABLO_SETUP_EVAL_OUTPUT) writeFileSync(resolve(process.env.ABLO_SETUP_EVAL_OUTPUT), encoded);
process.stdout.write(encoded);
if (result.outcome !== 'passed') process.exitCode = 1;
