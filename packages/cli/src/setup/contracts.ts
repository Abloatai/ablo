import { z } from 'zod';

export const SETUP_CONTRACT_VERSION = 1 as const;

export const setupEvidenceSchema = z.object({
  source: z.enum([
    'filesystem',
    'package_manifest',
    'git',
    'environment',
    'ablo_config',
    'ablo_api',
    'inference',
    'user',
  ]),
  locator: z.string().min(1).optional(),
  detail: z.string().min(1),
  observedAt: z.iso.datetime(),
}).strict();

export const setupFactSchema = z.object({
  key: z.string().min(1),
  value: z.json(),
  confidence: z.enum(['high', 'medium', 'low']),
  evidence: z.array(setupEvidenceSchema).min(1),
}).strict();

/** Adoption work discovery can infer without claiming a runtime authority exists. */
export const setupCoordinationAdoptionDispositionSchema = z.enum([
  'existing_state_reuse_candidate',
  'model_migration_required',
  'coordination_path_undetermined',
]);

export const setupDecisionSchema = z.object({
  id: z.string().min(1),
  question: z.string().min(1),
  status: z.enum(['unresolved', 'resolved', 'not_applicable']),
  choices: z.array(z.object({
    value: z.string().min(1),
    label: z.string().min(1),
    consequence: z.string().min(1),
  }).strict()),
  selected: z.string().min(1).optional(),
  reason: z.string().min(1),
}).strict().superRefine((decision, ctx) => {
  if (decision.status === 'resolved' && decision.selected === undefined) {
    ctx.addIssue({ code: 'custom', message: 'A resolved decision needs a selected value.' });
  }
  if (
    decision.selected !== undefined &&
    !decision.choices.some((choice) => choice.value === decision.selected)
  ) {
    ctx.addIssue({ code: 'custom', message: 'The selected value must be one of the choices.' });
  }
});

export const setupMutationClassSchema = z.enum([
  'read_only',
  'local_write',
  'remote_write',
  'database_write',
]);

export const setupApprovalClassSchema = z.enum(['none', 'review', 'explicit']);

export const setupActionSchema = z.object({
  id: z.string().min(1),
  stepId: z.string().min(1),
  kind: z.enum([
    'inspect_repository',
    'analyze_compatibility',
    'select_application',
    'install_dependency',
    'write_files',
    'adapt_write_paths',
    'authenticate',
    'select_project',
    'select_branch',
    'connect_database',
    'push_schema',
    'verify',
    'run_canary',
  ]),
  summary: z.string().min(1),
  mutation: setupMutationClassSchema,
  approval: setupApprovalClassSchema,
  executor: z.enum(['deterministic', 'agent', 'user']).default('deterministic'),
  status: z.enum(['planned', 'blocked', 'not_needed']),
  blockedBy: z.array(z.string().min(1)).default([]),
  paths: z.array(z.string().min(1)).default([]),
  preconditions: z.array(z.string().min(1)).default([]),
}).strict();

/** One lexically detected application write site. Candidate evidence, not an AST verdict. */
export const setupMutationSiteSchema = z.object({
  path: z.string().min(1),
  line: z.number().int().positive(),
  kind: z.enum(['prisma', 'drizzle', 'sql', 'http', 'ablo']),
  operation: z.enum([
    'create',
    'update',
    'delete',
    'upsert',
    'bulk_create',
    'bulk_update',
    'bulk_delete',
    'sql_write',
    'http_write',
  ]),
  modelHint: z.string().min(1).nullable(),
  confidence: z.enum(['high', 'medium', 'low']),
}).strict();

/** PostgreSQL column evidence used by setup's existing-table compatibility gate. */
export const setupDatabaseColumnSchema = z.object({
  table: z.string().min(1),
  column: z.string().min(1),
  dataType: z.string().min(1),
  nullable: z.boolean(),
  defaultExpression: z.string().min(1).nullable(),
  generatedBy: z.enum(['application', 'database']).default('application'),
}).strict();

