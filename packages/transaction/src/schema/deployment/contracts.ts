import { z } from 'zod';
import type { SchemaJSON } from '../serialize.js';
import type { BackfillValue, RenameHints } from '../diff.js';
import type { MigrationStep } from '../diff.js';

export const deploymentPhaseSchema = z.enum(['intent', 'expand', 'dual_write', 'backfill', 'verify', 'switch', 'contract', 'recover']);
export type DeploymentPhase = z.infer<typeof deploymentPhaseSchema>;
export const deploymentOwnerSchema = z.enum(['application', 'application_migration', 'ablo']);
export type DeploymentOwner = z.infer<typeof deploymentOwnerSchema>;
export const deploymentSeveritySchema = z.enum(['blocker', 'error', 'warning', 'info']);
export type DeploymentSeverity = z.infer<typeof deploymentSeveritySchema>;
export const deploymentCategorySchema = z.enum(['policy_intent', 'physical_contract', 'compatibility', 'data_movement', 'destructive_contract', 'advisory', 'observation']);
export type DeploymentCategory = z.infer<typeof deploymentCategorySchema>;
export const deploymentDirectionSchema = z.enum(['source_to_active', 'source_to_database', 'active_to_database', 'client_to_active']);
export type DeploymentDirection = z.infer<typeof deploymentDirectionSchema>;

export const databaseColumnSnapshotSchema = z.object({
  name: z.string(), dataType: z.string(), nullable: z.boolean(), default: z.string().nullable(), primary: z.boolean(), unique: z.boolean(),
  /** Capped count of rows whose required routing value is NULL; absent for ordinary columns. */
  nullCount: z.number().int().nonnegative().nullable().optional(),
});
export type DatabaseColumnSnapshot = z.infer<typeof databaseColumnSnapshotSchema>;
export const databaseIndexSnapshotSchema = z.object({
  name: z.string(), columns: z.array(z.string()), unique: z.boolean(), valid: z.boolean(), ready: z.boolean(), predicate: z.string().nullable(),
});
export const databaseForeignKeySnapshotSchema = z.object({
  name: z.string(), columns: z.array(z.string()), referencedSchema: z.string(), referencedTable: z.string(), referencedColumns: z.array(z.string()), validated: z.boolean(),
});
export const databaseTableSnapshotSchema = z.object({
  schema: z.string(), name: z.string(), columns: z.record(z.string(), databaseColumnSnapshotSchema),
  indexes: z.array(databaseIndexSnapshotSchema).optional(), foreignKeys: z.array(databaseForeignKeySnapshotSchema).optional(),
  rowLevelSecurity: z.boolean().nullable(), forceRowLevelSecurity: z.boolean().nullable(),
  replicaIdentity: z.string().nullable(), publicationMember: z.boolean().nullable(),
});
export type DatabaseTableSnapshot = z.infer<typeof databaseTableSnapshotSchema>;
export const databaseSnapshotSchema = z.object({
  observedAt: z.string(), subject: z.string(), fingerprint: z.string(), appSchema: z.string(), ownership: z.enum(['application', 'ablo']),
  tables: z.record(z.string(), databaseTableSnapshotSchema),
});
export type DatabaseSnapshot = z.infer<typeof databaseSnapshotSchema>;

export interface SourceSchemaSnapshot { readonly observedAt: string; readonly path: string; readonly hash: string; readonly schema: SchemaJSON; }
export interface ActiveSchemaSnapshot { readonly observedAt: string; readonly schemaId: string; readonly version: number; readonly hash: string; readonly pushedAt: string | null; readonly schema: SchemaJSON; }
export interface DeploymentTarget { readonly organizationId: string | null; readonly projectId: string | null; readonly branchId: string | null; readonly databaseSubject: string | null; readonly confirmed: boolean; }
export const deploymentGateSchema = z.object({
  id: z.string().min(1),
  phase: z.enum(['expand', 'dual_write', 'backfill', 'verify', 'switch', 'contract']),
  owner: deploymentOwnerSchema,
  resource: z.string().min(1),
  title: z.string().min(1),
  action: z.string().min(1),
  status: z.enum(['pending', 'ready', 'satisfied']),
  dependsOn: z.array(z.string()).default([]),
  approval: z.string().min(1).optional(),
});
export const deploymentManifestSchema = z.object({
  id: z.string().min(1),
  live: z.boolean().default(true),
  targetPhase: z.enum(['expand', 'dual_write', 'backfill', 'verify', 'switch', 'contract']).default('expand'),
  gates: z.array(deploymentGateSchema),
});
export type DeploymentGate = z.infer<typeof deploymentGateSchema>;
export type DeploymentManifest = z.infer<typeof deploymentManifestSchema>;
export interface DeploymentIntent { readonly renames?: RenameHints; readonly backfills?: readonly BackfillValue[]; readonly acceptDestructive?: boolean; readonly manifest?: DeploymentManifest; }
export interface DeploymentObservation { readonly target: DeploymentTarget; readonly source: SourceSchemaSnapshot; readonly active: ActiveSchemaSnapshot | null; readonly database: DatabaseSnapshot | null; readonly intent?: DeploymentIntent; readonly supplementalFindings?: readonly DeploymentFinding[]; }

