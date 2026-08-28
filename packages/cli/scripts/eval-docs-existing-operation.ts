import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import {
  SETUP_CONTRACT_VERSION,
  setupAdaptationTaskSchema,
} from '../src/setup/contracts';
import { gradeExistingOperationCoordination } from '../src/setup/docsEval';
import {
  runSetupWritePathEval,
  type SetupEvalVerifier,
} from '../src/setup/evalHarness';
import { createAiGatewaySetupEvalRunner } from './lib/ai-gateway-setup-eval-runner';
import {
  buildDocsEvalBundle,
  discoverPublicDocsEvalPages,
} from './lib/docs-eval-bundle';

const packageRoot = resolve(import.meta.dirname, '..');
const repositoryRoot = resolve(packageRoot, '../..');
const publicDocsRoot = join(repositoryRoot, 'packages/ablo/docs');
const fixtureSource = join(packageRoot, 'evals/fixtures/existing-operation-coordination');
const evalRoot = mkdtempSync(join(tmpdir(), 'ablo-docs-eval-'));
const applicationRoot = join(evalRoot, 'application');
cpSync(fixtureSource, applicationRoot, { recursive: true });

const record = setupAdaptationTaskSchema.parse({
  schemaVersion: SETUP_CONTRACT_VERSION,
  kind: 'ablo_setup_adaptation_task',
  recordId: 'docs-existing-operation-coordination-v1',
  actionId: 'coordinate_existing_operation',
  repositoryRoot: applicationRoot,
  applicationRoot,
  selectedModels: ['taskRuns'],
  discoveryHints: [],
  scope: {
    allowedRoot: applicationRoot,
    mustExploreBeyondHints: true,
    mayReadEnvironmentValues: false,
    maximumMutation: 'local_write',
  },
  objective: 'Two workers can complete the same task at the same time, and both run the expensive sandbox preparation. Add Ablo so only one prepares each task. The prepared result should still go through the app\'s existing completion path. Keep the change small.',
  constraints: [
    'Use the existing Ablo wiring.',
    'Preserve the public result, authorization, GraphQL resolver, and existing Postgres transaction.',
    'Do not install dependencies or perform network, database, credential, or external effects.',
  ],
  acceptanceCriteria: [
    'Concurrent attempts for one task do not both perform sandbox preparation.',
    'A contender returns the existing skipped result without preparing.',
    'Failure does not permanently prevent a later attempt.',
    'Pass strict TypeScript checking without changing protected ownership boundaries.',
  ],
});

const protectedPaths = [
  'src/ablo.ts',
  'src/auth.ts',
  'src/db.ts',
  'src/tasks/contract.ts',
  'src/tasks/existingTaskService.ts',
  'src/graphql/resolver.ts',
  'package.json',
  'README.md',
] as const;
const protectedBefore = new Map(protectedPaths.map((path) => [
  path,
  readFileSync(join(applicationRoot, path), 'utf8'),
]));

const semanticVerifier: SetupEvalVerifier = {
  id: 'existing-operation-semantics',
  async verify({ applicationRoot: root }) {
    const operationPath = 'src/tasks/completeTask.ts';
    const source = readFileSync(join(root, operationPath), 'utf8');
    const protectedChanges = [...protectedBefore].flatMap(([path, content]) =>
      readFileSync(join(root, path), 'utf8') === content ? [] : [path]
    );
    const findings = gradeExistingOperationCoordination({
      source,
      operationPath,
      protectedChanges,
    });
    return findings.length === 0
      ? {
          status: 'pass',
          detail: 'Identifier coordination wraps preparation and preserves the existing operation and owners.',
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
  id: 'typescript',
  async verify({ applicationRoot: root }) {
    const tsc = resolve(repositoryRoot, 'node_modules/.bin/tsc');
    const result = spawnSync(tsc, ['-p', 'tsconfig.json'], {
      cwd: root,
      encoding: 'utf8',
      timeout: 30_000,
    });
    return result.status === 0
      ? { status: 'pass', detail: 'Strict TypeScript checking passed.', findings: [] }
      : {
          status: 'fail',
          detail: `TypeScript exited ${result.status ?? 'without a code'}.`,
          findings: [{
            code: 'typescript_failed',
            detail: 'The resulting integration does not typecheck.',
            evidencePaths: [],
          }],
        };
  },
};

const documentationRoutingVerifier: SetupEvalVerifier = {
  id: 'documentation-routing',
  async verify({ agent }) {
    const reads = agent.telemetry?.documentationReads ?? [];
    const destination = 'references/coordinate-existing-work.md';
    const destinationIndex = reads.indexOf(destination);
    if (destinationIndex < 0) {
      return {
        status: 'fail',
        detail: `The agent read ${reads.length} documentation page(s) without reaching the existing-operation guide.`,
        findings: [{
          code: 'documentation_route_not_found',
          detail: 'A routing page is not the destination; this task is owned by the existing-operation guide.',
          evidencePaths: [...reads],
        }],
      };
    }
    return {
      status: 'pass',
      detail: `The agent reached the existing-operation guide after ${destinationIndex} other page(s).`,
      findings: [],
    };
  },
};

const documentationAccess = process.env.ABLO_DOCS_EVAL_ACCESS === 'browsable'
  ? 'browsable'
  : 'injected';
const bundle = buildDocsEvalBundle({
  record,
  pages: documentationAccess === 'browsable'
    ? discoverPublicDocsEvalPages(publicDocsRoot)
    : [{
        path: join(publicDocsRoot, 'coordinate-existing-work.md'),
        name: 'coordinate-existing-work.md',
      }],
});
const model = process.env.ABLO_DOCS_EVAL_MODEL;
if (!process.env.AI_GATEWAY_API_KEY || !model) {
  process.stderr.write(
    'A real stateless docs eval requires AI_GATEWAY_API_KEY and ABLO_DOCS_EVAL_MODEL (for example openai/gpt-5-mini).\n',
  );
  process.exit(2);
}
const result = await runSetupWritePathEval({
  caseId: documentationAccess === 'browsable'
    ? `${basename(fixtureSource)}-docs-discovery`
    : basename(fixtureSource),
  record,
  bundle,
  runner: createAiGatewaySetupEvalRunner(model, {
    documentationAccess,
    taskPresentation: 'user-request',
  }),
  verifiers: [
    ...(documentationAccess === 'browsable' ? [documentationRoutingVerifier] : []),
    semanticVerifier,
    typecheckVerifier,
  ],
  timeoutMs: Number(process.env.ABLO_SETUP_EVAL_TIMEOUT_MS ?? 20 * 60_000),
});
const encoded = `${JSON.stringify(result, null, 2)}\n`;
if (process.env.ABLO_SETUP_EVAL_OUTPUT) {
  writeFileSync(resolve(process.env.ABLO_SETUP_EVAL_OUTPUT), encoded);
}
process.stdout.write(encoded);
if (result.outcome !== 'passed') process.exitCode = 1;
