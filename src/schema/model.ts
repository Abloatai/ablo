/**
 * Schema Model Definition
 *
 * A model is a Zod object schema + optional relations.
 * Types are inferred directly from Zod — no custom type system.
 *
 * Usage:
 *   import { z } from 'zod';
 *   import { model, relation } from '@ablo/sync-engine/schema';
 *
 *   const tasks = model({
 *     title: z.string(),
 *     status: z.enum(['todo', 'doing', 'done']).default('todo'),
 *     projectId: z.string().optional(),
 *   }, {
 *     project: relation.belongsTo('projects', 'projectId'),
 *   });
 */

import { z } from 'zod';
import type { RelationDef } from './relation';
import { getFieldMeta, type FieldMeta } from './field';

// ── Load strategies ───────────────────────────────────────────────────────

/**
 * Controls when model data is loaded from the server.
 *
 * - `'instant'` — loaded during bootstrap (appears immediately on page load)
 * - `'lazy'`    — loaded on first access (e.g., when you navigate to a page that needs it)
 * - `'manual'`  — only loaded when you explicitly call sync.model.load()
 */
export type LoadStrategy = 'instant' | 'lazy' | 'manual';

// ── Model definition types ────────────────────────────────────────────────

/** A record of relation definitions */
export type RelationRecord = Record<string, RelationDef>;

/**
 * Persistence hints for IndexedDB write-through and hydration.
 *
 * The sync engine's generic loader uses these to route incoming rows to
 * the right client-side store without the consumer wiring each model by
 * hand. `store` defaults to the model's {@link ModelDef.typename} (which
 * itself defaults to the schema key), so consumers only set this when
 * the IDB store name diverges from the typename.
 */
export interface PersistOptions {
  /**
   * Name of the IndexedDB object store that backs this model.
   * Defaults to the model's {@link ModelDef.typename}.
   */
  store?: string;
}

/** Options for model() */
export interface ModelOptions {
  /** When to load this model's data. Default: 'instant' */
  load?: LoadStrategy;
  /** Max records to bootstrap. Default: unlimited. Only applies to 'instant' strategy. */
  bootstrapLimit?: number;
  /** Order to sort by during bootstrap (e.g., 'created_at DESC'). */
  bootstrapOrderBy?: string;
  /**
   * The GraphQL/wire `__typename` value for this model.
   *
   * Used by the generic loader + hydration pipeline to stamp `__typename`
   * on raw rows before `pool.createFromData(...)`, and to look up the
   * matching class in the model registry. Defaults to the schema key
   * (e.g., `tasks` → `'tasks'`). Provide explicitly when the wire shape
   * uses a different casing (e.g., schema key `slideLayer` → typename
   * `'SlideLayer'`).
   *
   * This is the single source of truth for "what identifies this model
   * on the wire." Every other layer (IDB store name, query.returns
   * references, delta routing) resolves through this value.
   */
  typename?: string;
  /**
   * IndexedDB persistence hints. See {@link PersistOptions}.
   */
  persist?: PersistOptions;
  /**
   * The actual database table name. Defaults to snake_case of the model
   * name if not provided. Used by the bootstrap query builder to know
   * which table to SELECT from — without this, the server has to guess
   * via a naming convention that may not match the Prisma @@map directive.
   */
  tableName?: string;

  /**
   * Whether this model's table has an organization_id column.
   * Default: true. When false, the bootstrap query omits the
   * `WHERE organization_id = $1` clause for this model.
   */
  orgScoped?: boolean;

  /**
   * Template for the sync group this entity lives in. When set, the
   * mesh layer treats this entity as *scopable* — `mesh.join(agent, { scope:
   * [{ entity: schema.models[name], ids }] })` derives
   * `allowedSyncGroups: [format.replace('{id}', id)]`.
   * The single `{id}` placeholder is substituted with the scope id.
   *
   * Example: `syncGroupFormat: 'matter:{id}'` + `scope: { matters: 'acme-q3' }`
   * yields a capability restricted to `sync_group: ['matter:acme-q3']`.
   *
   * Leave unset for entities that aren't directly scopable (nested
   * children whose access derives from their parent — e.g. a `redline`
   * inside a `document` inside a `matter`). The `/mesh` layer consults
   * this field to decide which entities are valid scope keys.
   */
  syncGroupFormat?: string;

  /**
   * Whether clients may issue CREATE/UPDATE/DELETE mutations for this
   * model via the `batch_ack` wire protocol. Default: false.
   *
   * Safety-by-default: a newly-declared schema entity is read-only from
   * the client side until the author explicitly opts into wire mutability.
   * Prevents the class of bug where adding a new entity to the schema
   * silently exposes it as a write surface (the 2026-04-20 `AgentJob`
   * incident) OR where internal tables (`sync_deltas`, `presences`,
   * digest/ingestion tables) become writable by accident.
   *
   * The server's `buildModelMap` (src/server/commit.ts) derives
   * the mutation allowlist from this flag — no parallel hardcoded list.
   */
  mutable?: boolean;

  /**
   * Defer MobX observability setup until the model is first accessed
   * by an observer component. Default: false (observe immediately).
   *
   * Use for models that are created in bulk (e.g., during import or
   * batch bootstrap) where most instances are never rendered. The
   * model's constructor skips makeObservable(); instead, consuming
   * code calls model.makeObservable() when the model enters the
   * render tree. This matches Ablo's SlideLayer.ensureObservable()
   * pattern and avoids ~10ms of MobX setup overhead per instance
   * when creating hundreds of models that never get observed.
   */
  lazyObservable?: boolean;

