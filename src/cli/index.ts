#!/usr/bin/env node

import { intro, outro, select, confirm, spinner, note, cancel, isCancel } from '@clack/prompts';
import pc from 'picocolors';
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';
import { migrate, MIGRATE_USAGE } from './migrate';
import { connect, CONNECT_USAGE } from './connect';
import { push } from './push';
import { generate } from './generate';
import { dev, wireEnvLocal } from './dev';
import { login, logout } from './login';
import { resolveApiKey, resolvePushPlan, guardActiveProjectKey } from './config';
import { mode } from './mode';
import { projects, ensureProject, projectSlugFromPackageName } from './projects';
import { status } from './status';
import { logs } from './logs';
import { webhooks } from './webhooks';
import { check } from './check';
import { upgrade } from './upgrade';
import { pull, buildSchemaSourceFromDb } from './pull';
import { prismaPull } from './prisma-pull';
import { drizzlePull } from './drizzle-pull';
import { brand } from './theme';

const LOGO = `
  ${brand('ablo')} ${pc.dim('sync engine')}
`;

/**
 * Per-subcommand usage shown by `ablo <cmd> --help`. Sourced from each command
 * module so the help text can't drift from the parser. Commands without an entry
 * fall through to the top-level command list.
 */
const SUBCOMMAND_USAGE: Readonly<Record<string, string>> = {
  connect: CONNECT_USAGE,
  migrate: MIGRATE_USAGE,
};

