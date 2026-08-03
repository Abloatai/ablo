/**
 * Branch-first orchestration for `ablo dev`.
 *
 * The long-lived login key is used only to ensure a branch and exchange for a
 * short-lived branch credential. The temporary key is handed to the existing
 * schema watcher and its gitignored `.env.local` wiring so the application uses
 * the same branch without copy-paste. It is never added to the long-lived Ablo
 * credential store or the repository.
 */

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { branchSlugSchema } from '@abloatai/transaction/branches';
import { AbloValidationError } from '@abloatai/transaction/errors';
import { ensureBranchCredential } from './branches';
import { resolveManagementKey } from './config';
import { dev, type DevRuntimeOptions } from './dev';
import { DEFAULT_URL } from './controlPlane';

export const BRANCH_DEV_USAGE = `Usage:
  ablo dev [--branch <slug>] [--branch-ttl-hours <1-168>]
           [--schema <path>] [--export <name>] [--url <url>]
           [--local] [--source <path>]
  ablo dev --no-watch [branch options]

By default, dev discovers the Git/CI branch, ensures its isolated Ablo branch,
mints an expiring runtime key, writes it to gitignored .env.local, pushes the
schema, and watches for changes.`;

export interface BranchDevArgs {
  branchSlug?: string;
  ttlHours: number;
  devArgv: string[];
}

export function parseBranchDevArgs(argv: readonly string[]): BranchDevArgs {
  let branchSlug: string | undefined;
  let ttlHours = 8;
  const devArgv: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg) continue;
    if (arg === '--no-branch') {
      throw new AbloValidationError(
        '--no-branch was removed: development is branch-isolated. Use --branch <slug> to select explicitly.',
        { code: 'cli_invalid_arguments' },
      );
    }
    if (arg === '--branch') {
      branchSlug = argv[++index];
      if (!branchSlug) {
        throw new AbloValidationError('--branch requires a slug', {
          code: 'cli_invalid_arguments',
        });
      }
      continue;
    }
    if (arg === '--branch-ttl-hours') {
      const value = Number(argv[++index]);
      if (!Number.isInteger(value) || value < 1 || value > 168) {
        throw new AbloValidationError('--branch-ttl-hours must be between 1 and 168', {
          code: 'cli_invalid_arguments',
        });
      }
      ttlHours = value;
      continue;
    }
    devArgv.push(arg);
  }

  return {
    ...(branchSlug ? { branchSlug } : {}),
    ttlHours,
    devArgv,
  };
}

/** Convert a Git/CI ref into a safe branch slug. */
export function branchSlugFromRef(ref: string): string {
  const base = ref
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!base) {
    throw new AbloValidationError(`cannot derive an Ablo branch slug from "${ref}"`, {
      code: 'cli_invalid_arguments',
    });
  }

  const nonRoot = base === 'production' ? 'production-dev' : base;
  const shortened =
    nonRoot.length <= 40
      ? nonRoot
      : `${nonRoot.slice(0, 31).replace(/-+$/g, '')}-${createHash('sha256')
          .update(nonRoot)
          .digest('hex')
          .slice(0, 8)}`;
  return branchSlugSchema.parse(shortened);
}

function gitBranch(): string | undefined {
  try {
    const value = execFileSync('git', ['branch', '--show-current'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return value || undefined;
  } catch {
    return undefined;
  }
}

export function discoverBranchRef(
  explicit: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
  readGitBranch: () => string | undefined = gitBranch,
): string {
  const value =
    explicit ??
    env.ABLO_BRANCH ??
    env.GITHUB_HEAD_REF ??
    env.GITHUB_REF_NAME ??
    env.VERCEL_GIT_COMMIT_REF ??
    env.CI_COMMIT_REF_NAME ??
    readGitBranch();
  if (!value) {
    throw new AbloValidationError(
      'Could not determine the Git branch. Pass --branch <slug> or set ABLO_BRANCH.',
      { code: 'cli_invalid_arguments' },
    );
  }
  return value;
}

function valueAfter(argv: readonly string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
}

export interface BranchDevDependencies {
  bootstrap?: typeof ensureBranchCredential;
  runDev?: (argv: readonly string[], options?: DevRuntimeOptions) => Promise<void>;
  resolveManagementKey?: () => string | undefined;
  discoverRef?: (explicit: string | undefined) => string;
}

export async function runBranchDev(
  argv: readonly string[],
  dependencies: BranchDevDependencies = {},
): Promise<void> {
  const parsed = parseBranchDevArgs(argv);
  const run = dependencies.runDev ?? dev;
  const ref = (dependencies.discoverRef ?? discoverBranchRef)(parsed.branchSlug);
  const slug = branchSlugFromRef(ref);
  const managementKey =
    dependencies.resolveManagementKey?.() ?? resolveManagementKey();
  if (!managementKey) {
    throw new AbloValidationError(
      'Creating a development branch needs a project management credential. Run `npx ablo login` or set ABLO_MANAGEMENT_KEY.',
      { code: 'cli_invalid_arguments' },
    );
  }
  if (!managementKey.startsWith('mk_')) {
    throw new AbloValidationError(
      'Branch creation needs the active project management credential (mk_…). Run `npx ablo login` to refresh it.',
      { code: 'cli_invalid_arguments' },
    );
  }

  const baseUrl =
    valueAfter(parsed.devArgv, '--url') ??
    process.env.ABLO_API_URL ??
    DEFAULT_URL;
  const result = await (dependencies.bootstrap ?? ensureBranchCredential)({
    slug,
    apiKey: managementKey,
    baseUrl,
    ttlHours: parsed.ttlHours,
    kind: 'dev',
  });

  await run(parsed.devArgv, {
    apiKey: result.credential.api_key,
    branch: {
      id: result.branch.id,
      projectId: result.branch.project_id,
      slug: result.branch.slug,
      expiresAt: result.credential.expires_at,
    },
  });
}
