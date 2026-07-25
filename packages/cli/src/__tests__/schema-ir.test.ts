/**
 * The intermediate representation's emitter, tested on hand-built IR.
 *
 * These assertions belong to `schemaIr` rather than to either importer: they
 * describe how an IR becomes `defineSchema(...)` source, independent of which
 * ORM produced it. What each importer produces from a real schema is the
 * conformance battery's job (`derivation/`).
 */

import { emitSchemaSource, fieldExpr, type IRSchema } from '../schemaIr';

const IMPORT = '@abloatai/ablo/schema';

describe('fieldExpr', () => {
  it('omits .from when the column round-trips through camelToSnake', () => {
    // projectId → project_id is exactly the engine default, so no override needed.
    expect(fieldExpr({ name: 'projectId', kind: 'string', optional: false, column: 'project_id' })).toBe(
      'field.string()',
    );
  });

  it('keeps .from when the column would not round-trip', () => {
    expect(fieldExpr({ name: 'deadline', kind: 'date', optional: true, column: 'due_at' })).toBe(
      "field.date().from('due_at').optional()",
    );
  });

  it('carries enum members in declaration order', () => {
    expect(fieldExpr({ name: 'status', kind: 'enum', enumValues: ['b', 'a'], optional: false })).toBe(
      "field.enum(['b', 'a'])",
    );
  });

  it('falls back to a string when an enum has no members to carry', () => {
    // The engine's `field.enum` needs a non-empty tuple, so an empty member
    // list has to degrade rather than emit uncompilable source.
    expect(fieldExpr({ name: 'status', kind: 'enum', enumValues: [], optional: false })).toBe('field.string()');
  });
});

describe('emitSchemaSource', () => {
  const oneModel = (relations: IRSchema['models'][number]['relations']): IRSchema => ({
    models: [{ key: 'a', fields: [{ name: 'x', kind: 'string', optional: false }], relations }],
    skipped: [],
  });

  it('drops the relation import when there are no relations', () => {
    const source = emitSchemaSource(oneModel([]), IMPORT);
    expect(source).toContain('import { defineSchema, model, field }');
    expect(source).not.toContain('relation');
  });

  it('imports relation when at least one model has one', () => {
    const source = emitSchemaSource(oneModel([{ name: 'b', target: 'bs', fkField: 'x' }]), IMPORT);
    expect(source).toContain('import { defineSchema, model, relation, field }');
    expect(source).toContain("b: relation.belongsTo('bs', 'x'),");
  });

  it('quotes a key that is not a valid identifier', () => {
    const source = emitSchemaSource(
      { models: [{ key: 'audit-log', fields: [{ name: 'x', kind: 'string', optional: false }], relations: [] }], skipped: [] },
      IMPORT,
    );
    expect(source).toContain("'audit-log': model({");
  });

  it('emits a reviewer note as a trailing comment', () => {
    const source = emitSchemaSource(
      {
        models: [
          { key: 'a', fields: [{ name: 'x', kind: 'json', optional: false, note: 'stored as JSON' }], relations: [] },
        ],
        skipped: [],
      },
      IMPORT,
    );
    expect(source).toContain('x: field.json(), // review: stored as JSON');
  });
});
