import { describe, expect, it, jest } from '@jest/globals';
import {
  branchSlugFromRef,
  discoverBranchRef,
  parseBranchDevArgs,
  runBranchDev,
} from '../branchDev';
import type { EnsureBranchCredentialInput } from '../branches';
import type { DevRuntimeOptions } from '../dev';

const branch = {
  object: 'branch' as const,
  id: 'br_feature',
  project_id: 'project_a',
  parent_branch_id: 'br_root',
  slug: 'feature-order-approval',
  name: 'feature-order-approval',
  kind: 'dev' as const,
  state: 'ready' as const,
  origin: 'empty' as const,
  root: false,
  expires_at: null,
  created_at: '2026-07-26T08:00:00.000Z',
  deleted_at: null,
};

const credential = {
  object: 'branch_credential' as const,
  branch_id: branch.id,
  api_key: 'sk_test_temporary_branch',
  expires_at: '2026-07-26T16:00:00.000Z',
};

describe('branch-aware dev arguments', () => {
  it('separates branch orchestration flags from existing dev flags', () => {
    expect(
      parseBranchDevArgs([
        '--branch',
        'feature/orders',
        '--branch-ttl-hours',
        '12',
        '--schema',
        'db/schema.ts',
        '--watch',
      ]),
    ).toEqual({
      branchSlug: 'feature/orders',
      ttlHours: 12,
      devArgv: ['--schema', 'db/schema.ts', '--watch'],
    });
  });

  it('rejects the removed shared-sandbox escape hatch', () => {
    expect(() => parseBranchDevArgs(['--no-branch', '--no-watch'])).toThrow(
      /development is branch-isolated/,
    );
  });
});

describe('branch discovery', () => {
  it('normalizes Git refs into safe plane slugs', () => {
    expect(branchSlugFromRef('Feature/Order Approval')).toBe('feature-order-approval');
    expect(branchSlugFromRef('production')).toBe('production-dev');
  });

  it('shortens long refs deterministically without exceeding the plane limit', () => {
    const ref = `feature/${'very-long-name-'.repeat(5)}`;
    const first = branchSlugFromRef(ref);
    expect(first).toBe(branchSlugFromRef(ref));
    expect(first.length).toBeLessThanOrEqual(40);
  });

  it('prefers explicit and CI refs before consulting Git', () => {
    const git = jest.fn(() => 'git-branch');
    expect(discoverBranchRef('explicit', { ABLO_BRANCH: 'env' }, git)).toBe('explicit');
    expect(discoverBranchRef(undefined, { GITHUB_HEAD_REF: 'pull-request' }, git)).toBe(
      'pull-request',
    );
    expect(git).not.toHaveBeenCalled();
  });
});

describe('runBranchDev', () => {
  it('bootstraps a branch and passes only the temporary key to dev', async () => {
    const bootstrap = jest.fn<
      (input: EnsureBranchCredentialInput) => Promise<{ branch: typeof branch; credential: typeof credential }>
    >(async () => ({ branch, credential }));
    const runDev = jest.fn<
      (argv: readonly string[], options?: DevRuntimeOptions) => Promise<void>
    >(async () => undefined);

    await runBranchDev(
      ['--branch', 'Feature/Order Approval', '--no-watch', '--url', 'https://engine.test'],
      {
        bootstrap,
        runDev,
        resolveManagementKey: () => 'mk_management',
        discoverRef: (explicit) => explicit ?? 'unused',
      },
    );

    expect(bootstrap).toHaveBeenCalledWith({
      slug: 'feature-order-approval',
      apiKey: 'mk_management',
      baseUrl: 'https://engine.test',
      ttlHours: 8,
      kind: 'dev',
    });
    expect(runDev).toHaveBeenCalledWith(
      ['--no-watch', '--url', 'https://engine.test'],
      {
        apiKey: credential.api_key,
        branch: {
          id: branch.id,
          projectId: branch.project_id,
          slug: branch.slug,
          expiresAt: credential.expires_at,
        },
      },
    );
  });

  it('refuses a production observer as branch-management authority', async () => {
    await expect(
      runBranchDev(['--branch', 'feature/orders'], {
        resolveManagementKey: () => 'rk_live_observer',
        discoverRef: (explicit) => explicit ?? 'unused',
      }),
    ).rejects.toThrow(/management credential/);
  });
});
