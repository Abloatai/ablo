import { execFileSync, spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import {
  SETUP_CONTRACT_VERSION,
  setupAdaptationTaskSchema,
} from '../src/setup/contracts';
import { gradeSandcastleIssueCoordination } from '../src/setup/docsEval';
import {
  runSetupWritePathEval,
  type SetupEvalVerifier,
} from '../src/setup/evalHarness';
import { captureSetupWorkspace } from '../src/setup/evaluation';
import { createAiGatewaySetupEvalRunner } from './lib/ai-gateway-setup-eval-runner';
import {
  buildDocsEvalBundle,
  discoverPublicDocsEvalPages,
} from './lib/docs-eval-bundle';

const SANDCASTLE_URL = 'https://github.com/mattpocock/sandcastle.git';
const SANDCASTLE_COMMIT = 'e99f832f26dc9d245c019a9ddd19fa5dee792427';
const TARGET = 'src/templates/parallel-planner/main.mts';
const WIRING = 'src/templates/parallel-planner/ablo.mts';
const OWNER_GUIDE = 'references/coordinate-existing-work.md';
const packageRoot = resolve(import.meta.dirname, '..');
const repositoryRoot = resolve(packageRoot, '../..');
const publicDocsRoot = join(repositoryRoot, 'packages/ablo/docs');
const wiringSeed = join(packageRoot, 'evals/seeds/sandcastle-parallel-planner/ablo.mts');

function observedCommit(root: string): string {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
}

function fetchPinnedSandcastle(): string {
  const supplied = process.env.ABLO_DOCS_EVAL_SANDCASTLE_ROOT;
  if (supplied) {
    const root = realpathSync(resolve(supplied));
    if (observedCommit(root) !== SANDCASTLE_COMMIT) {
      throw new Error(`Sandcastle docs eval requires ${SANDCASTLE_COMMIT}.`);
    }
    if (!existsSync(join(root, 'node_modules/.bin/tsgo'))) {
      throw new Error('The supplied Sandcastle checkout needs npm ci --ignore-scripts before this eval.');
    }
    return root;
  }
  const parent = mkdtempSync(join(tmpdir(), 'ablo-docs-sandcastle-source-'));
  const root = join(parent, 'repository');
  mkdirSync(root);
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  execFileSync('git', ['remote', 'add', 'origin', SANDCASTLE_URL], { cwd: root });
  execFileSync('git', ['fetch', '--quiet', '--depth', '1', 'origin', SANDCASTLE_COMMIT], {
    cwd: root,
    timeout: 120_000,
  });
  execFileSync('git', ['checkout', '--quiet', '--detach', 'FETCH_HEAD'], { cwd: root });
  execFileSync('npm', ['ci', '--ignore-scripts'], { cwd: root, timeout: 180_000 });
  return root;
}

const sourceRoot = fetchPinnedSandcastle();

function createApplicationRoot(): string {
  const applicationRoot = join(mkdtempSync(join(tmpdir(), 'ablo-docs-sandcastle-eval-')), 'sandcastle');
  cpSync(sourceRoot, applicationRoot, {
    recursive: true,
    verbatimSymlinks: true,
    filter: (source) => !['.git', 'node_modules'].includes(basename(source)),
  });
  symlinkSync(join(sourceRoot, 'node_modules'), join(applicationRoot, 'node_modules'), 'dir');
  cpSync(wiringSeed, join(applicationRoot, WIRING));
  return applicationRoot;
}

function buildRecord(applicationRoot: string) {
  return setupAdaptationTaskSchema.parse({
    schemaVersion: SETUP_CONTRACT_VERSION,
    kind: 'ablo_setup_adaptation_task',
    recordId: 'docs-sandcastle-parallel-planner-v1',
    actionId: 'coordinate_parallel_issue_implementation',
    repositoryRoot: applicationRoot,
    applicationRoot,
    selectedModels: ['taskRuns'],
    databaseMappings: [],
    discoveryHints: [],
    scope: {
      allowedRoot: applicationRoot,
      mustExploreBeyondHints: true,
      mayReadEnvironmentValues: false,
      maximumMutation: 'local_write',
    },
    objective: 'Two copies of Sandcastle\'s shipped `parallel-planner` template can select and implement the same issue at once. Use the existing Ablo wiring so only one copy runs the implementer for each issue. A contender should skip that issue, and completed work must still use the template\'s existing branch merge flow. Keep the change to this template and keep it small.',
    constraints: [
      'Preserve Sandcastle planning, per-issue branches, and its existing merge phase.',
      'Do not install dependencies or perform network, sandbox, credential, or external effects.',
      'Use only the supplied public Ablo documentation for Ablo behavior.',
    ],
    acceptanceCriteria: [
      'Concurrent planner processes do not both run the implementer for one issue ID.',
      'A contended issue produces no completed branch for this planner to merge.',
      'Failures release coordination so a later planner can retry.',
      'The pinned repository still passes strict TypeScript checking.',
    ],
  });
}

function changedOutsideTarget(
  before: ReturnType<typeof captureSetupWorkspace>,
  after: ReturnType<typeof captureSetupWorkspace>,
): string[] {
  const oldFiles = new Map(before.files.map((file) => [file.path, file.fingerprint]));
  const newFiles = new Map(after.files.map((file) => [file.path, file.fingerprint]));
  return [...new Set([...oldFiles.keys(), ...newFiles.keys()])]
    .filter((path) => path !== TARGET)
    .filter((path) => oldFiles.get(path) !== newFiles.get(path))
    .sort();
}

const models = (process.env.ABLO_DOCS_EVAL_MODELS
  ?? 'openai/gpt-5.6-sol,anthropic/claude-haiku-4.5')
  .split(',')
  .map((model) => model.trim())
  .filter(Boolean);
const runs = Number(process.env.ABLO_DOCS_EVAL_RUNS ?? 1);
if (!process.env.AI_GATEWAY_API_KEY) {
  process.stderr.write('AI_GATEWAY_API_KEY is required for the Sandcastle docs eval.\n');
  process.exit(2);
}
if (!Number.isInteger(runs) || runs < 1) {
  throw new Error('ABLO_DOCS_EVAL_RUNS must be a positive integer.');
}

const results = [];
for (const model of models) {
  for (let run = 1; run <= runs; run += 1) {
    const applicationRoot = createApplicationRoot();
    const record = buildRecord(applicationRoot);
    const protectedBefore = captureSetupWorkspace(applicationRoot);
    const semanticVerifier: SetupEvalVerifier = {
      id: 'sandcastle-issue-coordination',
      async verify({ applicationRoot: root }) {
        const findings = gradeSandcastleIssueCoordination({
          source: readFileSync(join(root, TARGET), 'utf8'),
          operationPath: TARGET,
          protectedChanges: changedOutsideTarget(protectedBefore, captureSetupWorkspace(root)),
        });
        return findings.length === 0
          ? {
              status: 'pass',
              detail: 'Issue coordination wraps the real implementer and preserves Sandcastle branch merging.',
              findings: [],
            }
          : {
              status: 'fail',
              detail: findings.map(({ detail }) => detail).join('; '),
              findings: [...findings],
            };
      },
    };
    const typecheckVerifier: SetupEvalVerifier = {
      id: 'sandcastle-typescript',
      async verify({ applicationRoot: root }) {
        const result = spawnSync(
          resolve(repositoryRoot, 'node_modules/.bin/tsc'),
          ['-p', 'tsconfig.json', '--noEmit'],
          {
          cwd: root,
          encoding: 'utf8',
          timeout: 60_000,
          },
        );
        return result.status === 0
          ? { status: 'pass', detail: 'Pinned Sandcastle strict TypeScript checking passed.', findings: [] }
          : {
              status: 'fail',
              detail: `${result.stdout}${result.stderr}`.slice(0, 2_000),
              findings: [{
                code: 'sandcastle_typescript_failed',
                detail: 'The resulting pinned Sandcastle repository does not typecheck.',
                evidencePaths: [TARGET],
              }],
            };
      },
    };
    const routingVerifier: SetupEvalVerifier = {
      id: 'documentation-routing',
      async verify({ agent }) {
        const reads = agent.telemetry?.documentationReads ?? [];
        const index = reads.indexOf(OWNER_GUIDE);
        return index >= 0
          ? { status: 'pass', detail: `The agent reached the owning guide after ${index} other page(s).`, findings: [] }
          : {
              status: 'fail',
              detail: `The agent read ${reads.length} page(s) without reaching the existing-operation guide.`,
              findings: [{
                code: 'documentation_route_not_found',
                detail: 'The existing-operation guide owns identifier coordination around this operation.',
                evidencePaths: [...reads],
              }],
            };
      },
    };
    results.push(await runSetupWritePathEval({
      caseId: `sandcastle-parallel-planner:${model}:run-${run}`,
      record,
      bundle: buildDocsEvalBundle({
        record,
        pages: discoverPublicDocsEvalPages(publicDocsRoot),
      }),
      runner: createAiGatewaySetupEvalRunner(model, {
        documentationAccess: 'browsable',
        taskPresentation: 'user-request',
      }),
      verifiers: [routingVerifier, semanticVerifier, typecheckVerifier],
      timeoutMs: Number(process.env.ABLO_SETUP_EVAL_TIMEOUT_MS ?? 20 * 60_000),
    }));
  }
}

const encoded = `${JSON.stringify({
  schemaVersion: 1,
  kind: 'ablo_docs_real_repository_matrix',
  provider: 'vercel-ai-gateway',
  repository: { url: SANDCASTLE_URL, commit: SANDCASTLE_COMMIT },
  seed: { path: WIRING, source: 'existing reviewed application wiring' },
  runsPerModel: runs,
  results,
}, null, 2)}\n`;
if (process.env.ABLO_SETUP_EVAL_OUTPUT) {
  writeFileSync(resolve(process.env.ABLO_SETUP_EVAL_OUTPUT), encoded);
}
process.stdout.write(encoded);
if (results.some(({ outcome }) => outcome !== 'passed')) process.exitCode = 1;
