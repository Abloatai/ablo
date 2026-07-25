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
    tasks: mutable.instant(
      {
        title: field.string(),
        status: field.enum(['todo', 'done']),
        priority: z.number().optional(),
        projectId: field.string().from('project_uuid').indexed(),
      },
      {
        typename: 'Task',
        tableName: 'tasks',
        relations: {
          project: relation.belongsTo('projects', 'projectId', { index: true }),
          comments: relation.hasMany('comments', 'taskId', { orderBy: 'createdAt' }),
        },
      },
    ),
    projects: mutable.instant(
      { name: field.string(), teamId: field.string() },
      {
        typename: 'Project',
        tableName: 'projects',
        policy: { by: 'parent', fk: 'team_id', parent: 'team' },
      },
    ),
    comments: readOnly.lazy({ taskId: field.string(), body: field.string() }),
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

    expect(Object.keys(back.models).sort()).toEqual(['comments', 'projects', 'tasks']);

    const tasks = back.models.tasks;
    if (!tasks) throw new Error('expected tasks model after round-trip');
    expect(tasks.typename).toBe('Task');
    expect(tasks.tableName).toBe('tasks');
    expect(tasks.mutable).toBe(true);
    expect(tasks.load).toBe('instant');

    const projects = back.models.projects;
    if (!projects) throw new Error('expected projects model after round-trip');
    expect(projects.tenancy).toEqual({
      kind: 'parent',
      via: { localKey: 'team_id', parentTable: 'team' },
    });

    expect(back.models.comments?.load).toBe('lazy');
  });

  it('preserves field names and type tags', () => {
    const back = parseSchema(serializeSchema(schema));
    const tasks = back.models.tasks;
    if (!tasks) throw new Error('expected tasks model after round-trip');
    const fields = tasks.fields;
    expect(Object.keys(fields).sort()).toEqual(['priority', 'projectId', 'status', 'title']);
    const status = fields.status;
    if (!status) throw new Error('expected status field on tasks');
    expect(status.type).toBe('enum');
    expect(status.enumValues).toEqual(['todo', 'done']);
    const projectId = fields.projectId;
    if (!projectId) throw new Error('expected projectId field on tasks');
    expect(projectId.isIndexed).toBe(true);
    expect(projectId.column).toBe('project_uuid');
    expect(fields.priority?.isOptional).toBe(true);
  });

  it('preserves relations including resolved foreignKeyColumn (snake_case casing)', () => {
    const back = parseSchema(serializeSchema(schema));
    const tasks = back.models.tasks;
    if (!tasks) throw new Error('expected tasks model after round-trip');
    const rels = tasks.relations;
    const project = rels.project;
    if (!project) throw new Error('expected project relation on tasks');
    expect(project.type).toBe('belongsTo');
    expect(project.target).toBe('projects');
    expect(project.foreignKey).toBe('projectId');
    // casing: 'snake_case' resolved this at build time; it must survive.
    expect(project.foreignKeyColumn).toBe('project_uuid');
    const comments = rels.comments;
    if (!comments) throw new Error('expected comments relation on tasks');
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
      { tasks: mutable.instant({ title: field.string() }, { typename: 'Task', tableName: 'tasks' }) },
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
    const tasksValidator = back.validators.tasks;
    if (!tasksValidator) throw new Error('expected tasks validator after round-trip');
    const parsed = tasksValidator.parse({
      id: 'x',
      createdAt: new Date(),
      updatedAt: new Date(),
      title: 'hi',
      status: 'todo',
      projectId: 'p1',
    });
    expect(parsed.title).toBe('hi');
  });

  it('schemaHash is stable across serialize round-trips and changes with content', () => {
    const h1 = schemaHash(schema);
    const h2 = schemaHash(parseSchema(serializeSchema(schema)));
    expect(h1).toBe(h2);

    const different = defineSchema({ tasks: model({ title: field.string() }, { mutable: true }) });
    expect(schemaHash(different)).not.toBe(h1);
  });
});

describe('conflict axis (Axis 3) round-trip', () => {
  // Guards the serialization split-brain: the declared `conflict` map must
  // survive serialize → parse so a pushed multi-tenant schema enforces the
  // same coordination as the single-tenant boot path. If any of the three
  // serialize edits (ModelJSON / modelToJSON / modelFromJSON) is missing, the
  // field is silently stripped here.
  it('preserves a declared per-committer-kind conflict map', () => {
    const s = defineSchema({
      widgets: model(
        { name: field.string() },
        {
          typename: 'Widget',
          tableName: 'widgets',
          mutable: true,
          conflict: { user: 'overwrite', agent: 'reject', system: 'notify' },
        }),
    });
    const back = parseSchema(serializeSchema(s));
    expect(back.models.widgets?.conflict).toEqual({
      user: 'overwrite',
      agent: 'reject',
      system: 'notify',
    });
  });

  it('absent conflict → undefined after round-trip (back-compat, like plane)', () => {
    const s = defineSchema({
      widgets: model({ name: field.string() }, { typename: 'Widget', tableName: 'widgets', mutable: true }),
    });
    const back = parseSchema(serializeSchema(s));
    const widgets = back.models.widgets;
    if (!widgets) throw new Error('expected widgets model after round-trip');
    expect(widgets.conflict).toBeUndefined();
  });
});
