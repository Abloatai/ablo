/**
 * Schema-linkage types used by `@ablo/sync-engine/mesh`.
 *
 * Entities are declared once in `@ablo/sync-engine/schema` via
 * `defineSchema({ ... })`. The mesh references them by `ModelDef` so
 * renames in the schema flow through TypeScript to every mesh call
 * site. Scope-capable entities are detected by the presence of
 * `syncGroupFormat` in their model options.
 */

import type { Schema } from '../schema/schema';

/**
 * The schema keys that can serve as scope keys — entities whose
 * `ModelDef.syncGroupFormat` is set at declaration time. Other
 * entities still exist; they just can't be top-level scope targets.
 */
export type ScopableEntityNames<S extends Schema> = {
  [K in keyof S['models']]: S['models'][K] extends { syncGroupFormat: string }
    ? K
    : never;
}[keyof S['models']];
