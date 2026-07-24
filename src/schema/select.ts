/**
 * `selectModels` projects a schema down to a subset of its models.
 *
 * It lets one canonical schema serve several apps, each subscribing only to the
 * models it needs. Rather than re-declare a model's fields in a second schema —
 * which you would then have to keep identical by hand — an app selects the
 * models it wants from the canonical schema. Field shapes, resolved foreign-key
 * columns, computed getters, typenames, and identity roles all come from the
 * source, so a subset cannot drift from the canonical definition.
 *
 * ```ts
 * import { schema as full } from './schema';
 * import { selectModels } from '@abloatai/ablo/schema';
 *
 * // Subscribe to identity and document content only.
 * export const schema = selectModels(full, ['users', 'organizations', 'workspaces', 'folders', 'files']);
 * ```
 *
 * Relations whose target falls outside the selected set are dropped, so the
 * subset sees only its own models. Dropping a relation that carries `parent`
 * scope-inheritance throws instead, because silently losing it would mis-route
 * a record's fan-out — the selected set must be closed under `parent` edges.
 */

import type { Schema, SchemaRecord } from '../transaction/schema/schema.js';
import { buildFieldRefs } from '../transaction/schema/schema.js';
import type { ModelDef } from '../transaction/schema/model.js';
import type { RelationDef } from '../transaction/schema/relation.js';
import { AbloValidationError } from '../transaction/errors.js';
import { schemaHash } from './serialize.js';

export function selectModels<S extends SchemaRecord, K extends keyof S & string>(
  schema: Schema<S>,
  keys: readonly K[],
): Schema<Pick<S, K>> {
  const keep = new Set<string>(keys as readonly string[]);
  const models: Record<string, ModelDef> = {};
  const validators: Record<string, unknown> = {};

  for (const key of keys) {
    const def = schema.models[key];
    if (!def) {
      throw new AbloValidationError(
        `selectModels: "${key}" is not a model in the source schema`,
        { code: 'invalid_schema', param: key },
      );
    }

    // Prune relations whose target isn't in the selected set. A pruned
    // `parent` edge is a routing error, not a silent drop.
    const relations: Record<string, RelationDef> = {};
    for (const [relName, rel] of Object.entries(def.relations as Record<string, RelationDef>)) {
      if (keep.has(rel.target)) {
        relations[relName] = rel;
        continue;
      }
      if (rel.options?.parent) {
        throw new AbloValidationError(
          `selectModels: model "${key}" has a parent relation "${relName}" → "${rel.target}", ` +
            `which is not in the selected set. Include "${rel.target}" so scope inheritance still routes.`,
          { code: 'invalid_schema', param: `${key}.${relName}` },
        );
      }
    }

    models[key] = { ...def, relations };
    validators[key] = (schema.validators as Record<string, unknown>)[key];
  }

  return {
    models: models as unknown as Pick<S, K>,
    // References for exactly the models this projection kept.
    fields: buildFieldRefs(models) as Schema<Pick<S, K>>['fields'],
    validators: validators as Schema<Pick<S, K>>['validators'],
    identityRoles: schema.identityRoles,
    sessionSettings: schema.sessionSettings,
    // Record the full source's hash so the drift check can recognize this subset
    // as current against a server running that full schema. Prefer the source's
    // OWN `sourceSchemaHash` when it is itself a projection, so a subset-of-a-
    // subset still points at the original full schema rather than an intermediate
    // one. `schemaHash` ignores this field, so re-projecting stays deterministic.
    sourceSchemaHash: schema.sourceSchemaHash ?? schemaHash(schema),
  };
}

/**
 * `omitModels` is `selectModels` from the other side: keep every model EXCEPT
 * the named ones. Use it when an app is the general case and a separate app
 * owns the omitted models — the suite shell drops a specialized store that the
 * standalone app selects for itself:
 *
 * ```ts
 * export const schema = omitModels(full, ['reports', 'reportSections']);
 * ```
 *
 * Same validation as `selectModels`: relations into the omitted set are
 * dropped, and a dropped `parent` edge throws — so a model whose scope routes
 * through an omitted parent cannot be silently kept.
 */
export function omitModels<S extends SchemaRecord, K extends keyof S & string>(
  schema: Schema<S>,
  keys: readonly K[],
): Schema<Omit<S, K>> {
  const drop = new Set<string>(keys as readonly string[]);
  for (const key of keys) {
    if (!schema.models[key]) {
      throw new AbloValidationError(
        `omitModels: "${key}" is not a model in the source schema`,
        { code: 'invalid_schema', param: key },
      );
    }
  }
  const kept = Object.keys(schema.models).filter((k) => !drop.has(k));
  return selectModels(schema, kept as (keyof S & string)[]) as Schema<Omit<S, K>>;
}
