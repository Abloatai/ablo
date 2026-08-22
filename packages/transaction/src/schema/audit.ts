import type { ModelJSON, SchemaJSON } from './serialize.js';
import { resolveTenancy } from './tenancy.js';

export interface SchemaAuditFinding {
  readonly code: 'scope_routing_without_access_policy';
  readonly severity: 'error';
  readonly model: string;
  readonly message: string;
  readonly fix: string;
}

interface RoutingAnchor {
  readonly description: string;
  readonly column: string;
  readonly parentTable?: string;
}

function tableName(key: string, model: ModelJSON): string {
  return model.tableName ?? key;
}

function fieldColumn(model: ModelJSON, field: string): string {
  return model.fields[field]?.column ?? field;
}

function camelToSnake(value: string): string {
  return value.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

function reachesScope(
  key: string,
  models: SchemaJSON['models'],
  seen: ReadonlySet<string> = new Set(),
): boolean {
  if (seen.has(key)) return false;
  const model = models[key];
  if (!model) return false;
  if (model.scope) return true;
  const nextSeen = new Set(seen).add(key);
  return Object.values(model.relations).some(
    (relation) => relation.type === 'belongsTo' && reachesScope(relation.target, models, nextSeen),
  );
}

function routingAnchors(
  model: ModelJSON,
  models: SchemaJSON['models'],
): readonly RoutingAnchor[] {
  const anchors: RoutingAnchor[] = [];

  if (model.scope) {
    anchors.push({ description: `scope root ${String(model.scope)}`, column: 'id' });
  }

  for (const role of model.entityRoles ?? []) {
    anchors.push({
      description: `entity role ${role.kind}`,
      column: fieldColumn(model, role.source.field),
    });
  }

  for (const [relationName, relation] of Object.entries(model.relations)) {
    if (relation.type !== 'belongsTo' || !reachesScope(relation.target, models)) continue;
    const target = models[relation.target];
    if (!target) continue;
    anchors.push({
      description: `parent scope ${relationName}`,
      column: relation.foreignKeyColumn,
      parentTable: tableName(relation.target, target),
    });
  }

  return anchors;
}

function policyMatches(anchor: RoutingAnchor, model: ModelJSON): boolean {
  const tenancy = resolveTenancy(model);
  if (tenancy.kind === 'source') return true;
  if (tenancy.kind === 'column') {
    return tenancy.column === anchor.column || tenancy.column === camelToSnake(anchor.column);
  }
  if (tenancy.kind === 'parent') {
    return tenancy.via.localKey === anchor.column &&
      (anchor.parentTable === undefined || tenancy.via.parentTable === anchor.parentTable);
  }
  return false;
}

/**
 * Finds mutable models whose sync-group routing is narrower than their row-read
 * policy. A correctly filtered list or routed stream is not evidence that a
 * foreign row is unreadable; only the policy is the authorization boundary.
 */
export function auditSchemaAccessPolicies(schema: SchemaJSON): readonly SchemaAuditFinding[] {
  const findings: SchemaAuditFinding[] = [];

  for (const [key, model] of Object.entries(schema.models)) {
    if (model.mutable === false || model.routingOnly === true) continue;
    const mismatched = routingAnchors(model, schema.models)
      .filter((anchor) => !policyMatches(anchor, model));
    if (mismatched.length === 0) continue;

    const policy = resolveTenancy(model);
    const routedBy = mismatched.map(({ description, column }) => `${description} (${column})`).join(', ');
    findings.push({
      code: 'scope_routing_without_access_policy',
      severity: 'error',
      model: key,
      message:
        `Model "${key}" routes changes by ${routedBy}, but its row-access policy is ` +
        `by ${policy.kind}. Sync groups route delivery; they do not authorize reads. ` +
        `A filtered list or correctly routed live stream is not an authorization proof.`,
      fix:
        `Make policy follow the same customer/workspace boundary on every reachable model, ` +
        `use policy: { by: 'source' } with one Ablo organization per hard tenant, or set ` +
        `groups.routingOnly: true to explicitly acknowledge an intentionally broader read policy.`,
    });
  }

  return findings;
}
