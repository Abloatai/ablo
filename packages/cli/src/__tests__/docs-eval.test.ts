import { describe, expect, it } from '@jest/globals';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SETUP_CONTRACT_VERSION, setupAdaptationTaskSchema } from '../setup/contracts';
import {
  gradeExistingOperationCoordination,
  gradeSandcastleIssueCoordination,
} from '../setup/docsEval';
import { buildDocsEvalBundle } from '../../scripts/lib/docs-eval-bundle';

const operationPath = 'src/tasks/completeTask.ts';

function codes(source: string, protectedChanges: readonly string[] = []): string[] {
  return gradeExistingOperationCoordination({
    source,
    operationPath,
    protectedChanges,
  }).map(({ code }) => code);
}

describe('brownfield documentation eval grader', () => {
  it('gives a fresh model only generic mechanics and the pinned public page', () => {
    const root = mkdtempSync(join(tmpdir(), 'ablo-docs-bundle-test-'));
    const page = join(root, 'public.md');
    writeFileSync(page, '# Public integration page\n');
    const record = setupAdaptationTaskSchema.parse({
      schemaVersion: SETUP_CONTRACT_VERSION,
      kind: 'ablo_setup_adaptation_task',
      recordId: 'isolated-docs-eval',
      actionId: 'implement',
      repositoryRoot: root,
      applicationRoot: root,
      selectedModels: ['tasks'],
      discoveryHints: [],
      scope: {
        allowedRoot: root,
        mustExploreBeyondHints: true,
        mayReadEnvironmentValues: false,
        maximumMutation: 'local_write',
      },
      objective: 'Prevent duplicate work while preserving the existing operation.',
      constraints: ['Do not perform remote effects.'],
      acceptanceCriteria: ['The application typechecks.'],
    });

    const bundle = buildDocsEvalBundle({ record, pages: [{ path: page }] });

    expect(bundle.skill.version).toBe('docs-eval-v1');
    expect(bundle.skill.files.map(({ path }) => path)).toEqual([
      'SKILL.md',
      'references/public.md',
    ]);
    expect(bundle.skill.files[0]?.content).not.toContain('commits.create');
    expect(bundle.skill.files[1]?.content).toBe('# Public integration page\n');
  });

  it('accepts identifier coordination around the existing operation', () => {
    const source = `
      import { ablo } from '../ablo';
      async function prepareInSandbox(input: CompleteTaskInput) { return input.requestedResult; }
      export async function completeTask(input: CompleteTaskInput) {
        const lease = await ablo.taskRuns.claim(input.id, {
          contention: { mode: 'skip' },
          ttl: '5m',
          heartbeat: { every: '30s' },
        });
        if (!lease) return { outcome: 'skipped' };
        await using heldLease = lease;
        const prepared = await prepareInSandbox(input);
        return existingTaskService.commitPrepared(input, prepared);
      }
    `;

    expect(codes(source)).toEqual([]);
  });

  it('accepts a multiline skipped result that includes the current task', () => {
    const source = `
      export async function completeTask(input: CompleteTaskInput) {
        const lease = await ablo.taskRuns.claim(input.id, {
          contention: { mode: 'skip' },
          ttl: '5m',
          heartbeat: { every: '30s' },
        });
        if (!lease) {
          // The public contract permits the current task on a skipped result.
          const task = await existingTaskService.get(input.id);
          return { outcome: 'skipped', task };
        }
        try {
          const prepared = await prepareInSandbox(input);
          return existingTaskService.commitPrepared(input, prepared);
        } finally {
          await lease.release();
        }
      }
    `;

    expect(codes(source)).toEqual([]);
  });

  it('identifies replacement writes and ownership changes', () => {
    const source = `
      export async function completeTask(input: CompleteTaskInput) {
        const prepared = await prepareInSandbox(input);
        return ablo.taskRuns.update(input.id, { result: prepared });
      }
    `;

    expect(codes(source, ['src/db.ts', 'src/graphql/resolver.ts'])).toEqual(expect.arrayContaining([
      'claim_boundary_missing',
      'lease_release_missing',
      'operation_order_wrong',
      'contention_result_missing',
      'ownership_boundary_bypassed',
      'existing_transaction_replaced',
      'public_api_changed',
    ]));
  });
});

