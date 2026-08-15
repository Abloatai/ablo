/**
 * Field builders for schema definitions. Each helper — {@link field}.string(),
 * .number(), .enum(), and so on — returns an ordinary Zod schema with a little
 * sync-engine metadata attached (its type tag and whether it is indexed) plus a
 * couple of chainable methods. The metadata is tucked into the schema's description
 * as a JSON string so it survives `.optional()`, `.nullable()`, and `.default()`
 * chaining, and {@link resolveFieldMeta} reads it back out as a {@link FieldMeta}.
 *
 * Usage:
 *   import { field } from '@abloatai/transaction/schema';
 *
 *   const items = model({
 *     title: field.string(),
 *     projectId: field.string().indexed(),     // fluent chain
 *     priority: field.number().optional(),
 *     status: field.enum(['todo', 'doing', 'done']),
 *   });
 *
 * Or use Zod directly (no metadata, but still works):
 *   import { z } from 'zod';
 *
 *   const items = model({
 *     title: z.string(),
 *   });
 */

import { z } from 'zod';
import { AbloValidationError } from '../errors.js';

// ── Helpers ───────────────────────────────────────────────────────────────

/** Distinguish a Zod schema from a plain object shape (ZodRawShape). */
function isZodSchema(value: unknown): value is z.ZodType {
  return (
    typeof value === 'object' &&
    value !== null &&
    '_def' in value &&
    typeof (value as Record<string, unknown>)._def === 'object'
  );
}

// ── Metadata types ────────────────────────────────────────────────────────

/**
 * The sync-engine metadata describing one field, available at runtime through a
 * model's `fields` map. The {@link field} builders attach it, and the migration
 * planner, type generator, and OpenAPI generator all read it.
 *
 * Declared in `wire/modelShape.ts` and inferred here, not restated: this record
 * crosses the wire twice — serialized into the pushed artifact, and reported
 * back by `GET /api/schema` — so a second declaration would be a copy that
 * drifts in whichever direction nobody is looking.
 */
export type { FieldMeta } from '../wire/modelShape.js';
import type { FieldMeta } from '../wire/modelShape.js';

// ── Metadata encoding ─────────────────────────────────────────────────────
//
// We stash metadata in `.describe('__sync:{json}')` so it rides along with
// the Zod schema through `.optional()`, `.nullable()`, etc. At schema-build
// time we parse it back out into structured FieldMeta.

const META_PREFIX = '__sync:';

function encodeMeta(meta: Omit<FieldMeta, 'isOptional'>): string {
  return META_PREFIX + JSON.stringify(meta);
}

function decodeMeta(description: string | undefined): Omit<FieldMeta, 'isOptional'> | null {
  if (!description?.startsWith(META_PREFIX)) return null;
  try {
    return JSON.parse(description.slice(META_PREFIX.length));
  } catch {
    return null;
  }
}

/**
 * Extract FieldMeta from a Zod schema. Returns null if no sync-engine
 * metadata is attached (e.g., raw `z.string()` usage).
 *
 * Walks through `.optional()` and `.nullable()` wrappers to find the
 * underlying description.
 */
export function getFieldMeta(schema: z.ZodType): FieldMeta | null {
  let current: z.ZodType = schema;
  let isOptional = false;

  // Unwrap optional / nullable / default to reach the inner type
  // (these are the wrappers that preserve .describe() but may hide it).
  // `instanceof` keeps the narrowing typed; no `_def` digging.
  const MAX_UNWRAP = 5;
  for (let i = 0; i < MAX_UNWRAP; i++) {
    if (current instanceof z.ZodOptional) {
      isOptional = true;
      current = current.unwrap() as z.ZodType;
      continue;
    }
    if (current instanceof z.ZodNullable) {
      isOptional = true;
      current = current.unwrap() as z.ZodType;
      continue;
    }
    if (current instanceof z.ZodDefault) {
      // .removeDefault() — v4 deprecates in favor of .unwrap() but
      // the installed @types only expose removeDefault on ZodDefault.
      current = current.unwrap() as z.ZodType;
      continue;
    }
    break;
  }

  // The description lives on the innermost schema we reached.
  const description = current.description ?? schema.description;
  const base = decodeMeta(description);
  if (!base) return null;

  return { ...base, isOptional };
}

