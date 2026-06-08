/**
 * `selectModels` — project a schema down to a subset of its models.
 *
 * The Prisma-style "one canonical schema, each app selects what it needs"
 * primitive. Instead of re-declaring a model's fields in a second schema (which
 * must then be kept shape-identical by hand), an app picks the models it
 * subscribes to from the canonical schema. Field shapes, resolved FK columns,
 * computeds, typenames, and identity roles all come from the source — so a
 * subset is structurally incapable of drifting from the canonical definition.
 *
 * ```ts
 * import { schema as full } from '@ablo/schema';
 * import { selectModels } from '@abloatai/ablo/schema';
 *
 * // Vault subscribes to identity + dataroom content only.
 * export const schema = selectModels(full, ['users', 'organizations', 'datarooms', 'folders', 'files']);
 * ```
 *
 * Relations whose target falls outside the selected set are dropped — the
 * subset only sees its own models. A dropped relation that carries `parent`
 * scope-inheritance throws instead: silently losing it would mis-route a
 * record's fan-out, so the selected set must be closed under `parent` edges.
 */

import type { Schema, SchemaRecord } from './schema.js';
import type { ModelDef } from './model.js';
import type { RelationDef } from './relation.js';
import { AbloValidationError } from '../errors.js';

export function selectModels<S extends SchemaRecord, K extends keyof S & string>(
  schema: Schema<S>,
  keys: readonly K[],
): Schema<Pick<S, K>> {
  const keep = new Set<string>(keys as readonly string[]);
  const models: Record<string, ModelDef> = {};
  const validators: Record<string, unknown> = {};

  for (const key of keys) {
    const def = schema.models[key] as ModelDef | undefined;
    if (!def) {
      throw new AbloValidationError(
        `selectModels: "${String(key)}" is not a model in the source schema`,
        { code: 'invalid_schema', param: String(key) },
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
          `selectModels: model "${String(key)}" has a parent relation "${relName}" → "${rel.target}", ` +
            `which is not in the selected set. Include "${rel.target}" so scope inheritance still routes.`,
          { code: 'invalid_schema', param: `${String(key)}.${relName}` },
        );
      }
    }

    models[key] = { ...def, relations } as ModelDef;
    validators[key] = (schema.validators as Record<string, unknown>)[key];
  }

  return {
    models: models as unknown as Pick<S, K>,
    validators: validators as Schema<Pick<S, K>>['validators'],
    identityRoles: schema.identityRoles,
  };
}
