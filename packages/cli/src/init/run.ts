import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cancel, confirm, intro, isCancel, note, outro, select, spinner } from '@clack/prompts';
import pc from 'picocolors';
import { AbloValidationError } from '@abloatai/transaction/errors';
import { ADMIN_URL_VAR, readProjectAdminDatabaseUrl } from '../dbRole';
import { resolveManagementKey } from '../config';
import { login } from '../login';
import { buildSchemaSourceFromDb } from '../pull';
import { ensureProject, projectSlugFromPackageName } from '../projects';
import { brand } from '../theme';
import { generateProviders, generateSessionRoute } from '../generators/authScaffold';
import {
  generateAgent,
  generateComponent,
  generateDataSource,
  generateEnv,
  generateRegister,
  generateSchema,
  generateSyncConfig,
  generateWebhookRoute,
} from './generators';
import {
  detectNextLayout,
  detectOrm,
  detectPackageManager,
  INIT_AUTHS,
  INIT_FRAMEWORKS,
  INIT_STORAGES,
  parseInitArgs,
  type InitOptions,
  type InitStorage,
} from './options';
import {
  applyInitWritePlan,
  planInitWrites,
  projectInitWritePlan,
  type InitOwnedFile,
} from './writer';
import { setupInitResultSchema, type SetupInitResult } from '../setup/contracts';

function bailIfCancelled<T>(value: T | symbol): asserts value is T {
  if (isCancel(value)) {
    cancel('Cancelled.');
    process.exit(0);
  }
}

async function chooseOption(
  name: string,
  flagValue: string | undefined,
  fallback: string,
  allowed: readonly string[],
  interactive: boolean,
  prompt: () => Promise<unknown>,
): Promise<string> {
  if (flagValue !== undefined) {
    if (!allowed.includes(flagValue)) {
      throw new AbloValidationError(
        `Invalid --${name} "${flagValue}". Allowed: ${allowed.join(', ')}`,
        { code: 'cli_invalid_arguments' },
      );
    }
    return flagValue;
  }
  if (!interactive) return fallback;
  const value = await prompt();
  bailIfCancelled(value);
  return value as string;
}

async function chooseBool(
  flagValue: boolean | undefined,
  fallback: boolean,
  interactive: boolean,
  prompt: () => Promise<unknown>,
): Promise<boolean> {
  if (flagValue !== undefined) return flagValue;
  if (!interactive) return fallback;
  const value = await prompt();
  bailIfCancelled(value);
  return value as boolean;
}

async function ensureInitProject(opts: InitOptions): Promise<void> {
  if (!opts.useProject) return;
  const slug =
    opts.project ??
    projectSlugFromPackageName(
      (() => {
        try {
          return (JSON.parse(readFileSync('package.json', 'utf8')) as { name?: unknown }).name;
        } catch {
          return undefined;
        }
      })(),
    );
  if (!slug) return;
  const ensured = await ensureProject(slug);
  if (ensured) {
    console.log(
      `  ${pc.green('✓')} ${ensured.created ? 'Created' : 'Using'} project ${pc.bold(ensured.slug)} ${pc.dim(`(${ensured.id})`)} — keys you mint for it are isolated from the org's other apps.`,
    );
  }
}

function renderWritePlan(actions: ReturnType<typeof planInitWrites>['actions']): string {
  return actions
    .map((action) => {
      const verb =
        action.kind === 'create'
          ? 'create'
          : action.kind === 'update'
            ? 'update'
            : 'leave unchanged';
      return `${verb.padEnd(15)} ${action.path}${action.note ?? ''}`;
    })
    .join('\n');
}

function renderAppliedWrites(actions: ReturnType<typeof planInitWrites>['actions']): string {
  return actions
    .map((action) => {
      const status =
        action.kind === 'create'
          ? pc.green('created')
          : action.kind === 'update'
            ? pc.yellow('updated')
            : pc.dim('unchanged');
      return `${pc.green('✓')} ${action.path}${action.note ?? ''} ${pc.dim(`(${status})`)}`;
    })
    .join('\n');
}

