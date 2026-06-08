/**
 * Schema Model Definition
 *
 * A model is a Zod object schema + optional relations.
 * Types are inferred directly from Zod — no custom type system.
 *
 * Usage:
 *   import { z } from 'zod';
 *   import { model, relation } from '@abloatai/ablo/schema';
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
import type { RelationDef } from './relation.js';
import type { EntityRole } from './roles.js';
import { getFieldMeta, inferFieldMetaFromZod, type FieldMeta } from './field.js';
// Tenancy is owned by `tenancy.ts` (single source of truth). `ScopedViaRef` is
// re-exported so existing `import { ScopedViaRef } from './model'` call sites
// keep resolving while consumers migrate.
import { resolveTenancy, type Tenancy, type ScopedViaRef } from './tenancy.js';
export type { ScopedViaRef, Tenancy } from './tenancy.js';
import { DEFAULT_PLANE, type SchemaPlane } from './plane.js';

/** Normalize the `entityRoles` option (single | array | undefined) to an array. */
function normalizeEntityRoles(
  input: EntityRole | readonly EntityRole[] | undefined,
): readonly EntityRole[] | undefined {
  if (!input) return undefined;
  return Array.isArray(input) ? input : [input as EntityRole];
}

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


/**
 * Declares a membership edge on a join model. See {@link ModelOptions.grants}
 * for semantics and how the server membership resolver reads it. Both fields
 * name `belongsTo` relations declared on the same model.
 */
export interface GrantsRef {
  /** Relation name pointing at the identity that gains access (e.g. `'user'`). */
  subject: string;
  /** Relation name pointing at the scope-root entity (e.g. `'dataroom'`). */
  scope: string;
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
   * Scope rows via a parent table when THIS table has no
   * `organization_id` column of its own, but rows still belong to a
   * tenant via a foreign key (e.g. `memberRoles.member_id → member.id`,
   * `teamMember.team_id → team.id`, `users.id ← member.user_id`).
   *
   * Emits, in place of the missing `organization_id = $1` clause:
   *
   *   WHERE <table>.<localKey> IN
   *     (SELECT <parentKey> FROM <parentTable> WHERE <parentOrgColumn> = $1)
   *
   * Use this INSTEAD of `orgScoped: false` for any `load: 'instant'`
   * model whose rows would otherwise leak cross-tenant on bootstrap —
   * dropping the filter entirely exposes the entire DB to every client.
   *
   * Identifiers must match the regular `[a-zA-Z_][a-zA-Z0-9_]*` shape;
   * the SQL compiler validates them to keep this away from injection
   * paths.
   */
  scopedVia?: ScopedViaRef;

  /**
   * Override the physical tenancy column name (default `organization_id`).
   * Authoring sugar — normalized into the canonical {@link tenancy} descriptor.
   */
  orgColumn?: string;

  /**
   * Canonical tenancy descriptor. You normally don't set this — `orgScoped`,
   * `scopedVia`, and `orgColumn` are normalized into it at build time. Set it
   * directly only to author the union form explicitly.
   */
  tenancy?: Tenancy;

  /**
   * Which database plane this model's rows live in. `tenant` (default) =
   * the tenant data plane, emitted into a customer's BYO/dedicated DB by
   * provisioning. `control` = Ablo's control plane (sync log, attribution,
   * audit) — never emitted into a customer DB. See `./plane.ts`.
   */
  plane?: SchemaPlane;

  /**
   * Marks this model as a **scope root** — a model that forms a sync group of
   * its own. A scope-root record lives in the group `<kind>:<id>`, where `kind`
   * defaults to the lowercased `typename` (so a `Deck` → `deck:<id>`). Pass a
   * string to override the kind explicitly (`scope: 'matter'`).
   *
   * Replaces the old `syncGroupFormat` template string: there is no `{id}`
   * placeholder to author — the engine mints the branded {@link SyncGroup} from
   * `(kind, id)`. Child models inherit a root's group via their `belongsTo`
   * relations (a `document` with `dataroomId` fans into `dataroom:<id>`), so
   * only the root declares anything.
   */
  scope?: boolean | string;

  /**
   * Declares this model as a **membership edge** that grants an identity access
   * to a scope root — the relation-driven equivalent of "this user can see that
   * dataroom." Both values are *relation names* already declared on this model:
   * `subject` is the `belongsTo` to the identity (e.g. a `user`), `scope` is the
   * `belongsTo` to the scope-root entity (e.g. a `dataroom`).
   *
   * The server's membership resolver reads this at connect time — for identity
   * `U`, it queries `WHERE <subject FK> = U` and adds `<scopeKind>:<scope FK>`
   * to the identity's subscribed groups (Linear's `/sync/user_sync_groups`).
   *
   * ```ts
   * // dataroomMember: { userId, dataroomId }
   * grants: { subject: 'user', scope: 'dataroom' } // both are relation names
   * ```
   *
   * Not needed for org-level access — a `dataroom.organizationId` already routes
   * via the `org:<id>` group. `grants` is only for sub-org membership.
   */
  grants?: GrantsRef;

  /**
   * Explicit record→group roles for routing that isn't relational — a group
   * keyed on a plain field rather than the record's own id or a `belongsTo`
   * scope root. The escape hatch for cases like per-recipient inbox fan-out:
   *
   * ```ts
   * // a message routes to its addressee's inbox, keyed on `toId`
   * entityRoles: [entityRole({ kind: 'inbox', source: 'toId' })]
   * ```
   *
   * Prefer {@link scope} (self group) + `belongsTo` relations (parent groups)
   * when the routing follows the relation graph — reach for `entityRoles` only
   * when it genuinely doesn't.
   */
  entityRoles?: EntityRole | readonly EntityRole[];

