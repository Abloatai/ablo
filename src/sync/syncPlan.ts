/**
 * Derives a client's sync plan from its {@link Schema}. Walking the schema's
 * models and relations, it produces two declarative arrays consumed when the
 * store is constructed: the foreign-key indexes to register on the in-memory
 * object pool, and the enrichment rules that attach related parents to
 * incoming rows. See {@link deriveSyncPlanFromSchema}.
 */

import type { Schema } from '../transaction/schema/schema.js';

/** A foreign-key index to register on the in-memory object pool when the store is constructed. */
export interface ForeignKeyIndexSpec {
  /**
   * The name of the child model, where the foreign-key field lives, and the
   * name the object pool indexes by. Use the wire type-name casing (for
   * example `'Block'`, not `'block'`), since that is the value
   * stamped onto reconstructed models and the key the pool looks up.
   */
  readonly modelName: string;
  /** The foreign-key field name on the child model, for example `'sectionId'`. */
  readonly fieldName: string;
}

/**
 * A declarative rule for enriching an incoming row with its related parent.
 *
 * When a delta for `modelName` arrives and its row has been constructed, the
 * store reads the row's `foreignKey` value, looks up the matching parent in
 * the object pool, and attaches it under `relationKey`. Enrichment is
 * best-effort: if the parent is not in the pool yet — for example, it arrives
 * later in the same bootstrap batch — the step is skipped without error.
 */
export interface EnrichmentPlanEntry {
  /** The child model whose incoming deltas should be enriched. */
  readonly modelName: string;
  /** The foreign-key field on the child that points at the parent's id. */
  readonly foreignKey: string;
  /** The property name under which to attach the parent model. */
  readonly relationKey: string;
}

/**
 * Walks a schema and derives the two sync-plan arrays used when the store is
 * constructed: the foreign-key indexes to register on the object pool and the
 * enrichment plan. See {@link ForeignKeyIndexSpec} and
 * {@link EnrichmentPlanEntry}.
 *
 * Both are drawn from each `belongsTo` relation that sets `options.index` or
 * `options.enrich`; relations without those options are skipped. Enabling them
 * is opt-in, so adding a `belongsTo` relation never silently changes how deltas
 * apply or how lookups resolve. A `hasMany` or `hasOne` relation registers its
 * index on the target model, since that is where the foreign key lives. The
 * function has no side effects and is called once at construction.
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
        // For hasMany and hasOne, the foreign key lives on the target model,
        // not the current one, so register the index on the target. Its wire
        // type name is resolved from the schema here.
        const targetDef = schema.models[rel.target];
        const targetTypename = targetDef?.typename ?? rel.target;
        foreignKeyIndexes.push({ modelName: targetTypename, fieldName: rel.foreignKey });
      }
    }
  }

  return { enrichmentPlan, foreignKeyIndexes };
}
