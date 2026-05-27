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
 * type Task = InferModel<typeof schema, 'tasks'>;
 * ```
 */

// Re-export Zod for convenience (consumers can also import directly)
export { z } from 'zod';

// Field helpers (optional convenience wrappers around Zod)
export { field, indexed, getFieldMeta, type FieldMeta } from './field.js';

// Relation builders
export { relation, type RelationDef, type RelationType } from './relation.js';

// Model builder
export {
  model,
  type ModelDef,
  type ModelOptions,
  type LoadStrategy,
  type PersistOptions,
  type RelationRecord,
} from './model.js';

// Intent-first shorthand: `mutable.lazy({...})` and friends. Read the
// safety posture and load shape off the verb tokens; everything else
// falls back to sensible defaults. See sugar.ts for the full pattern.
export { mutable, readOnly, type SugarOptions } from './sugar.js';

// Schema definition + type inference
export {
  defineSchema,
  composeIdentitySyncGroups,
  type Schema,
  type SchemaRecord,
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
  type IdentityRole,
  type IdentityContext,
  identityRole,
  extractIdentityIds,
  type IdentityRoleSource,
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

// Schema diff + migration planning (pure; SQL emission is server-side)
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
