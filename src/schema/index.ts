/**
 * @abloatai/ablo/schema — Schema Definition DSL
 *
 * Define your data models with Zod. Types are inferred automatically.
 *
 * ```ts
 * import { z } from 'zod';
 * import { defineSchema, model, relation } from '@abloatai/ablo/schema';
 *
 * export const schema = defineSchema({
 *   tasks: model({
 *     title: z.string(),
 *     status: z.enum(['todo', 'doing', 'done']).default('todo'),
 *     projectId: z.string().optional(),
 *   }, {
 *     project: relation.belongsTo('projects', 'projectId'),
 *   }),
 * });
 *
 * type Task = Model<typeof schema, 'tasks'>;
 * ```
 */

// Re-export Zod for convenience (consumers can also import directly)
export { z } from 'zod';

// Field helpers (optional convenience wrappers around Zod)
export { field, indexed, getFieldMeta, type FieldBuilder, type FieldMeta } from './field.js';

// Relation builders
export { relation, type RelationDef, type RelationType } from './relation.js';

// Tenancy — the single source of truth for how a model's rows are tenant-scoped.
export {
  tenancySchema,
  scopedViaRefSchema,
  policyInputSchema,
  resolvePolicy,
  resolveTenancy,
  tenancyColumn,
  DEFAULT_ORG_COLUMN,
  type Tenancy,
  type ScopedViaRef,
  type PolicyInput,
} from './tenancy.js';

// Database plane — which DB a model's rows live in (`tenant` portable to a BYO
// customer DB, `control` = Ablo's own). Sibling axis to `tenancy`.
export { planeSchema, DEFAULT_PLANE, type SchemaPlane } from './plane.js';

// Decomposed sync-delta storage row (P0 of the control/tenant plane split —
// see docs/plans/sync-delta-zod-decomposition.md). Describes the existing
// `sync_deltas` columns as Zod schemas grouped by subsystem + database plane.
export {
  syncDeltaCoreSchema,
  deltaAttributionSchema,
  deltaProvenanceSchema,
  syncDeltaRowSchema,
  participantKindSchema,
  confirmationStateSchema,
  backfillProvenanceSchema,
  DELTA_PLANES,
  type SyncDeltaCore,
  type DeltaAttribution,
  type DeltaProvenance,
  type SyncDeltaRow,
  type ParticipantKind,
  type ConfirmationState,
  type BackfillProvenance,
} from './sync-delta-row.js';

// Canonical WIRE delta contract — the broadcast (server→client) projection of
// the stored row. The SDK client and the sync-server both derive their
// `SyncDelta` type from these via `z.infer` so the contract cannot drift.
export {
  syncDeltaActionSchema,
  wireDeltaDataSchema,
  participantRefSchema,
  syncDeltaWireCoreSchema,
  clientSyncDeltaSchema,
  serverSyncDeltaSchema,
  type SyncDeltaAction,
  type WireDeltaData,
  type ParticipantRef,
  type SyncDeltaWireCore,
  type ClientSyncDelta,
  type ServerSyncDelta,
} from './sync-delta-wire.js';

// Model builder
export {
  model,
  scopeKindOf,
  type ModelDef,
  type ModelOptions,
  type LoadStrategy,
  type PersistOptions,
  type RelationRecord,
  type GrantsRef,
  type ConflictAxis,
} from './model.js';

// Axis 3 — coordination authoring helpers for the `conflict` axis (composable
// disposition fns + a `cn`-style combinator).
export {
  coordination,
  humansOverwrite,
  humansReject,
  humansNotify,
  agentsOverwrite,
  agentsReject,
  agentsNotify,
  systemOverwrite,
  systemReject,
  systemNotify,
  type ConflictRule,
} from './coordination.js';

// Claim-first shorthand: `mutable.lazy({...})` and friends. Read the
// safety posture and load shape off the verb tokens; everything else
// falls back to sensible defaults. See sugar.ts for the full pattern.
export { mutable, readOnly, type SugarOptions } from './sugar.js';

// Schema definition + type inference
export {
  defineSchema,
  composeIdentitySyncGroups,
  type Schema,
  type SchemaRecord,
  type Model,
  type InferModel,
  type InferCreate,
  type InferModelNames,
  type BaseModelFields,
  type InsertValue,
  type UpsertValue,
  type UpdateValue,
  type DeleteId,
  type DefineSchemaOptions,
  type Casing,
  type CasingConvention,
  type CasingFn,
  composeEntitySyncGroups,
  type IdentityRole,
  type IdentityContext,
  type IdentityRoleSource,
  type EntityRole,
  type EntityContext,
  type EntityRoleSource,
  type RoleSource,
  type RoleContext,
  type SyncGroup,
  type SyncGroupInput,
  identityRole,
  entityRole,
  extractIdentityIds,
  extractEntityIds,
  syncGroup,
  syncGroupSchema,
  syncGroupInputSchema,
  isSyncGroupInput,
  identityRoleSchema,
  entityRoleSchema,
  roleSchema,
  roleSourceSchema,
  scopeSchema,
  grantsRefSchema,
  groupsInputSchema,
  type GroupsInput,
} from './schema.js';

// Schema ⇄ JSON (control-plane transport for hosted multi-tenant)
export {
  serializeSchema,
  parseSchema,
  toSchemaJSON,
  fromSchemaJSON,
  schemaHash,
  type SchemaJSON,
  type ModelJSON,
  type RelationJSON,
} from './serialize.js';

// Schema projection — derive an app's subset from one canonical schema.
export { selectModels } from './select.js';

// Schema → Postgres DDL (pure; shared by the hosted server and the CLI)
export {
  generateProvisionPlan,
  generateMigrationPlan,
  generateJsonColumnReconciliation,
  appSchemaName,
  camelToSnake,
  snakeToCamel,
  q,
  sqlType,
  type ProvisionPlan,
  type MigrationPlan,
} from './ddl.js';

// Schema diff + migration planning (pure; SQL emission lowered by ddl.ts)
export {
  diffSchema,
  classifyMigration,
  classifyCast,
  isAutoApplicable,
  isBlockerResolved,
  unresolvedBlockers,
  type BackfillValue,
  type MigrationStep,
  type FieldChanges,
  type FieldColumnChange,
  type FieldTypeChange,
  type NullabilityChange,
  type EnumValuesChange,
  type IndexChange,
  type CastSafety,
  type FieldType,
  type RenameHints,
  type MigrationSignal,
  type MigrationClassification,
  type WarningCode,
  type BlockerCode,
} from './diff.js';

// Schema → TypeScript type emission (the `generate` half; pure)
export { generateTypes } from './generate.js';

// Query definition DSL + type inference
export {
  query,
  defineQueries,
  type QueryDef,
  type QueryRecord,
  type Queries,
  type InferQueryInput,
  type InferQueryResult,
} from './queries.js';

export { schemaToOpenApi, type SchemaToOpenApiOptions } from './openapi.js';
