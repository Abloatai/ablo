/**
 * @ablo/sync-engine/schema — Schema Definition DSL
 *
 * Define your data models with Zod. Types are inferred automatically.
 *
 * ```ts
 * import { z } from 'zod';
 * import { defineSchema, model, relation } from '@ablo/sync-engine/schema';
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
export { field, indexed, getFieldMeta, type FieldMeta } from './field';

// Relation builders
export { relation, type RelationDef, type RelationType } from './relation';

// Model builder
export {
  model,
  type ModelDef,
  type ModelOptions,
  type LoadStrategy,
  type PersistOptions,
  type RelationRecord,
} from './model';

// Intent-first shorthand: `mutable.lazy({...})` and friends. Read the
// safety posture and load shape off the verb tokens; everything else
// falls back to sensible defaults. See sugar.ts for the full pattern.
export { mutable, readOnly, type SugarOptions } from './sugar';

// Schema definition + type inference
export {
  defineSchema,
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
} from './schema';

// Query definition DSL + type inference
export {
  query,
  defineQueries,
  type QueryDef,
  type QueryRecord,
  type Queries,
  type InferQueryInput,
  type InferQueryResult,
} from './queries';