export const setupCompatibilityBlockerCodeSchema = z.enum([
  'database_schema_unavailable',
  'identity_type_unsupported',
  'stable_identity_missing',
]);

export const setupDatabaseMappingSchema = z.object({
  table: z.string().min(1),
  field: z.enum(['id', 'organizationId', 'createdBy']),
  column: z.string().min(1).nullable(),
  databaseType: z.enum([
    'text',
    'uuid',
    'bigint',
  ]).nullable(),
  generatedBy: z.enum(['application', 'ablo', 'database']).nullable(),
  status: z.enum(['ready', 'review_required']),
  reason: z.string().min(1),
  evidence: z.array(setupEvidenceSchema).min(1),
}).strict().superRefine((mapping, ctx) => {
  if (mapping.column === null && (mapping.databaseType !== null || mapping.generatedBy !== null)) {
    ctx.addIssue({
      code: 'custom',
      message: 'A disabled database capability cannot declare a type or generation owner.',
    });
  }
  if (mapping.column !== null && (mapping.databaseType === null || mapping.generatedBy === null)) {
    ctx.addIssue({
      code: 'custom',
      message: 'A mapped database capability needs a database type and generation owner.',
    });
  }
});

export const setupCompatibilityRemediationSchema = z.object({
  kind: z.enum(['migration', 'translation', 'retain_direct_path', 'unsupported']),
  summary: z.string().min(1),
}).strict();

export const setupCompatibilityBlockerSchema = z.object({
  code: setupCompatibilityBlockerCodeSchema,
  table: z.string().min(1).nullable(),
  field: z.string().min(1).nullable(),
  observed: z.string().min(1),
  expected: z.string().min(1),
  remediations: z.array(setupCompatibilityRemediationSchema).min(1),
  evidence: z.array(setupEvidenceSchema).min(1),
}).strict();

const incompatibleDispositionSchema = z.object({
  blockers: z.array(setupCompatibilityBlockerSchema).min(1),
  mappings: z.array(setupDatabaseMappingSchema),
}).strict();

/** One canonical machine-readable compatibility result for CLI and agent handoffs. */
export const setupCompatibilityDispositionSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('compatible'),
    blockers: z.array(z.never()).length(0),
    mappings: z.array(setupDatabaseMappingSchema),
  }).strict(),
  incompatibleDispositionSchema.extend({ status: z.literal('migration_required') }),
  incompatibleDispositionSchema.extend({ status: z.literal('translation_required') }),
  incompatibleDispositionSchema.extend({ status: z.literal('migration_or_translation_required') }),
  incompatibleDispositionSchema.extend({ status: z.literal('unsupported') }),
]);

/** Bounded handoff from the deterministic setup kernel to an installing coding agent. */
export const setupAdaptationTaskSchema = z.object({
  schemaVersion: z.literal(SETUP_CONTRACT_VERSION),
  kind: z.literal('ablo_setup_adaptation_task'),
  recordId: z.string().min(1),
  actionId: z.string().min(1),
  repositoryRoot: z.string().min(1),
  applicationRoot: z.string().min(1),
  selectedModels: z.array(z.string().min(1)).min(1),
  databaseMappings: z.array(setupDatabaseMappingSchema).default([]),
  discoveryHints: z.array(setupMutationSiteSchema),
  scope: z.object({
    allowedRoot: z.string().min(1),
    mustExploreBeyondHints: z.literal(true),
    mayReadEnvironmentValues: z.literal(false),
    maximumMutation: z.literal('local_write'),
  }).strict(),
  objective: z.string().min(1),
  constraints: z.array(z.string().min(1)).min(1),
  acceptanceCriteria: z.array(z.string().min(1)).min(1),
}).strict().superRefine((record, ctx) => {
  if (record.applicationRoot !== record.scope.allowedRoot) {
    ctx.addIssue({
      code: 'custom',
      path: ['scope', 'allowedRoot'],
      message: 'The adaptation scope must equal the selected application root.',
    });
  }
});

export const setupSkillFileSchema = z.object({
  path: z.string().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  content: z.string().min(1),
}).strict();

