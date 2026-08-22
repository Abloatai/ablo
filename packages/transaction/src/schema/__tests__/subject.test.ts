import { describe, expect, it } from '@jest/globals';
import { defineSchema, model } from '../index.js';
import { z } from 'zod';
import { generateMigrationPlan, generateProvisionPlan } from '../ddl.js';
import { parseSchema, serializeSchema, toSchemaJSON } from '../serialize.js';

describe('row subject authorization schema', () => {
  const schema = defineSchema({
    records: model(
      { workspaceId: z.string().min(1), title: z.string() },
      { subject: { field: 'workspaceId', group: 'workspace' } },
    ),
  }, { casing: 'snake_case' });

  it('round-trips one canonical subject rule', () => {
    expect(toSchemaJSON(schema).models.records?.subject).toEqual({
      field: 'workspaceId',
      group: 'workspace',
    });
    expect(parseSchema(serializeSchema(schema)).models.records?.subject).toEqual({
      field: 'workspaceId',
      group: 'workspace',
    });
  });

  it('rejects a rule naming an undeclared field', () => {
    expect(() => defineSchema({
      records: model({ workspaceId: z.string() }, {
        subject: { field: 'missing', group: 'workspace' },
      }),
    })).toThrow(/not a declared field/);
  });

  it.each([
    ['number', z.number()],
    ['nullable', z.string().min(1).nullable()],
    ['optional', z.string().min(1).optional()],
    ['empty-string-compatible', z.string()],
    ['coercing', z.coerce.string().min(1)],
  ])('rejects an incompatible %s subject field', (_name, workspaceId) => {
    expect(() => defineSchema({
      records: model({ workspaceId }, {
        subject: { field: 'workspaceId', group: 'workspace' },
      }),
    })).toThrow(/required, non-empty string field/);
  });

  it('compiles the subject group into provision and migration RLS', () => {
    const json = toSchemaJSON(schema);
    const provision = generateProvisionPlan(json, 'public').statements.join('\n');
    expect(provision).toContain("current_setting('app.current_subject_groups', true)");
    expect(provision).toContain("'workspace:' || \"workspace_id\"::text");

    const previous = structuredClone(json);
    delete previous.models.records?.subject;
    const migration = generateMigrationPlan([], {
      prev: previous,
      next: json,
      targetSchema: 'public',
    }).statements.join('\n');
    expect(migration).toContain("current_setting('app.current_subject_groups', true)");
  });
});