  /**
   * Computed getters installed on the dynamic model class prototype.
   *
   * Each key becomes a getter on the model instance. The function receives
   * `self` (the model instance) and returns the computed value. These replace
   * hand-coded getter methods on legacy Model subclasses.
   *
   * @example
   * model({ title: z.string(), metadata: z.string() }, {}, {
   *   computed: {
   *     displayTitle: (self) => self.title || `Untitled`,
   *     metadataObject: (self) => {
   *       try { return JSON.parse(self.metadata || '{}'); }
   *       catch { return {}; }
   *     },
   *   },
   * })
   */
  computed?: ComputedRecord;
}

/** Base type for computed getter records. Preserves return types via inference. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ComputedRecord = Record<string, (self: any) => any>;

/** A complete model definition: Zod shape + fields metadata + relations + options */
export interface ModelDef<
  Shape extends z.ZodRawShape = z.ZodRawShape,
  R extends RelationRecord = RelationRecord,
  C extends ComputedRecord = ComputedRecord,
> {
  /** The Zod object schema for this model's fields */
  readonly schema: z.ZodObject<Shape>;
  /** The raw shape (for type inference) */
  readonly shape: Shape;
  /**
   * Runtime metadata for each field, keyed by field name.
   *
   * Populated automatically from `field.*()` builders. Fields defined
   * with raw Zod (e.g., `z.string()`) get a fallback metadata entry
   * with type inferred from Zod's `_def.typeName`.
   *
   * Used by the CLI (`npx ablo migrate`), admin panels, and any tooling
   * that needs to introspect the schema without parsing Zod internals.
   */
  readonly fields: Record<string, FieldMeta>;
  /** Relations to other models */
  readonly relations: R;
  /** Load strategy */
  readonly load: LoadStrategy;
  /** Max records to bootstrap */
  readonly bootstrapLimit?: number;
  /** Sort order for bootstrap */
  readonly bootstrapOrderBy?: string;
  /**
   * The GraphQL/wire `__typename` value for this model. When unset in
   * {@link ModelOptions}, this falls back to the schema key at schema
   * assembly time (see `defineSchema`).
   */
  readonly typename?: string;
  /** IndexedDB persistence hints. See {@link PersistOptions}. */
  readonly persist?: PersistOptions;
  /** The actual database table name from Prisma @@map. See {@link ModelOptions.tableName}. */
  readonly tableName?: string;
  /** Whether the table has organization_id. See {@link ModelOptions.orgScoped}. */
  readonly orgScoped?: boolean;
  /** Template for `/mesh` scope derivation. See {@link ModelOptions.syncGroupFormat}. */
  readonly syncGroupFormat?: string;
  /** Whether wire-level CREATE/UPDATE/DELETE is allowed. See {@link ModelOptions.mutable}. */
  readonly mutable?: boolean;
  /** Defer MobX setup until first observer access. See {@link ModelOptions.lazyObservable}. */
  readonly lazyObservable?: boolean;
  /** Computed getters for the dynamic model class. See {@link ModelOptions.computed}. */
  readonly computed?: C;
}

// ── Model factory ─────────────────────────────────────────────────────────

/**
 * Define a model with a Zod shape and optional relations.
 *
 * ```ts
 * import { z } from 'zod';
 * import { model, relation } from '@ablo/sync-engine/schema';
 *
 * const tasks = model({
 *   title: z.string(),
 *   status: z.enum(['todo', 'doing', 'done']).default('todo'),
 *   priority: z.number().default(0),
 *   projectId: z.string().optional(),
 * }, {
 *   project: relation.belongsTo('projects', 'projectId'),
 * });
 * ```
 */
/**
 * Define a model with fields, optional relations, and load strategy.
 *
 * ```ts
 * // Loaded at bootstrap (default)
 * const tasks = model({ title: z.string() });
 *
 * // Loaded on first access (lazy)
 * const slideLayers = model({ slideId: z.string(), type: z.string() }, {
 *   slide: relation.belongsTo('slides', 'slideId'),
 * }, { load: 'lazy' });
 *
 * // Only loaded when explicitly requested
 * const auditLogs = model({ action: z.string() }, {}, { load: 'manual' });
 * ```
 */
export function model<
  Shape extends z.ZodRawShape,
  R extends RelationRecord = Record<string, never>,
  C extends ComputedRecord = Record<string, never>,
>(
  shape: Shape,
  relations?: R,
  options?: ModelOptions & { computed?: C }
): ModelDef<Shape, R, C> {
  // Build the fields metadata record by walking the Zod shape.
  // Fields built with `field.*()` have structured metadata; fields built
  // with raw Zod get a fallback derived from the Zod typeName.
  const fields: Record<string, FieldMeta> = {};
  for (const [name, zodType] of Object.entries(shape)) {
    const meta = getFieldMeta(zodType as z.ZodTypeAny);
    if (meta) {
      fields[name] = meta;
    } else {
      fields[name] = inferMetaFromZod(zodType as z.ZodTypeAny);
    }
  }

  return {
    schema: z.object(shape),
    shape,
    fields,
    relations: (relations ?? {}) as R,
    load: options?.load ?? 'instant',
    bootstrapLimit: options?.bootstrapLimit,
    bootstrapOrderBy: options?.bootstrapOrderBy,
    typename: options?.typename,
    persist: options?.persist,
    tableName: options?.tableName,
    orgScoped: options?.orgScoped,
    syncGroupFormat: options?.syncGroupFormat,
    mutable: options?.mutable,
    lazyObservable: options?.lazyObservable,
    computed: options?.computed,
  };
}

/**
 * Fallback: infer FieldMeta from a raw Zod schema (no `field.*()` wrapper).
 * Walks through optional/nullable wrappers to find the inner Zod type.
 */
function inferMetaFromZod(schema: z.ZodTypeAny): FieldMeta {
  let current: z.ZodTypeAny = schema;
  let isOptional = false;

  for (let i = 0; i < 5; i++) {
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
