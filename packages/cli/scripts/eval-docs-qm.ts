import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  SETUP_CONTRACT_VERSION,
  setupAdaptationTaskSchema,
} from '../src/setup/contracts';
import {
  runSetupWritePathEval,
  type SetupEvalVerifier,
} from '../src/setup/evalHarness';
import { createAiGatewaySetupEvalRunner } from './lib/ai-gateway-setup-eval-runner';
import { buildDocsEvalBundle } from './lib/docs-eval-bundle';

const QM_URL = 'https://github.com/yc-software/qm.git';
const QM_COMMIT = '9ff90fc770d60658ae6c350b691204b5a5b3e394';
const TASK_STORE = 'src/tasks/postgres-task-store.ts';
const packageRoot = resolve(import.meta.dirname, '..');
const repositoryRoot = resolve(packageRoot, '../..');

function fetchPinnedQm(): string {
  const supplied = process.env.ABLO_SETUP_BENCHMARK_YC_SOFTWARE_QM_ROOT;
  if (supplied) return realpathSync(resolve(supplied));
  const parent = mkdtempSync(join(tmpdir(), 'ablo-docs-qm-source-'));
  const root = join(parent, 'repository');
  mkdirSync(root);
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  execFileSync('git', ['remote', 'add', 'origin', QM_URL], { cwd: root });
  execFileSync('git', ['fetch', '--quiet', '--depth', '1', 'origin', QM_COMMIT], {
    cwd: root,
    timeout: 120_000,
  });
  execFileSync('git', ['checkout', '--quiet', '--detach', 'FETCH_HEAD'], { cwd: root });
  return root;
}

const sourceRoot = fetchPinnedQm();
function createApplicationRoot(): string {
  const applicationRoot = join(mkdtempSync(join(tmpdir(), 'ablo-docs-qm-eval-')), 'qm');
  cpSync(sourceRoot, applicationRoot, { recursive: true, verbatimSymlinks: true });
  const observedCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: applicationRoot,
    encoding: 'utf8',
  }).trim();
  if (observedCommit !== QM_COMMIT) {
    throw new Error(`QM docs eval requires ${QM_COMMIT}; observed ${observedCommit}.`);
  }
  return applicationRoot;
}

function buildRecord(applicationRoot: string) {
  return setupAdaptationTaskSchema.parse({
  schemaVersion: SETUP_CONTRACT_VERSION,
  kind: 'ablo_setup_adaptation_task',
  recordId: 'docs-qm-transaction-boundary-v1',
  actionId: 'evaluate_task_transition_coordination',
  repositoryRoot: applicationRoot,
  applicationRoot,
  selectedModels: ['tasks'],
  databaseMappings: [],
  discoveryHints: [{
    path: TASK_STORE,
    line: 126,
    kind: 'sql',
    operation: 'sql_write',
    modelHint: 'tasks',
    confidence: 'high',
  }],
  scope: {
    allowedRoot: applicationRoot,
    mustExploreBeyondHints: true,
    mayReadEnvironmentValues: false,
    maximumMutation: 'local_write',
  },
  objective: 'Evaluate whether QM task status transitions should be moved through Ablo so concurrent agents cannot both complete the same transition. Implement the smallest correct integration only if the supplied public API preserves the existing conditional update and task-event atomicity. Otherwise report the exact blocker and make no edits.',
  constraints: [
    'Preserve QM public TaskStore behavior and its pinned upstream ownership structure.',
    'The conditional task update and matching task_events insert must remain one Postgres transaction.',
    'Do not install dependencies or perform network, database, credential, or external effects.',
    'Use only the supplied public Ablo documentation for Ablo behavior.',
  ],
  acceptanceCriteria: [
    'No two callers can both win the same expected-status transition.',
    'A successful status change and its task event remain atomic.',
    'A rejected transition still returns null without an event.',
    'If the public API cannot preserve all three properties, the run reports blocked and leaves the repository pristine.',
  ],
  });
}

const boundaryVerifier: SetupEvalVerifier = {
  id: 'qm-pinned-transaction-boundary',
  async verify({ applicationRoot: root }) {
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    const dirty = execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], {
      cwd: root,
      encoding: 'utf8',
    }).trim();
    const source = readFileSync(join(root, TASK_STORE), 'utf8');
    const preservesBoundary = source.includes('await client.query("BEGIN")')
      && source.includes('WHERE id = $1 AND status = $2 RETURNING *')
      && source.includes("'status_changed'")
      && source.includes('await client.query("COMMIT")');
    const findings = [
      ...(commit === QM_COMMIT ? [] : [{
        code: 'unpinned_repository',
        detail: `Expected QM ${QM_COMMIT}; observed ${commit}.`,
        evidencePaths: [],
      }]),
      ...(dirty === '' ? [] : [{
        code: 'unexpected_repository_edit',
        detail: 'The agent edited QM despite the unsupported cross-system transaction boundary.',
        evidencePaths: dirty.split('\n').filter(Boolean).map((line) => line.slice(3)),
      }]),
      ...(preservesBoundary ? [] : [{
        code: 'transaction_boundary_changed',
        detail: 'QM conditional update and task-event insert no longer retain their upstream transaction boundary.',
        evidencePaths: [TASK_STORE],
      }]),
    ];
    return findings.length === 0
      ? {
          status: 'pass',
          detail: 'Pinned QM remained pristine and retained its conditional update plus event transaction.',
          findings: [],
        }
      : { status: 'fail', detail: findings.map(({ detail }) => detail).join('; '), findings };
  },
};

const models = (process.env.ABLO_DOCS_EVAL_MODELS
  ?? 'openai/gpt-5.6-sol,anthropic/claude-opus-5')
  .split(',')
  .map((model) => model.trim())
  .filter(Boolean);
if (!process.env.AI_GATEWAY_API_KEY) {
  process.stderr.write('AI_GATEWAY_API_KEY is required for the real QM model matrix.\n');
  process.exit(2);
}

const results = [];
for (const model of models) {
  const applicationRoot = createApplicationRoot();
  const record = buildRecord(applicationRoot);
  const bundle = buildDocsEvalBundle({
    record,
    pages: [{
      path: join(repositoryRoot, 'packages/ablo/docs/coordinate-existing-work.md'),
      name: 'coordinate-existing-work.md',
    }],
  });
  const result = await runSetupWritePathEval({
    caseId: `yc-software-qm-transaction-boundary:${model}`,
    record,
    bundle,
    runner: createAiGatewaySetupEvalRunner(model),
    verifiers: [boundaryVerifier],
    expectedOutcome: 'blocked',
    timeoutMs: Number(process.env.ABLO_SETUP_EVAL_TIMEOUT_MS ?? 20 * 60_000),
  });
  results.push(result);
}
const encoded = `${JSON.stringify({
  schemaVersion: 1,
  kind: 'ablo_setup_model_matrix',
  provider: 'vercel-ai-gateway',
  repository: { url: QM_URL, commit: QM_COMMIT },
  results,
}, null, 2)}\n`;
if (process.env.ABLO_SETUP_EVAL_OUTPUT) {
  writeFileSync(resolve(process.env.ABLO_SETUP_EVAL_OUTPUT), encoded);
}
process.stdout.write(encoded);
if (results.some(({ outcome }) => outcome !== 'blocked')) process.exitCode = 1;