async function main() {
  let command: string | undefined = process.argv[2];

  // `ablo <command> --help` / `-h` should print usage, not forward `--help` into
  // the command's own arg parser — which throws "unknown flag: --help" and reads
  // as "the command doesn't exist" (a real user's agent drew exactly that wrong
  // conclusion about `ablo migrate`). Print command-specific usage when we have
  // it; otherwise fall through to the top-level command list below.
  if (command && process.argv.slice(3).some((a) => a === '--help' || a === '-h')) {
    if (SUBCOMMAND_USAGE[command]) {
      console.log(SUBCOMMAND_USAGE[command]);
      return;
    }
    command = undefined;
  }

  if (command === 'init') {
    await init(process.argv.slice(3));
  } else if (command === 'login') {
    await login(process.argv.slice(3));
  } else if (command === 'logout') {
    logout();
  } else if (command === 'mode') {
    await mode(process.argv.slice(3));
  } else if (command === 'projects') {
    await projects(process.argv.slice(3));
  } else if (command === 'status') {
    await status(process.argv.slice(3));
  } else if (command === 'logs') {
    await logs(process.argv.slice(3));
  } else if (command === 'webhooks') {
    await webhooks(process.argv.slice(3));
  } else if (command === 'dev') {
    // Renamed: nothing runs locally, so `dev` was a lie. Kept as an alias for
    // `ablo push --watch`. Honor an explicit `--no-watch` (push once, then exit):
    // appending `--watch` unconditionally clobbered it (last-flag-wins parsing),
    // so `ablo dev --no-watch` watched forever — the exact runaway-in-an-agent
    // footgun the `--no-watch` escape hatch exists to prevent.
    const devArgs = process.argv.slice(3);
    const oneShot = devArgs.includes('--no-watch');
    console.log(
      pc.dim(
        oneShot
          ? '  `ablo dev --no-watch` is `ablo push` (push once, no watcher) — running that.'
          : '  `ablo dev` is now `ablo push --watch` — running that.',
      ),
    );
    await dev(oneShot ? devArgs : [...devArgs, '--watch']);
  } else if (command === 'check') {
    await check(process.argv.slice(3));
  } else if (command === 'pull') {
    // `ablo pull`         → introspect the live database (lossy: no enums/relations)
    // `ablo pull prisma`  → read a Prisma schema file (lossless: enums + relations)
    // `ablo pull drizzle` → reflect a Drizzle module    (lossless: enums + relations)
    const rest = process.argv.slice(3);
    if (rest[0] === 'prisma') {
      await prismaPull(rest.slice(1));
    } else if (rest[0] === 'drizzle') {
      await drizzlePull(rest.slice(1));
    } else {
      await pull(rest);
    }
  } else if (command === 'connect') {
    await connect(process.argv.slice(3));
  } else if (command === 'migrate') {
    await migrate(process.argv.slice(3));
  } else if (command === 'push') {
    // Two flows: the sandbox dev flow (role check, env wiring, server-side
    // provisioning, optional --watch) and the raw one-shot pusher (production
    // deploys, advanced flags). The credential resolves explicit ABLO_API_KEY
    // → the ACTIVE mode's stored credential (`resolvePushPlan`), so
    // `ablo login` + `ablo mode production` + `npx ablo push` deploys to
    // production instead of demanding sk_test_. `--watch` stays sandbox-only:
    // it routes to the dev flow, whose live-key refusal names the supported
    // production path.
    const rest = process.argv.slice(3);
    const advanced = rest.some((a) => ['--force', '--rename', '--backfill', '--url'].includes(a));
    const watching = rest.includes('--watch');
    // Project guard: if the active project has no key but other projects do,
    // the user switched with `ablo projects use` and never minted here. Refuse
    // rather than silently deploy with — or demand — the wrong project's key.
    // (`--url` overrides the target entirely, so it bypasses the guard.)
    const guard = guardActiveProjectKey();
    if (!guard.ok && guard.available.length > 0 && !rest.includes('--url')) {
      console.error(
        `  ${pc.yellow('⚠')} active project ${pc.bold(guard.activeProfile)} has no stored key ${pc.dim(
          `(you have keys for: ${guard.available.join(', ')})`,
        )}`,
      );
      const loginCmd =
        guard.activeProfile === 'default'
          ? 'ablo login'
          : `ablo login --project ${guard.activeProfile}`;
      console.error(
        pc.dim(
          `    Mint one with ${pc.bold(loginCmd)}, or switch with ${pc.bold('ablo projects use <slug>')}.`,
        ),
      );
      process.exitCode = 1;
      return;
    }
    const plan = resolvePushPlan();
    if (advanced || (plan.flow === 'production' && !watching)) {
      await push(rest);
    } else {
      await dev(rest);
    }
  } else if (command === 'upgrade') {
    await upgrade(process.argv.slice(3));
  } else if (command === 'generate') {
    await generate(process.argv.slice(3));
  } else if (command === 'schema') {
    // Renamed: `ablo schema push` → `ablo push` (flat-verb grammar).
    console.error(
      `  ${pc.red('✗')} \`ablo schema push\` was renamed to \`${brand('ablo push')}\`.`,
    );
    console.error(`    Run \`ablo push${process.argv.slice(4).join(' ') ? ' ' + process.argv.slice(4).join(' ') : ''}\` instead.`);
    process.exitCode = 1;
  } else {
    console.log(LOGO);
    console.log(`  ${pc.bold('Usage:')}`);
    console.log(`    npx ablo init                          Scaffold ablo/ directory + starter schema`);
    console.log(`    npx ablo init --yes [--framework nextjs] Non-interactive (agents/CI): no prompts, flag-driven`);
    console.log(`                  [--auth apikey] [--storage direct|endpoint] [--project <slug>] [--no-project]`);
    console.log(`                  [--no-agent] [--no-pull] [--no-install] [--no-login]`);
    console.log(`    npx ablo login                         Authorize in your browser (provisions sandbox + production keys)`);
    console.log(`    npx ablo login --project <slug>        Same, scoped to a project (mints its keys, makes it active)`);
    console.log(`    npx ablo logout                        Remove the stored API key`);
    console.log(`    npx ablo mode [sandbox|production]     Switch active environment, like Stripe`);
    console.log(`    npx ablo projects list                 List the org's projects (default + your own)`);
    console.log(`    npx ablo projects create <slug>        Create a project (its keys/schema/data are isolated)`);
    console.log(`    npx ablo projects use <slug|default>   Switch the active project (run login --project to mint its keys)`);
    console.log(`    npx ablo status                        Show org, mode, keys, and server health`);
    console.log(`    npx ablo status --json                 Same, machine-readable (mode, key prefix, org id, api host)`);
    console.log(`    npx ablo logs [-n N] [--since 15m]     Tail commit activity (follows; --no-follow to exit)`);
    console.log(`    npx ablo webhooks create <url>         Register an outbound webhook endpoint (writes ABLO_WEBHOOK_SECRET)`);
    console.log(`    npx ablo webhooks list|roll|enable|rm  Manage webhook endpoints + delivery health`);
    console.log(`    npx ablo dev                           Push your schema definition (sandbox) + watch for changes`);
    console.log(`    npx ablo dev --no-watch                Push once and exit (no file watcher)`);
    console.log(`    npx ablo pull                          Generate schema.ts from your existing database (read-only, lossy)`);
    console.log(`    npx ablo pull prisma [path]            Generate schema.ts from a Prisma schema (keeps enums + relations)`);
    console.log(`    npx ablo pull drizzle <module>         Generate schema.ts from a Drizzle schema (keeps enums + relations)`);
    console.log(`    npx ablo check                         Check your existing database fits the schema (read-only, creates no tables)`);
    console.log(`    npx ablo connect                       Connect a real database — prints the logical-replication setup SQL (the one way)`);
    console.log(`    npx ablo connect --check               Validate DATABASE_URL is replication-ready (wal_level, publication, role, replica identity)`);
    console.log(`    npx ablo migrate                       Provision your synced-model tables in your own Postgres (optional escape hatch — \`connect\` is the way)`);
    console.log(`    npx ablo migrate --dry-run             Print the SQL without executing (preview)`);
    console.log(`    npx ablo push                          Upload your schema definition to Ablo (metadata only — rows stay in your DB)`);
    console.log(`    npx ablo push --force                  Allow destructive/unexecutable changes`);
    console.log(`    npx ablo push --rename a:b             Treat model "a" as renamed to "b"`);
    console.log(`    npx ablo push --backfill model.field=value  Seed existing rows so a required field can be added`);
    console.log(`    npx ablo upgrade                       Migrate your code to the current API (preview; add --write to apply)`);
    console.log(`    npx ablo generate                      Emit TypeScript types from your schema`);
    console.log(`    npx ablo generate --out path.ts        Write generated types to a path`);
    console.log();
    console.log(`  ${pc.bold('Schema workflow:')}`);
    console.log(`    The server holds its own copy of your schema — edit ${brand('ablo/schema.ts')}, then`);
    console.log(`    run ${brand('ablo push')} (or keep ${brand('ablo dev')} running) before the server will accept`);
    console.log(`    writes to new or changed models. Skip it and writes fail with ${pc.yellow('server_execute_unknown_model')}.`);
    console.log();
  }
}

/** Abort the wizard cleanly on Ctrl-C / Esc. */
function bailIfCancelled<T>(value: T | symbol): asserts value is T {
  if (isCancel(value)) {
    cancel('Cancelled.');
    process.exit(0);
  }
}

// ── init flags (so agents / CI can run init without a TTY) ──────────────────
// Interactive clack prompts (`select`/`confirm`) need a TTY — an agent or CI run
// has none, so the prompts would hang/crash. When stdin isn't a TTY, or `--yes`
// / `CI` is set, init runs NON-INTERACTIVELY: every choice comes from a flag or a
// sane default, and no prompt is shown. Flags also override in interactive mode.
const INIT_FRAMEWORKS = ['nextjs', 'vite', 'remix', 'vanilla'];
const INIT_AUTHS = ['apikey', 'firebase', 'auth0', 'clerk', 'supabase', 'betterauth', 'jwt'];
// 'datasource' is accepted as a legacy alias for 'endpoint'.
const INIT_STORAGES = ['direct', 'endpoint', 'datasource'];
type InitStorage = 'direct' | 'endpoint';

