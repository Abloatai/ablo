/**
 * The derivation conformance battery — one set of assertions about what
 * lowering an ORM schema into {@link IRSchema} must produce, run against every
 * source that can produce one.
 *
 * The contract this file exists to protect: a source is correct when it lowers
 * the shared fixture the same way every other source does. Before this
 * battery, each importer carried its own copy of these assertions, worded
 * slightly differently, over its own fixture — so a case added to one was
 * simply absent from the other, and nothing failed.
 *
 * A suite is a named function over a {@link ConformanceContext}. A source runs
 * the suites it can satisfy, listed explicitly in its own wiring file. A source
 * that cannot satisfy one omits it there, in the open, with a comment saying
 * why — a capability gap is a visible line in a wiring file, never a silent
 * skip inside a shared suite.
 */

import { camelToSnake, emitSchemaSource, type IRField, type IRModel, type IRSchema } from '../../schemaIr';

/** The physical column a field resolves to, whether stated or derived.
 *
 *  Sources differ in how they represent an unremarkable column: one records it
 *  only when the schema overrode it, another always records what it read. Both
 *  mean the same column, and the emitter treats them identically, so this is
 *  the value comparisons must use. */
export function effectiveColumn(f: IRField): string {
  return f.column ?? camelToSnake(f.name);
}

export interface ConformanceContext {
  /** The source under test, used in test names. */
  readonly source: string;
  /** The lowered fixture. Valid only inside a test body. */
  ir(): IRSchema;
  /** An adopted model, by key. Throws when it was not adopted. */
  model(key: string): IRModel;
  /** A declared field on an adopted model. Throws when absent. */
  field(modelKey: string, fieldName: string): IRField;
}

export type ConformanceSuite = (ctx: ConformanceContext) => void;

/**
 * Register a source's conformance run: lower the fixture once, then let each
 * listed suite assert against it.
 */
export function runConformance(opts: {
  source: string;
  lower: () => IRSchema | Promise<IRSchema>;
  suites: readonly ConformanceSuite[];
}): void {
  let lowered: IRSchema | undefined;

  const ir = (): IRSchema => {
    if (lowered === undefined) throw new Error('the fixture has not been lowered yet');
    return lowered;
  };
  const model = (key: string): IRModel => {
    const found = ir().models.find((m) => m.key === key);
    if (found === undefined) throw new Error(`model "${key}" was not adopted by ${opts.source}`);
    return found;
  };
  const field = (modelKey: string, fieldName: string): IRField => {
    const found = model(modelKey).fields.find((f) => f.name === fieldName);
    if (found === undefined) throw new Error(`field "${modelKey}.${fieldName}" was not declared by ${opts.source}`);
    return found;
  };

  const ctx: ConformanceContext = { source: opts.source, ir, model, field };

  describe(`${opts.source} — derivation conformance`, () => {
    beforeAll(async () => {
      lowered = await opts.lower();
    });
    for (const suite of opts.suites) suite(ctx);
  });
}

// ── Suites ──────────────────────────────────────────────────────────────────

/** Which tables become models, and why the rest do not. */
export const adoptSuite: ConformanceSuite = (ctx) => {
  describe('adopt contract', () => {
    it('adopts exactly the tenant-scoped tables', () => {
      expect(ctx.ir().models.map((m) => m.key).sort()).toEqual(['records', 'workspaces']);
    });

    it('skips a table with no tenancy column, and says so', () => {
      const skips = ctx.ir().skipped;
      expect(skips).toHaveLength(1);
      expect(skips[0]?.reason).toMatch(/organization_id/);
    });
  });
};

/** The columns the engine owns are implicit and must never be declared. */
export const baseColumnsSuite: ConformanceSuite = (ctx) => {
  describe('base columns', () => {
    it('never surfaces an engine-owned column as a declared field', () => {
      const declared = ctx.model('records').fields.map((f) => f.name);
      for (const owned of ['id', 'organizationId', 'createdBy', 'createdAt', 'updatedAt']) {
        expect(declared).not.toContain(owned);
      }
    });

    it('leaves a model that is only base columns plus one field with just that field', () => {
      expect(ctx.model('workspaces').fields.map((f) => f.name)).toEqual(['name']);
    });
  });
};

