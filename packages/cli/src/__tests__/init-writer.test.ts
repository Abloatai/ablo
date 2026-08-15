import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  applyInitWritePlan,
  mergeEnvironmentTemplate,
  planInitWrites,
  projectInitWritePlan,
} from '../init/writer';
import { setupInitPlanProjectionSchema } from '../setup/contracts';

describe('init filesystem transaction', () => {
  it('plans every conflict before writing any generated file', () => {
    const root = mkdtempSync(join(tmpdir(), 'ablo-init-writer-'));
    mkdirSync(join(root, 'app'), { recursive: true });
    writeFileSync(join(root, 'app/providers.tsx'), '// user provider tree\n');

    const plan = planInitWrites({
      root,
      files: [
        { path: 'ablo/schema.ts', content: '// generated schema\n' },
        { path: 'app/providers.tsx', content: '// generated providers\n' },
      ],
      environment: { path: '.env.local', template: 'ABLO_API_KEY=sk_placeholder\n' },
    });

    expect(plan.conflicts).toEqual([{ path: 'app/providers.tsx', reason: 'occupied' }]);
    expect(() => applyInitWritePlan(plan)).toThrow('occupied targets');
    expect(() => readFileSync(join(root, 'ablo/schema.ts'), 'utf8')).toThrow();
    expect(readFileSync(join(root, 'app/providers.tsx'), 'utf8')).toBe('// user provider tree\n');
  });

  it('projects an init plan without generated contents', () => {
    const root = mkdtempSync(join(tmpdir(), 'ablo-init-writer-'));
    const secretSentinel = 'generated-content-must-not-cross-the-adapter';
    const plan = planInitWrites({
      root,
      files: [{ path: 'ablo/schema.ts', content: secretSentinel }],
      environment: { path: '.env', template: 'ABLO_API_KEY=sk_placeholder\n' },
    });

    const projection = projectInitWritePlan(plan);

    expect(setupInitPlanProjectionSchema.parse(projection)).toEqual(projection);
    expect(JSON.stringify(projection)).not.toContain(secretSentinel);
    expect(projection.actions.map(({ path }) => path)).toEqual(['ablo/schema.ts', '.env']);
  });

  it('is idempotent when generated files already match', () => {
    const root = mkdtempSync(join(tmpdir(), 'ablo-init-writer-'));
    mkdirSync(join(root, 'ablo'), { recursive: true });
    writeFileSync(join(root, 'ablo/schema.ts'), '// generated schema\n');

    const plan = planInitWrites({
      root,
      files: [{ path: 'ablo/schema.ts', content: '// generated schema\n' }],
      environment: { path: '.env', template: 'ABLO_API_KEY=sk_placeholder\n' },
    });
    expect(plan.conflicts).toEqual([]);
    expect(plan.actions.map(({ kind }) => kind)).toEqual(['unchanged', 'create']);
    applyInitWritePlan(plan);

    const rerun = planInitWrites({
      root,
      files: [{ path: 'ablo/schema.ts', content: '// generated schema\n' }],
      environment: { path: '.env', template: 'ABLO_API_KEY=sk_placeholder\n' },
    });
    expect(rerun.conflicts).toEqual([]);
    expect(rerun.actions.every(({ kind }) => kind === 'unchanged')).toBe(true);
  });

  it('merges missing environment assignments by key and preserves existing values', () => {
    const existing = [
      '# ABLO_API_KEY is configured by deployment',
      'export ABLO_API_KEY="sk_real"',
      'DATABASE_URL=postgres://real',
      '',
    ].join('\n');
    const template = [
      'ABLO_API_KEY=sk_placeholder',
      'ABLO_PROJECT_ID=proj_placeholder',
      'ABLO_BRANCH_ID=br_placeholder',
      'DATABASE_URL=postgres://placeholder',
      '',
    ].join('\n');

    const merged = mergeEnvironmentTemplate(existing, template);
    expect(merged.addedKeys).toEqual(['ABLO_PROJECT_ID', 'ABLO_BRANCH_ID']);
    expect(merged.content).toContain('export ABLO_API_KEY="sk_real"');
    expect(merged.content).toContain('DATABASE_URL=postgres://real');
    expect(merged.content).not.toContain('sk_placeholder');
    expect(merged.content).not.toContain('postgres://placeholder');
    expect(merged.content).toContain('ABLO_PROJECT_ID=proj_placeholder');
    expect(merged.content).toContain('ABLO_BRANCH_ID=br_placeholder');
  });

  it('does not treat an ABLO_ comment as an existing assignment', () => {
    const merged = mergeEnvironmentTemplate(
      '# Set ABLO_API_KEY in production\n',
      'ABLO_API_KEY=sk_placeholder\n',
    );
    expect(merged.addedKeys).toEqual(['ABLO_API_KEY']);
    expect(merged.content).toContain('ABLO_API_KEY=sk_placeholder');
  });

  it('revalidates every target before writing the first file', () => {
    const root = mkdtempSync(join(tmpdir(), 'ablo-init-writer-'));
    writeFileSync(join(root, '.env'), 'EXISTING=value\n');
    const plan = planInitWrites({
      root,
      files: [{ path: 'ablo/schema.ts', content: '// generated schema\n' }],
      environment: { path: '.env', template: 'ABLO_API_KEY=sk_placeholder\n' },
    });

    writeFileSync(join(root, '.env'), 'EXISTING=edited-after-plan\n');

    expect(() => applyInitWritePlan(plan)).toThrow('changed after planning');
    expect(() => readFileSync(join(root, 'ablo/schema.ts'), 'utf8')).toThrow();
    expect(readFileSync(join(root, '.env'), 'utf8')).toBe('EXISTING=edited-after-plan\n');
  });

  it('rejects targets outside the project root', () => {
    const root = mkdtempSync(join(tmpdir(), 'ablo-init-writer-'));
    expect(() =>
      planInitWrites({
        root,
        files: [{ path: '../outside.ts', content: '// no\n' }],
        environment: { path: '.env', template: 'ABLO_API_KEY=sk_placeholder\n' },
      }),
    ).toThrow('inside the project root');
  });
});

