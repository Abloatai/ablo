/**
 * Schema-diff + migration-planning tests.
 *
 * Structure copied from Drizzle Kit's differ tests: table-driven cases that
 * build a `before`/`after` schema in-code, run them through the differ (with
 * explicit rename hints where relevant), and assert on the exact emitted step
 * array. Layered on top, Prisma-style destructive assertions check the
 * warning/unexecutable classification.
 *
 * The differ is pure (no DB), so everything here is a fast unit test.
 */

import type { FieldMeta } from '@ablo/transaction/schema/field';
import type { SchemaJSON, ModelJSON } from '../serialize.js';
import {
  diffSchema,
  classifyMigration,
  classifyCast,
  isAutoApplicable,
  isBlockerResolved,
  unresolvedBlockers,
  type FieldType,
  type MigrationStep,
} from '../diff.js';

// ── Fixture helpers ────────────────────────────────────────────────────────────

function fld(
  type: FieldType,
  opts: { optional?: boolean; indexed?: boolean; enumValues?: readonly string[]; column?: string } = {},
): FieldMeta {
  return {
    type,
    isOptional: opts.optional ?? false,
    isIndexed: opts.indexed ?? false,
    ...(opts.enumValues ? { enumValues: opts.enumValues } : {}),
    ...(opts.column ? { column: opts.column } : {}),
  };
}

function mdl(fields: Record<string, FieldMeta>, tableName?: string): ModelJSON {
  return {
    fields,
    relations: {},
    load: 'instant',
    typename: 'X',
    tenancy: { kind: 'column', column: 'organization_id' },
    ...(tableName ? { tableName } : {}),
  };
}

function sch(models: Record<string, ModelJSON>): SchemaJSON {
  return { v: 3, models, identityRoles: [] };
}

// ── Model-level diffs ───────────────────────────────────────────────────────────

describe('diffSchema — models', () => {
  it('first push (prev = null) creates every model, no per-field steps', () => {
    const next = sch({
      tasks: mdl({ title: fld('string') }, 'tasks'),
      projects: mdl({ name: fld('string') }, 'projects'),
    });
    expect(diffSchema(null, next)).toStrictEqual<MigrationStep[]>([
      { kind: 'create_model', model: 'tasks', tableName: 'tasks' },
      { kind: 'create_model', model: 'projects', tableName: 'projects' },
    ]);
  });

  it('falls back to the model key when tableName is unset', () => {
    const next = sch({ tasks: mdl({ title: fld('string') }) });
    expect(diffSchema(null, next)).toStrictEqual([
      { kind: 'create_model', model: 'tasks', tableName: 'tasks' },
    ]);
  });

  it('adds a new model', () => {
    const prev = sch({ tasks: mdl({ title: fld('string') }, 'tasks') });
    const next = sch({
      tasks: mdl({ title: fld('string') }, 'tasks'),
      notes: mdl({ body: fld('string') }, 'notes'),
    });
    expect(diffSchema(prev, next)).toStrictEqual([
      { kind: 'create_model', model: 'notes', tableName: 'notes' },
    ]);
  });

  it('drops a removed model', () => {
    const prev = sch({
      tasks: mdl({ title: fld('string') }, 'tasks'),
      legacy: mdl({ x: fld('string') }, 'legacy_table'),
    });
    const next = sch({ tasks: mdl({ title: fld('string') }, 'tasks') });
    expect(diffSchema(prev, next)).toStrictEqual([
      { kind: 'drop_model', model: 'legacy', tableName: 'legacy_table' },
    ]);
  });

  it('treats an unhinted removed+added pair as drop + create (not a rename)', () => {
    const prev = sch({ task: mdl({ title: fld('string') }, 'task') });
    const next = sch({ todo: mdl({ title: fld('string') }, 'todo') });
    const steps = diffSchema(prev, next);
    expect(steps).toStrictEqual([
      { kind: 'create_model', model: 'todo', tableName: 'todo' },
      { kind: 'drop_model', model: 'task', tableName: 'task' },
    ]);
  });

  it('honours a model rename hint (no drop/create)', () => {
    const prev = sch({ task: mdl({ title: fld('string') }, 'task') });
    const next = sch({ todo: mdl({ title: fld('string') }, 'todo') });
    const steps = diffSchema(prev, next, { models: [{ from: 'task', to: 'todo' }] });
    expect(steps).toStrictEqual([{ kind: 'rename_model', from: 'task', to: 'todo' }]);
  });

  it('diffs fields across a renamed model', () => {
    const prev = sch({ task: mdl({ title: fld('string') }, 'task') });
    const next = sch({ todo: mdl({ title: fld('string'), done: fld('boolean', { optional: true }) }, 'todo') });
    const steps = diffSchema(prev, next, { models: [{ from: 'task', to: 'todo' }] });
    expect(steps).toStrictEqual([
      { kind: 'rename_model', from: 'task', to: 'todo' },
      { kind: 'add_field', model: 'todo', field: 'done', meta: fld('boolean', { optional: true }) },
    ]);
  });
});

