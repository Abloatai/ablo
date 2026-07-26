import { z } from 'zod';

/**
 * A branch handle is for people and URLs. Durable routing always uses the
 * immutable branch id returned by the server.
 */
export const branchSlugSchema = z
  .string()
  .min(1)
  // During the additive rollout this is also the legacy plane adapter, whose
  // persisted environment contract is capped at 40 characters.
  .max(40)
  .regex(
    /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/,
    'must be a lowercase slug containing only letters, numbers, and hyphens',
  );

export const branchKindSchema = z.enum(['dev', 'preview', 'test', 'long_lived']);
export type BranchKind = z.infer<typeof branchKindSchema>;

export const branchStateSchema = z.enum([
  'provisioning',
  'ready',
  'failed',
  'deleting',
  'deleted',
]);
export type BranchState = z.infer<typeof branchStateSchema>;

export const branchOriginSchema = z.enum(['empty', 'source_snapshot', 'coordinated_fork']);
export type BranchOrigin = z.infer<typeof branchOriginSchema>;

export const branchResponseSchema = z.object({
  object: z.literal('branch'),
  id: z.string(),
  project_id: z.string(),
  parent_branch_id: z.string().nullable(),
  slug: branchSlugSchema,
  name: z.string().nullable(),
  kind: branchKindSchema,
  state: branchStateSchema,
  origin: branchOriginSchema,
  root: z.boolean(),
  expires_at: z.string().nullable(),
  created_at: z.string(),
  deleted_at: z.string().nullable(),
});
export type BranchResponse = z.infer<typeof branchResponseSchema>;

export const branchListResponseSchema = z.object({
  object: z.literal('list'),
  data: z.array(branchResponseSchema).readonly(),
});
export type BranchListResponse = z.infer<typeof branchListResponseSchema>;

export const createBranchRequestSchema = z.object({
  slug: branchSlugSchema,
  name: z.string().min(1).max(200).optional(),
  parent_branch_id: z.string().optional(),
  kind: branchKindSchema.optional(),
  origin: branchOriginSchema.optional(),
  expires_at: z.iso.datetime().optional(),
});
export type CreateBranchRequest = z.infer<typeof createBranchRequestSchema>;

export const branchCredentialRequestSchema = z
  .object({
    ttl_hours: z.number().int().min(1).max(168).optional(),
  })
  .strict();
export type BranchCredentialRequest = z.infer<typeof branchCredentialRequestSchema>;

export const branchCredentialResponseSchema = z.object({
  object: z.literal('branch_credential'),
  branch_id: z.string(),
  api_key: z.string(),
  expires_at: z.string(),
});
export type BranchCredentialResponse = z.infer<typeof branchCredentialResponseSchema>;

export const branchParentCompatibilitySchema = z.enum([
  'same',
  'compatible',
  'review',
  'blocked',
  'unknown',
]);
export type BranchParentCompatibility = z.infer<typeof branchParentCompatibilitySchema>;

export const branchStatusSchemaSummarySchema = z
  .object({
    active: z.boolean(),
    version: z.number().int().nullable(),
    hash: z.string().nullable(),
    parent_compatibility: branchParentCompatibilitySchema,
    changes: z.number().int().nonnegative(),
    warnings: z.number().int().nonnegative(),
    blockers: z.number().int().nonnegative(),
  })
  .strict();

export const branchStatusDataSourceSchema = z
  .object({
    kind: z.enum(['hosted', 'direct', 'endpoint']),
    status: z.enum(['unverified', 'active', 'rejected']).nullable(),
    host: z.string().nullable(),
    database: z.string().nullable(),
    cursor: z.string().nullable(),
    event_lag: z.number().int().nonnegative(),
    retry_count: z.number().int().nonnegative(),
    last_success_at: z.string().nullable(),
    last_error: z.string().nullable(),
  })
  .strict();

export const branchStatusBlockerSchema = z
  .object({
    code: z.enum(['branch_not_ready', 'schema_missing', 'data_source_not_ready']),
    problem: z.string(),
    fix: z.string(),
  })
  .strict();

export const branchStatusResponseSchema = z
  .object({
    object: z.literal('branch_status'),
    branch: branchResponseSchema,
    ready: z.boolean(),
    schema: branchStatusSchemaSummarySchema,
    data_source: branchStatusDataSourceSchema,
    blockers: z.array(branchStatusBlockerSchema).readonly(),
  })
  .strict();
export type BranchStatusResponse = z.infer<typeof branchStatusResponseSchema>;