export interface DeploymentFinding {
  readonly id: string; readonly code: string; readonly category: DeploymentCategory; readonly severity: DeploymentSeverity;
  readonly direction: DeploymentDirection; readonly phase: DeploymentPhase; readonly owner: DeploymentOwner;
  readonly model?: string; readonly field?: string; readonly column?: string; readonly from?: unknown; readonly to?: unknown;
  readonly message: string; readonly action: string;
  readonly dependsOn?: readonly string[];
}
export interface DeploymentStep {
  readonly id: string; readonly phase: DeploymentPhase; readonly owner: DeploymentOwner; readonly title: string; readonly action: string;
  readonly dependsOn: readonly string[]; readonly findingIds: readonly string[]; readonly status: 'ready' | 'blocked' | 'advisory'; readonly executableByAblo: boolean;
}
export interface SchemaDeploymentPlan {
  readonly id: 'ablo-schema-deployment-plan-v1'; readonly mode: 'plan'; readonly createdAt: string; readonly fingerprint: string; readonly target: DeploymentTarget;
  readonly states: { readonly source: Omit<SourceSchemaSnapshot, 'schema'>; readonly active: Omit<ActiveSchemaSnapshot, 'schema'> | null; readonly database: Omit<DatabaseSnapshot, 'tables'> | null; };
  readonly findings: readonly DeploymentFinding[]; readonly steps: readonly DeploymentStep[]; readonly outcome: 'aligned' | 'ready' | 'blocked';
  readonly operations: { readonly sourceToActive: readonly MigrationStep[]; readonly provision: readonly MigrationStep[] };
  readonly rollbackTarget: { readonly schemaId: string; readonly version: number; readonly hash: string; readonly strategy: 'reactivate_artifact'; } | null;
  readonly recovery: 'rollback' | 'forward_only';
}
export interface DeploymentApplyResult { readonly plan: SchemaDeploymentPlan; readonly appliedStepIds: readonly string[]; readonly verification: SchemaDeploymentPlan; readonly recorded: boolean; }

export const deploymentTargetSchema = z.object({
  organizationId: z.string().nullable(), projectId: z.string().nullable(), branchId: z.string().nullable(), databaseSubject: z.string().nullable(), confirmed: z.boolean(),
});
export const deploymentFindingSchema = z.object({
  id: z.string(), code: z.string(), category: deploymentCategorySchema, severity: deploymentSeveritySchema,
  direction: deploymentDirectionSchema, phase: deploymentPhaseSchema, owner: deploymentOwnerSchema,
  model: z.string().optional(), field: z.string().optional(), column: z.string().optional(), from: z.unknown().optional(), to: z.unknown().optional(),
  message: z.string(), action: z.string(),
  dependsOn: z.array(z.string()).readonly().optional(),
});
export const deploymentStepSchema = z.object({
  id: z.string(), phase: deploymentPhaseSchema, owner: deploymentOwnerSchema, title: z.string(), action: z.string(),
  dependsOn: z.array(z.string()).readonly(), findingIds: z.array(z.string()).readonly(), status: z.enum(['ready', 'blocked', 'advisory']), executableByAblo: z.boolean(),
});
export const schemaDeploymentPlanSchema = z.object({
  id: z.literal('ablo-schema-deployment-plan-v1'), mode: z.literal('plan'), createdAt: z.string(), fingerprint: z.string(), target: deploymentTargetSchema,
  states: z.object({
    source: z.object({ observedAt: z.string(), path: z.string(), hash: z.string() }),
    active: z.object({ observedAt: z.string(), schemaId: z.string(), version: z.number(), hash: z.string(), pushedAt: z.string().nullable() }).nullable(),
    database: z.object({ observedAt: z.string(), subject: z.string(), fingerprint: z.string(), appSchema: z.string(), ownership: z.enum(['application', 'ablo']) }).nullable(),
  }),
  findings: z.array(deploymentFindingSchema).readonly(), steps: z.array(deploymentStepSchema).readonly(), outcome: z.enum(['aligned', 'ready', 'blocked']),
  // Submitted operations are never executed. Apply re-observes and returns a
  // server-built plan; this field is retained only to validate the full plan
  // envelope and obtain its fingerprint.
  operations: z.object({
    sourceToActive: z.array(z.custom<MigrationStep>()).readonly(),
    provision: z.array(z.custom<MigrationStep>()).readonly(),
  }),
  rollbackTarget: z.object({ schemaId: z.string(), version: z.number(), hash: z.string(), strategy: z.literal('reactivate_artifact') }).nullable(),
  recovery: z.enum(['rollback', 'forward_only']),
});