// ── Field-level diffs ────────────────────────────────────────────────────────────

describe('diffSchema — fields', () => {
  const base = (fields: Record<string, FieldMeta>) => sch({ t: mdl(fields, 't') });

  it('adds an optional field', () => {
    const steps = diffSchema(base({ a: fld('string') }), base({ a: fld('string'), b: fld('number', { optional: true }) }));
    expect(steps).toStrictEqual([
      { kind: 'add_field', model: 't', field: 'b', meta: fld('number', { optional: true }) },
    ]);
  });

  it('drops a field', () => {
    const steps = diffSchema(base({ a: fld('string'), b: fld('number') }), base({ a: fld('string') }));
    expect(steps).toStrictEqual([{ kind: 'drop_field', model: 't', field: 'b' }]);
  });

  it('treats unhinted field remove+add as drop + add', () => {
    const steps = diffSchema(base({ a: fld('string'), name: fld('string') }), base({ a: fld('string'), label: fld('string') }));
    expect(steps).toStrictEqual([
      { kind: 'add_field', model: 't', field: 'label', meta: fld('string') },
      { kind: 'drop_field', model: 't', field: 'name' },
    ]);
  });

  it('honours a field rename hint', () => {
    const steps = diffSchema(
      base({ a: fld('string'), name: fld('string') }),
      base({ a: fld('string'), label: fld('string') }),
      { fields: [{ model: 't', from: 'name', to: 'label' }] },
    );
    expect(steps).toStrictEqual([{ kind: 'rename_field', model: 't', from: 'name', to: 'label' }]);
  });

  it('detects alter on a renamed field (rename then alter)', () => {
    const steps = diffSchema(
      base({ name: fld('string') }),
      base({ label: fld('string', { optional: true }) }),
      { fields: [{ model: 't', from: 'name', to: 'label' }] },
    );
    expect(steps).toStrictEqual([
      { kind: 'rename_field', model: 't', from: 'name', to: 'label' },
      { kind: 'alter_field', model: 't', field: 'label', changes: { nullability: { fromOptional: false, toOptional: true } } },
    ]);
  });

  it('alters nullability both directions', () => {
    const toOptional = diffSchema(base({ a: fld('string') }), base({ a: fld('string', { optional: true }) }));
    expect(toOptional).toStrictEqual([
      { kind: 'alter_field', model: 't', field: 'a', changes: { nullability: { fromOptional: false, toOptional: true } } },
    ]);
    const toRequired = diffSchema(base({ a: fld('string', { optional: true }) }), base({ a: fld('string') }));
    expect(toRequired).toStrictEqual([
      { kind: 'alter_field', model: 't', field: 'a', changes: { nullability: { fromOptional: true, toOptional: false } } },
    ]);
  });

  it('alters index flag', () => {
    const steps = diffSchema(base({ a: fld('string') }), base({ a: fld('string', { indexed: true }) }));
    expect(steps).toStrictEqual([
      { kind: 'alter_field', model: 't', field: 'a', changes: { indexed: { from: false, to: true } } },
    ]);
  });

  it('treats a physical column override change as a column rename', () => {
    const steps = diffSchema(
      base({ senderId: fld('string', { column: 'sender_id' }) }),
      base({ senderId: fld('string', { column: 'author_id' }) }),
    );
    expect(steps).toStrictEqual([
      {
        kind: 'alter_field',
        model: 't',
        field: 'senderId',
        changes: { column: { from: 'sender_id', to: 'author_id' } },
      },
    ]);
  });

  it('captures multiple facets in one alter_field step (Atlas-style)', () => {
    const steps = diffSchema(
      base({ a: fld('number') }),
      base({ a: fld('string', { optional: true, indexed: true }) }),
    );
    expect(steps).toStrictEqual([
      {
        kind: 'alter_field',
        model: 't',
        field: 'a',
        changes: {
          type: { from: 'number', to: 'string', cast: 'safe' },
          nullability: { fromOptional: false, toOptional: true },
          indexed: { from: false, to: true },
        },
      },
    ]);
  });

  it('emits no step when a field is unchanged', () => {
    expect(diffSchema(base({ a: fld('string', { indexed: true }) }), base({ a: fld('string', { indexed: true }) }))).toStrictEqual([]);
  });

  it('diffs enum values (added + removed) while staying an enum', () => {
    const steps = diffSchema(
      base({ status: fld('enum', { enumValues: ['todo', 'doing', 'done'] }) }),
      base({ status: fld('enum', { enumValues: ['todo', 'done', 'archived'] }) }),
    );
    expect(steps).toStrictEqual([
      {
        kind: 'alter_field',
        model: 't',
        field: 'status',
        changes: { enumValues: { added: ['archived'], removed: ['doing'] } },
      },
    ]);
  });

  it('does not emit an enumValues change when leaving the enum type', () => {
    const steps = diffSchema(
      base({ status: fld('enum', { enumValues: ['a', 'b'] }) }),
      base({ status: fld('string') }),
    );
    expect(steps).toStrictEqual([
      { kind: 'alter_field', model: 't', field: 'status', changes: { type: { from: 'enum', to: 'string', cast: 'safe' } } },
    ]);
  });
});