export async function runInit(args: readonly string[] = []): Promise<SetupInitResult> {
  const opts = parseInitArgs(args);
  const interactive = Boolean(process.stdin.isTTY) && !opts.yes && !process.env.CI;

  intro(`${brand('ablo')} ${pc.dim('sync engine')}`);
  if (!existsSync('package.json')) {
    throw new AbloValidationError('No package.json found. Run this from your project root.', {
      code: 'cli_invalid_arguments',
    });
  }

  const framework = await chooseOption(
    'framework',
    opts.framework,
    'nextjs',
    INIT_FRAMEWORKS,
    interactive,
    () =>
      select({
        message: 'Framework',
        initialValue: 'nextjs',
        options: [
          { value: 'nextjs', label: 'Next.js' },
          { value: 'vite', label: 'Vite (React)' },
          { value: 'remix', label: 'Remix' },
          { value: 'vanilla', label: 'None (vanilla TypeScript)' },
        ],
      }),
  );
  const auth = await chooseOption('auth', opts.auth, 'apikey', INIT_AUTHS, interactive, () =>
    select({
      message: 'Authentication',
      initialValue: 'apikey',
      options: [
        { value: 'apikey', label: 'API key only (no login)' },
        { value: 'firebase', label: 'Firebase' },
        { value: 'auth0', label: 'Auth0' },
        { value: 'clerk', label: 'Clerk' },
        { value: 'supabase', label: 'Supabase Auth' },
        { value: 'betterauth', label: 'Better Auth' },
        { value: 'jwt', label: 'Custom JWT' },
      ],
    }),
  );
  const storageChoice = await chooseOption(
    'storage',
    opts.storage,
    'replication',
    INIT_STORAGES,
    false,
    () => Promise.resolve('replication'),
  );
  const storage: InitStorage =
    storageChoice === 'datasource' ? 'endpoint' : (storageChoice as InitStorage);
  const agent = await chooseBool(opts.agent, true, interactive, () =>
    confirm({ message: 'Include the AI agent teammate example?', initialValue: true }),
  );
  const pullExisting = await chooseBool(opts.pull, false, interactive, () =>
    confirm({ message: 'Pull models from an existing database? (needs DATABASE_URL)', initialValue: false }),
  );

  if (!interactive) {
    note(
      `framework=${framework}  auth=${auth}  storage=${storage}  agent=${agent}  pull=${pullExisting}`,
      'Non-interactive (no TTY / --yes)',
    );
  }

  const layout =
    framework === 'nextjs' ? detectNextLayout() : { appBase: 'app', aliasBase: '.' };
  const abloDir = join(layout.aliasBase, 'ablo');
  const files: InitOwnedFile[] = [];
  let schemaSource = generateSchema();
  let schemaNote = '';
  if (pullExisting) {
    const dbUrl = readProjectAdminDatabaseUrl();
    if (!dbUrl) {
      schemaNote = pc.dim(` (no ${ADMIN_URL_VAR} — wrote starter; run \`ablo pull\` later)`);
    } else {
      try {
        const pulled = await buildSchemaSourceFromDb({
          dbUrl,
          appSchema: 'public',
          importPath: '@abloatai/ablo/schema',
        });
        if (pulled.models.length > 0) {
          schemaSource = pulled.source;
          schemaNote = pc.dim(` (pulled ${pulled.models.length} models)`);
        } else {
          schemaNote = pc.dim(' (no adoptable tables — wrote starter)');
        }
      } catch {
        schemaNote = pc.dim(' (pull failed — wrote starter)');
      }
    }
  }

  files.push({ path: join(abloDir, 'schema.ts'), content: schemaSource, note: schemaNote });
  files.push({
    path: join(abloDir, 'index.ts'),
    content: generateSyncConfig(auth, { serverOnly: framework === 'nextjs' }),
  });
  files.push({ path: join(abloDir, 'register.ts'), content: generateRegister() });

  const orm = detectOrm(opts.orm);
  if (storage === 'endpoint') {
    files.push({
      path: join(abloDir, 'data-source.ts'),
      content: generateDataSource(orm),
      note: orm === 'drizzle' ? ' (Drizzle)' : ' (Prisma)',
    });
  }
  const envFile = framework === 'nextjs' ? '.env.local' : '.env';
  const envBody = generateEnv(storage);
  if (agent) files.push({ path: join(abloDir, 'agent.ts'), content: generateAgent() });

  if (framework === 'nextjs') {
    if (storage === 'endpoint') {
      const webhookDir = join(layout.appBase, 'api', 'ablo', 'webhooks');
      files.push({
        path: join(webhookDir, 'route.ts'),
        content: generateWebhookRoute(orm),
        note: orm === 'prisma' ? ' (Prisma mirror)' : ' (add your database write)',
      });
    }
    files.push({
      path: join(layout.appBase, 'providers.tsx'),
      content: generateProviders(),
      note: ` (wrap ${join(layout.appBase, 'layout.tsx')} in <Providers>)`,
    });
    files.push({
      path: join(layout.appBase, 'api', 'ablo-session', 'route.ts'),
      content: generateSessionRoute(),
      note: ' (wire your auth)',
    });
  }
  if (framework !== 'vanilla') {
    files.push({ path: join(abloDir, 'RecordList.tsx'), content: generateComponent() });
  }

  const writePlan = planInitWrites({ files, environment: { path: envFile, template: envBody } });
  if (writePlan.conflicts.length > 0) {
    const occupied = writePlan.conflicts.map(({ path }) => `  - ${path}`).join('\n');
    throw new AbloValidationError(
      `Ablo init did not change any files because these application-owned paths already contain different contents:\n${occupied}\n\nMove them, reconcile Ablo manually, or rerun after they match the generated scaffold. Init never overwrites an occupied application file.`,
      { code: 'cli_invalid_arguments' },
    );
  }
  if (opts.plan) {
    note(renderWritePlan(writePlan.actions), 'Plan (no files changed)');
    outro(`Dry run complete. Re-run without ${pc.bold('--plan')} to apply it.`);
    return setupInitResultSchema.parse({
      status: 'planned',
      plan: projectInitWritePlan(writePlan),
    });
  }

  applyInitWritePlan(writePlan);
  const initResult = setupInitResultSchema.parse({
    status: 'applied',
    plan: projectInitWritePlan(writePlan),
  });
  note(renderAppliedWrites(writePlan.actions), 'Files');

  const packageManager = detectPackageManager();
  if (opts.install) {
    const progress = spinner();
    progress.start('Installing @abloatai/ablo');
    try {
      execFileSync(packageManager, ['add', '@abloatai/ablo'], { stdio: 'ignore' });
      progress.stop('Installed @abloatai/ablo');
    } catch {
      progress.stop(
        `${pc.yellow('!')} Couldn't auto-install — run ${pc.bold(`${packageManager} install @abloatai/ablo`)}`,
      );
    }
  }

  const steps = [
    `Run ${pc.bold('npx ablo login')} to authorize branch management`,
    `Set ${pc.bold('DATABASE_URL')} in ${pc.bold(envFile)} — your Postgres is the system of record; rows live there, never with Ablo`,
    `Run ${pc.bold('npx ablo dev')} — pushes your schema definition and watches for changes`,
    ...(storage === 'replication'
      ? [
          `Connect your database — ${pc.bold('npx ablo connect')} prints the one-time logical-replication setup SQL to run on your Postgres`,
          `Verify it — ${pc.bold('npx ablo connect check')} walks wal_level, the publication, the role, and replica identity, with the exact fix for anything missing`,
          `Register it — ${pc.bold('npx ablo connect register')} tells Ablo to start replicating; your app keeps writing through your own backend while Ablo tails the WAL`,
        ]
      : [
          `Provision your DB: ${pc.bold('npx ablo migrate')} (creates your Ablo-model tables + the adapter tables; keep your own migrations for everything else), then mount ${pc.bold(`${abloDir}/data-source.ts`)} at ${pc.bold('/api/ablo/source')}`,
        ]),
    ...(framework === 'nextjs'
      ? [
          `Wrap ${pc.bold(join(layout.appBase, 'layout.tsx'))} in ${pc.bold('<Providers>')} (${join(layout.appBase, 'providers.tsx')}) and add your auth to ${pc.bold(join(layout.appBase, 'api', 'ablo-session', 'route.ts'))}`,
        ]
      : []),
    `Run ${pc.bold(`${packageManager} run dev`)} and open two browser tabs — changes sync in real-time`,
    ...(agent
      ? [
          `Run ${pc.bold(`npx tsx ${abloDir}/agent.ts`)} — an AI teammate edits the same records`,
          `Run ${pc.bold('npx ablo logs')} to watch human + agent commits stream by`,
        ]
      : []),
  ];
  note(steps.map((step, index) => `${index + 1}. ${step}`).join('\n'), 'Next steps');

  const existingKey = resolveManagementKey();
  if (existingKey) {
    await ensureInitProject(opts);
    outro(
      `Already authorized ${pc.dim(`(${existingKey.slice(0, 11)}…)`)}. Run ${pc.bold('npx ablo dev')} next. ${pc.dim('Docs:')} https://abloatai.com/docs`,
    );
    return initResult;
  }
  if (interactive && opts.login) {
    const loginNow = await confirm({ message: 'Log in now? (opens your browser)', initialValue: true });
    if (!isCancel(loginNow) && loginNow) {
      outro(`${pc.dim('Docs:')} https://abloatai.com/docs`);
      await login();
      await ensureInitProject(opts);
      return initResult;
    }
  }
  outro(`Run ${pc.bold('npx ablo login')} when ready. ${pc.dim('Docs:')} https://abloatai.com/docs`);
  return initResult;
}
