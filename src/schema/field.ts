/**
 * Schema Field Helpers
 *
 * Thin wrappers around Zod that add sync-engine metadata (type tag, indexed).
 * Metadata is stored in `z.describe()` as a JSON-encoded string so it
 * survives `.optional()`, `.nullable()`, and `.default()` chain calls.
 *
 * Usage:
 *   import { field } from '@ablo/sync-engine/schema';
 *
 *   const tasks = model({
 *     title: field.string(),
 *     projectId: field.string().indexed(),     // fluent chain
 *     priority: field.number().optional(),
 *     status: field.enum(['todo', 'doing', 'done']),
 *   });
 *
 * Or use Zod directly (no metadata, but still works):
 *   import { z } from 'zod';
 *
 *   const tasks = model({
 *     title: z.string(),
 *   });
 */

import { z } from 'zod';

// ── Helpers ───────────────────────────────────────────────────────────────

/** Distinguish a Zod schema from a plain object shape (ZodRawShape). */
function isZodSchema(value: unknown): value is z.ZodTypeAny {
  return (
    typeof value === 'object' &&
    value !== null &&
    '_def' in value &&
    typeof (value as Record<string, unknown>)._def === 'object'
  );
}

// ── Metadata types ────────────────────────────────────────────────────────

/** Runtime metadata for a schema field, readable via `ModelDef.fields`. */
export interface FieldMeta {
  /** Sync-engine type tag (maps to storage/serialization hints). */
  type: 'string' | 'number' | 'boolean' | 'date' | 'enum' | 'json';
  /** Whether the field was marked optional via `.optional()` or `.nullable()`. */
  isOptional: boolean;
  /** Whether the field was marked indexed via `.indexed()`. */
  isIndexed: boolean;
  /** For enums: the allowed values. */
  enumValues?: readonly string[];
}

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
  if (!description || !description.startsWith(META_PREFIX)) return null;
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
export function getFieldMeta(schema: z.ZodTypeAny): FieldMeta | null {
  let current: z.ZodTypeAny = schema;
  let isOptional = false;

  // Unwrap optional / nullable / default to reach the inner type
  // (these are the wrappers that preserve .describe() but may hide it).
  // ZodOptional, ZodNullable, ZodDefault all have ._def.innerType.
  const MAX_UNWRAP = 5;
  for (let i = 0; i < MAX_UNWRAP; i++) {
    const def = (current as unknown as { _def: { typeName: string; innerType?: z.ZodTypeAny } })._def;
    if (def.typeName === 'ZodOptional' || def.typeName === 'ZodNullable' || def.typeName === 'ZodDefault') {
      isOptional = isOptional || def.typeName !== 'ZodDefault';
      if (def.innerType) {
        current = def.innerType;
        continue;
      }
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
 * Fallback: infer FieldMeta directly from a raw Zod schema when no
 * `field.*()` metadata was attached.
 *
 * Walks through `.optional()` / `.nullable()` / `.default()` wrappers
 * to find the inner primitive, then maps Zod's `_def.typeName` to
 * the sync-engine type tag. Used by `resolveFieldMeta` and by
 * `model()` / `query()` at definition time.
 *
 * Kept as an internal helper rather than exported directly — the
 * public API is `resolveFieldMeta`, which combines this fallback
 * with the `getFieldMeta` fast path.
 */
function inferFieldMetaFromZod(schema: z.ZodTypeAny): FieldMeta {
  let current: z.ZodTypeAny = schema;
  let isOptional = false;

  const MAX_UNWRAP = 5;
  for (let i = 0; i < MAX_UNWRAP; i++) {
    const def = (current as unknown as { _def: { typeName: string; innerType?: z.ZodTypeAny; values?: readonly string[] } })._def;
    if (def.typeName === 'ZodOptional' || def.typeName === 'ZodNullable') {
      isOptional = true;
      if (def.innerType) {
        current = def.innerType;
        continue;
      }
    }
    if (def.typeName === 'ZodDefault') {
      if (def.innerType) {
        current = def.innerType;
        continue;
      }
    }
    break;
  }

  const def = (current as unknown as { _def: { typeName: string; values?: readonly string[] } })._def;
  const typeName = def.typeName;

  let type: FieldMeta['type'] = 'string';
  let enumValues: readonly string[] | undefined;
  switch (typeName) {
    case 'ZodString':
      type = 'string';
      break;
    case 'ZodNumber':
      type = 'number';
      break;
    case 'ZodBoolean':
      type = 'boolean';
      break;
    case 'ZodDate':
      type = 'date';
      break;
    case 'ZodEnum':
      type = 'enum';
      enumValues = def.values;
      break;
    case 'ZodObject':
    case 'ZodArray':
    case 'ZodRecord':
    case 'ZodUnion':
    case 'ZodUnknown':
      type = 'json';
      break;
    default:
      type = 'string';
  }

  return { type, isOptional, isIndexed: false, enumValues };
}

/**
 * Resolve FieldMeta for any Zod schema — whether it was built with
 * `field.*()` (which attaches sync-engine metadata) or with raw Zod
 * (which requires fallback inference from `_def.typeName`).
 *
 * This is the single public entry point for "given a Zod field, tell
 * me its sync-engine type tag and optionality." Both `model()` and
 * `query()` use it to populate their `fields` / `inputFields` maps at
 * definition time, and the schema serializer reads those maps at
 * serialization time.
 *
 * Contract: always returns a value. Never returns null. Unknown Zod
 * types fall through to `'string'` — this is intentional and matches
 * the existing behavior that was previously duplicated in
 * `model.ts:inferMetaFromZod`.
 */
export function resolveFieldMeta(schema: z.ZodTypeAny): FieldMeta {
  const attached = getFieldMeta(schema);
  if (attached) return attached;
  return inferFieldMetaFromZod(schema);
}

// ── Chainable field builders ──────────────────────────────────────────────
//
// Each builder returns the underlying Zod schema (so `z.object(shape)` still
// works) with `.indexed()` added as a chainable method. `.optional()` and
// `.nullable()` still come from Zod itself and preserve the description.

/** Add `.indexed()` to a Zod schema without disturbing its type. */
function withIndexed<T extends z.ZodTypeAny>(schema: T, baseMeta: Omit<FieldMeta, 'isOptional' | 'isIndexed'>): T & { indexed(): T } {
  const described = schema.describe(encodeMeta({ ...baseMeta, isIndexed: false })) as T & { indexed?: () => T };
  described.indexed = () => {
    return schema.describe(encodeMeta({ ...baseMeta, isIndexed: true })) as T;
  };
  return described as T & { indexed(): T };
}

export const field = {
  /** String field */
  string() {
    return withIndexed(z.string(), { type: 'string' });
  },

  /** Number field */
  number() {
    return withIndexed(z.number(), { type: 'number' });
  },

  /** Boolean field */
  boolean() {
    return withIndexed(z.boolean(), { type: 'boolean' });
  },

  /** Date field */
  date() {
    return withIndexed(z.date(), { type: 'date' });
  },

  /** Enum field with constrained string values */
  enum<const T extends readonly [string, ...string[]]>(values: T) {
    return withIndexed(z.enum(values), { type: 'enum', enumValues: values });
  },

  /**
   * JSON field. Three call shapes:
   *
   * ```ts
   * field.json()                                        // unknown JSON blob
   * field.json(z.array(z.string()))                     // typed JSON with Zod schema
   * field.json({ icon: z.string().default('default') }) // typed sub-properties with defaults
   * ```
   *
   * The third form is the key DX feature for metadata fields. It wraps the
   * plain object in `z.object()` automatically, and the model runtime generates
   * a `${field}Json` getter that parses the JSON string on read, applies Zod
   * defaults, and caches the result.
   *
   * Example:
   * ```ts
   * const slideDecks = model({
   *   metadata: field.json({
   *     icon: z.string().default('presentation'),
   *     color: z.string().default('#F59E0B'),
   *     summary: z.string().optional(),
   *   }),
   * });
   *
   * // At runtime:
   * deck.metadata       // raw JSON string (unchanged)
   * deck.metadataJson   // { icon: 'presentation', color: '#F59E0B', summary: undefined }
   * deck.metadataJson.icon  // 'presentation' (typed, with default)
   * ```
   */
  json<T extends z.ZodTypeAny = z.ZodUnknown>(schemaOrShape?: T | z.ZodRawShape) {
    let inner: z.ZodTypeAny;
    if (!schemaOrShape) {
      inner = z.unknown();
    } else if (isZodSchema(schemaOrShape)) {
      inner = schemaOrShape;
    } else {
      // Plain object shape → wrap in z.object() for the sub-property pattern
      inner = z.object(schemaOrShape as z.ZodRawShape);
    }
    return withIndexed(inner, { type: 'json' });
  },

  /** Indexed string field (shorthand for `field.string().indexed()`). */
  id() {
    return field.string().indexed();
  },
} as const;

// ── Legacy function form (kept for backward compat) ──────────────────────

/** Mark a Zod schema as indexed for fast lookups (function form). */
export function indexed<T extends z.ZodTypeAny>(schema: T): T {
  // Try to preserve existing metadata type tag if present.
  const meta = decodeMeta(schema.description);
  const newMeta: Omit<FieldMeta, 'isOptional'> = meta
    ? { ...meta, isIndexed: true }
    : { type: 'string', isIndexed: true };
  return schema.describe(encodeMeta(newMeta)) as T;
}
