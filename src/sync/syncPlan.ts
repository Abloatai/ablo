/**
 * syncPlan — schema → sync-plan derivation.
 *
 * Pure leaf extracted from BaseSyncedStore.ts: walks a `Schema` and derives
 * the two declarative arrays the store's constructor consumes (FK indexes,
 * enrichment plan). No class state, no side effects — `BaseSyncedStore`
 * re-exports everything here so importers are unchanged.
 */

import type { Schema } from '../schema/schema.js';

/** A foreign-key index to register on the ObjectPool at construction time. */
export interface ForeignKeyIndexSpec {
  /**
   * The child model name (where the FK field lives) — this is the type
   * that will be passed to `pool.registerForeignKey(modelName, fieldName)`
   * and later to `pool.getByForeignKey(modelName, fieldName, value)`.
   *
   * Use the wire `__typename` casing (e.g., `'SlideLayer'`, not
   * `'slideLayer'`) — that's the value `createFromData` stamps onto
   * models and the pool indexes by.
   */
  readonly modelName: string;
  /** The FK field name on the child model, e.g. `'slideId'`. */
  readonly fieldName: string;
}

/**
 * A declarative enrichment rule for the delta-apply path.
 *
 * When a delta for `modelName` arrives, after the model is constructed
 * the base store reads `data[foreignKey]` from the payload, looks up
 * the matching parent in the ObjectPool, and attaches it as
 * `data[relationKey]`. Best-effort: if the parent isn't yet in the
 * pool (e.g., arrived later in the same bootstrap batch), enrichment
 * silently no-ops.
 *
 * Replaces the previous pattern of overriding `enrichRelations` on a
 * subclass to hardcode per-model enrichment logic.
 */
export interface EnrichmentPlanEntry {
  /** The child model whose incoming deltas should be enriched. */
  readonly modelName: string;
  /** The FK field on the child that points at the parent's id. */
  readonly foreignKey: string;
  /** The property name under which to attach the parent model. */
  readonly relationKey: string;
}

/**
 * Walk a schema and derive the two sync-plan arrays consumed by
 * `BaseSyncedStore`'s constructor: FK indexes to register on the pool,
 * and the enrichment plan.
 *
 * FK indexes and enrichment entries are pulled from each `belongsTo`
 * relation where `options.index` / `options.enrich` is set. Relations
 * without those options are skipped — this is an opt-in mechanism so
 * adding a `belongsTo` never silently changes delta or lookup semantics.
 *
 * Pure function: takes a Schema, returns two arrays. No side effects,
 * no class state. Called once at construction time from `BaseSyncedStore`.
 */
export function deriveSyncPlanFromSchema(schema: Schema): {
  enrichmentPlan: EnrichmentPlanEntry[];
  foreignKeyIndexes: ForeignKeyIndexSpec[];
} {
  const enrichmentPlan: EnrichmentPlanEntry[] = [];
  const foreignKeyIndexes: ForeignKeyIndexSpec[] = [];

  for (const [modelName, def] of Object.entries(schema.models)) {
    const typename = def.typename ?? modelName;

    for (const [relationKey, rel] of Object.entries(def.relations)) {
      if (rel.type === 'belongsTo') {
        if (rel.options?.index) {
          foreignKeyIndexes.push({ modelName: typename, fieldName: rel.foreignKey });
        }
        if (rel.options?.enrich) {
          enrichmentPlan.push({
            modelName: typename,
            foreignKey: rel.foreignKey,
            relationKey,
          });
        }
      } else if (rel.type === 'hasMany' || rel.type === 'hasOne') {
        // hasMany/hasOne: the FK lives on the TARGET model, not the current model.
        // Register the FK index on the target so getByForeignKey works.
        // Target typename is resolved at registration time from the schema.
        const targetDef = schema.models[rel.target];
        const targetTypename = targetDef?.typename ?? rel.target;
        foreignKeyIndexes.push({ modelName: targetTypename, fieldName: rel.foreignKey });
      }
    }
  }

  return { enrichmentPlan, foreignKeyIndexes };
}
