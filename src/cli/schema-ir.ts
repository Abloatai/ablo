/**
 * Shared intermediate representation + emitter for the *lossless* schema
 * front-ends (`ablo pull prisma`, and the upcoming `ablo pull drizzle`).
 *
 * Why this exists separately from `pull.ts`:
 *   `ablo pull` introspects the live DATABASE (`information_schema`). By the
 *   time a schema reaches Postgres, the ORM's intent is gone — enums have
 *   collapsed to `text` + a check constraint, relations to bare columns, JSON
 *   shape to `jsonb`. So DB-pull is lossy *by construction*.
 *
 *   These front-ends read the ORM SOURCE instead (the `.prisma` file, the
 *   Drizzle module), where enum members and relation field/cardinality are
 *   still declared. That's the same move `drizzle-zero` / `prisma-zero` make.
 *   Each front-end lowers its input into this IR, then emits `defineSchema(...)`
 *   source through one shared emitter so the two paths stay consistent.
 *
 * The emitter prefers the `field.*` builder over raw `z.*` precisely because
 * `field.enum([...])` carries the member list and `field.from(col)` carries a
 * physical-column override — the two things DB-pull can't express.
 */

export type IRScalarKind = 'string' | 'number' | 'boolean' | 'date' | 'json';
export type IRFieldKind = IRScalarKind | 'enum';

export interface IRField {
  /** The `defineSchema` field key. */
  name: string;
  kind: IRFieldKind;
  /** Allowed values when `kind === 'enum'`. Non-empty by contract. */
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
  /** Model key == physical table name. */
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
// Kept local (not imported from pull.ts) so the lossless front-ends don't drag
// in the `postgres` client that the DB-pull path needs.

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
