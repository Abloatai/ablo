import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const INIT_FRAMEWORKS = ['nextjs', 'vite', 'remix', 'vanilla'] as const;
export const INIT_AUTHS = [
  'apikey',
  'firebase',
  'auth0',
  'clerk',
  'supabase',
  'betterauth',
  'jwt',
] as const;
export const INIT_STORAGES = ['replication', 'endpoint', 'datasource'] as const;
export const INIT_ORMS = ['prisma', 'drizzle', 'none'] as const;

export type InitStorage = 'endpoint' | 'replication';
export type DetectedOrm = (typeof INIT_ORMS)[number];

export interface InitOptions {
  readonly yes: boolean;
  readonly plan: boolean;
  readonly framework?: string;
  readonly auth?: string;
  readonly storage?: string;
  readonly agent?: boolean;
  readonly pull?: boolean;
  readonly install: boolean;
  readonly login: boolean;
  readonly orm?: string;
  /** Explicit project slug; `--no-project` opts out of app-scoped setup. */
  readonly project?: string;
  readonly useProject: boolean;
}

export function parseInitArgs(args: readonly string[]): InitOptions {
  const has = (flag: string): boolean => args.includes(flag);
  const val = (flag: string): string | undefined => {
    const inline = args.find((arg) => arg.startsWith(`${flag}=`));
    if (inline) return inline.slice(flag.length + 1);
    const index = args.indexOf(flag);
    const next = args[index + 1];
    return index >= 0 && next && !next.startsWith('-') ? next : undefined;
  };
  return {
    yes: has('--yes') || has('-y'),
    plan: has('--plan') || has('--dry-run'),
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

/** Detect the ORM without importing customer code or executing its config. */
export function detectOrm(override?: string, root = process.cwd()): DetectedOrm {
  if (override === 'prisma' || override === 'drizzle' || override === 'none') return override;
  try {
    const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const dependencies = { ...pkg.dependencies, ...pkg.devDependencies };
    if (dependencies['@prisma/client'] || dependencies.prisma) return 'prisma';
    if (dependencies['drizzle-orm']) return 'drizzle';
  } catch {
    // An unreadable manifest produces the neutral scaffold; init validates the
    // project root separately before this detector runs.
  }
  return 'none';
}

export function detectNextLayout(root = process.cwd()): {
  readonly appBase: string;
  readonly aliasBase: string;
} {
  const useSrc =
    existsSync(resolve(root, 'src', 'app')) ||
    (!existsSync(resolve(root, 'app')) && existsSync(resolve(root, 'src')));
  return useSrc
    ? { appBase: join('src', 'app'), aliasBase: 'src' }
    : { appBase: 'app', aliasBase: '.' };
}

export function detectPackageManager(root = process.cwd()): 'pnpm' | 'yarn' | 'bun' | 'npm' {
  if (existsSync(resolve(root, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(resolve(root, 'yarn.lock'))) return 'yarn';
  if (existsSync(resolve(root, 'bun.lockb'))) return 'bun';
  return 'npm';
}