/** Versioned, self-contained knowledge bundle consumed by any coding-agent harness. */
export const setupSkillBundleSchema = z.object({
  schemaVersion: z.literal(SETUP_CONTRACT_VERSION),
  kind: z.literal('ablo_setup_skill'),
  id: z.literal('integrate-ablo'),
  version: z.string().min(1),
  entrypoint: z.literal('SKILL.md'),
  files: z.array(setupSkillFileSchema).min(1),
}).strict();

export const setupAgentBundleSchema = z.object({
  schemaVersion: z.literal(SETUP_CONTRACT_VERSION),
  kind: z.literal('ablo_setup_agent_bundle'),
  createdAt: z.iso.datetime(),
  record: setupAdaptationTaskSchema,
  skill: setupSkillBundleSchema,
}).strict();

export const setupWorkspaceSnapshotSchema = z.object({
  schemaVersion: z.literal(SETUP_CONTRACT_VERSION),
  kind: z.literal('ablo_setup_workspace_snapshot'),
  repositoryRoot: z.string().min(1),
  capturedAt: z.iso.datetime(),
  truncated: z.boolean(),
  files: z.array(z.object({
    path: z.string().min(1),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    size: z.number().int().nonnegative(),
    protectedEnvironment: z.boolean(),
  }).strict()),
}).strict();

export const setupDiffEvaluationSchema = z.object({
  schemaVersion: z.literal(SETUP_CONTRACT_VERSION),
  kind: z.literal('ablo_setup_diff_evaluation'),
  createdAt: z.iso.datetime(),
  selectedModels: z.array(z.string().min(1)).min(1),
  changes: z.array(z.object({
    path: z.string().min(1),
    kind: z.enum(['created', 'modified', 'deleted']),
  }).strict()),
  checks: z.array(z.object({
    id: z.string().min(1),
    status: z.enum(['pass', 'fail', 'review']),
    detail: z.string().min(1),
    evidencePaths: z.array(z.string().min(1)),
  }).strict()),
  outcome: z.enum(['candidate', 'incomplete', 'unsafe']),
  summary: z.string().min(1),
}).strict();

export const setupEvalVerificationSchema = z.object({
  id: z.string().min(1),
  status: z.enum(['pass', 'fail', 'error']),
  detail: z.string().min(1),
  durationMs: z.number().int().nonnegative(),
}).strict();

/** Agent-reported review handoff. Evidence only; repository graders remain authoritative. */
export const setupAgentHandoffSchema = z.object({
  outcome: z.enum(['candidate', 'blocked', 'failed']),
  changedFiles: z.array(z.string().min(1)),
  exploredWritePaths: z.array(z.object({
    model: z.string().min(1),
    path: z.string().min(1),
    role: z.string().min(1),
  }).strict()),
  directWriteExceptions: z.array(z.object({
    path: z.string().min(1),
    reason: z.string().min(1),
  }).strict()),
  verification: z.array(z.object({
    command: z.string().min(1),
    exitCode: z.number().int().nullable(),
    result: z.string().min(1),
  }).strict()),
  blockers: z.array(z.string().min(1)),
}).strict();

/** One measured application-integration attempt. Transcripts and source stay out. */
export const setupEvalResultSchema = z.object({
  schemaVersion: z.literal(SETUP_CONTRACT_VERSION),
  kind: z.literal('ablo_setup_eval_result'),
  caseId: z.string().min(1),
  runner: z.string().min(1),
  model: z.string().min(1).nullable(),
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime(),
  durationMs: z.number().int().nonnegative(),
  agent: z.object({
    status: z.enum(['completed', 'failed', 'timed_out']),
    exitCode: z.number().int().nullable(),
    handoff: setupAgentHandoffSchema.nullable(),
  }).strict(),
  diff: setupDiffEvaluationSchema,
  verification: z.array(setupEvalVerificationSchema),
  outcome: z.enum(['passed', 'blocked', 'failed', 'incomplete', 'unsafe']),
  summary: z.string().min(1),
}).strict();

