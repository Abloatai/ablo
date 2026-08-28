import { defineSchema } from '../schema.js';
import { model } from '../model.js';
import { toSchemaJSON, schemaHash } from '../serialize.js';
import { z } from 'zod';
import {
  buildSchemaDeploymentPlan,
  runSchemaDeploymentLifecycle,
  type DatabaseSnapshot,
  type DeploymentObservation,
  runResumableBackfill,
} from '../deployment/index.js';

const decks = defineSchema({
  branches: model({ title: z.string() }, { groups: { root: 'project' } }),
  subscriptions: model({ userId: z.string() }),
});
const schema = toSchemaJSON(decks);

const database: DatabaseSnapshot = {
  observedAt: '2026-08-28T00:00:00.000Z',
  subject: 'postgres.example/decks',
  fingerprint: 'db_one',
  appSchema: 'public',
  ownership: 'application',
  tables: {
    branches: {
      schema: 'public', name: 'branches', rowLevelSecurity: true, forceRowLevelSecurity: true, replicaIdentity: 'f', publicationMember: true,
      columns: {
        organization_id: { name: 'organization_id', dataType: 'text', nullable: false, default: null, primary: false, unique: false },
        title: { name: 'title', dataType: 'text', nullable: false, default: null, primary: false, unique: false },
      },
    },
    subscriptions: {
      schema: 'public', name: 'subscriptions', rowLevelSecurity: true, forceRowLevelSecurity: true, replicaIdentity: 'f', publicationMember: true,
      columns: {
        id: { name: 'id', dataType: 'text', nullable: false, default: null, primary: true, unique: true },
        organization_id: { name: 'organization_id', dataType: 'text', nullable: false, default: null, primary: false, unique: false },
        user_id: { name: 'user_id', dataType: 'text', nullable: false, default: null, primary: false, unique: false },
      },
    },
  },
};

const observation = (): DeploymentObservation => ({
  target: { organizationId: 'org_decks', projectId: 'project_decks', branchId: 'branch_main', databaseSubject: database.subject, confirmed: true },
  source: { observedAt: '2026-08-28T00:00:00.000Z', path: 'ablo/schema.ts', hash: schemaHash(decks), schema },
  active: { observedAt: '2026-08-28T00:00:00.000Z', schemaId: 'schema_57', version: 57, hash: schemaHash(decks), pushedAt: '2026-08-22T00:00:00.000Z', schema },
  database,
});

describe('one schema deployment skeleton', () => {
  it('separates policy intent, hard identity, and timestamp advisories', () => {
    const plan = buildSchemaDeploymentPlan(observation(), '2026-08-28T01:00:00.000Z');
    expect(plan.outcome).toBe('blocked');
    expect(plan.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'scope_routing_without_access_policy', model: 'branches', category: 'policy_intent', severity: 'blocker' }),
      expect.objectContaining({ code: 'missing_identity_column', model: 'branches', column: 'id', category: 'physical_contract', severity: 'blocker' }),
      expect.objectContaining({ code: 'base_column_degraded', model: 'subscriptions', column: 'created_at', category: 'advisory', severity: 'warning' }),
    ]));
    expect(plan.steps[0]).toEqual(expect.objectContaining({ phase: 'intent', dependsOn: [] }));
    expect(plan.steps.every((step, index) => index === 0 || step.dependsOn.length === 1)).toBe(true);
    expect(plan.rollbackTarget).toEqual(expect.objectContaining({ version: 57, strategy: 'reactivate_artifact' }));
  });

  it('uses the same observation and plan object for plan mode', async () => {
    const result = await runSchemaDeploymentLifecycle({ observe: async () => observation() }, 'plan');
    expect(result).toEqual(expect.objectContaining({ id: 'ablo-schema-deployment-plan-v1', outcome: 'blocked' }));
  });

  it('keeps live expand and contract in separately approved manifests', () => {
    const input = observation();
    const plan = buildSchemaDeploymentPlan({ ...input, intent: { manifest: {
      id: 'rename-branches-id', live: true, targetPhase: 'contract', gates: [
        { id: 'expand', phase: 'expand', owner: 'application_migration', resource: 'branches.id', title: 'add identity', action: 'add column', status: 'satisfied', dependsOn: [] },
        { id: 'contract', phase: 'contract', owner: 'application_migration', resource: 'branches.id', title: 'remove old identity', action: 'drop old column', status: 'ready', dependsOn: ['expand'], approval: 'review-42' },
      ],
    } } }, '2026-08-28T01:00:00.000Z');
    expect(plan.findings).toContainEqual(expect.objectContaining({ code: 'mixed_expand_contract', severity: 'blocker', phase: 'contract' }));
  });

  it('resumes a bounded idempotent backfill from its durable checkpoint', async () => {
    let stored = null as Awaited<ReturnType<typeof runResumableBackfill>> | null;
    const cursors: (string | null)[] = [];
    const result = await runResumableBackfill({
      load: async () => stored,
      save: async (checkpoint) => { stored = checkpoint; },
      runBatch: async ({ cursor }) => {
        cursors.push(cursor);
        return cursor === null ? { nextCursor: '500', processed: 500, done: false } : { nextCursor: '750', processed: 250, done: true };
      },
      now: () => '2026-08-28T01:00:00.000Z',
    }, { jobId: 'subscriptions-created-at', idempotencyKey: 'schema-58:subscriptions.createdAt', batchSize: 500 });
    expect(cursors).toEqual([null, '500']);
    expect(result).toEqual(expect.objectContaining({ status: 'succeeded', processed: 750, batches: 2, cursor: '750' }));
    expect(await runResumableBackfill({ load: async () => stored, save: async () => {}, runBatch: async () => { throw new Error('must not rerun'); } }, { jobId: result.jobId, idempotencyKey: result.idempotencyKey })).toBe(result);
  });
});