/** Every field kind the IR can carry, and optionality. */
export const scalarsSuite: ConformanceSuite = (ctx) => {
  const expected: readonly { field: string; kind: IRField['kind']; optional: boolean }[] = [
    { field: 'title', kind: 'string', optional: false },
    { field: 'priority', kind: 'number', optional: true },
    { field: 'counter', kind: 'number', optional: true },
    { field: 'done', kind: 'boolean', optional: true },
    { field: 'meta', kind: 'json', optional: true },
    { field: 'deadline', kind: 'date', optional: true },
    { field: 'workspaceId', kind: 'string', optional: true },
  ];

  describe('scalars', () => {
    for (const { field, kind, optional } of expected) {
      it(`lowers ${field} to ${kind}${optional ? ', optional' : ''}`, () => {
        const f = ctx.field('records', field);
        expect(f.kind).toBe(kind);
        expect(f.optional).toBe(optional);
      });
    }

    it('covers every kind the IR can carry', () => {
      const kinds = new Set(ctx.model('records').fields.map((f) => f.kind));
      expect([...kinds].sort()).toEqual(['boolean', 'date', 'enum', 'json', 'number', 'string']);
    });
  });
};

/** Enum members survive, in order — the fact database introspection loses. */
export const enumsSuite: ConformanceSuite = (ctx) => {
  describe('enums', () => {
    it('preserves the member list and its order', () => {
      const f = ctx.field('records', 'status');
      expect(f.kind).toBe('enum');
      expect(f.enumValues).toEqual(['todo', 'doing', 'done']);
    });
  });
};

/** A foreign key becomes one `belongsTo` pointing at a real model. */
export const relationsSuite: ConformanceSuite = (ctx) => {
  describe('relations', () => {
    it('lowers a single-column foreign key to one belongsTo', () => {
      expect(ctx.model('records').relations).toEqual([
        { name: 'workspace', target: 'workspaces', fkField: 'workspaceId' },
      ]);
    });

    it('gives a model with no foreign key no relations', () => {
      expect(ctx.model('workspaces').relations).toEqual([]);
    });

    it('points every relation at an adopted model, through a declared field', () => {
      const keys = ctx.ir().models.map((m) => m.key);
      for (const m of ctx.ir().models) {
        for (const r of m.relations) {
          expect(keys).toContain(r.target);
          expect(m.fields.map((f) => f.name)).toContain(r.fkField);
        }
      }
    });
  });
};

/** Physical column names, stated or derived. */
export const namingSuite: ConformanceSuite = (ctx) => {
  const columns: readonly { field: string; column: string }[] = [
    { field: 'title', column: 'title' },
    { field: 'workspaceId', column: 'workspace_id' },
    { field: 'deadline', column: 'due_at' },
  ];

  describe('naming', () => {
    for (const { field, column } of columns) {
      it(`resolves ${field} to column ${column}`, () => {
        expect(effectiveColumn(ctx.field('records', field))).toBe(column);
      });
    }

    it('records the column when it would not be derivable from the field name', () => {
      // `deadline` → `due_at` cannot be recovered by camelToSnake, so the
      // source has to have carried it explicitly for `.from()` to be emitted.
      expect(ctx.field('records', 'deadline').column).toBe('due_at');
    });
  });
};

/** A lowering that loses information must say so, in the generated file. */
export const lossySuite: ConformanceSuite = (ctx) => {
  describe('lossy lowering', () => {
    it('stores a scalar list as json and flags it for review', () => {
      const f = ctx.field('records', 'labels');
      expect(f.kind).toBe('json');
      // The wording is the source's own; that it warns at all is the contract.
      expect(f.note).toMatch(/JSON/i);
    });
  });
};

/** The emitted `defineSchema(...)` source, which is what the customer reads. */
export const emitSuite: ConformanceSuite = (ctx) => {
  describe('emitted source', () => {
    const emit = (): string => emitSchemaSource(ctx.ir(), '@abloatai/ablo/schema');

    it('carries the enum members the database could not', () => {
      expect(emit()).toContain("field.enum(['todo', 'doing', 'done'])");
    });

    it('carries the relation', () => {
      expect(emit()).toContain("relation.belongsTo('workspaces', 'workspaceId')");
    });

    it('overrides only the column that needs it', () => {
      const source = emit();
      expect(source).toContain(".from('due_at')");
      expect(source).not.toContain(".from('title')");
      expect(source).not.toContain(".from('workspace_id')");
    });

    it('marks the lossy field for review', () => {
      expect(emit()).toMatch(/labels: field\.json\(\).*\/\/ review:/);
    });

    it('emits models in a stable order', () => {
      const source = emit();
      expect(source.indexOf('records:')).toBeLessThan(source.indexOf('workspaces:'));
    });
  });
};

/** Every suite, for a source that satisfies the whole contract. */
export const ALL_SUITES: readonly ConformanceSuite[] = [
  adoptSuite,
  baseColumnsSuite,
  scalarsSuite,
  enumsSuite,
  relationsSuite,
  namingSuite,
  lossySuite,
  emitSuite,
];