/** One immutable upstream repository used to grade setup discovery. */
export const setupRepositoryBenchmarkCaseSchema = z.object({
  schemaVersion: z.literal(SETUP_CONTRACT_VERSION),
  kind: z.literal('ablo_setup_repository_benchmark_case'),
  caseId: z.string().min(1),
  repository: z.object({
    url: z.url(),
    commit: z.string().regex(/^[a-f0-9]{40}$/),
  }).strict(),
  expectations: z.object({
    applicationRoot: z.string().min(1),
    persistenceIncludes: z.array(z.string().min(1)),
    requiredMutationPaths: z.array(z.string().min(1)),
    forbiddenMutationPathPrefixes: z.array(z.string().min(1)),
    coordinationAdoption: setupCoordinationAdoptionDispositionSchema,
  }).strict(),
}).strict();

export const setupRepositoryBenchmarkResultSchema = z.object({
  schemaVersion: z.literal(SETUP_CONTRACT_VERSION),
  kind: z.literal('ablo_setup_repository_benchmark_result'),
  caseId: z.string().min(1),
  repositoryUrl: z.url(),
  commit: z.string().regex(/^[a-f0-9]{40}$/),
  checks: z.array(z.object({
    id: z.string().min(1),
    status: z.enum(['pass', 'fail']),
    detail: z.string().min(1),
  }).strict()),
  outcome: z.enum(['passed', 'failed']),
}).strict();

const setupStepResultBaseSchema = z.object({
  stepId: z.string().min(1),
  summary: z.string().min(1),
  facts: z.array(setupFactSchema).default([]),
  decisions: z.array(setupDecisionSchema).default([]),
  actions: z.array(setupActionSchema).default([]),
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime(),
}).strict();

export const setupStepResultSchema = z.discriminatedUnion('status', [
  setupStepResultBaseSchema.extend({ status: z.literal('complete') }),
  setupStepResultBaseSchema.extend({
    status: z.literal('incomplete'),
    next: z.string().min(1),
  }),
  setupStepResultBaseSchema.extend({
    status: z.literal('blocked'),
    blockers: z.array(z.string().min(1)).min(1),
    next: z.string().min(1),
  }),
  setupStepResultBaseSchema.extend({
    status: z.literal('failed'),
    error: z.object({
      code: z.string().min(1),
      message: z.string().min(1),
    }).strict(),
  }),
]);

export const setupTargetSchema = z.object({
  repositoryRoot: z.string().min(1),
  applicationRoot: z.string().min(1).nullable(),
  packageName: z.string().min(1).nullable(),
  abloProjectId: z.string().min(1).nullable(),
  abloBranchId: z.string().min(1).nullable(),
  databaseFingerprint: z.string().min(1).nullable(),
  localSchemaDigest: z.string().min(1).nullable(),
  pushedSchemaDigest: z.string().min(1).nullable(),
}).strict();

export const setupPostconditionSchema = z.object({
  id: z.string().min(1),
  description: z.string().min(1),
  status: z.enum(['unverified', 'satisfied', 'unsatisfied', 'blocked']),
  evidence: z.array(setupEvidenceSchema).default([]),
}).strict();

/** Redacted projection of init's filesystem transaction. File contents never cross this seam. */
export const setupInitPlanProjectionSchema = z.object({
  root: z.string().min(1),
  actions: z.array(z.object({
    kind: z.enum(['create', 'update', 'unchanged']),
    path: z.string().min(1),
    note: z.string().optional(),
    precondition: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('absent') }).strict(),
      z.object({
        kind: z.literal('content'),
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
      }).strict(),
    ]).optional(),
  }).strict()),
  conflicts: z.array(z.object({
    path: z.string().min(1),
    reason: z.literal('occupied'),
  }).strict()),
}).strict();

export const setupInitResultSchema = z.object({
  status: z.enum(['planned', 'applied']),
  plan: setupInitPlanProjectionSchema,
}).strict();

