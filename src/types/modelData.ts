/**
 * The generic record shape for a model's data — a map from field name to value.
 *
 * Because the values are typed as `unknown`, read the data as the
 * schema-inferred entity type rather than accessing fields off this shape
 * directly. It has no imports of its own, so any module can depend on it
 * without creating an import cycle.
 */

/** A record mapping each model field name to its value. */
export type ModelData = Record<string, unknown>;
