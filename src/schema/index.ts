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

// Model residency — which database a model's rows live in (`tenant` can be a
// customer's own database, `control` is Ablo's). A sibling axis to `tenancy`.
export {
  residencySchema,
  DEFAULT_RESIDENCY,
  type ModelResidency,
  // Deliberate back-compat re-export of the deprecated aliases:
  // eslint-disable-next-line @typescript-eslint/no-deprecated
  planeSchema,
  // eslint-disable-next-line @typescript-eslint/no-deprecated
  DEFAULT_PLANE,
  // eslint-disable-next-line @typescript-eslint/no-deprecated
  type SchemaPlane,
} from './residency.js';

// The stored `sync_deltas` row, described as Zod schemas grouped by subsystem and by
// which database the columns live in.
export {
  syncDeltaCoreSchema,
  deltaAttributionSchema,
  deltaProvenanceSchema,
  syncDeltaRowSchema,
  participantKindSchema,
  confirmationStateSchema,
  backfillProvenanceSchema,
  DELTA_RESIDENCY,
  type SyncDeltaCore,
  type DeltaAttribution,
  type DeltaProvenance,
  type SyncDeltaRow,
  type ParticipantKind,
  type ConfirmationState,
  type BackfillProvenance,
} from './syncDeltaRow.js';

// The wire delta contract — the server-to-client projection of the stored row.
// Both the client SDK and the server derive their `SyncDelta` type from these with
// `z.infer`, so the two ends cannot drift apart.
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
} from '../wire/delta.js';

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

// Coordination authoring helpers for the `conflict` axis — composable disposition
// functions plus a combinator that merges them.
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

// Claim-first shorthand for common model options: `mutable.lazy({...})` and friends
// encode a model's write-safety and load strategy in the verb, and fall back to
// sensible defaults for everything else.
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
  intersectRequestedWithAllowed,
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

// Schema ⇄ JSON — serialize a schema for transport and rebuild it on the far side.
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

// Schema → Postgres DDL — shared by the host implementation and the command-line tools.
export {
  generateProvisionPlan,
  generateMigrationPlan,
  appSchemaName,
  camelToSnake,
  snakeToCamel,
  q,
  sqlType,
  type ProvisionPlan,
  type MigrationPlan,
} from './ddl.js';

// Safe-DDL locking knobs (lock_timeout plus a bounded retry on lock contention),
// shared by `ablo migrate` and the host that applies a schema push, so tuning the
// ABLO_SCHEMA_LOCK_* variables changes both paths the same way.
export {
  PG_LOCK_NOT_AVAILABLE,
  resolveDdlLockTimeout,
  resolveDdlMaxLockAttempts,
  ddlLockRetryBackoffMs,
  type DdlLockEnv,
} from './ddlLock.js';

// Schema diff + migration planning — produces the plan the DDL layer turns into SQL.
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

// Schema → TypeScript type emission.
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
