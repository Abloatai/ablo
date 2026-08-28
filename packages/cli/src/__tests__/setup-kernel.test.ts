import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import {
  SETUP_CONTRACT_VERSION,
  setupAdaptationTaskSchema,
  setupAgentBundleSchema,
  setupDiffEvaluationSchema,
  setupEvalResultSchema,
  setupPlanSchema,
  setupStepResultSchema,
} from '../setup/contracts';
import { discoverMutationSites, discoverSetupPlan } from '../setup/discover';
import { executeSetupProgram, type SetupProgram } from '../setup/program';
import { readSetupCheckpoint, writeSetupCheckpointAtomic } from '../setup/checkpoint';
import { resolveRuntimeApiKeyReadOnly } from '../config';
import { buildWritePathAdaptationTask } from '../setup/adaptation';
import { buildSetupAgentBundle } from '../setup/skill';
import { captureSetupWorkspace, evaluateSetupDiff } from '../setup/evaluation';
import { runSetupWritePathEval } from '../setup/evalHarness';
import {
  analyzeSetupCompatibility,
  discoverDatabaseColumnsFromSqlSource,
  discoverTransactionalRequirementsFromSqlSource,
} from '../setup/compatibility';

function complete(stepId: string) {
  const at = new Date(0).toISOString();
  return setupStepResultSchema.parse({
    stepId,
    status: 'complete',
    summary: `${stepId} complete`,
    facts: [],
    decisions: [],
    actions: [],
    startedAt: at,
    finishedAt: at,
  });
}