interface InitOptions {
  readonly yes: boolean;
  readonly framework?: string;
  readonly auth?: string;
  readonly storage?: string;
  readonly agent?: boolean;
  readonly pull?: boolean;
  readonly install: boolean;
  readonly login: boolean;
  readonly orm?: string;
  /** Explicit project slug (`--project my-app`); default derives from the
   *  package.json name. `--no-project` opts out (org-default project). */
  readonly project?: string;
  readonly useProject: boolean;
}

function parseInitArgs(args: readonly string[]): InitOptions {
  const has = (flag: string): boolean => args.includes(flag);
  const val = (flag: string): string | undefined => {
    const inline = args.find((a) => a.startsWith(`${flag}=`));
    if (inline) return inline.slice(flag.length + 1);
    const i = args.indexOf(flag);
    const next = args[i + 1];
    return i >= 0 && next && !next.startsWith('-') ? next : undefined;
  };
  return {
    yes: has('--yes') || has('-y'),
    framework: val('--framework'),
    auth: val('--auth'),
    storage: val('--storage'),
    agent: has('--no-agent') ? false : has('--agent') ? true : undefined,
    pull: has('--no-pull') ? false : has('--pull') ? true : undefined,
    install: !has('--no-install'),
    login: !has('--no-login'),
    orm: val('--orm'),
    project: val('--project'),
    useProject: !has('--no-project'),
  };
}

/**
 * Init's project step: every app gets its OWN Ablo project (the Neon/
 * Supabase shape — its keys, schema, and data plane are isolated from the
 * org's other apps). Slug = `--project` or the package.json name. Requires
 * an authorized credential; keyless init skips silently (the org-default
 * project keeps working) and `ablo projects create` picks it up later.
 */
