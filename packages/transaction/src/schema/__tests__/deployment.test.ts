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
    expect(plan.findings.filter(({ code, model }) => code === 'missing_identity_column' && model === 'branches')).toHaveLength(1);
    expect(plan.findings.filter(({ code, model, column }) => code === 'base_column_degraded' && model === 'subscriptions' && column === 'created_at')).toHaveLength(1);
  });

  it('uses matching non-null PostgreSQL columns as completed required-field migration evidence', () => {
    const input = observation();
    const source = structuredClone(input.source.schema);
    source.models.subscriptions!.tableName = 'billing_subscriptions';
    source.models.subscriptions!.fields.displayName = {
      ...source.models.subscriptions!.fields.userId!,
      column: 'display_name',
    };
    const active = structuredClone(source);
    delete active.models.subscriptions!.fields.displayName;
    const observedDatabase = structuredClone(database);
    observedDatabase.tables.billing_subscriptions = {
      ...observedDatabase.tables.subscriptions!,
      name: 'billing_subscriptions',
    };
    delete observedDatabase.tables.subscriptions;
    observedDatabase.tables.billing_subscriptions.columns.display_name = {
      name: 'display_name', dataType: 'text', nullable: false, default: null, primary: false, unique: false,
    };

    const plan = buildSchemaDeploymentPlan({
      ...input,
      source: { ...input.source, schema: source },
      active: { ...input.active!, schema: active },
      database: observedDatabase,
    }, '2026-08-28T01:00:00.000Z');

    expect(plan.findings).not.toContainEqual(expect.objectContaining({ code: 'required_field_added', model: 'subscriptions', field: 'displayName' }));
    expect(plan.findings).toContainEqual(expect.objectContaining({
      code: 'database_migration_verified',
      severity: 'info',
      from: { requiredChanges: 1 },
    }));
  });

  it('keeps a required-field blocker when PostgreSQL still permits nulls', () => {
    const input = observation();
    const source = structuredClone(input.source.schema);
    source.models.subscriptions!.fields.displayName = {
      ...source.models.subscriptions!.fields.userId!,
      column: 'display_name',
    };
    const active = structuredClone(source);
    delete active.models.subscriptions!.fields.displayName;
    const observedDatabase = structuredClone(database);
    observedDatabase.tables.subscriptions!.columns.display_name = {
      name: 'display_name', dataType: 'text', nullable: true, default: null, primary: false, unique: false,
    };

    const plan = buildSchemaDeploymentPlan({
      ...input,
      source: { ...input.source, schema: source },
      active: { ...input.active!, schema: active },
      database: observedDatabase,
    }, '2026-08-28T01:00:00.000Z');

    expect(plan.findings).toContainEqual(expect.objectContaining({
      code: 'required_field_added', model: 'subscriptions', field: 'displayName', severity: 'blocker',
    }));
    expect(plan.findings).toContainEqual(expect.objectContaining({
      code: 'column_nullable', model: 'subscriptions', field: 'displayName', severity: 'blocker',
    }));
  });

  it.each([
    {
      name: 'the observed type disagrees with the source field',
      database: { dataType: 'boolean', nullable: false, nullCount: undefined },
      expectedPhysicalCode: 'column_type_mismatch',
    },
    {
      name: 'the snapshot contradicts its non-null constraint with observed NULL rows',
      database: { dataType: 'text', nullable: false, nullCount: 1 },
      expectedPhysicalCode: null,
    },
  ])('does not discharge required migration work when $name', ({ database: column, expectedPhysicalCode }) => {
    const input = observation();
    const source = structuredClone(input.source.schema);
    source.models.subscriptions!.fields.displayName = {
      ...source.models.subscriptions!.fields.userId!,
      column: 'display_name',
    };
    const active = structuredClone(source);
    delete active.models.subscriptions!.fields.displayName;
    const observedDatabase = structuredClone(database);
    observedDatabase.tables.subscriptions!.columns.display_name = {
      name: 'display_name', default: null, primary: false, unique: false, ...column,
    };

    const plan = buildSchemaDeploymentPlan({
      ...input,
      source: { ...input.source, schema: source },
      active: { ...input.active!, schema: active },
      database: observedDatabase,
    }, '2026-08-28T01:00:00.000Z');

    expect(plan.findings).toContainEqual(expect.objectContaining({
      code: 'required_field_added', model: 'subscriptions', field: 'displayName', severity: 'blocker',
    }));
    if (expectedPhysicalCode) {
      expect(plan.findings).toContainEqual(expect.objectContaining({
        code: expectedPhysicalCode, model: 'subscriptions', field: 'displayName', severity: 'blocker',
      }));
    }
  });

  it('uses PostgreSQL evidence for an optional-to-required transition', () => {
    const input = observation();
    const source = structuredClone(input.source.schema);
    source.models.subscriptions!.fields.userId = {
      ...source.models.subscriptions!.fields.userId!,
      isOptional: false,
    };
    const active = structuredClone(source);
    active.models.subscriptions!.fields.userId = {
      ...active.models.subscriptions!.fields.userId!,
      isOptional: true,
    };

    const plan = buildSchemaDeploymentPlan({
      ...input,
      source: { ...input.source, schema: source },
      active: { ...input.active!, schema: active },
    }, '2026-08-28T01:00:00.000Z');

    expect(plan.findings).not.toContainEqual(expect.objectContaining({
      code: 'made_required', model: 'subscriptions', field: 'userId', severity: 'blocker',
    }));
    expect(plan.findings).toContainEqual(expect.objectContaining({
      code: 'database_migration_verified', from: { requiredChanges: 1 }, severity: 'info',
    }));
  });

  it('uses a matching PostgreSQL type as completed risky-cast evidence while keeping recovery forward-only', () => {
    const input = observation();
    const source = structuredClone(input.source.schema);
    delete source.models.branches;
    source.models.subscriptions!.fields.userId = {
      ...source.models.subscriptions!.fields.userId!,
      type: 'json',
    };
    const active = structuredClone(source);
    active.models.subscriptions!.fields.userId = {
      ...active.models.subscriptions!.fields.userId!,
      type: 'string',
    };
    const observedDatabase = structuredClone(database);
    delete observedDatabase.tables.branches;
    observedDatabase.tables.subscriptions!.columns.user_id!.dataType = 'jsonb';

    const plan = buildSchemaDeploymentPlan({
      ...input,
      source: { ...input.source, schema: source },
      active: { ...input.active!, schema: active },
      database: observedDatabase,
    }, '2026-08-28T01:00:00.000Z');

    expect(plan.findings).not.toContainEqual(expect.objectContaining({
      code: 'risky_cast', model: 'subscriptions', field: 'userId', severity: 'error',
    }));
    expect(plan.findings).toContainEqual(expect.objectContaining({
      code: 'database_type_correction_verified',
      category: 'destructive_contract',
      severity: 'info',
      from: { typeCorrections: 1 },
    }));
    expect(plan.outcome).toBe('ready');
    expect(plan.rollbackTarget).toBeNull();
    expect(plan.recovery).toBe('forward_only');
  });

  it.each([
    { name: 'PostgreSQL still has the active type', databaseType: 'text', observed: true },
    { name: 'PostgreSQL was not observed', databaseType: 'jsonb', observed: false },
  ])('keeps a risky-cast error when $name', ({ databaseType, observed }) => {
    const input = observation();
    const source = structuredClone(input.source.schema);
    delete source.models.branches;
    source.models.subscriptions!.fields.userId = {
      ...source.models.subscriptions!.fields.userId!,
      type: 'json',
    };
    const active = structuredClone(source);
    active.models.subscriptions!.fields.userId = {
      ...active.models.subscriptions!.fields.userId!,
      type: 'string',
    };
    const observedDatabase = structuredClone(database);
    delete observedDatabase.tables.branches;
    observedDatabase.tables.subscriptions!.columns.user_id!.dataType = databaseType;

    const plan = buildSchemaDeploymentPlan({
      ...input,
      source: { ...input.source, schema: source },
      active: { ...input.active!, schema: active },
      database: observed ? observedDatabase : null,
    }, '2026-08-28T01:00:00.000Z');

    expect(plan.findings).toContainEqual(expect.objectContaining({
      code: 'risky_cast', model: 'subscriptions', field: 'userId', severity: 'error',
    }));
    expect(plan.findings).not.toContainEqual(expect.objectContaining({ code: 'database_type_correction_verified' }));
  });

  it('does not treat a TEXT column as proof that a narrowed enum constraint is satisfied', () => {
    const input = observation();
    const source = structuredClone(input.source.schema);
    delete source.models.branches;
    source.models.subscriptions!.fields.userId = {
      ...source.models.subscriptions!.fields.userId!,
      type: 'enum',
      enumValues: ['active', 'paused'],
    };
    const active = structuredClone(source);
    active.models.subscriptions!.fields.userId = {
      ...active.models.subscriptions!.fields.userId!,
      type: 'string',
      enumValues: undefined,
    };
    const observedDatabase = structuredClone(database);
    delete observedDatabase.tables.branches;

    const plan = buildSchemaDeploymentPlan({
      ...input,
      source: { ...input.source, schema: source },
      active: { ...input.active!, schema: active },
      database: observedDatabase,
    }, '2026-08-28T01:00:00.000Z');

    expect(plan.findings).toContainEqual(expect.objectContaining({
      code: 'risky_cast', model: 'subscriptions', field: 'userId', severity: 'error',
    }));
    expect(plan.findings).not.toContainEqual(expect.objectContaining({ code: 'database_type_correction_verified' }));
  });

  it('treats removal from an application-owned served schema as metadata-only when its table remains present', () => {
    const input = observation();
    const source = structuredClone(input.source.schema);
    delete source.models.branches;

    const plan = buildSchemaDeploymentPlan({
      ...input,
      source: { ...input.source, schema: source },
    }, '2026-08-28T01:00:00.000Z');

    expect(plan.operations.sourceToActive).toContainEqual(expect.objectContaining({ kind: 'drop_model', model: 'branches' }));
    expect(plan.findings).not.toContainEqual(expect.objectContaining({ code: 'drop_model', model: 'branches' }));
    expect(plan.findings).toContainEqual(expect.objectContaining({
      code: 'application_model_removal_verified',
      category: 'compatibility',
      severity: 'warning',
      from: { removedModels: 1 },
      to: 'physical_tables_preserved',
    }));
    expect(plan.rollbackTarget).toEqual(expect.objectContaining({ version: 57 }));
  });

  it.each([
    { name: 'Ablo owns the database', ownership: 'ablo' as const, keepTable: true },
    { name: 'the application table is absent', ownership: 'application' as const, keepTable: false },
  ])('keeps a removed-model error when $name', ({ ownership, keepTable }) => {
    const input = observation();
    const source = structuredClone(input.source.schema);
    delete source.models.branches;
    const observedDatabase = structuredClone(database);
    observedDatabase.ownership = ownership;
    if (!keepTable) delete observedDatabase.tables.branches;

    const plan = buildSchemaDeploymentPlan({
      ...input,
      source: { ...input.source, schema: source },
      database: observedDatabase,
    }, '2026-08-28T01:00:00.000Z');

    expect(plan.findings).toContainEqual(expect.objectContaining({
      code: 'drop_model', model: 'branches', severity: 'error',
    }));
    expect(plan.findings).not.toContainEqual(expect.objectContaining({ code: 'application_model_removal_verified' }));
  });

  it('keeps required migration work blocked when PostgreSQL was not observed', () => {
    const input = observation();
    const source = structuredClone(input.source.schema);
    source.models.subscriptions!.fields.displayName = {
      ...source.models.subscriptions!.fields.userId!,
      column: 'display_name',
    };
    const active = structuredClone(source);
    delete active.models.subscriptions!.fields.displayName;

    const plan = buildSchemaDeploymentPlan({
      ...input,
      source: { ...input.source, schema: source },
      active: { ...input.active!, schema: active },
      database: null,
    }, '2026-08-28T01:00:00.000Z');

    expect(plan.findings).toContainEqual(expect.objectContaining({
      code: 'required_field_added', model: 'subscriptions', field: 'displayName', severity: 'blocker',
    }));
    expect(plan.findings).toContainEqual(expect.objectContaining({ code: 'database_unobserved', severity: 'blocker' }));
  });

  it('summarizes active physical drift when PostgreSQL already matches the candidate', () => {
    const input = observation();
    const active = structuredClone(input.active!.schema);
    active.models.subscriptions!.fields.userId = {
      ...active.models.subscriptions!.fields.userId!,
      type: 'boolean',
    };

    const plan = buildSchemaDeploymentPlan({
      ...input,
      active: { ...input.active!, schema: active },
    }, '2026-08-28T01:00:00.000Z');

    expect(plan.findings).not.toContainEqual(expect.objectContaining({
      code: 'column_type_mismatch', direction: 'active_to_database', model: 'subscriptions', field: 'userId',
    }));
    expect(plan.findings).toContainEqual(expect.objectContaining({
      code: 'candidate_alignment_verified',
      direction: 'active_to_database',
      from: { activePhysicalDifferences: 1 },
      severity: 'info',
    }));
  });

  it('retains both physical directions when source and active disagree differently with PostgreSQL', () => {
    const input = observation();
    const source = structuredClone(input.source.schema);
    source.models.subscriptions!.fields.userId = {
      ...source.models.subscriptions!.fields.userId!,
      type: 'boolean',
    };
    const active = structuredClone(input.active!.schema);
    active.models.subscriptions!.fields.userId = {
      ...active.models.subscriptions!.fields.userId!,
      type: 'number',
    };

    const plan = buildSchemaDeploymentPlan({
      ...input,
      source: { ...input.source, schema: source },
      active: { ...input.active!, schema: active },
    }, '2026-08-28T01:00:00.000Z');

    expect(plan.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'column_type_mismatch', direction: 'source_to_database', model: 'subscriptions', field: 'userId' }),
      expect.objectContaining({ code: 'column_type_mismatch', direction: 'active_to_database', model: 'subscriptions', field: 'userId' }),
    ]));
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