describe('setup program kernel', () => {
  it('blocks a dependent step when its prerequisite is incomplete', async () => {
    let dependentRan = false;
    const at = new Date(0).toISOString();
    const program: SetupProgram<Record<string, never>> = {
      id: 'test-program',
      steps: [
        {
          id: 'choose',
          label: 'Choose target',
          mutation: 'read_only',
          approval: 'none',
          run: () => setupStepResultSchema.parse({
            stepId: 'choose',
            status: 'incomplete',
            summary: 'A choice is required.',
            next: 'Choose one.',
            facts: [], decisions: [], actions: [], startedAt: at, finishedAt: at,
          }),
        },
        {
          id: 'apply',
          label: 'Apply changes',
          mutation: 'local_write',
          approval: 'review',
          dependsOn: ['choose'],
          run: () => {
            dependentRan = true;
            return complete('apply');
          },
        },
      ],
    };

    const results = await executeSetupProgram(
      program,
      { repositoryRoot: '/project', state: {} },
      { now: () => new Date(0) },
    );

    expect(dependentRan).toBe(false);
    expect(results.map(({ status }) => status)).toEqual(['incomplete', 'blocked']);
  });

  it('writes and validates an atomic checkpoint inside the project', () => {
    const root = mkdtempSync(join(tmpdir(), 'ablo-setup-checkpoint-'));
    const at = new Date(0).toISOString();
    const checkpoint = {
      schemaVersion: SETUP_CONTRACT_VERSION,
      kind: 'ablo_setup_checkpoint' as const,
      programId: 'test-program',
      repositoryRoot: root,
      createdAt: at,
      updatedAt: at,
      completedStepIds: ['inspect'],
      results: [complete('inspect')],
    };

    const path = writeSetupCheckpointAtomic(root, checkpoint);

    expect(path).toBe(join(root, '.ablo/setup-checkpoint.json'));
    expect(readSetupCheckpoint(root)).toEqual(checkpoint);
    expect(() => writeSetupCheckpointAtomic(root, checkpoint, '../escape.json')).toThrow(
      'inside the project root',
    );
  });

  it('resumes completed steps without running them again', async () => {
    const root = '/project';
    const at = new Date(0).toISOString();
    let inspectRan = false;
    const program: SetupProgram<Record<string, never>> = {
      id: 'resume-program',
      steps: [
        {
          id: 'inspect',
          label: 'Inspect',
          mutation: 'read_only',
          approval: 'none',
          run: () => {
            inspectRan = true;
            return complete('inspect');
          },
        },
        {
          id: 'plan',
          label: 'Plan',
          mutation: 'read_only',
          approval: 'none',
          dependsOn: ['inspect'],
          run: () => complete('plan'),
        },
      ],
    };

    const results = await executeSetupProgram(
      program,
      { repositoryRoot: root, state: {} },
      {
        now: () => new Date(0),
        resumeFrom: {
          schemaVersion: SETUP_CONTRACT_VERSION,
          kind: 'ablo_setup_checkpoint',
          programId: 'resume-program',
          repositoryRoot: root,
          createdAt: at,
          updatedAt: at,
          completedStepIds: ['inspect'],
          results: [complete('inspect')],
        },
      },
    );

    expect(inspectRan).toBe(false);
    expect(results.map(({ stepId }) => stepId)).toEqual(['inspect', 'plan']);
  });

  it('enforces typed preconditions and does not run a declined step', async () => {
    const at = new Date(0).toISOString();
    let ran = false;
    const program: SetupProgram<Record<string, never>> = {
      id: 'precondition-program',
      steps: [{
        id: 'write',
        label: 'Write files',
        mutation: 'local_write',
        approval: 'review',
        precondition: () => setupStepResultSchema.parse({
          stepId: 'write',
          status: 'blocked',
          summary: 'Reviewed target changed.',
          blockers: ['precondition:target_digest'],
          next: 'Re-plan before applying.',
          facts: [], decisions: [], actions: [], startedAt: at, finishedAt: at,
        }),
        run: () => {
          ran = true;
          return complete('write');
        },
      }],
    };

    const results = await executeSetupProgram(
      program,
      { repositoryRoot: '/project', state: {} },
      { now: () => new Date(0) },
    );

    expect(ran).toBe(false);
    expect(results[0]?.status).toBe('blocked');
  });

  it('runs registered cleanups in reverse order even when a step fails', async () => {
    const cleaned: string[] = [];
    const program: SetupProgram<Record<string, never>> = {
      id: 'cleanup-program',
      steps: [{
        id: 'temporary',
        label: 'Temporary work',
        mutation: 'local_write',
        approval: 'review',
        run: ({ registerCleanup }) => {
          registerCleanup(() => { cleaned.push('first'); });
          registerCleanup(() => { cleaned.push('second'); });
          throw new Error('step failed');
        },
      }],
    };

    await expect(executeSetupProgram(
      program,
      { repositoryRoot: '/project', state: {} },
    )).rejects.toThrow('step failed');
    expect(cleaned).toEqual(['second', 'first']);
  });

  it('reads a legacy credential layout without migrating it during planning', () => {
    const configDir = mkdtempSync(join(tmpdir(), 'ablo-setup-config-'));
    const configPath = join(configDir, 'config.json');
    const original = '{"mode":"sandbox","apiKey":"sk_test_legacy"}\n';
    writeFileSync(configPath, original);
    const previous = process.env.ABLO_CONFIG_DIR;
    const previousApiKey = process.env.ABLO_API_KEY;
    process.env.ABLO_CONFIG_DIR = configDir;
    delete process.env.ABLO_API_KEY;
    try {
      expect(resolveRuntimeApiKeyReadOnly()).toEqual({
        key: 'sk_test_legacy',
        source: 'stored',
      });
      expect(readFileSync(configPath, 'utf8')).toBe(original);
      expect(existsSync(join(configDir, 'credentials.json'))).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.ABLO_CONFIG_DIR;
      else process.env.ABLO_CONFIG_DIR = previous;
      if (previousApiKey === undefined) delete process.env.ABLO_API_KEY;
      else process.env.ABLO_API_KEY = previousApiKey;
    }
  });
});

