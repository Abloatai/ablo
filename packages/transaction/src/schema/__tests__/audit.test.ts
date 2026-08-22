import { describe, expect, it } from '@jest/globals';
import { z } from 'zod';
import {
  auditSchemaAccessPolicies,
  defineSchema,
  model,
  parseSchema,
  relation,
  serializeSchema,
  toSchemaJSON,
} from '../index.js';

describe('auditSchemaAccessPolicies', () => {
  it('flags the Circle shape where workspace groups sit inside one constant tenant policy', () => {
    const circle = defineSchema(
      {
        workspaces: model(
          { name: z.string(), abloTenantId: z.string() },
          {
            tableName: 'workspaces',
            policy: { by: 'column', column: 'ablo_tenant_id' },
            groups: { root: 'workspace' },
          },
        ),
        issues: model(
          { workspaceId: z.string(), abloTenantId: z.string(), title: z.string() },
          {
            tableName: 'issues',
            policy: { by: 'column', column: 'ablo_tenant_id' },
            relations: { workspace: relation.belongsTo('workspaces', 'workspaceId') },
          },
        ),
      },
      { casing: 'snake_case' },
    );

    const findings = auditSchemaAccessPolicies(toSchemaJSON(circle));
    expect(findings.map(({ model: modelName }) => modelName)).toEqual(['workspaces', 'issues']);
    expect(findings[0]).toMatchObject({
      code: 'scope_routing_without_access_policy',
      severity: 'error',
    });
    expect(findings[0]?.message).toContain('not an authorization proof');
  });

  it('accepts CRM-style source policy across a workspace root and parent graph', () => {
    const crm = defineSchema(
      {
        workspaces: model(
          { name: z.string() },
          { policy: { by: 'source' }, groups: { root: 'workspace' } },
        ),
        contacts: model(
          { workspaceId: z.string(), name: z.string() },
          {
            policy: { by: 'source' },
            relations: { workspace: relation.belongsTo('workspaces', 'workspaceId') },
          },
        ),
      },
      { casing: 'snake_case' },
    );

    expect(auditSchemaAccessPolicies(toSchemaJSON(crm))).toEqual([]);
  });

  it('accepts an explicit routing-only acknowledgement and preserves it on the wire', () => {
    const schema = defineSchema({
      messages: model(
        { workspaceId: z.string() },
        {
          policy: { by: 'column', column: 'organization_id' },
          groups: { root: 'workspace', routingOnly: true },
        },
      ),
    });
    const json = toSchemaJSON(schema);

    expect(json.models.messages?.routingOnly).toBe(true);
    expect(parseSchema(serializeSchema(schema)).models.messages?.routingOnly).toBe(true);
    expect(auditSchemaAccessPolicies(json)).toEqual([]);
  });
});