/**
 * Infers a {@link FieldMeta} from a plain Zod schema that carries no field-builder
 * metadata — for example a bare `z.string()`. It unwraps `.optional()`,
 * `.nullable()`, and `.default()` to reach the inner type, then maps that Zod type
 * to a sync-engine type tag. Most callers should use {@link resolveFieldMeta}
 * instead, which tries the attached metadata first and falls back to this.
 */
export function inferFieldMetaFromZod(schema: z.ZodType): FieldMeta {
  let current: z.ZodType = schema;
  let isOptional = false;

  const MAX_UNWRAP = 5;
  for (let i = 0; i < MAX_UNWRAP; i++) {
    if (current instanceof z.ZodOptional || current instanceof z.ZodNullable) {
      isOptional = true;
      current = current.unwrap() as z.ZodType;
      continue;
    }
    if (current instanceof z.ZodDefault) {
      current = current.unwrap() as z.ZodType;
      continue;
    }
    break;
  }

  let type: FieldMeta['type'] = 'string';
  let enumValues: readonly string[] | undefined;
  if (current instanceof z.ZodString) {
    type = 'string';
  } else if (current instanceof z.ZodNumber) {
    type = 'number';
  } else if (current instanceof z.ZodBoolean) {
    type = 'boolean';
  } else if (current instanceof z.ZodDate) {
    type = 'date';
  } else if (current instanceof z.ZodEnum) {
    type = 'enum';
    // ZodEnum.options is the public v4 accessor for enum values.
    enumValues = current.options as readonly string[];
  } else if (
    current instanceof z.ZodObject ||
    current instanceof z.ZodArray ||
    current instanceof z.ZodRecord ||
    current instanceof z.ZodUnion ||
    current instanceof z.ZodUnknown ||
    // `z.custom<T>()` is opaque — its shape cannot be inspected — so it is treated
    // as a JSON blob rather than falling through to the `'string'` default. The type
    // tag drives how the runtime observes the field, and an opaque custom value
    // should be tracked by reference rather than deeply.
    current instanceof z.ZodCustom
  ) {
    type = 'json';
  }

  return { type, isOptional, isIndexed: false, enumValues };
}

/**
 * Resolves a {@link FieldMeta} for any Zod schema, whether it was built with a
 * {@link field} builder (which attaches metadata) or with plain Zod (which needs
 * inference). This is the single entry point for "given a Zod field, tell me its
 * sync-engine type tag and whether it is optional"; the model and query builders use
 * it to populate their field maps, and the serializer reads those maps.
 *
 * It always returns a value and never returns null. A Zod type it does not recognize
 * falls through to the `string` tag by design.
 */
export function resolveFieldMeta(schema: z.ZodType): FieldMeta {
  const attached = getFieldMeta(schema);
  if (attached) return attached;
  return inferFieldMetaFromZod(schema);
}

// ── Chainable field builders ──────────────────────────────────────────────
//
// Each builder returns the underlying Zod schema (so `z.object(shape)` still
// works) with `.indexed()` added as a chainable method. `.optional()` and
// `.nullable()` still come from Zod itself and preserve the description.

/** A Zod schema returned by a {@link field} builder — the underlying Zod type plus
 *  two chainable methods: `indexed()` marks the field for a database index, and
 *  `from(column)` overrides the database column name it maps to. */
export type FieldBuilder<T extends z.ZodType> = T & {
  indexed(): FieldBuilder<T>;
  from(column: string): FieldBuilder<T>;
};

