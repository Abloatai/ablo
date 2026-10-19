import { z } from 'zod';
import { schemaDeploymentPlanSchema } from '../schema/deployment/contracts.js';
import type { SchemaJSON } from '../schema/serialize.js';
import { fieldMetaSchema } from './modelShape.js';

const identifier = z.string().min(1).max(63).regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/);
const connection = z.string().min(1).max(4096).refine((value) => {
  try { return ['postgres:', 'postgresql:'].includes(new URL(value).protocol); }
  catch { return false; }
}, 'Enter a PostgreSQL connection URL.');

// The server regenerates the reviewed contract before applying it; the wire carries its envelope.
const contract: z.ZodType<SchemaJSON> = z.object({
  v: z.literal(3), models: z.record(z.string(), z.any()),
  identityRoles: z.array(z.any()), sessionSettings: z.any().optional(),
});

export const postgresOnboardingTargetSchema = z.object({
  projectId: z.string().min(1), branchId: z.string().min(1),
});
export const postgresOnboardingConnectionSchema = postgresOnboardingTargetSchema.extend({
  mode: z.enum(['automatic', 'manual']), schema: identifier.default('public'),
  connectionString: connection, writeConnectionString: connection.optional(),
});
export const postgresOnboardingSelectionSchema = z.object({
  table: identifier, tenancy: z.enum(['source', 'column']), tenantColumn: identifier.optional(),
}).refine((value) => value.tenancy !== 'column' || !!value.tenantColumn, 'Choose a tenant column.');
export const postgresOnboardingRuntimeSchema = z.object({
  connectionString: connection, writeConnectionString: connection,
});
export const postgresOnboardingPlanRequestSchema = postgresOnboardingConnectionSchema.extend({
  selections: z.array(postgresOnboardingSelectionSchema).min(1).max(50),
  runtime: postgresOnboardingRuntimeSchema.optional(),
});
export const postgresOnboardingRecipeRequestSchema = postgresOnboardingTargetSchema.extend({
  databaseUrl: connection, schema: identifier.default('public'), tables: z.array(identifier).min(1).max(50),
});
export const postgresOnboardingStepSchema = z.object({
  title: z.string(), detail: z.string(), sql: z.array(z.string()).readonly(),
  affectsOthers: z.array(z.string()).readonly().optional(),
});
export const postgresOnboardingTableSchema = z.object({
  table: z.string(), fields: z.record(z.string(), fieldMetaSchema),
  tenantColumns: z.array(z.string()), reason: z.string().nullable(), rowLevelSecurity: z.boolean(),
});
export const postgresOnboardingInspectionSchema = z.object({
  database: z.string(), schema: z.string(), provider: z.string(),
  walReady: z.boolean(), guidance: z.string().nullable(),
  tables: z.array(postgresOnboardingTableSchema),
});
export const postgresOnboardingPlanSchema = z.object({
  fingerprint: z.string(), runtime: postgresOnboardingRuntimeSchema,
  steps: z.array(postgresOnboardingStepSchema),
  contract, deployment: schemaDeploymentPlanSchema,
});
export const postgresOnboardingApplyRequestSchema = postgresOnboardingPlanRequestSchema.extend({
  reviewed: postgresOnboardingPlanSchema,
});
export type PostgresOnboardingConnection = z.infer<typeof postgresOnboardingConnectionSchema>;
export type PostgresOnboardingSelection = z.infer<typeof postgresOnboardingSelectionSchema>;
export type PostgresOnboardingInspection = z.infer<typeof postgresOnboardingInspectionSchema>;
export type PostgresOnboardingPlan = z.infer<typeof postgresOnboardingPlanSchema>;
export type PostgresOnboardingPlanRequest = z.infer<typeof postgresOnboardingPlanRequestSchema>;
