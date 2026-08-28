import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setupEvalResultSchema, type SetupEvalResult } from '../src/setup/contracts';

const packageRoot = resolve(import.meta.dirname, '..');
const repositoryRoot = resolve(packageRoot, '../..');
const childScript = join(packageRoot, 'scripts/eval-docs-existing-operation.ts');
const tsxLoader = join(repositoryRoot, 'node_modules/tsx/dist/loader.mjs');
const runId = new Date().toISOString().replace(/[:.]/g, '-');
const resultsRoot = resolve(
  process.env.ABLO_DOCS_EVAL_RESULTS_DIR
    ?? join(repositoryRoot, 'packages/evals/results/docs-discovery', runId),
);
const models = (process.env.ABLO_DOCS_EVAL_MODELS
  ?? 'openai/gpt-5.6-sol,anthropic/claude-haiku-4.5')
  .split(',')
  .map((model) => model.trim())
  .filter(Boolean);
const runs = Number(process.env.ABLO_DOCS_EVAL_RUNS ?? 3);

if (!process.env.AI_GATEWAY_API_KEY) {
  throw new Error('AI_GATEWAY_API_KEY is required for the discovery matrix.');
}
if (!Number.isInteger(runs) || runs < 1) {
  throw new Error('ABLO_DOCS_EVAL_RUNS must be a positive integer.');
}

mkdirSync(resultsRoot, { recursive: true });

interface Attempt {
  readonly model: string;
  readonly run: number;
  readonly resultFile: string;
  readonly result: SetupEvalResult;
}

const attempts: Attempt[] = [];
const owningGuide = 'references/coordinate-existing-work.md';
for (const model of models) {
  for (let run = 1; run <= runs; run += 1) {
    const safeModel = model.replace(/[^a-z0-9.-]+/gi, '_');
    const resultFile = join(resultsRoot, `${safeModel}.run-${run}.json`);
    process.stdout.write(`  ${model} run ${run}/${runs} ... `);
    const child = spawnSync(
      process.execPath,
      ['--import', tsxLoader, childScript],
      {
        cwd: repositoryRoot,
        encoding: 'utf8',
        timeout: Number(process.env.ABLO_SETUP_EVAL_TIMEOUT_MS ?? 20 * 60_000),
        maxBuffer: 20 * 1024 * 1024,
        env: {
          ...process.env,
          ABLO_DOCS_EVAL_ACCESS: 'browsable',
          ABLO_DOCS_EVAL_MODEL: model,
          ABLO_SETUP_EVAL_OUTPUT: resultFile,
        },
      },
    );
    if (!readFileExists(resultFile)) {
      throw new Error(
        `Discovery child produced no result for ${model} run ${run}: ${child.stderr.slice(0, 1000)}`,
      );
    }
    const result = setupEvalResultSchema.parse(JSON.parse(readFileSync(resultFile, 'utf8')));
    attempts.push({ model, run, resultFile, result });
    const routing = result.verification.find(({ id }) => id === 'documentation-routing')?.status;
    const implementation = result.verification
      .filter(({ id }) => id !== 'documentation-routing')
      .every(({ status }) => status === 'pass');
    process.stdout.write(`${result.outcome.toUpperCase()} routing=${routing ?? 'missing'} implementation=${implementation ? 'pass' : 'fail'}\n`);
  }
}

function readFileExists(path: string): boolean {
  try {
    readFileSync(path, 'utf8');
    return true;
  } catch {
    return false;
  }
}

function rate(count: number, total: number): number {
  return total === 0 ? 0 : count / total;
}

const summary = models.map((model) => {
  const selected = attempts.filter((attempt) => attempt.model === model);
  const overallPassed = selected.filter(({ result }) => result.outcome === 'passed').length;
  const routingPassed = selected.filter(({ result }) =>
    result.verification.find(({ id }) => id === 'documentation-routing')?.status === 'pass'
  ).length;
  const implementationPassed = selected.filter(({ result }) =>
    result.verification
      .filter(({ id }) => id !== 'documentation-routing')
      .every(({ status }) => status === 'pass')
  ).length;
  const documentationReads = selected.map(({ result }) =>
    result.agent.telemetry?.documentationReads.length ?? 0
  );
  const documentationReadWords = selected.map(({ result }) =>
    result.agent.telemetry?.documentationReadWords ?? 0
  );
  const pagesBeforeOwningGuide = selected.map(({ result }) => {
    const index = result.agent.telemetry?.documentationReads.indexOf(owningGuide) ?? -1;
    return index < 0 ? null : index;
  });
  const routedPages = pagesBeforeOwningGuide.filter((value): value is number => value !== null);
  return {
    model,
    attempts: selected.length,
    overallPassRate: rate(overallPassed, selected.length),
    routingPassRate: rate(routingPassed, selected.length),
    implementationPassRate: rate(implementationPassed, selected.length),
    averageDocumentationReads: documentationReads.reduce((sum, value) => sum + value, 0) / selected.length,
    averageDocumentationReadWords: documentationReadWords.reduce((sum, value) => sum + value, 0) / selected.length,
    averagePagesBeforeOwningGuide: routedPages.length === 0
      ? null
      : routedPages.reduce((sum, value) => sum + value, 0) / routedPages.length,
    maximumPagesBeforeOwningGuide: routedPages.length === 0 ? null : Math.max(...routedPages),
  };
});

const aggregate = {
  schemaVersion: 1,
  kind: 'ablo_docs_discovery_matrix',
  runId,
  provider: 'vercel-ai-gateway',
  runsPerModel: runs,
  models,
  summary,
  attempts: attempts.map(({ model, run, resultFile, result }) => ({
    model,
    run,
    resultFile,
    outcome: result.outcome,
    routing: result.verification.find(({ id }) => id === 'documentation-routing') ?? null,
    implementationPassed: result.verification
      .filter(({ id }) => id !== 'documentation-routing')
      .every(({ status }) => status === 'pass'),
    documentationReads: result.agent.telemetry?.documentationReads ?? [],
    documentationSearches: result.agent.telemetry?.documentationSearches ?? [],
  })),
};
const aggregatePath = join(resultsRoot, 'matrix.json');
writeFileSync(aggregatePath, `${JSON.stringify(aggregate, null, 2)}\n`);
process.stdout.write(`\n${JSON.stringify(summary, null, 2)}\nresults: ${aggregatePath}\n`);
if (summary.some(({ overallPassRate }) => overallPassRate < 1)) process.exitCode = 1;
