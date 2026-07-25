/**
 * A shared intermediate representation and emitter for the schema importers that
 * read an ORM's own source. `ablo pull prisma` and `ablo pull drizzle` each lower
 * their input into this representation, then run it through one emitter that
 * prints `defineSchema(...)` TypeScript source, so the two importers stay
 * consistent.
 *
 * These importers exist alongside the database-introspection path (`ablo pull`
 * against a live Postgres database) because introspection loses information. By
 * the time a schema reaches the database, enums have collapsed to text plus a
 * check constraint, relations to bare columns, and JSON shape to `jsonb`. Reading
 * the ORM source instead preserves the enum member list and the relation field
 * and cardinality the database no longer records.
 *
 * The emitter favors the `field.*` builder over raw `z.*` for the same reason:
 * `field.enum([...])` carries the member list and `field.from(col)` carries a
 * physical-column override — the two facts database introspection cannot express.
 */

export type IRScalarKind = 'string' | 'number' | 'boolean' | 'date' | 'json';
export type IRFieldKind = IRScalarKind | 'enum';

export interface IRField {
  /** The `defineSchema` field key. */
  name: string;
  kind: IRFieldKind;
  /** The allowed values, present and never empty when `kind` is `'enum'`. */
  enumValues?: readonly string[];
  optional: boolean;
  /**
   * Physical column name, when the source declared one that differs from what
   * the engine would derive from the field name. Emitted as `.from('col')`.
   */
  column?: string;
  /** Reviewer hint, emitted as a trailing `// review:` comment. */
  note?: string;
}

export interface IRRelation {
  /** Relation key on the owning model. */
  name: string;
  /** Target model key (the referenced table). */
  target: string;
  /** Local foreign-key field — a declared field on this same model. */
  fkField: string;
}

export interface IRModel {
  /** The model key, which equals the physical table name. */
  key: string;
  fields: IRField[];
  relations: IRRelation[];
}

export interface IRSkip {
  name: string;
  reason: string;
}

export interface IRSchema {
  models: IRModel[];
  skipped: IRSkip[];
}

// ── Casing / identifiers ────────────────────────────────────────────────────
// These helpers are kept local rather than shared with the database-introspection
// path, so the source-reading importers don't pull in the Postgres client that
// path depends on.

/** Mirror of the engine's field→column derivation (camelCase → snake_case). */
export function camelToSnake(s: string): string {
  return s.replace(/[A-Z]/g, (ch) => `_${ch.toLowerCase()}`);
}

function isIdentifier(s: string): boolean {
  return /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(s);
}

/** Object-literal key — bare when it's a valid identifier, quoted otherwise. */
function quoteKey(s: string): string {
  return isIdentifier(s) ? s : `'${s.replace(/'/g, "\\'")}'`;
}

function quoteString(s: string): string {
  return `'${s.replace(/'/g, "\\'")}'`;
}

// ── Field expression ────────────────────────────────────────────────────────

function baseFieldExpr(f: IRField): string {
  switch (f.kind) {
    case 'string':
      return 'field.string()';
    case 'number':
      return 'field.number()';
    case 'boolean':
      return 'field.boolean()';
    case 'date':
      return 'field.date()';
    case 'json':
      return 'field.json()';
    case 'enum': {
      const values = f.enumValues ?? [];
      // Guard: an empty enum can't be expressed as `field.enum([])` (the engine
      // requires a non-empty tuple). Callers should avoid this, but stay safe.
      if (values.length === 0) return 'field.string()';
      return `field.enum([${values.map(quoteString).join(', ')}])`;
    }
  }
}

/** Render one IR field as a `field.*()` chain. */
export function fieldExpr(f: IRField): string {
  let expr = baseFieldExpr(f);
  // Only emit `.from()` when the column wouldn't round-trip through the engine's
  // own field→column derivation — otherwise the override is noise.
  if (f.column && f.column !== camelToSnake(f.name)) {
    expr += `.from(${quoteString(f.column)})`;
  }
  if (f.optional) expr += '.optional()';
  return expr;
}

// ── Emitter ─────────────────────────────────────────────────────────────────

/**
 * Render an {@link IRSchema} as `defineSchema(...)` TypeScript source.
 *
 * Imports `relation` only when at least one model has a relation, and `field`
 * always (the builder is how enums and column overrides survive).
 */
export function emitSchemaSource(schema: IRSchema, importPath: string): string {
  const hasRelations = schema.models.some((m) => m.relations.length > 0);
  const imports = ['defineSchema', 'model', ...(hasRelations ? ['relation'] : []), 'field'];

  const lines: string[] = [
    `import { ${imports.join(', ')} } from ${quoteString(importPath)};`,
    '',
    'export const schema = defineSchema({',
  ];

  const models = [...schema.models].sort((a, b) => a.key.localeCompare(b.key));
  for (const m of models) {
    lines.push(`  ${quoteKey(m.key)}: model({`);
    for (const f of m.fields) {
      const note = f.note ? ` // review: ${f.note}` : '';
      lines.push(`    ${quoteKey(f.name)}: ${fieldExpr(f)},${note}`);
    }
    if (m.relations.length > 0) {
      lines.push('  }, {');
      for (const r of m.relations) {
        lines.push(`    ${quoteKey(r.name)}: relation.belongsTo(${quoteString(r.target)}, ${quoteString(r.fkField)}),`);
      }
      lines.push('  }),');
    } else {
      lines.push('  }),');
    }
  }

  lines.push('});', '');
  return lines.join('\n');
}