describe('read-only setup discovery', () => {
  function project(): string {
    const root = mkdtempSync(join(tmpdir(), 'ablo-setup-plan-'));
    mkdirSync(join(root, 'app'), { recursive: true });
    writeFileSync(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
    writeFileSync(join(root, 'package.json'), JSON.stringify({
      name: 'fixture-app',
      dependencies: {
        next: '16.0.0',
        '@clerk/nextjs': '7.0.0',
        '@prisma/client': '7.0.0',
      },
    }));
    writeFileSync(
      join(root, '.env.local'),
      'DATABASE_URL=postgres://secret-user:secret-password@db.example.test/app\nCLERK_SECRET_KEY=secret-value\n',
    );
    writeFileSync(join(root, 'app/schema.ts'), [
      'export const schemaSql = `',
      'CREATE TABLE records (',
      '  id TEXT PRIMARY KEY,',
      '  created_at TIMESTAMPTZ NOT NULL,',
      '  updated_at TIMESTAMPTZ NOT NULL',
      ');',
      '`;',
    ].join('\n'));
    writeFileSync(join(root, 'app/providers.tsx'), '// existing Clerk provider\n');
    return root;
  }

  it('returns a schema-validated plan without writing project state or exposing values', async () => {
    const root = project();
    const before = readdirSync(root).sort();

    const plan = await discoverSetupPlan({ root });
    const encoded = JSON.stringify(plan);

    expect(setupPlanSchema.parse(plan)).toEqual(plan);
    expect(plan.target.applicationRoot).toBe(root);
    expect(plan.target.packageName).toBe('fixture-app');
    expect(plan.facts.find(({ key }) => key === 'package.manager')?.value).toBe('pnpm');
    expect(plan.facts.find(({ key }) => key === 'application.frameworks')?.value).toEqual(['nextjs']);
    expect(plan.facts.find(({ key }) => key === 'application.authCandidates')?.value).toEqual(['clerk']);
    expect(plan.facts.find(({ key }) => key === 'application.ormCandidates')?.value).toEqual(['prisma']);
    expect(plan.facts.find(({ key }) => key === 'application.coordinationAdoption')?.value).toBe(
      'coordination_path_undetermined',
    );
    expect(encoded).toContain('DATABASE_URL');
    expect(encoded).toContain('CLERK_SECRET_KEY');
    expect(encoded).not.toContain('secret-password');
    expect(encoded).not.toContain('secret-value');
    expect(encoded).not.toContain('db.example.test');
    expect(readdirSync(root).sort()).toEqual(before);
  });

  it('selects the runnable database owner instead of a nested UI package', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ablo-setup-headless-'));
    mkdirSync(join(root, 'src/stores'), { recursive: true });
    mkdirSync(join(root, 'plugins/web-ui/src'), { recursive: true });
    writeFileSync(join(root, 'package.json'), JSON.stringify({
      name: 'headless-core',
      scripts: { start: 'node src/index.ts', worker: 'node src/worker.ts' },
      dependencies: { fastify: '5.0.0', pg: '8.0.0' },
    }));
    writeFileSync(join(root, 'plugins/web-ui/package.json'), JSON.stringify({
      name: 'web-ui',
      scripts: { start: 'vite' },
      dependencies: { vite: '7.0.0' },
    }));
    writeFileSync(
      join(root, 'src/stores/records.ts'),
      `await pool.query('UPDATE records SET status = $1 WHERE id = $2', [status, id]);\n`,
    );
    writeFileSync(
      join(root, 'plugins/web-ui/src/api.ts'),
      `await fetch('/api/preferences', { method: 'POST', body: JSON.stringify(input) });\n`,
    );

    const plan = await discoverSetupPlan({ root });

    expect(plan.target.applicationRoot).toBe(root);
    expect(plan.target.packageName).toBe('headless-core');
    expect(plan.facts.find(({ key }) => key === 'application.kinds')?.value).toEqual(['node']);
    expect(plan.facts.find(({ key }) => key === 'application.directMutationSites')?.value).toEqual([
      expect.objectContaining({ path: 'src/stores/records.ts', kind: 'sql', operation: 'sql_write' }),
    ]);
    expect(plan.facts.find(({ key }) => key === 'application.coordinationAdoption')?.value).toBe(
      'existing_state_reuse_candidate',
    );
    expect(plan.facts.find(({ key }) => key === 'application.excludedNestedPackages')?.value).toEqual([
      { root: 'plugins/web-ui', name: 'web-ui' },
    ]);
    expect(plan.decisions.find(({ id }) => id === 'application_root')).toEqual(
      expect.objectContaining({
        status: 'resolved',
        selected: '.',
        reason: 'Exactly one runnable package owns database access, so it is the coordination boundary.',
      }),
    );

    const monorepoRoot = resolve(__dirname, '../../../..');
    const command = spawnSync(
      process.execPath,
      [
        '--import', join(monorepoRoot, 'node_modules/tsx/dist/loader.mjs'),
        join(monorepoRoot, 'packages/cli/src/index.ts'),
        'setup', '--plan', '--json', '--root', root,
      ],
      {
        cwd: root,
        encoding: 'utf8',
        env: {
          ...process.env,
          ABLO_API_KEY: '',
          ABLO_CONFIG_DIR: join(root, '.external-config'),
          CI: '1',
        },
      },
    );
    expect(command.status).toBe(0);
    const commandPlan = setupPlanSchema.parse(JSON.parse(command.stdout));
    expect(commandPlan.target.applicationRoot).toBe(root);
    expect(commandPlan.facts.find(({ key }) => key === 'application.directMutationSites')?.value).toEqual([
      expect.objectContaining({ path: 'src/stores/records.ts', kind: 'sql' }),
    ]);
  });

  it('selects a root runtime owner and reports non-Postgres persistence instead of its renderer', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ablo-setup-file-backed-'));
    mkdirSync(join(root, 'src/state'), { recursive: true });
    mkdirSync(join(root, 'web-ui/src'), { recursive: true });
    mkdirSync(join(root, 'packages/desktop/src'), { recursive: true });
    writeFileSync(join(root, 'package.json'), JSON.stringify({
      name: 'file-backed-runtime',
      scripts: { dev: 'tsx watch src/cli.ts' },
      dependencies: {},
    }));
    writeFileSync(join(root, 'web-ui/package.json'), JSON.stringify({
      name: 'renderer',
      scripts: { dev: 'vite' },
      dependencies: { vite: '7.0.0' },
    }));
    writeFileSync(join(root, 'packages/desktop/package.json'), JSON.stringify({
      name: 'desktop-shell',
      scripts: { start: 'electron .', dev: 'node scripts/launch.mjs' },
      dependencies: { electron: '41.0.0' },
    }));
    writeFileSync(join(root, 'src/cli.ts'), `import { save } from './state/workspace.ts';\nawait save({ records: [] });\n`);
    writeFileSync(join(root, 'src/state/workspace.ts'), [
      `import { writeFile, rename } from 'node:fs/promises';`,
      `export async function save(value: unknown) {`,
      `  await writeFile('/tmp/board.json.next', JSON.stringify(value));`,
      `  await rename('/tmp/board.json.next', '/tmp/board.json');`,
      `}`,
    ].join('\n'));
    writeFileSync(join(root, 'web-ui/src/api.ts'), `await fetch('/api/records', { method: 'POST' });\n`);

    const plan = await discoverSetupPlan({ root });

    expect(plan.target.applicationRoot).toBe(root);
    expect(plan.target.packageName).toBe('file-backed-runtime');
    expect(plan.facts.find(({ key }) => key === 'application.kinds')?.value).toEqual(['node']);
    expect(plan.facts.find(({ key }) => key === 'application.persistenceCandidates')?.value).toEqual(['filesystem']);
    expect(plan.facts.find(({ key }) => key === 'application.excludedNestedPackages')?.value).toEqual([
      { root: 'packages/desktop', name: 'desktop-shell' },
      { root: 'web-ui', name: 'renderer' },
    ]);
    expect(plan.facts.find(({ key }) => key === 'application.directMutationSites')?.value).toEqual([]);
    expect(plan.facts.find(({ key }) => key === 'application.coordinationAdoption')?.value).toBe(
      'model_migration_required',
    );
    expect(plan.decisions.find(({ id }) => id === 'application_root')).toEqual(expect.objectContaining({
      status: 'resolved',
      selected: '.',
      reason: 'Exactly one package owns a concrete runtime entrypoint, so it is the application boundary.',
    }));
    expect(plan.decisions.find(({ id }) => id === 'development_database')?.reason).toContain(
      'write paths migrated behind an authority',
    );
  });

  it('inventories direct and Ablo mutation sites without executing project code', () => {
    const root = project();
    const path = join(root, 'app/actions.ts');
    writeFileSync(path, [
      `await prisma.record.create({ data });`,
      `await tx.report.updateMany({ where, data });`,
      `await db.delete(records).where(eq(records.id, id));`,
      'await sql`UPDATE records SET title = ${title}`;',
      `await axios.patch('/api/records/1', body);`,
      `await ablo.records.update({ id, data });`,
      `cache.delete(id);`,
    ].join('\n'));

    const sites = discoverMutationSites(root, [path]);

    expect(sites.map(({ kind, operation, modelHint }) => [kind, operation, modelHint])).toEqual([
      ['prisma', 'create', 'record'],
      ['prisma', 'bulk_update', 'report'],
      ['drizzle', 'delete', 'records'],
      ['sql', 'sql_write', 'records'],
      ['http', 'http_write', null],
      ['ablo', 'update', 'records'],
    ]);
  });

  it('projects reviewed models and discovery leads into a bounded agent record', async () => {
    const root = project();
    const path = join(root, 'app/actions.ts');
    writeFileSync(path, [
      `await prisma.record.update({ where: { id }, data });`,
      `await prisma.auditLog.create({ data: event });`,
      `await fetch('/api/records', { method: 'DELETE' });`,
    ].join('\n'));
    const plan = await discoverSetupPlan({ root });

    const record = buildWritePathAdaptationTask({ plan, selectedModels: ['record'] });

    expect(setupAdaptationTaskSchema.parse(record)).toEqual(record);
    expect(record.scope).toEqual({
      allowedRoot: root,
      mustExploreBeyondHints: true,
      mayReadEnvironmentValues: false,
      maximumMutation: 'local_write',
    });
    expect(record.discoveryHints.map(({ modelHint }) => modelHint)).toEqual(['record', null]);
    expect(record.discoveryHints.some(({ modelHint }) => modelHint === 'auditLog')).toBe(false);
    expect(record.databaseMappings).toEqual(plan.compatibility.mappings);
    expect(record.constraints).toContain(
      'Validate ABLO_API_KEY presence without logging its value; await client readiness before work and await client disposal after active work during shutdown.',
    );
  });

  it('packages a versioned skill whose file digests and hard boundaries are self-contained', async () => {
    const root = project();
    const plan = await discoverSetupPlan({ root });
    const record = buildWritePathAdaptationTask({ plan, selectedModels: ['record'] });

    const bundle = buildSetupAgentBundle(record, () => new Date(0));

    expect(setupAgentBundleSchema.parse(bundle)).toEqual(bundle);
    expect(bundle.createdAt).toBe(new Date(0).toISOString());
    for (const file of bundle.skill.files) {
      expect(file.sha256).toBe(createHash('sha256').update(file.content).digest('hex'));
    }
    const skill = bundle.skill.files.find(({ path }) => path === 'SKILL.md')?.content ?? '';
    expect(skill).toContain('Independently explore');
    expect(skill).toContain('npx ablo docs coordinate-existing-work');
    expect(skill).toContain('do not read the full documentation set');
    expect(skill).toContain('preserve its Postgres write');
    expect(skill).toContain('Do not run login, branch, connect, push, dev');
    expect(skill).toContain('createTransactionClient(...)');
    expect(skill).toContain('Preserve memory-backed test modes');
    const api = bundle.skill.files.find(({ path }) =>
      path === 'references/api-contract.md'
    )?.content ?? '';
    expect(api).toContain('stopped accepting work and active work has settled');
    expect(api).toContain('do not invent a second identity option');
    expect(skill).not.toContain('throwaway hosted data plane');
  });

  it('treats a safe Ablo application diff as a candidate that still needs semantic grading', async () => {
    const root = project();
    const applicationRoot = join(root, 'app');
    writeFileSync(join(applicationRoot, 'actions.ts'), `await prisma.records.update({ where: { id }, data });\n`);
    const plan = await discoverSetupPlan({ root });
    const discoveredTask = buildWritePathAdaptationTask({ plan, selectedModels: ['records'] });
    const record = setupAdaptationTaskSchema.parse({
      ...discoveredTask,
      applicationRoot,
      scope: { ...discoveredTask.scope, allowedRoot: applicationRoot },
    });
    const before = captureSetupWorkspace(root, () => new Date(0));

    writeFileSync(join(applicationRoot, 'actions.ts'), `await ablo.records.update({ id, data });\n`);
    const after = captureSetupWorkspace(root, () => new Date(1));
    const evaluation = evaluateSetupDiff({ before, after, record, now: () => new Date(2) });

    expect(setupDiffEvaluationSchema.parse(evaluation)).toEqual(evaluation);
    expect(evaluation.outcome).toBe('candidate');
    expect(evaluation.changes).toEqual([{ path: 'app/actions.ts', kind: 'modified' }]);
    expect(evaluation.checks.find(({ id }) => id === 'selected_model_calls')?.status).toBe('pass');
    expect(evaluation.checks.find(({ id }) => id === 'semantic_write_coverage')?.status).toBe('review');
    expect(evaluation.summary).toContain('not activation proof');
  });

  it('does not accept an agent run when a selected model has no observable Ablo write', async () => {
    const root = project();
    writeFileSync(join(root, 'app/actions.ts'), `await prisma.records.delete({ where: { id } });\n`);
    const plan = await discoverSetupPlan({ root });
    const record = buildWritePathAdaptationTask({ plan, selectedModels: ['records'] });
    const before = captureSetupWorkspace(root, () => new Date(0));
    const after = captureSetupWorkspace(root, () => new Date(1));

    const evaluation = evaluateSetupDiff({ before, after, record, now: () => new Date(2) });

    expect(evaluation.outcome).toBe('incomplete');
    expect(evaluation.checks.find(({ id }) => id === 'selected_model_calls')).toEqual(expect.objectContaining({
      status: 'fail',
      detail: expect.stringContaining('records'),
    }));
  });

  it('marks edits outside the app and protected environment changes unsafe without reading secrets', async () => {
    const root = project();
    const applicationRoot = join(root, 'app');
    const plan = await discoverSetupPlan({ root });
    const discoveredTask = buildWritePathAdaptationTask({ plan, selectedModels: ['records'] });
    const record = setupAdaptationTaskSchema.parse({
      ...discoveredTask,
      applicationRoot,
      scope: { ...discoveredTask.scope, allowedRoot: applicationRoot },
    });
    const before = captureSetupWorkspace(root, () => new Date(0));

    writeFileSync(join(applicationRoot, 'actions.ts'), `await ablo.records.create({ data });\n`);
    writeFileSync(join(root, 'README.md'), 'agent changed a file outside the app\n');
    writeFileSync(join(root, '.env.local'), 'DATABASE_URL=postgres://a-different-secret-value\n');
    const after = captureSetupWorkspace(root, () => new Date(1));
    const evaluation = evaluateSetupDiff({ before, after, record, now: () => new Date(2) });
    const encodedSnapshots = JSON.stringify({ before, after, evaluation });

    expect(evaluation.outcome).toBe('unsafe');
    expect(evaluation.checks.find(({ id }) => id === 'application_scope')).toEqual(expect.objectContaining({ status: 'fail' }));
    expect(evaluation.checks.find(({ id }) => id === 'environment_values')).toEqual(expect.objectContaining({ status: 'fail' }));
    expect(encodedSnapshots).not.toContain('secret-password');
    expect(encodedSnapshots).not.toContain('a-different-secret-value');
  });

  it('grades the repository and verifiers instead of trusting the agent run status', async () => {
    const root = project();
    const path = join(root, 'app/actions.ts');
    writeFileSync(path, `await prisma.records.update({ where: { id }, data });\n`);
    const plan = await discoverSetupPlan({ root });
    const record = buildWritePathAdaptationTask({ plan, selectedModels: ['records'] });

    const result = await runSetupWritePathEval({
      caseId: 'scattered-record-writes',
      record,
      runner: {
        id: 'fixture-agent',
        model: 'deterministic-test-double',
        async run() {
          writeFileSync(path, `await ablo.records.update({ id, data });\n`);
          return { status: 'completed', exitCode: 0 };
        },
      },
      verifiers: [{
        id: 'preserves-required-call',
        async verify() {
          return readFileSync(path, 'utf8').includes('ablo.records.update')
            ? { status: 'pass', detail: 'The required mutation is present.' }
            : { status: 'fail', detail: 'The required mutation is absent.' };
        },
      }],
      now: (() => {
        let tick = 0;
        return () => new Date(tick++);
      })(),
    });

    expect(setupEvalResultSchema.parse(result)).toEqual(result);
    expect(result.outcome).toBe('passed');
    expect(result.inputs).toEqual(expect.objectContaining({
      recordId: record.recordId,
      skillId: 'integrate-ablo',
      files: expect.arrayContaining([
        expect.objectContaining({ path: 'SKILL.md', sha256: expect.stringMatching(/^[a-f0-9]{64}$/) }),
      ]),
    }));
    expect(result.diff.changes).toEqual([{ path: 'app/actions.ts', kind: 'modified' }]);
    expect(JSON.stringify(result)).not.toContain('prisma.records.update');
    expect(JSON.stringify(result)).not.toContain('ablo.records.update');
  });

  it('fails an agent-reported completion when independent verification fails', async () => {
    const root = project();
    const plan = await discoverSetupPlan({ root });
    const record = buildWritePathAdaptationTask({ plan, selectedModels: ['records'] });

    const result = await runSetupWritePathEval({
      caseId: 'hollow-completion',
      record,
      runner: {
        id: 'fixture-agent',
        model: null,
        async run() { return { status: 'completed', exitCode: 0 }; },
      },
      verifiers: [{
        id: 'semantic-coverage',
        async verify() { return { status: 'fail', detail: 'Direct writes remain.' }; },
      }],
    });

    expect(result.agent.status).toBe('completed');
    expect(result.outcome).toBe('failed');
  });

  it('accepts a no-change blocker only with a validated handoff and independent proof', async () => {
    const root = project();
    const plan = await discoverSetupPlan({ root });
    const record = buildWritePathAdaptationTask({ plan, selectedModels: ['records'] });
    const result = await runSetupWritePathEval({
      caseId: 'proven-schema-blocker',
      record,
      expectedOutcome: 'blocked',
      runner: {
        id: 'fixture-agent',
        model: 'deterministic-test-double',
        async run() {
          return {
            status: 'completed',
            exitCode: 0,
            handoff: {
              outcome: 'blocked',
              changedFiles: [],
              exploredWritePaths: [{ model: 'records', path: 'app/actions.ts', role: 'authoritative writes' }],
              directWriteExceptions: [{ path: 'app/actions.ts', reason: 'Existing table is incompatible with the pinned schema contract.' }],
              verification: [],
              blockers: ['A reviewed database migration is required.'],
            },
          } as const;
        },
      },
      verifiers: [{
        id: 'schema-compatibility',
        async verify() { return { status: 'pass', detail: 'The incompatibility is independently proven.' }; },
      }],
    });

    expect(result.outcome).toBe('blocked');
    expect(result.agent.handoff?.blockers).toHaveLength(1);
  });

  it('does not treat an unexplained no-op as a correct blocker', async () => {
    const root = project();
    const plan = await discoverSetupPlan({ root });
    const record = buildWritePathAdaptationTask({ plan, selectedModels: ['records'] });
    const result = await runSetupWritePathEval({
      caseId: 'unexplained-noop',
      record,
      expectedOutcome: 'blocked',
      runner: {
        id: 'fixture-agent',
        model: null,
        async run() { return { status: 'completed', exitCode: 0 }; },
      },
      verifiers: [{
        id: 'schema-compatibility',
        async verify() { return { status: 'pass', detail: 'A blocker exists.' }; },
      }],
    });

    expect(result.outcome).toBe('incomplete');
  });

  it('emits a clean machine-readable plan from the packaged CLI entrypoint', () => {
    const root = project();
    const monorepoRoot = resolve(__dirname, '../../../..');
    const cli = join(monorepoRoot, 'packages/cli/src/index.ts');
    const tsxLoader = join(monorepoRoot, 'node_modules/tsx/dist/loader.mjs');
    const configDir = join(root, '.external-config');
    const result = spawnSync(
      process.execPath,
      ['--import', tsxLoader, cli, 'setup', '--plan', '--json', '--root', root],
      {
        cwd: root,
        encoding: 'utf8',
        env: {
          ...process.env,
          ABLO_API_KEY: '',
          ABLO_CONFIG_DIR: configDir,
          CI: '1',
        },
      },
    );

    expect(result.status).toBe(0);
    const plan = setupPlanSchema.parse(JSON.parse(result.stdout));
    expect(plan.kind).toBe('ablo_setup_plan');
    expect(plan.summary).toContain('No project files were changed');
    expect(() => readFileSync(join(root, '.ablo/setup-checkpoint.json'), 'utf8')).toThrow();
  });

  it('starts the same setup program from the single bare setup command', () => {
    const root = project();
    const monorepoRoot = resolve(__dirname, '../../../..');
    const result = spawnSync(
      process.execPath,
      [
        '--import', join(monorepoRoot, 'node_modules/tsx/dist/loader.mjs'),
        join(monorepoRoot, 'packages/cli/src/index.ts'),
        'setup', '--root', root,
      ],
      {
        cwd: root,
        encoding: 'utf8',
        env: {
          ...process.env,
          ABLO_API_KEY: '',
          ABLO_CONFIG_DIR: join(root, '.external-config'),
          CI: '1',
          // This is the one case that reads the rendered plan rather than JSON,
          // so the assertion must see the text and not the runner's colouring.
          NO_COLOR: '1',
        },
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('setup plan');
    expect(result.stdout).toContain('Result  blocked');
    expect(() => readFileSync(join(root, '.ablo/setup-checkpoint.json'), 'utf8')).toThrow();
  });

  it('keeps agent bundles internal instead of exposing orchestration flags', () => {
    const root = project();
    const monorepoRoot = resolve(__dirname, '../../../..');
    const result = spawnSync(
      process.execPath,
      [
        '--import', join(monorepoRoot, 'node_modules/tsx/dist/loader.mjs'),
        join(monorepoRoot, 'packages/cli/src/index.ts'),
        'setup', '--plan', '--agent-bundle', '--root', root,
      ],
      {
        cwd: root,
        encoding: 'utf8',
        env: {
          ...process.env,
          ABLO_API_KEY: '',
          ABLO_CONFIG_DIR: join(root, '.external-config'),
          CI: '1',
        },
      },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Unknown setup option: --agent-bundle');
  });
});

describe('brownfield compatibility preflight', () => {
  const qmSql = `
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL CHECK (status IN ('pending', 'running')),
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS task_events (
      id BIGSERIAL PRIMARY KEY,
      task_id TEXT NOT NULL,
      created_at BIGINT NOT NULL
    );

    await client.query('BEGIN');
    const result = await client.query(\`
      UPDATE tasks
      SET status = $1, updated_at = $2
      WHERE id = $3 AND status = $4
      RETURNING *
    \`);
    await client.query(\`INSERT INTO task_events (task_id) VALUES ($1)\`);
    await client.query('COMMIT');
  `;

  it('maps QM identities without interpreting application timestamps', () => {
    const columns = discoverDatabaseColumnsFromSqlSource({ path: 'src/tasks/store.ts', source: qmSql });
    const requirements = discoverTransactionalRequirementsFromSqlSource({
      path: 'src/tasks/store.ts',
      source: qmSql,
    });

    const result = analyzeSetupCompatibility({ columns, requirements });
    expect(columns.filter(({ column }) => column.endsWith('_at')).map(({ column }) => column))
      .toEqual(['created_at', 'updated_at', 'created_at']);
    expect(result.status).toBe('compatible');
    expect(result.blockers).toEqual([]);
    expect(result.mappings.find(({ table, field }) => table === 'task_events' && field === 'id'))
      .toEqual(expect.objectContaining({
        databaseType: 'bigint',
        generatedBy: 'database',
        status: 'ready',
      }));
    expect(result.mappings).toHaveLength(2);
  });

  it('keeps adaptation closed when database metadata is unavailable', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ablo-setup-compatibility-'));
    writeFileSync(join(root, 'package.json'), JSON.stringify({
      name: 'brownfield-app',
      dependencies: { next: '16.0.0', pg: '8.0.0' },
    }));
    const plan = await discoverSetupPlan({ root });
    const blockedPlan = setupPlanSchema.parse({
      ...plan,
      compatibility: analyzeSetupCompatibility({ columns: [] }),
    });

    expect(() => buildWritePathAdaptationTask({ plan: blockedPlan, selectedModels: ['record'] }))
      .toThrow('database_schema_unavailable');
  });
});