export const setupPlanSchema = z.object({
  schemaVersion: z.literal(SETUP_CONTRACT_VERSION),
  kind: z.literal('ablo_setup_plan'),
  mode: z.literal('plan'),
  createdAt: z.iso.datetime(),
  target: setupTargetSchema,
  compatibility: setupCompatibilityDispositionSchema,
  steps: z.array(setupStepResultSchema),
  facts: z.array(setupFactSchema),
  decisions: z.array(setupDecisionSchema),
  actions: z.array(setupActionSchema),
  postconditions: z.array(setupPostconditionSchema),
  outcome: z.enum(['ready_to_apply', 'needs_decisions', 'blocked']),
  summary: z.string().min(1),
}).strict();

export const setupCheckpointSchema = z.object({
  schemaVersion: z.literal(SETUP_CONTRACT_VERSION),
  kind: z.literal('ablo_setup_checkpoint'),
  programId: z.string().min(1),
  repositoryRoot: z.string().min(1),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  completedStepIds: z.array(z.string().min(1)),
  results: z.array(setupStepResultSchema),
}).strict();

export const setupReportSchema = z.object({
  schemaVersion: z.literal(SETUP_CONTRACT_VERSION),
  kind: z.literal('ablo_setup_report'),
  createdAt: z.iso.datetime(),
  target: setupTargetSchema,
  outcome: z.enum(['complete', 'incomplete', 'blocked', 'failed']),
  facts: z.array(setupFactSchema),
  decisions: z.array(setupDecisionSchema),
  actions: z.array(setupActionSchema),
  postconditions: z.array(setupPostconditionSchema),
  next: z.array(z.string().min(1)),
}).strict();

export type SetupEvidence = z.infer<typeof setupEvidenceSchema>;
export type SetupFact = z.infer<typeof setupFactSchema>;
export type SetupCoordinationAdoptionDisposition = z.infer<
  typeof setupCoordinationAdoptionDispositionSchema
>;
export type SetupDecision = z.infer<typeof setupDecisionSchema>;
export type SetupAction = z.infer<typeof setupActionSchema>;
export type SetupStepResult = z.infer<typeof setupStepResultSchema>;
export type SetupTarget = z.infer<typeof setupTargetSchema>;
export type SetupPlan = z.infer<typeof setupPlanSchema>;
export type SetupCheckpoint = z.infer<typeof setupCheckpointSchema>;
export type SetupReport = z.infer<typeof setupReportSchema>;
export type SetupInitPlanProjection = z.infer<typeof setupInitPlanProjectionSchema>;
export type SetupInitResult = z.infer<typeof setupInitResultSchema>;
export type SetupMutationSite = z.infer<typeof setupMutationSiteSchema>;
export type SetupDatabaseColumn = z.infer<typeof setupDatabaseColumnSchema>;
export type SetupDatabaseMapping = z.infer<typeof setupDatabaseMappingSchema>;
export type SetupCompatibilityBlocker = z.infer<typeof setupCompatibilityBlockerSchema>;
export type SetupCompatibilityDisposition = z.infer<typeof setupCompatibilityDispositionSchema>;
export type SetupAdaptationTask = z.infer<typeof setupAdaptationTaskSchema>;
export type SetupSkillBundle = z.infer<typeof setupSkillBundleSchema>;
export type SetupAgentBundle = z.infer<typeof setupAgentBundleSchema>;
export type SetupWorkspaceSnapshot = z.infer<typeof setupWorkspaceSnapshotSchema>;
export type SetupDiffEvaluation = z.infer<typeof setupDiffEvaluationSchema>;
export type SetupEvalVerification = z.infer<typeof setupEvalVerificationSchema>;
export type SetupAgentHandoff = z.infer<typeof setupAgentHandoffSchema>;
export type SetupEvalResult = z.infer<typeof setupEvalResultSchema>;
export type SetupRepositoryBenchmarkCase = z.infer<typeof setupRepositoryBenchmarkCaseSchema>;
export type SetupRepositoryBenchmarkResult = z.infer<typeof setupRepositoryBenchmarkResultSchema>;