  /**
   * Whether clients may issue CREATE/UPDATE/DELETE mutations for this
   * model via the `commit` wire protocol. Default: false.
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

  /**
   * Fields to back-fill from the sync client identity when missing
   * during IndexedDB self-healing.
   *
   * Healing runs on every row loaded from IDB at hydration time and on
   * every delta merge. If the row is missing one of these fields, the
   * engine writes the corresponding identity value (`organizationId` /
   * `userId` from `SyncClient.initialize`) into the row before passing
   * it to the ObjectPool. Without this, rows from a past version that
   * didn't write the field would surface as `undefined` and break any
   * code that assumes the field is set.
   *
   * @example
   * autoFill: [
   *   { field: 'organizationId', from: 'organizationId' },
   *   { field: 'createdBy', from: 'userId' },
   * ]
   */
  autoFill?: readonly AutoFillRule[];

  /**
   * Fields whose absence makes a stored row "orphaned" — corrupt
   * enough that the engine should drop it instead of loading it.
   *
   * Healing returns `null` for the row when any listed field is
   * missing, which causes the caller to skip pool insertion for that
   * record. Use for foreign keys whose absence would crash dependent
   * code (e.g. a `SlideLayer` with no `slideId` can't render anywhere).
   *
   * @example requiredFields: ['slideId']
   */
  requiredFields?: readonly string[];
}

/** Base type for computed getter records. Preserves return types via inference. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ComputedRecord = Record<string, (self: any) => any>;

/**
 * Identity sources the sync engine can pull from when auto-filling a
 * record's missing field during IndexedDB self-healing.
 *
 * - `'organizationId'` — the org id passed to `SyncClient.initialize`
 * - `'userId'` — the user id passed to `SyncClient.initialize`
 */
export type AutoFillSource = 'organizationId' | 'userId';

/**
 * Declaration of a field that should be back-filled from the connected
 * sync identity if missing from a stored row.
 *
 * Used by `SyncClient.healModelRecord` to repair pre-existing IDB rows
 * that were written without `organizationId` / `createdBy` due to past
 * bugs in delta merging. Declared per-model so the engine itself stays
 * product-neutral.
 */
export interface AutoFillRule {
  /** Field name on the model (e.g. `'organizationId'`, `'createdBy'`). */
  field: string;
  /** Where to read the replacement value from on the sync client. */
  from: AutoFillSource;
}

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
  /** Canonical tenancy descriptor — the single source of truth, normalized from
   *  the `orgScoped`/`scopedVia`/`orgColumn` authoring sugar at build. */
  readonly tenancy: Tenancy;
  /** Database plane — `tenant` (default) is portable to a customer DB; `control`
   *  is Ablo-only. See {@link ModelOptions.plane} and `./plane.ts`. */
  readonly plane?: SchemaPlane;
  /** Scope-root marker. See {@link ModelOptions.scope}. */
  readonly scope?: boolean | string;
  /** Membership edge granting identity → scope-root access. See {@link ModelOptions.grants}. */
  readonly grants?: GrantsRef;
  /** Explicit non-relational record→group roles (normalized to an array). See {@link ModelOptions.entityRoles}. */
  readonly entityRoles?: readonly EntityRole[];
  /** Whether wire-level CREATE/UPDATE/DELETE is allowed. See {@link ModelOptions.mutable}. */
  readonly mutable?: boolean;
  /** Defer MobX setup until first observer access. See {@link ModelOptions.lazyObservable}. */
  readonly lazyObservable?: boolean;
  /** Computed getters for the dynamic model class. See {@link ModelOptions.computed}. */
  readonly computed?: C;
  /** Auto-fill rules for IDB self-healing. See {@link ModelOptions.autoFill}. */
  readonly autoFill?: readonly AutoFillRule[];
  /** Fields whose absence orphans a row. See {@link ModelOptions.requiredFields}. */
  readonly requiredFields?: readonly string[];
}

// ── Model factory ─────────────────────────────────────────────────────────

/**
 * Define a model with a Zod shape and optional relations.
 *
 * ```ts
 * import { z } from 'zod';
 * import { model, relation } from '@abloatai/ablo/schema';
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
    const meta = getFieldMeta(zodType as z.ZodType);
    if (meta) {
      fields[name] = meta;
    } else {
      fields[name] = inferFieldMetaFromZod(zodType as z.ZodType);
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
    // Normalize all tenancy authoring sugar into the one canonical descriptor.
    tenancy: resolveTenancy({
      tenancy: options?.tenancy,
      orgScoped: options?.orgScoped,
      scopedVia: options?.scopedVia,
      orgColumn: options?.orgColumn,
    }),
    plane: options?.plane ?? DEFAULT_PLANE,
    scope: options?.scope,
    grants: options?.grants,
    entityRoles: normalizeEntityRoles(options?.entityRoles),
    mutable: options?.mutable,
    lazyObservable: options?.lazyObservable,
    computed: options?.computed,
    autoFill: options?.autoFill,
    requiredFields: options?.requiredFields,
  };
}

/**
 * The sync-group kind a scope-root model mints, or `undefined` when the model
 * isn't a scope root. `scope: true` derives the kind from the lowercased
 * typename (`SlideDeck` → `slidedeck`); `scope: 'deck'` sets it explicitly
 * (the form to use when the wire kind must differ from the typename). One place
 * so the commit path, the membership resolver, and the participant join-side
 * all agree on what a record's own group is.
 */
export function scopeKindOf(
  def: { scope?: boolean | string; typename?: string },
  fallbackKey: string,
): string | undefined {
  if (!def.scope) return undefined;
  return (typeof def.scope === 'string' ? def.scope : (def.typename ?? fallbackKey)).toLowerCase();
}
