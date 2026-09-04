import { afterEach, describe, expect, it, jest } from '@jest/globals';
import type { SchemaDeploymentPlan } from '@abloatai/transaction/schema';
import { renderDeploymentPlan } from '../plan/render';

describe('schema deployment plan renderer', () => {
  afterEach(() => { jest.restoreAllMocks(); });

  it('collapses repeated optional metadata advisories without hiding other findings', () => {
    const lines: string[] = [];
    jest.spyOn(console, 'log').mockImplementation((line = '') => lines.push(String(line)));
    const metadata = (
      id: string,
      model: string,
      column: string,
    ): SchemaDeploymentPlan['findings'][number] => ({
      id, code: 'base_column_degraded', category: 'advisory', severity: 'warning',
      direction: 'source_to_database', phase: 'intent', owner: 'application', model, column,
      message: `Table "${model}" has no "${column}"; audit or ordering metadata may be reduced.`,
      action: 'Declare and add this field only if the application needs that metadata.',
    });
    const plan: SchemaDeploymentPlan = {
      id: 'ablo-schema-deployment-plan-v1',
      mode: 'plan',
      createdAt: '2026-09-04T00:00:00.000Z',
      fingerprint: 'plan_test',
      target: {
        organizationId: null,
        projectId: null,
        branchId: null,
        databaseSubject: 'postgres.example/app',
        confirmed: true,
      },
      outcome: 'aligned',
      states: {
        source: {
          observedAt: '2026-09-04T00:00:00.000Z',
          path: 'ablo/schema.ts',
          hash: 'source',
        },
        active: {
          observedAt: '2026-09-04T00:00:00.000Z',
          schemaId: 'schema_test',
          version: 3,
          hash: 'active',
          pushedAt: '2026-09-04T00:00:00.000Z',
        },
        database: {
          observedAt: '2026-09-04T00:00:00.000Z',
          subject: 'postgres.example/app',
          fingerprint: 'database',
          appSchema: 'public',
          ownership: 'application',
        },
      },
      findings: [
        metadata('one', 'messages', 'created_by'),
        metadata('two', 'messages', 'created_at'),
        metadata('three', 'conversations', 'created_at'),
        {
          id: 'four', code: 'foreign_key_unverified', category: 'advisory', severity: 'warning',
          direction: 'source_to_database', phase: 'intent', owner: 'application', model: 'messages',
          message: 'A distinct warning.', action: 'Inspect it.',
        },
      ],
      steps: [{
        id: 'intent',
        phase: 'intent',
        title: 'intent',
        action: 'Review advisories.',
        status: 'advisory',
        owner: 'application',
        executableByAblo: false,
        findingIds: ['one', 'two', 'three', 'four'],
        dependsOn: [],
      }],
      operations: { sourceToActive: [], provision: [] },
      rollbackTarget: null,
      recovery: 'rollback',
    };

    renderDeploymentPlan(plan);

    const output = lines.join('\n');
    expect(output).toContain('optional metadata → 3 columns across 2 models');
    expect(output).toContain('created_by (1), created_at (2)');
    expect(output).toContain('A distinct warning.');
    expect(output).not.toContain('Table "messages" has no');
  });
});
