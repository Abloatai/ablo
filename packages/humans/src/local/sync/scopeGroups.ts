import type { ClaimTarget } from '@abloatai/transaction/types/streams';
import type { Schema } from '@abloatai/transaction/schema/schema';
import { scopeKindOf, type ModelDef } from '@abloatai/transaction/schema/model';

/** A schema-shaped selector used to narrow connection groups and presence reads. */
export type GroupScope =
  | ClaimTarget
  | readonly ClaimTarget[]
  | string
  | readonly string[]
  | { readonly syncGroup: string }
  | { readonly syncGroups: readonly string[] }
  | Record<string, string | readonly string[] | undefined>;

/** Resolve an application-shaped scope into the wire groups owned by the schema. */
export function resolveScopeGroups(
  scope: GroupScope | undefined,
  schema?: Schema,
): string[] {
  if (!scope) return [];
  if (typeof scope === 'string') return [scope];
  if (Array.isArray(scope)) {
    const groups: string[] = [];
    for (const entry of scope as readonly unknown[]) {
      if (typeof entry === 'string') groups.push(entry);
      else if (isEntityScope(entry)) groups.push(groupFromEntityRef(entry, schema));
    }
    return groups;
  }
  const direct = scope as { syncGroup?: unknown; syncGroups?: unknown };
  if (isEntityScope(scope)) return [groupFromEntityRef(scope, schema)];
  if (typeof direct.syncGroup === 'string') return [direct.syncGroup];
  if (Array.isArray(direct.syncGroups)) {
    return direct.syncGroups.filter((group): group is string => typeof group === 'string');
  }
  const groups: string[] = [];
  for (const [key, value] of Object.entries(scope) as [string, unknown][]) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const id of value as unknown[]) {
        if (typeof id === 'string') groups.push(groupFromSchemaKey(key, id, schema));
      }
    } else if (typeof value === 'string') {
      groups.push(groupFromSchemaKey(key, value, schema));
    }
  }
  return groups;
}

export function groupFromEntityRef(ref: ClaimTarget, schema?: Schema): string {
  const match = findModelForEntityRef(ref, schema);
  const kind = match
    ? groupKindForModel(match.def, match.key)
    : ref.type.toLowerCase();
  return `${kind}:${ref.id}`;
}

function groupFromSchemaKey(schemaKey: string, id: string, schema?: Schema): string {
  const def = schema?.models[schemaKey];
  const kind = def ? groupKindForModel(def, schemaKey) : schemaKey.toLowerCase();
  return `${kind}:${id}`;
}

function groupKindForModel(def: ModelDef, key: string): string {
  return scopeKindOf(def, key) ?? (def.typename ?? key).toLowerCase();
}

function findModelForEntityRef(
  ref: ClaimTarget,
  schema?: Schema,
): { key: string; def: ModelDef } | null {
  if (!schema?.models) return null;
  const wanted = ref.type.toLowerCase();
  for (const [key, def] of Object.entries(schema.models) as [string, ModelDef][]) {
    const typename = def.typename ?? key;
    if (typename.toLowerCase() === wanted || key.toLowerCase() === wanted) {
      return { key, def };
    }
  }
  return null;
}

function isEntityScope(scope: unknown): scope is ClaimTarget {
  return (
    typeof scope === 'object' &&
    scope !== null &&
    !Array.isArray(scope) &&
    typeof (scope as { type?: unknown }).type === 'string' &&
    typeof (scope as { id?: unknown }).id === 'string'
  );
}
