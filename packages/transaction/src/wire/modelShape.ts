/**
 * What a model is made of — its fields and its edges.
 *
 * These shapes travel twice: they are what `ablo push` serializes into the
 * schema artifact, and what `GET /api/schema` reports back about the artifact
 * that is deployed. Two crossings, one definition, and the definition lives
 * here because `wire/` is the leaf every other layer may depend on.
 *
 * They were TypeScript interfaces, so the schema-read route could not send them
 * without hand-writing a second copy of the record it was refusing to send — the
 * shadow type wearing the fix's clothes. Declared as Zod and derived back into
 * TypeScript, there is nowhere for a second copy to live.
 *
 * **Vocabulary ownership.** `type` is a CLOSED enum: the engine owns the set of
 * types it can store and serialize, so a value outside it is a bug, not an
 * extension. `enumValues` is an OPEN list: the values belong to the application
 * that declared them, and the protocol never interprets one.
 */

import { z } from 'zod';

/**
 * The engine's type vocabulary — closed, and owned by the engine.
 *
 * Each member maps to storage and serialization behaviour, so this is the whole
 * set by construction. A schema's own richer types (a `z.email()`, a branded id)
 * narrow one of these; they do not add a member.
 */
export const fieldTypeSchema = z.enum([
  'string',
  'number',
  'boolean',
  'date',
  'enum',
  'json',
]);
export type FieldType = z.infer<typeof fieldTypeSchema>;

/** One field of a model, as the schema artifact records it. */
export const fieldMetaSchema = z.object({
  /** Sync-engine type tag, which maps to storage and serialization hints. */
  type: fieldTypeSchema,
  /** Whether the field was marked optional via `.optional()` or `.nullable()`. */
  isOptional: z.boolean(),
  /** Whether the field was marked indexed via `.indexed()`. */
  isIndexed: z.boolean(),
  /**
   * Physical database column name override. When absent, SQL layers derive the
   * column from the field name using the active casing convention.
   */
  column: z.string().optional(),
  /**
   * For enums: the allowed values.
   *
   * The application's vocabulary, carried verbatim — an open list, because the
   * protocol has no opinion about what a caller's statuses are called.
   */
  enumValues: z.array(z.string()).readonly().optional(),
});
export type FieldMeta = z.infer<typeof fieldMetaSchema>;

/**
 * How one model points at another. Closed, like {@link fieldTypeSchema}: the
 * engine resolves exactly these three when it plans a read.
 */
export const relationTypeSchema = z.enum(['belongsTo', 'hasMany', 'hasOne']);
export type RelationType = z.infer<typeof relationTypeSchema>;

/**
 * One edge of a model — what a caller may expand, and what it expands into.
 *
 * Reported alongside the fields because half the answer is not an answer: an
 * agent asking what a model looks like wants its shape AND its edges, and
 * shipping only the scalars invites the second question immediately.
 */
export const relationMetaSchema = z.object({
  type: relationTypeSchema,
  /** The schema key of the model on the other end. */
  target: z.string(),
  /** The field on the owning side that carries the link. */
  foreignKey: z.string(),
});
export type RelationMeta = z.infer<typeof relationMetaSchema>;