function assertColumnName(column: string): void {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/.test(column)) {
    throw new AbloValidationError(`field.from(): invalid column identifier ${JSON.stringify(column)}`, { code: 'schema_definition_invalid' });
  }
}

/** Add sync-engine chain methods to a Zod schema without disturbing its type. */
function withFieldMethods<T extends z.ZodType>(
  schema: T,
  meta: Omit<FieldMeta, 'isOptional'>,
): FieldBuilder<T> {
  const described = schema.describe(encodeMeta(meta)) as FieldBuilder<T>;
  described.indexed = () => withFieldMethods(schema, { ...meta, isIndexed: true });
  described.from = (column: string) => {
    assertColumnName(column);
    return withFieldMethods(schema, { ...meta, column });
  };
  return described;
}

function buildField<T extends z.ZodType>(
  schema: T,
  baseMeta: Omit<FieldMeta, 'isOptional' | 'isIndexed'>,
): FieldBuilder<T> {
  return withFieldMethods(schema, { ...baseMeta, isIndexed: false });
}

export const field = {
  /** Defines a text field. */
  string() {
    return buildField(z.string(), { type: 'string' });
  },

  /** Defines a numeric field. */
  number() {
    return buildField(z.number(), { type: 'number' });
  },

  /** Defines a true/false field. */
  boolean() {
    return buildField(z.boolean(), { type: 'boolean' });
  },

  /** Defines a timestamp field, represented as a JavaScript `Date`. */
  date() {
    return buildField(z.date(), { type: 'date' });
  },

  /** Defines a field constrained to a fixed set of string values. */
  enum<const T extends readonly [string, ...string[]]>(values: T) {
    return buildField(z.enum(values), { type: 'enum', enumValues: values });
  },

  /**
   * Defines a JSON field, with three call shapes:
   *
   * ```ts
   * field.json()                                        // unknown JSON blob
   * field.json(z.array(z.string()))                     // typed JSON with Zod schema
   * field.json({ icon: z.string().default('default') }) // typed sub-properties with defaults
   * ```
   *
   * The third form is especially handy for metadata fields. It wraps the plain
   * object in `z.object()` automatically, and the model runtime adds a
   * `${field}Json` getter that parses the JSON string on read, applies the Zod
   * defaults, and caches the result.
   *
   * Example:
   * ```ts
   * const reports = model({
   *   metadata: field.json({
   *     icon: z.string().default('report'),
   *     color: z.string().default('#F59E0B'),
   *     summary: z.string().optional(),
   *   }),
   * });
   *
   * // At runtime:
   * report.metadata       // raw JSON string (unchanged)
   * report.metadataJson   // { icon: 'report', color: '#F59E0B', summary: undefined }
   * report.metadataJson.icon  // 'report' (typed, with default)
   * ```
   */
  json<T extends z.ZodType = z.ZodUnknown>(schemaOrShape?: T | z.ZodRawShape) {
    let inner: z.ZodType;
    if (!schemaOrShape) {
      inner = z.unknown();
    } else if (isZodSchema(schemaOrShape)) {
      inner = schemaOrShape;
    } else {
      // Plain object shape → wrap in z.object() for the sub-property pattern
      inner = z.object(schemaOrShape);
    }
    return buildField(inner, { type: 'json' });
  },

  /** Defines an indexed text field — shorthand for `field.string().indexed()`. */
  id() {
    return field.string().indexed();
  },
} as const;

// ── Function form ────────────────────────────────────────────────────────

/** Marks a Zod schema as indexed so lookups on it use a database index. This is the
 *  standalone-function form of the `.indexed()` chain method. */
export function indexed<T extends z.ZodType>(schema: T): T {
  // Try to preserve existing metadata type tag if present.
  const meta = decodeMeta(schema.description);
  const newMeta: Omit<FieldMeta, 'isOptional'> = meta
    ? { ...meta, isIndexed: true }
    : { type: 'string', isIndexed: true };
  return schema.describe(encodeMeta(newMeta));
}