describe('pinned Sandcastle documentation eval grader', () => {
  it('accepts coordination around the existing per-issue implementer', () => {
    const source = `
      ${'// retained upstream line\n'.repeat(50)}
      const settled = await Promise.allSettled(issues.map(async (issue) => {
        const lease = await ablo.taskRuns.claim(issue.id, {
          contention: { mode: "skip" },
          ttl: "30m",
          heartbeat: { every: "30s" },
        });
        if (!lease) return undefined;
        await using heldLease = lease;
        return sandcastle.run({ name: "implementer" });
      }));
      const completedIssues = settled.flatMap(() => []);
      await sandcastle.run({ name: "merger" });
    `;

    expect(gradeSandcastleIssueCoordination({
      source,
      operationPath: 'src/templates/parallel-planner/main.mts',
      protectedChanges: [],
    })).toEqual([]);
  });

  it('accepts a bare return as the empty contended result', () => {
    const source = `
      ${'// retained upstream line\n'.repeat(50)}
      const settled = await Promise.allSettled(issues.map(async (issue) => {
        const lease = await ablo.taskRuns.claim(issue.id, {
          contention: { mode: "skip" },
          ttl: "30m",
          heartbeat: { every: "30s" },
        });
        if (!lease) return;
        await using heldLease = lease;
        return sandcastle.run({ name: "implementer" });
      }));
      const completedIssues = settled.flatMap(() => []);
      await sandcastle.run({ name: "merger" });
    `;

    expect(gradeSandcastleIssueCoordination({
      source,
      operationPath: 'src/templates/parallel-planner/main.mts',
      protectedChanges: [],
    })).toEqual([]);
  });

  it('accepts an empty-commit sentinel excluded by the existing merge filter', () => {
    const source = `
      ${'// retained upstream line\n'.repeat(50)}
      const settled = await Promise.allSettled(issues.map(async (issue) => {
        const lease = await ablo.taskRuns.claim(issue.id, {
          contention: { mode: "skip" },
          ttl: "30m",
          heartbeat: { every: "30s" },
        });
        if (!lease) {
          return { commits: [] };
        }
        try {
          return sandcastle.run({ name: "implementer" });
        } finally {
          await lease.release();
        }
      }));
      const completedIssues = settled.filter(
        (outcome) => outcome.status === "fulfilled" && outcome.value.commits.length > 0,
      );
      await sandcastle.run({ name: "merger" });
    `;

    expect(gradeSandcastleIssueCoordination({
      source,
      operationPath: 'src/templates/parallel-planner/main.mts',
      protectedChanges: [],
    })).toEqual([]);
  });

  it('accepts a marked skip excluded through a narrowed result value', () => {
    const source = `
      ${'// retained upstream line\n'.repeat(50)}
      const settled = await Promise.allSettled(issues.map(async (issue) => {
        const lease = await ablo.taskRuns.claim(issue.id, {
          contention: { mode: "skip" },
          ttl: "30m",
          heartbeat: { every: "30s" },
        });
        if (!lease) {
          return { skipped: true, issue };
        }
        try {
          const result = await sandcastle.run({ name: "implementer" });
          return { skipped: false, issue, result };
        } finally {
          await lease.release();
        }
      }));
      const completedIssues = settled.filter((outcome) => {
        if (outcome.status !== "fulfilled") return false;
        const value = outcome.value;
        return value.skipped === false && value.result.commits.length > 0;
      });
      await sandcastle.run({ name: "merger" });
    `;

    expect(gradeSandcastleIssueCoordination({
      source,
      operationPath: 'src/templates/parallel-planner/main.mts',
      protectedChanges: [],
    })).toEqual([]);
  });

  it('rejects a claim that replaces Sandcastle branch merging', () => {
    const source = `
      ${'// retained upstream line\n'.repeat(50)}
      const result = await ablo.commits.create({});
      await sandcastle.run({ name: "implementer" });
    `;

    expect(gradeSandcastleIssueCoordination({
      source,
      operationPath: 'src/templates/parallel-planner/main.mts',
      protectedChanges: ['src/run.ts'],
    }).map(({ code }) => code)).toEqual(expect.arrayContaining([
      'claim_boundary_missing',
      'lease_release_missing',
      'contention_result_missing',
      'ownership_boundary_bypassed',
      'existing_commit_path_replaced',
      'protected_owner_changed',
    ]));
  });
});