// ── Ordering (expand → contract) ─────────────────────────────────────────────────

describe('diffSchema — ordering', () => {
  it('orders creates → renames → field changes → drops', () => {
    const prev = sch({
      task: mdl({ title: fld('string'), old: fld('string') }, 'task'),
      gone: mdl({ x: fld('string') }, 'gone'),
    });
    const next = sch({
      todo: mdl({ title: fld('string'), extra: fld('number', { optional: true }) }, 'todo'),
      fresh: mdl({ y: fld('string') }, 'fresh'),
    });
    const steps = diffSchema(prev, next, { models: [{ from: 'task', to: 'todo' }] });
    const kinds = steps.map((s) => s.kind);
    expect(kinds).toStrictEqual([
      'create_model', // fresh
      'rename_model', // task → todo
      'add_field', // todo.extra
      'drop_field', // todo.old
      'drop_model', // gone
    ]);
  });
});

// ── Cast safety matrix ────────────────────────────────────────────────────────────

describe('classifyCast', () => {
  it('is safe for same type', () => {
    for (const t of ['string', 'number', 'boolean', 'date', 'enum', 'json'] as FieldType[]) {
      expect(classifyCast(t, t)).toBe('safe');
    }
  });

  it('is safe casting any scalar to string (TEXT)', () => {
    for (const t of ['number', 'boolean', 'date', 'enum', 'json'] as FieldType[]) {
      expect(classifyCast(t, 'string')).toBe('safe');
    }
  });

  it('is risky tightening into an enum (CHECK over existing data)', () => {
    expect(classifyCast('string', 'enum')).toBe('risky');
    expect(classifyCast('number', 'enum')).toBe('risky');
  });

  it('is risky parsing text into number/boolean/date/json', () => {
    expect(classifyCast('string', 'number')).toBe('risky');
    expect(classifyCast('string', 'boolean')).toBe('risky');
    expect(classifyCast('string', 'date')).toBe('risky');
    expect(classifyCast('string', 'json')).toBe('risky');
  });

  it('is notCastable for nonsensical conversions', () => {
    expect(classifyCast('boolean', 'number')).toBe('notCastable');
    expect(classifyCast('date', 'number')).toBe('notCastable');
    expect(classifyCast('json', 'enum')).toBe('notCastable');
    expect(classifyCast('number', 'date')).toBe('notCastable');
  });
});

// ── Destructive classification (Prisma two-tier) ──────────────────────────────────

