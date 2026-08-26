/**
 * Round-trip tests for serializeSchema / parseSchema / schemaHash.
 *
 * The contract: a `Schema`'s routing/scoping metadata, relations, field
 * names, and identity roles survive serialize → parse intact. Validators are
 * rebuilt permissively (the server never validates field shapes) and
 * `computed` closures are dropped.
 */

import { z } from 'zod';
import {
  defineSchema,
  model,
  mutable,
  readOnly,
  field,
  relation,
  identityRole,
  serializeSchema,
  parseSchema,
  schemaHash,
  composeIdentitySyncGroups,
} from '../index.js';

const schema = defineSchema(
  {
    items: mutable.instant(
      {
        title: field.string(),
        status: field.enum(['todo', 'done']),
        priority: z.number().optional(),
        workspaceId: field.string().from('workspace_uuid').indexed(),
      },
      {
        typename: 'Item',
        tableName: 'items',
        relations: {
          workspace: relation.belongsTo('workspaces', 'workspaceId', { index: true }),
          comments: relation.hasMany('comments', 'itemId', { orderBy: 'createdAt' }),
        },
      },
    ),
    workspaces: mutable.instant(
      { name: field.string(), teamId: field.string() },
      {
        typename: 'Workspace',
        tableName: 'workspaces',
        policy: { by: 'parent', fk: 'team_id', parent: 'team' },
      },
    ),
    comments: readOnly.lazy({ itemId: field.string(), body: field.string() }),
  },
  {
    casing: 'snake_case',
    identityRoles: [
      identityRole({ kind: 'org', source: 'organizationId' }),
      identityRole({ kind: 'team', source: 'teamIds', multi: true }),
    ],
  },
);

describe('serializeSchema / parseSchema', () => {
  it('round-trips model routing/scoping metadata', () => {
    const back = parseSchema(serializeSchema(schema));

    expect(Object.keys(back.models).sort()).toEqual(['comments', 'items', 'workspaces']);

    const items = back.models.items;
    if (!items) throw new Error('expected items model after round-trip');
    expect(items.typename).toBe('Item');
    expect(items.tableName).toBe('items');
    expect(items.mutable).toBe(true);
    expect(items.load).toBe('instant');

    const workspaces = back.models.workspaces;
    if (!workspaces) throw new Error('expected workspaces model after round-trip');
    expect(workspaces.tenancy).toEqual({
      kind: 'parent',
      via: { localKey: 'team_id', parentTable: 'team' },
    });

    expect(back.models.comments?.load).toBe('lazy');
  });

  it('preserves field names and type tags', () => {
    const back = parseSchema(serializeSchema(schema));
    const items = back.models.items;
    if (!items) throw new Error('expected items model after round-trip');
    const fields = items.fields;
    expect(Object.keys(fields).sort()).toEqual(['priority', 'status', 'title', 'workspaceId']);
    const status = fields.status;
    if (!status) throw new Error('expected status field on items');
    expect(status.type).toBe('enum');
    expect(status.enumValues).toEqual(['todo', 'done']);
    const workspaceId = fields.workspaceId;
    if (!workspaceId) throw new Error('expected workspaceId field on items');
    expect(workspaceId.isIndexed).toBe(true);
    expect(workspaceId.column).toBe('workspace_uuid');
    expect(fields.priority?.isOptional).toBe(true);
  });

  it('preserves relations including resolved foreignKeyColumn (snake_case casing)', () => {
    const back = parseSchema(serializeSchema(schema));
    const items = back.models.items;
    if (!items) throw new Error('expected items model after round-trip');
    const rels = items.relations;
    const workspace = rels.workspace;
    if (!workspace) throw new Error('expected workspace relation on items');
    expect(workspace.type).toBe('belongsTo');
    expect(workspace.target).toBe('workspaces');
    expect(workspace.foreignKey).toBe('workspaceId');
    // casing: 'snake_case' resolved this at build time; it must survive.
    expect(workspace.foreignKeyColumn).toBe('workspace_uuid');
    const comments = rels.comments;
    if (!comments) throw new Error('expected comments relation on items');
    expect(comments.type).toBe('hasMany');
    expect(comments._orderBy).toBe('createdAt');
  });

  it('round-trips identity roles as pure data and composes identically', () => {
    const back = parseSchema(serializeSchema(schema));
    expect(back.identityRoles).toEqual(schema.identityRoles);

    const identity = { organizationId: 'o1', teamIds: ['t1', 't2'] };
    expect(composeIdentitySyncGroups(identity, back)).toEqual(
      composeIdentitySyncGroups(identity, schema),
    );
    expect(composeIdentitySyncGroups(identity, back)).toEqual(['org:o1', 'team:t1', 'team:t2']);
  });

  it('round-trips session-setting mappings, and omits the key when none are declared', () => {
    // A schema WITHOUT sessionSettings parses back to an empty map, and the JSON
    // envelope omits the key entirely (so artifacts pushed before ADR 0011 stay
    // byte-identical).
    expect(schema.sessionSettings).toEqual({});
    const withoutJson = JSON.parse(serializeSchema(schema)) as Record<string, unknown>;
    expect('sessionSettings' in withoutJson).toBe(false);
    expect(parseSchema(serializeSchema(schema)).sessionSettings).toEqual({});

    // A schema WITH mappings carries them across serialize → parse intact.
    const withSettings = defineSchema(
      { items: mutable.instant({ title: field.string() }, { typename: 'Item', tableName: 'items' }) },
      {
        sessionSettings: {
          'app.current_org': 'orgId',
          'app.current_app_env': 'environment',
        },
      },
    );
    const back = parseSchema(serializeSchema(withSettings));
    expect(back.sessionSettings).toEqual(withSettings.sessionSettings);
    expect(back.sessionSettings).toEqual({
      'app.current_org': 'orgId',
      'app.current_app_env': 'environment',
    });
    // Declaring mappings changes the content hash (they cross to the server).
    expect(schemaHash(withSettings)).not.toBe(schemaHash(schema));
  });

  it('rebuilds working (permissive) validators', () => {
    const back = parseSchema(serializeSchema(schema));
    // Base fields are merged back in, and declared fields validate.
    const itemsValidator = back.validators.items;
    if (!itemsValidator) throw new Error('expected items validator after round-trip');
    const parsed = itemsValidator.parse({
      id: 'x',
      createdAt: new Date(),
      updatedAt: new Date(),
      title: 'hi',
      status: 'todo',
      workspaceId: 'p1',
    });
    expect(parsed.title).toBe('hi');
  });

  it('schemaHash is stable across serialize round-trips and changes with content', () => {
    const h1 = schemaHash(schema);
    const h2 = schemaHash(parseSchema(serializeSchema(schema)));
    expect(h1).toBe(h2);

    const different = defineSchema({ items: model({ title: field.string() }, { mutable: true }) });
    expect(schemaHash(different)).not.toBe(h1);
  });
});