async function ensureInitProject(opts: InitOptions): Promise<void> {
  if (!opts.useProject) return;
  const slug =
    opts.project ??
    projectSlugFromPackageName(
      (() => {
        try {
          return (JSON.parse(readFileSync('package.json', 'utf-8')) as { name?: unknown }).name;
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

const INIT_ORMS = ['prisma', 'drizzle', 'none'] as const;
type DetectedOrm = (typeof INIT_ORMS)[number];

/**
 * Pick the ORM to scaffold against. An explicit `--orm` wins; otherwise DETECT
 * from the project's dependencies so we never emit an import the project can't
 * resolve (a `@prisma/client` import in a non-Prisma app breaks the build on init
 * — worse than a neutral template) AND so the developer never has to choose
 * between adapters they'd have to reason about: we meet them on the ORM they
 * already use. Default to a neutral, always-compiling route when none is present.
 */
function detectOrm(override?: string): DetectedOrm {
  if (override === 'prisma' || override === 'drizzle' || override === 'none') return override;
  try {
    const pkg = JSON.parse(readFileSync('package.json', 'utf-8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    if (deps['@prisma/client'] || deps['prisma']) return 'prisma';
    if (deps['drizzle-orm']) return 'drizzle';
  } catch {
    /* unreadable package.json → neutral default */
  }
  return 'none';
}

/**
 * Detect the Next.js layout: routes at `app/` (root) or `src/app/`. create-next-app
 * maps the `@/*` alias to the project root in the first and to `src/` in the second.
 * The generated route/provider files import the `ablo/` dir via `@/ablo`, so init
 * must place BOTH the routes (`appBase`) and the `ablo/` dir (under `aliasBase`)
 * to match — otherwise the routes land where Next.js can't see them, or the
 * `@/ablo` imports dangle.
 */
function detectNextLayout(): { appBase: string; aliasBase: string } {
  const useSrc = existsSync(join('src', 'app')) || (!existsSync('app') && existsSync('src'));
  return useSrc
    ? { appBase: join('src', 'app'), aliasBase: 'src' }
    : { appBase: 'app', aliasBase: '.' };
}

/** Resolve a choice: flag (validated) → interactive prompt → default. Never prompts when non-interactive. */
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
      cancel(`Invalid --${name} "${flagValue}". Allowed: ${allowed.join(', ')}`);
      process.exit(1);
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

async function init(args: readonly string[] = []) {
  const opts = parseInitArgs(args);
  // No TTY → an agent or CI is driving; never block on a prompt.
  const interactive = Boolean(process.stdin.isTTY) && !opts.yes && !process.env.CI;

  intro(`${brand('ablo')} ${pc.dim('sync engine')}`);

  if (!existsSync('package.json')) {
    cancel('No package.json found. Run this from your project root.');
    process.exit(1);
  }

  const framework = await chooseOption('framework', opts.framework, 'nextjs', INIT_FRAMEWORKS, interactive, () =>
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

  // Your database is the system of record — Ablo never hosts data, so the only
  // choice is HOW Ablo reaches your Postgres: 'direct' (databaseUrl on the
  // client, the canonical default) or 'endpoint' (the connection string never
  // leaves your app; Ablo calls a signed Data Source route instead).
  // 'datasource' is the legacy flag spelling of 'endpoint'.
  const storageChoice = await chooseOption('storage', opts.storage, 'direct', INIT_STORAGES, interactive, () =>
    select({
      message: 'How should Ablo reach your database?',
      initialValue: 'direct',
      options: [
        { value: 'direct', label: 'Connection string (DATABASE_URL) — recommended' },
        { value: 'endpoint', label: 'Signed endpoint in my app (credentials never leave it)' },
      ],
    }),
  );
  const storage: InitStorage = storageChoice === 'datasource' ? 'endpoint' : (storageChoice as InitStorage);

  // The agent teammate is the headline example — defaults to yes.
  const agent = await chooseBool(opts.agent, true, interactive, () =>
    confirm({ message: 'Include the AI agent teammate example?', initialValue: true }),
  );

  // Opt-in: generate the schema from an existing database (like `prisma db pull`).
  // Read-only. Defaults OFF non-interactively (needs DATABASE_URL).
  const pullExisting = await chooseBool(opts.pull, false, interactive, () =>
    confirm({ message: 'Pull models from an existing database? (needs DATABASE_URL)', initialValue: false }),
  );

  if (!interactive) {
    note(
      `framework=${framework}  auth=${auth}  storage=${storage}  agent=${agent}  pull=${pullExisting}`,
      'Non-interactive (no TTY / --yes)',
    );
  }

  // Place `ablo/` under the same base the `@/` alias resolves to, so the
  // generated `@/ablo` imports in the Next.js routes resolve correctly (root for
  // an `app/` project, `src/` for a `src/app/` project). Non-Next frameworks keep
  // `ablo/` at the project root.
  const layout = framework === 'nextjs' ? detectNextLayout() : { appBase: 'app', aliasBase: '.' };
  const abloDir = join(layout.aliasBase, 'ablo');
  mkdirSync(abloDir, { recursive: true });
  const created: string[] = [];

  // Write a hand-authored starter schema. We deliberately don't try to
  // import from Prisma / Drizzle here — schema.ts is the SDK's source of
  // truth, and generator-based approaches leak framework coupling back
  // into the user's data model. Migration from an existing ORM is a
  // one-shot manual port, not a recurring build step.
  // Schema: pulled from an existing DB (opt-in) or the starter.
  let schemaSource = generateSchema();
  let schemaNote = '';
  if (pullExisting) {
    const dbUrl = process.env.DATABASE_URL ?? process.env.ABLO_DATABASE_URL;
    if (!dbUrl) {
      schemaNote = pc.dim(' (no DATABASE_URL — wrote starter; run `ablo pull` later)');
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
  writeFileSync(join(abloDir, 'schema.ts'), schemaSource);
  created.push(`${abloDir}/schema.ts${schemaNote}`);

  writeFileSync(join(abloDir, 'index.ts'), generateSyncConfig(auth, storage));
  created.push(`${abloDir}/index.ts`);

  writeFileSync(join(abloDir, 'register.ts'), generateRegister());
  created.push(`${abloDir}/register.ts`);

  // The ORM we scaffold every "Ablo → your database" path against — detected once from
  // the project's deps (or `--orm`), so the data-source endpoint and the webhook
  // route agree and the developer is never shown an adapter menu.
  const orm = detectOrm(opts.orm);

  if (storage === 'endpoint') {
    writeFileSync(join(abloDir, 'data-source.ts'), generateDataSource(orm));
    created.push(`${abloDir}/data-source.ts${orm === 'drizzle' ? ' (Drizzle)' : ' (Prisma)'}`);
  }

  const envFile = framework === 'nextjs' ? '.env.local' : '.env';
  // When the user is already authenticated (and isn't passing ABLO_API_KEY via
  // the shell), wire the REAL stored sandbox key instead of a placeholder, so
  // `init` + `push` runs without an "unknown key" detour. `wireEnvLocal` owns the
  // ABLO_API_KEY line and only targets `.env.local`, so this applies to the
  // Next.js path; other frameworks keep the documented placeholder.
  const resolvedKey = process.env.ABLO_API_KEY ? undefined : resolveApiKey('sandbox');
  const wireRealKey = envFile === '.env.local' && Boolean(resolvedKey);
  const envBody = generateEnv(storage, { includeApiKey: !wireRealKey });
  if (!existsSync(envFile)) {
    writeFileSync(envFile, envBody);
    created.push(envFile);
  } else {
    const existing = readFileSync(envFile, 'utf-8');
    if (!existing.includes('ABLO_')) {
      writeFileSync(envFile, existing + '\n' + envBody);
      created.push(`${envFile} ${pc.dim('(appended)')}`);
    } else {
      created.push(`${envFile} ${pc.dim('(already configured)')}`);
    }
  }
  if (wireRealKey && resolvedKey) {
    // Idempotent: creates/replaces the ABLO_API_KEY line and .gitignores the file.
    wireEnvLocal(resolvedKey);
    created.push(`.env.local ${pc.dim('(ABLO_API_KEY set from your login)')}`);
  }

  if (agent) {
    writeFileSync(join(abloDir, 'agent.ts'), generateAgent());
    created.push(`${abloDir}/agent.ts`);
  }

  if (framework === 'nextjs') {
    // Endpoint mode only: a webhook mirror that receives Ablo's signed change
    // stream. In direct mode the rows already land in your database through the
    // registered connection, so there is nothing to mirror.
    if (storage === 'endpoint') {
      // Webhook receiver at a DEDICATED path (not a catch-all), so it can't collide
      // with the Ablo HTTP handler's `[...all]` mount or the `/api/ablo/source` route.
      const webhookDir = join(layout.appBase, 'api', 'ablo', 'webhooks');
      mkdirSync(webhookDir, { recursive: true });
      writeFileSync(join(webhookDir, 'route.ts'), generateWebhookRoute(orm));
      created.push(`${webhookDir}/route.ts${orm === 'prisma' ? ' (Prisma mirror)' : ' (add your database write)'}`);
    }

    // Browser side: the provider (mounts one client) + the session route it
    // authenticates against (mints a short-lived token from your sk_ key).
    const providersPath = join(layout.appBase, 'providers.tsx');
    writeFileSync(providersPath, generateProviders());
    created.push(`${providersPath} ${pc.dim(`(wrap ${join(layout.appBase, 'layout.tsx')} in <Providers>)`)}`);

    const sessionDir = join(layout.appBase, 'api', 'ablo-session');
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, 'route.ts'), generateSessionRoute());
    created.push(`${join(sessionDir, 'route.ts')} ${pc.dim('(wire your auth)')}`);
  }

  if (framework !== 'vanilla') {
    writeFileSync(join(abloDir, 'TaskList.tsx'), generateComponent());
    created.push(`${abloDir}/TaskList.tsx`);
  }

  note(created.map((f) => `${pc.green('✓')} ${f}`).join('\n'), 'Created');

  const pm = detectPackageManager();
  if (opts.install) {
    const s = spinner();
    s.start('Installing @abloatai/ablo');
    try {
      execSync(`${pm} add @abloatai/ablo`, { stdio: 'ignore' });
      s.stop('Installed @abloatai/ablo');
    } catch {
      s.stop(`${pc.yellow('!')} Couldn't auto-install — run ${pc.bold(`${pm} install @abloatai/ablo`)}`);
    }
  }

  const steps = [
    `Get a ${pc.bold('sk_test_')} key at ${pc.cyan('https://abloatai.com')}`,
    `Run ${pc.bold('npx ablo login')} (or add ${pc.bold('ABLO_API_KEY')} to ${pc.bold(envFile)})`,
    `Set ${pc.bold('DATABASE_URL')} in ${pc.bold(envFile)} — your Postgres is the system of record; rows live there, never with Ablo`,
    `Run ${pc.bold('npx ablo dev')} — pushes your schema definition and watches for changes`,
    ...(storage === 'direct'
      ? [
          `Provision your DB: ${pc.bold('npx ablo migrate')} (creates your synced-model tables with row-level security; keep your own migrations for everything else)`,
        ]
      : [
          `Provision your DB: ${pc.bold('npx ablo migrate')} (creates your Ablo-model tables + the adapter tables; keep your own migrations for everything else), then mount ${pc.bold(`${abloDir}/data-source.ts`)} at ${pc.bold('/api/ablo/source')}`,
        ]),
    ...(framework === 'nextjs'
      ? [
          `Wrap ${pc.bold(join(layout.appBase, 'layout.tsx'))} in ${pc.bold('<Providers>')} (${join(layout.appBase, 'providers.tsx')}) and add your auth to ${pc.bold(join(layout.appBase, 'api', 'ablo-session', 'route.ts'))}`,
        ]
      : []),
    `Run ${pc.bold(`${pm} run dev`)} and open two browser tabs — changes sync in real-time`,
    ...(agent
      ? [
          `Run ${pc.bold(`npx tsx ${abloDir}/agent.ts`)} — an AI teammate edits the same tasks`,
          `Run ${pc.bold('npx ablo logs')} to watch human + agent commits stream by`,
        ]
      : []),
  ];
  note(steps.map((s, i) => `${i + 1}. ${s}`).join('\n'), 'Next steps');

  // Offer to authorize right away — the device flow opens the browser, so it's
  // ONLY offered interactively (never from an agent / CI / `--no-login`).
  // Skipped when a credential already exists: login is part of init, not a
  // separate quickstart step, and a logged-in user shouldn't be re-asked.
  const existingKey = resolveApiKey('sandbox');
  if (existingKey) {
    await ensureInitProject(opts);
    outro(`Already authorized ${pc.dim(`(${existingKey.slice(0, 11)}…)`)} — run ${pc.bold('npx ablo push')} next. ${pc.dim('Docs:')} https://abloatai.com/docs`);
    return;
  }
  if (interactive && opts.login) {
    const loginNow = await confirm({ message: 'Log in now? (opens your browser)', initialValue: true });
    if (!isCancel(loginNow) && loginNow) {
      outro(`${pc.dim('Docs:')} https://abloatai.com/docs`);
      await login();
      // Login just provisioned the credential — claim the app's project now.
      await ensureInitProject(opts);
      return;
    }
  }
  outro(`Run ${pc.bold('npx ablo login')} when ready. ${pc.dim('Docs:')} https://abloatai.com/docs`);
}

// ── Generators ──────────────────────────────────────────────────────────

function generateSchema(): string {
  return `import { defineSchema, model, relation, z } from '@abloatai/ablo/schema';

export const schema = defineSchema({
  // Models are writable (mutable) by default — declaring one here is the
  // opt-in. For server-managed read-only projections, pass
  // \`{ mutable: false }\` as the model's third argument.
  projects: model({
    name: z.string(),
    status: z.enum(['active', 'archived']).default('active'),
    description: z.string().optional(),
  }),

  tasks: model({
    title: z.string(),
    status: z.enum(['todo', 'doing', 'done']).default('todo'),
    priority: z.number().default(0),
    projectId: z.string().optional(),
    assigneeId: z.string().optional(),
    description: z.string().optional(),
    dueDate: z.date().optional(),
  }, {
    project: relation.belongsTo('projects', 'projectId'),
  }),
});
`;
}

function generateSyncConfig(auth: string, storage: InitStorage): string {
  // Direct mode: the client carries databaseUrl — Ablo registers the connection
  // and rows land in YOUR Postgres. Endpoint mode must omit it (the signed Data
  // Source route is the connection; registering both would double-connect).
  const databaseLine = storage === 'direct'
    ? `\n  databaseUrl: process.env.DATABASE_URL, // your Postgres — rows live here, never with Ablo`
    : '';
  const authLine = auth === 'apikey'
    ? ''
    : auth === 'firebase'
    ? `\n  auth: async () => {\n    const { getAuth } = await import('firebase/auth');\n    const user = getAuth().currentUser;\n    return user ? await user.getIdToken() : '';\n  },`
    : auth === 'auth0'
    ? `\n  // auth: () => getAccessTokenSilently(), // uncomment after Auth0 setup`
    : auth === 'clerk'
    ? `\n  // auth: () => getToken(), // uncomment after Clerk setup`
    : auth === 'supabase'
    ? `\n  // auth: async () => { const { data } = await supabase.auth.getSession(); return data.session?.access_token ?? ''; },`
    : auth === 'betterauth'
    ? `\n  // auth: async () => { const session = await authClient.getSession(); return session?.token ?? ''; },`
    : `\n  // auth: () => 'your-jwt-token', // replace with your auth provider`;

  return `import Ablo from '@abloatai/ablo';
import { schema } from './schema';

// SERVER-ONLY client — it holds your \`sk_\` key (and in direct mode your
// database URL). Use it from server code: the agent script and the
// /api/ablo-session route. Do NOT import this into a browser ('use client')
// component; the browser uses app/providers.tsx, which authenticates via the
// session route and never touches the key or the database URL.
export const sync = Ablo({
  apiKey: process.env.ABLO_API_KEY,${databaseLine}${authLine}
  schema,
});

// Name the client's type off the constructed value — the overload resolves at
// this call site, so this carries the full typed surface. (Like tRPC's
// \`typeof appRouter\`, Drizzle's \`typeof db\`.) Prefer this over \`ReturnType<typeof Ablo>\`.
export type Sync = typeof sync;
`;
}

// Register the project's schema into the SDK's global `Register` interface so
// `ablo.<model>` is typed across the project without re-passing the schema type.
// Emitted as a REGULAR `.ts` module (`ablo/register.ts`, a sibling of schema.ts).
// It's never imported anywhere — the `declare module` augmentation merges purely
// because the file is a module in the tsconfig `include` (the `import type` +
// `export {}` make it a module). TanStack Router relies on the same mechanism for
// its `Register` augmentation living in `src/router.tsx`. A `.d.ts` is NOT needed.
function generateRegister(): string {
  return `import type { schema } from './schema';

declare module '@abloatai/ablo' {
  interface Register {
    Schema: typeof schema;
  }
}

export {};
`;
}

function generateEnv(storage: InitStorage, opts: { includeApiKey?: boolean } = {}): string {
  const { includeApiKey = true } = opts;
  const databaseBlock = storage === 'direct'
    ? '# Your Postgres — the system of record. The client registers this connection\n' +
      '# (sent once over TLS, stored sealed) and every row lives HERE, never with Ablo.\n' +
      '# Use a dedicated non-superuser role; the browser never sees this value.\n' +
      'DATABASE_URL=postgres://user:password@host:5432/db\n'
    : '# Used by ablo/data-source.ts (your DB endpoint) + `ablo migrate` — NOT the client.\n' +
      '# Ablo never sees it; the browser never sees it. Your DB stays in your app.\n' +
      'DATABASE_URL=postgres://user:password@host:5432/db\n';
  const webhookBlock = storage === 'endpoint'
    ? '# Signing secret for the webhook receiver (app/api/ablo/webhooks/route.ts).\n' +
      '# Ablo mints this when you register the endpoint\'s URL (POST /v1/webhook_endpoints\n' +
      '# or the dashboard) and returns it once — paste it here.\n' +
      'ABLO_WEBHOOK_SECRET=whsec_your_endpoint_secret_here\n'
    : '';
  // Omit the placeholder ABLO_API_KEY when init will wire the real stored key
  // afterward (via wireEnvLocal), so the file ends with exactly one key line.
  const apiKeyBlock = includeApiKey
    ? '# Ablo Sync Engine — use a sk_test_ key for local dev (`npx ablo push`)\nABLO_API_KEY=sk_test_your_key_here\n'
    : '';
  return `${apiKeyBlock}${webhookBlock}${databaseBlock}`;
}

/**
 * The "Ablo → your database" Data Source endpoint, scaffolded for the ORM the
 * project already uses — one clean track, no adapter menu. Both variants derive
 * the SYNCED-model tables from the one Zod `schema` and rely on `ablo migrate` to
 * provision those plus the adapter's bookkeeping tables. Your non-synced tables
 * (auth, billing, anything without an organization_id) keep living in your own
 * ORM schema, provisioned by your own migrations — one database, two schemas.
 */
function generateDataSource(orm: DetectedOrm): string {
  return orm === 'drizzle' ? drizzleDataSourceScaffold() : prismaDataSourceScaffold();
}

function prismaDataSourceScaffold(): string {
  return `import { dataSourceNext } from '@abloatai/ablo/source/next';
import { prismaDataSource } from '@abloatai/ablo/source';
import { PrismaClient } from '@prisma/client';
import { schema } from './schema';

// Your database stays in THIS app — Ablo never sees DATABASE_URL. It only calls
// the signed endpoint below, and \`prismaDataSource\` runs the write in your own
// Prisma transaction, driven entirely by your Zod \`schema\`: it applies each
// operation, records idempotency by clientTxId, and appends the transactional
// outbox — all in ONE transaction. No commit or event-handling code to hand-write.
//
// Run \`npx ablo migrate\` to provision the ABLO model tables AND the adapter's two
// bookkeeping tables (ablo_idempotency, ablo_outbox). It does NOT touch your other
// tables — keep using \`prisma migrate\` for auth + any non-Ablo models.
export const runtime = 'nodejs'; // PrismaClient needs the Node runtime, not edge
const prisma = new PrismaClient();

export const { POST } = dataSourceNext({
  schema,
  apiKey: process.env.ABLO_API_KEY!,
  adapter: prismaDataSource(prisma, schema),
});
`;
}

function drizzleDataSourceScaffold(): string {
  return `import { dataSourceNext } from '@abloatai/ablo/source/next';
import { drizzleDataSource } from '@abloatai/ablo/source/drizzle';
import { drizzle } from 'drizzle-orm/node-postgres';
import { schema } from './schema';

// Your database stays in THIS app — Ablo never sees DATABASE_URL. It only calls
// the signed endpoint below, and \`drizzleDataSource\` runs the write in your own
// transaction. It derives table + column names straight from your Zod \`schema\`
// (the SAME rule \`ablo migrate\` provisions), so you don't keep a second Drizzle
// definition for the SYNCED models. Your other tables — auth, billing, anything
// not in this Ablo schema — stay in your own Drizzle schema, managed by
// drizzle-kit. One database, two schemas side by side: Ablo owns the synced
// models, you own the rest.
//
// Driver note: the commit is an INTERACTIVE transaction, so use a driver that
// supports one — node-postgres (any Postgres) or neon-serverless (Neon over
// WebSocket). Neon's HTTP driver (neon-http) is single-shot and throws on commit.
//
// Run \`npx ablo migrate\` to provision the ABLO model tables AND the adapter's two
// bookkeeping tables (ablo_idempotency, ablo_outbox). It does NOT touch your other
// tables — keep using drizzle-kit for auth + any non-Ablo models.
export const runtime = 'nodejs'; // node-postgres + interactive transactions need Node, not edge
const db = drizzle(process.env.DATABASE_URL!);

export const { POST } = dataSourceNext({
  schema,
  apiKey: process.env.ABLO_API_KEY!,
  adapter: drizzleDataSource(db, schema),
});
`;
}

/**
 * The "Ablo → your database" webhook receiver. Two variants so the scaffold
 * ALWAYS compiles: a working Prisma mirror when the project uses Prisma, and a
 * neutral, ORM-agnostic route (no foreign imports) otherwise.
 */
function generateWebhookRoute(orm: DetectedOrm): string {
  return orm === 'prisma' ? prismaWebhookRoute() : neutralWebhookRoute();
}

/** Shared doc header + the verify/order boilerplate that both variants use. */
const WEBHOOK_INTRO = `import { Webhook } from 'svix'; // any Standard Webhooks lib works (svix / standardwebhooks)
import type { AbloWebhookEvent } from '@abloatai/ablo/webhooks';`;

const WEBHOOK_DOC = `/**
 * The "Ablo → your database" half of the loop.
 *
 * Ablo owns the ordered transaction log (the source of truth) and streams every
 * committed change here as a SIGNED Standard-Webhooks event. You verify the
 * signature, then write each change into YOUR database. The other half — your app
 * MAKING changes + live sync — is the Ablo client in \`ablo/index.ts\`.
 *
 * Just like Stripe: you call Ablo to make changes (client) and Ablo calls you to
 * persist them (this route). Reliability is built in — Ablo retries on any
 * non-2xx, and \`event.syncId\` is a monotonic log position, so apply in order and
 * dedupe (skip a \`syncId\` you've already stored).
 */`;

/** Prisma project → a WORKING generic mirror: one upsert/delete for every model. */
function prismaWebhookRoute(): string {
  return `${WEBHOOK_INTRO}
import { PrismaClient } from '@prisma/client';

${WEBHOOK_DOC}
// Scaffolded WORKING: mirrors every model with one generic upsert/delete — NO
// per-model code. Edit only if your tables diverge from Ablo's schema.
const wh = new Webhook(process.env.ABLO_WEBHOOK_SECRET!);
const prisma = new PrismaClient();

/** Minimal typed view of a Prisma model delegate — typed dynamic access, no \`any\`. */
type ModelDelegate = {
  upsert(args: {
    where: { id: string };
    create: Record<string, unknown>;
    update: Record<string, unknown>;
  }): Promise<unknown>;
  delete(args: { where: { id: string } }): Promise<unknown>;
};

export async function POST(req: Request): Promise<Response> {
  const body = await req.text(); // RAW body — required for signature verification
  let batch: { data: AbloWebhookEvent[] };
  try {
    batch = wh.verify(body, Object.fromEntries(req.headers)) as { data: AbloWebhookEvent[] };
  } catch {
    return new Response('invalid signature', { status: 400 });
  }

  // Apply in log order. \`event.model\` is the model name (e.g. "task" → prisma.task).
  const events = [...batch.data].sort((a, b) => a.syncId - b.syncId);
  const delegates = prisma as unknown as Record<string, ModelDelegate | undefined>;

  for (const event of events) {
    const model = delegates[event.model];
    if (!model) continue; // a model you don't mirror locally — skip it
    if (event.data === null) {
      await model.delete({ where: { id: event.objectId } }).catch(() => {}); // already gone
    } else {
      await model.upsert({ where: { id: event.objectId }, create: event.data, update: event.data });
    }
  }

  return new Response(null, { status: 200 }); // 2xx fast; do heavy work async if needed
}
`;
}

/** No detected ORM → a neutral route that COMPILES; one clearly-marked database write point. */
function neutralWebhookRoute(): string {
  return `${WEBHOOK_INTRO}

${WEBHOOK_DOC}
const wh = new Webhook(process.env.ABLO_WEBHOOK_SECRET!);

export async function POST(req: Request): Promise<Response> {
  const body = await req.text(); // RAW body — required for signature verification
  let batch: { data: AbloWebhookEvent[] };
  try {
    batch = wh.verify(body, Object.fromEntries(req.headers)) as { data: AbloWebhookEvent[] };
  } catch {
    return new Response('invalid signature', { status: 400 });
  }

  for (const event of [...batch.data].sort((a, b) => a.syncId - b.syncId)) {
    // event.model = table name   event.objectId = row id   event.data = row (null on delete)
    // TODO: write into your database — one generic upsert/delete, no per-model code, e.g.:
    //
    //   if (event.data === null) {
    //     await db.deleteFrom(event.model).where('id', '=', event.objectId).execute();
    //   } else {
    //     await db.insertInto(event.model).values(event.data)
    //       .onConflict((c) => c.column('id').doUpdateSet(event.data)).execute();
    //   }
    void event;
  }

  return new Response(null, { status: 200 }); // 2xx fast; do heavy work async if needed
}
`;
}

function generateAgent(): string {
  return `import Ablo from '@abloatai/ablo';
import { schema } from './schema';

/**
 * An AI "teammate" that works the same synced tasks a human does.
 *
 * Run it with \`npx tsx ablo/agent.ts\` while the app is open in a browser tab —
 * its writes appear there instantly (same as another human), and stream in
 * \`npx ablo logs\`. That's the whole idea: humans and agents on one typed,
 * synced dataset.
 */
const ablo = Ablo({ schema, apiKey: process.env.ABLO_API_KEY });

async function main() {
  await ablo.ready();

  // File some work, like a teammate would.
  await ablo.tasks.create({ data: { title: 'Draft the Q3 roadmap', status: 'todo' } });
  const urgent = await ablo.tasks.create({ data: { title: 'URGENT: fix the login bug', status: 'todo' } });
  console.log('created 2 tasks');

  // Triage the urgent one to the top. We write based on the version we just
  // read (\`readAt\`), so if a human edits the same row at the same moment the
  // write is rejected instead of silently clobbering them.
  const snap = ablo.snapshot({ tasks: urgent.id });
  await ablo.tasks.update({
    id: urgent.id,
    data: { priority: 10 },
    readAt: snap.stamp,
    onStale: 'reject',
    wait: 'confirmed',
  });
  console.log('prioritized:', urgent.title);

  console.log('done — check your browser tab and \`npx ablo logs\`');
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
`;
}

function generateComponent(): string {
  return `'use client';

import { useAblo } from '@abloatai/ablo/react';
import { useState } from 'react';

// Browser component. It reads + writes through the Ablo client in context
// (mounted by app/providers.tsx) — it never imports the server \`sk_\` client.
export function TaskList() {
  const ablo = useAblo(); // typed client for writes (null until the provider is ready)
  const tasks = useAblo((a) => a.tasks.getAll({ where: { status: 'todo' }, orderBy: { priority: 'desc' } })) ?? [];
  const [title, setTitle] = useState('');

  const handleCreate = async () => {
    if (!title.trim() || !ablo) return;
    await ablo.tasks.create({ data: { title, status: 'todo' } });
    setTitle('');
  };

  return (
    <div>
      <h2>Tasks ({tasks.length})</h2>

      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
          placeholder="Add a task..."
          style={{ flex: 1, padding: 8 }}
        />
        <button onClick={handleCreate}>Add</button>
      </div>

      <ul style={{ listStyle: 'none', padding: 0 }}>
        {tasks.map((task) => (
          <li key={task.id} style={{ display: 'flex', justifyContent: 'space-between', padding: 8, borderBottom: '1px solid #eee' }}>
            <span>{task.title}</span>
            <button onClick={() => ablo?.tasks.update({ id: task.id, data: { status: 'done' } })}>
              Done
            </button>
          </li>
        ))}
      </ul>

      {tasks.length === 0 && <p style={{ color: '#999' }}>No tasks yet. Add one above.</p>}
    </div>
  );
}
`;
}

// The browser provider. Builds ONE Ablo client that authenticates via the
// session route (never the sk_ key) and mounts it so \`useAblo()\` works in any
// client component. AbloProvider takes a built \`client\` (Stripe <Elements> model).
function generateProviders(): string {
  return `'use client';

import Ablo from '@abloatai/ablo';
import { AbloProvider } from '@abloatai/ablo/react';
import { schema } from '@/ablo/schema';

// The browser client holds NO secret. The \`apiKey\` resolver fetches the route
// below, which mints a short-lived session token (already scoped to the org +
// user); the client keeps it fresh (refresh timer + wake/online/focus re-mint).
// Contract: return the token, return \`null\` when the user is signed out
// (→ the client signs out), or throw on a transient failure (→ it retries).
const ablo = Ablo({
  schema,
  apiKey: async () => {
    const res = await fetch('/api/ablo-session', {
      method: 'POST',
      credentials: 'include',
    });
    if (!res.ok) return null;
    const { token } = (await res.json()) as { token: string | null };
    return token;
  },
});

export function Providers({ children }: { children: React.ReactNode }) {
  return <AbloProvider client={ablo}>{children}</AbloProvider>;
}
`;
}

// The session-mint route. Runs server-side with your sk_ key, asserts WHO the
// browser is acting as (your auth), and returns ONLY a short-lived token.
function generateSessionRoute(): string {
  return `import { sync } from '@/ablo';

// Mints the browser's session token. The browser never sees your sk_ key — it
// only gets this token, which already names your org + the user you assert here.
// Replace getCurrentUser() with your real auth (NextAuth / Clerk / Better Auth / …).
export async function POST(): Promise<Response> {
  const user = await getCurrentUser(); // ← your auth: who is making this request?
  if (!user) return new Response('Unauthorized', { status: 401 });

  const { token } = await sync.sessions.create({ user: { id: user.id } });
  return Response.json({ token });
}

// TODO: replace with your auth provider's "current user" lookup.
async function getCurrentUser(): Promise<{ id: string } | null> {
  return null;
}
`;
}

function detectPackageManager(): string {
  if (existsSync('pnpm-lock.yaml')) return 'pnpm';
  if (existsSync('yarn.lock')) return 'yarn';
  if (existsSync('bun.lockb')) return 'bun';
  return 'npm';
}

main().catch(console.error);