describe('classifyMigration', () => {
  const base = (fields: Record<string, FieldMeta>) => sch({ t: mdl(fields, 't') });

  it('flags a dropped model as a warning', () => {
    const c = classifyMigration(diffSchema(sch({ t: mdl({ a: fld('string') }, 't') }), sch({})));
    expect(c.warnings).toStrictEqual([
      { code: 'drop_model', model: 't', detail: expect.stringContaining('drops table') },
    ]);
    expect(c.unexecutable).toHaveLength(0);
  });

  it('flags a dropped field as a warning', () => {
    const c = classifyMigration(diffSchema(base({ a: fld('string'), b: fld('number') }), base({ a: fld('string') })));
    expect(c.warnings.map((w) => w.code)).toStrictEqual(['drop_field']);
  });

  it('flags adding a required field as unexecutable', () => {
    const c = classifyMigration(diffSchema(base({ a: fld('string') }), base({ a: fld('string'), b: fld('number') })));
    expect(c.unexecutable.map((u) => u.code)).toStrictEqual(['required_field_added']);
    expect(c.warnings).toHaveLength(0);
  });

  it('does NOT flag adding an optional field', () => {
    const c = classifyMigration(diffSchema(base({ a: fld('string') }), base({ a: fld('string'), b: fld('number', { optional: true }) })));
    expect(c.warnings).toHaveLength(0);
    expect(c.unexecutable).toHaveLength(0);
  });

  it('flags making an optional field required as unexecutable', () => {
    const c = classifyMigration(diffSchema(base({ a: fld('string', { optional: true }) }), base({ a: fld('string') })));
    expect(c.unexecutable.map((u) => u.code)).toStrictEqual(['made_required']);
  });

  it('does NOT flag relaxing required → optional', () => {
    const c = classifyMigration(diffSchema(base({ a: fld('string') }), base({ a: fld('string', { optional: true }) })));
    expect(c.warnings).toHaveLength(0);
    expect(c.unexecutable).toHaveLength(0);
  });

  it('flags a risky cast as a warning, a notCastable cast as lossy_recreate', () => {
    const risky = classifyMigration(diffSchema(base({ a: fld('string') }), base({ a: fld('number') })));
    expect(risky.warnings.map((w) => w.code)).toStrictEqual(['risky_cast']);

    const lossy = classifyMigration(diffSchema(base({ a: fld('boolean') }), base({ a: fld('number') })));
    expect(lossy.warnings.map((w) => w.code)).toStrictEqual(['lossy_recreate']);
  });

  it('does NOT flag a safe cast', () => {
    const c = classifyMigration(diffSchema(base({ a: fld('number') }), base({ a: fld('string') })));
    expect(c.warnings).toHaveLength(0);
    expect(c.unexecutable).toHaveLength(0);
  });

  it('flags enum value removal but not addition', () => {
    const removed = classifyMigration(diffSchema(
      base({ s: fld('enum', { enumValues: ['a', 'b'] }) }),
      base({ s: fld('enum', { enumValues: ['a'] }) }),
    ));
    expect(removed.warnings.map((w) => w.code)).toStrictEqual(['enum_value_removed']);

    const added = classifyMigration(diffSchema(
      base({ s: fld('enum', { enumValues: ['a'] }) }),
      base({ s: fld('enum', { enumValues: ['a', 'b'] }) }),
    ));
    expect(added.warnings).toHaveLength(0);
  });

  it('treats creates, renames, and pure relaxations as auto-applicable', () => {
    const steps = diffSchema(
      sch({ task: mdl({ name: fld('string') }, 'task') }),
      sch({ todo: mdl({ label: fld('string', { optional: true }) }, 'todo') }),
      { models: [{ from: 'task', to: 'todo' }], fields: [{ model: 'todo', from: 'name', to: 'label' }] },
    );
    const c = classifyMigration(steps);
    expect(isAutoApplicable(c)).toBe(true);
    expect(c.warnings).toHaveLength(0);
  });

  it('is not auto-applicable when an unexecutable step is present', () => {
    const c = classifyMigration(diffSchema(
      sch({ t: mdl({ a: fld('string') }, 't') }),
      sch({ t: mdl({ a: fld('string'), b: fld('number') }, 't') }),
    ));
    expect(isAutoApplicable(c)).toBe(false);
  });
});

describe('backfill resolution', () => {
  const base = (fields: Record<string, FieldMeta>) => sch({ t: mdl(fields, 't') });

  it('a backfill resolves a required-field-added blocker', () => {
    const c = classifyMigration(diffSchema(base({ a: fld('string') }), base({ a: fld('string'), b: fld('number') })));
    expect(unresolvedBlockers(c, [{ model: 't', field: 'b', value: 0 }])).toHaveLength(0);
    // …but only for the matching field.
    expect(unresolvedBlockers(c, [{ model: 't', field: 'other', value: 0 }])).toHaveLength(1);
  });

  it('a backfill resolves a made-required blocker', () => {
    const c = classifyMigration(diffSchema(base({ a: fld('string', { optional: true }) }), base({ a: fld('string') })));
    expect(unresolvedBlockers(c, [{ model: 't', field: 'a', value: 'x' }])).toHaveLength(0);
  });

  it('a backfill does NOT resolve a destructive warning', () => {
    const dropSignal = { code: 'drop_field' as const, model: 't', field: 'b', detail: '' };
    expect(isBlockerResolved(dropSignal, [{ model: 't', field: 'b', value: 0 }])).toBe(false);
  });
});
