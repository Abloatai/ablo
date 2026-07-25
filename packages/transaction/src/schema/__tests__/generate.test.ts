/**
 * `generateTypes` — schema → TypeScript emission. Asserts the emitted source so
 * the generated client shape stays a stable contract. Pure; no IO.
 */

import { generateTypes } from '../generate.js';
import { defineSchema, model, field, serializeSchema, type SchemaJSON } from '../index.js';

/** Build a real SchemaJSON via the DSL (exercises the same path as a push). */
function jsonOf(schema: ReturnType<typeof defineSchema>): SchemaJSON {
  return JSON.parse(serializeSchema(schema)) as SchemaJSON;
}

describe('generateTypes', () => {
  it('emits base columns + declared fields with mapped types', () => {
    const out = generateTypes(
      jsonOf(
        defineSchema({
          tasks: model(
            {
              title: field.string(),
              count: field.number().optional(),
              done: field.boolean(),
              due: field.date().optional(),
              meta: field.json().optional(),
            },
            { typename: 'Task', tableName: 'tasks', mutable: true }),
        }),
      ),
    );

    expect(out).toContain('export interface Task {');
    expect(out).toContain('  id: string;');
    expect(out).toContain('  createdAt: Date;');
    expect(out).toContain('  organizationId?: string;');
    expect(out).toContain('  title: string;');
    expect(out).toContain('  count?: number;');
    expect(out).toContain('  done: boolean;');
    expect(out).toContain('  due?: Date;');
    expect(out).toContain('  meta?: unknown;');
  });

  it('emits enum fields as literal unions', () => {
    const out = generateTypes(
      jsonOf(
        defineSchema({
          tasks: model(
            { status: field.enum(['todo', 'doing', 'done']) },
            { typename: 'Task', tableName: 'tasks', mutable: true }),
        }),
      ),
    );
    expect(out).toContain(`  status: 'todo' | 'doing' | 'done';`);
  });

  it('emits the AbloSchema map keyed by model key → interface', () => {
    const out = generateTypes(
      jsonOf(
        defineSchema({
          tasks: model({ title: field.string() }, { typename: 'Task', tableName: 'tasks', mutable: true }),
          projects: model({ name: field.string() }, { typename: 'Project', tableName: 'projects', mutable: true }),
        }),
      ),
    );
    expect(out).toContain('export interface AbloSchema {');
    expect(out).toContain('  "tasks": Task;');
    expect(out).toContain('  "projects": Project;');
  });

  it('does not double-emit a redeclared base column', () => {
    // `defineSchema` rejects a model that redeclares a reserved base field, so a
    // colliding shape can only reach `generateTypes` from a non-DSL source (an
    // introspected / hand-built `SchemaJSON`, e.g. `ablo pull`). Build that JSON
    // directly to exercise generate.ts's BASE_FIELDS skip.
    const out = generateTypes({
      v: 3,
      models: {
        tasks: {
          fields: {
            organizationId: { type: 'string', isOptional: false, isIndexed: false },
            title: { type: 'string', isOptional: false, isIndexed: false },
          },
          relations: {},
          load: 'instant',
          typename: 'Task',
          tenancy: { kind: 'column', column: 'organization_id' },
        },
      },
      identityRoles: [],
    });
    // `organizationId?` from base appears once; the redeclaration is skipped.
    expect(out.match(/organizationId/g)?.length).toBe(1);
  });

  it('falls back to a valid identifier when typename is unusable', () => {
    // No typename → derived from the key; a key like `to-do items` PascalCases.
    const out = generateTypes({
      v: 3,
      models: {
        'to-do items': { fields: { x: { type: 'string', isOptional: false, isIndexed: false } }, relations: {}, load: 'instant', typename: '', tenancy: { kind: 'column', column: 'organization_id' } },
      },
      identityRoles: [],
    });
    expect(out).toContain('export interface ToDoItems {');
    expect(out).toContain('  "to-do items": ToDoItems;');
  });
});