describe('ablo init occupied-target behavior', () => {
  const monorepoRoot = resolve(__dirname, '../../../..');
  const cli = join(monorepoRoot, 'packages/cli/src/index.ts');
  const tsxLoader = join(monorepoRoot, 'node_modules/tsx/dist/loader.mjs');

  function runInit(
    root: string,
    framework: 'nextjs' | 'vanilla',
    extraArgs: readonly string[] = [],
  ) {
    return spawnSync(
      process.execPath,
      [
        '--import',
        tsxLoader,
        cli,
        'init',
        '--yes',
        '--framework',
        framework,
        '--auth',
        'apikey',
        '--no-agent',
        '--no-install',
        '--no-login',
        '--no-pull',
        ...extraArgs,
      ],
      {
        cwd: root,
        encoding: 'utf8',
        env: { ...process.env, CI: '1', ABLO_CONFIG_DIR: join(root, '.ablo-config') },
      },
    );
  }

  it('refuses a conventional Next.js providers file before creating anything', () => {
    const root = mkdtempSync(join(tmpdir(), 'ablo-init-cli-'));
    mkdirSync(join(root, 'app'), { recursive: true });
    writeFileSync(join(root, 'package.json'), '{"name":"occupied-next-app"}\n');
    writeFileSync(join(root, 'app/providers.tsx'), '// Clerk + theme + query providers\n');

    const result = runInit(root, 'nextjs');

    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toContain('app/providers.tsx');
    expect(readFileSync(join(root, 'app/providers.tsx'), 'utf8')).toBe(
      '// Clerk + theme + query providers\n',
    );
    expect(() => readFileSync(join(root, 'ablo/schema.ts'), 'utf8')).toThrow();
    expect(() => readFileSync(join(root, '.env.local'), 'utf8')).toThrow();
  });

  it('allows an exact non-interactive rerun without duplicating the environment', () => {
    const root = mkdtempSync(join(tmpdir(), 'ablo-init-cli-'));
    writeFileSync(join(root, 'package.json'), '{"name":"rerun-app"}\n');

    const first = runInit(root, 'vanilla');
    expect(first.status).toBe(0);
    const firstEnv = readFileSync(join(root, '.env'), 'utf8');

    const second = runInit(root, 'vanilla');
    expect(second.status).toBe(0);
    expect(readFileSync(join(root, '.env'), 'utf8')).toBe(firstEnv);
    expect(`${second.stdout}${second.stderr}`).toContain('unchanged');
  });

  it('prints a complete dry-run plan without creating files', () => {
    const root = mkdtempSync(join(tmpdir(), 'ablo-init-cli-'));
    writeFileSync(join(root, 'package.json'), '{"name":"plan-only-app"}\n');

    const result = runInit(root, 'vanilla', ['--plan']);

    expect(result.status).toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain('Plan (no files changed)');
    expect(`${result.stdout}${result.stderr}`).toContain('ablo/schema.ts');
    expect(`${result.stdout}${result.stderr}`).toContain('.env');
    expect(() => readFileSync(join(root, 'ablo/schema.ts'), 'utf8')).toThrow();
    expect(() => readFileSync(join(root, '.env'), 'utf8')).toThrow();
  });
});
