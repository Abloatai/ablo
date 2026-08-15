/**
 * Defines a model — one table's worth of fields, and one options object holding
 * everything else the engine needs to know about it. A model is a Zod object schema
 * paired with those options; the row type is inferred directly from Zod, with no
 * separate type system to keep in sync.
 *
 * Usage:
 *   import { z } from 'zod';
 *   import { model, relation } from '@abloatai/transaction/schema';
 *
 *   const items = model({
 *     title: z.string(),
 *     status: z.enum(['todo', 'doing', 'done']).default('todo'),
 *     projectId: z.string().optional(),
 *   }, {
 *     relations: { project: relation.belongsTo('projects', 'projectId') },
 *     load: 'lazy',
 *   });
 */

import { z } from 'zod';
import type { RelationDef } from './relation.js';
import type { EntityRole, GroupsInput } from './roles.js';
import { getFieldMeta, inferFieldMetaFromZod, type FieldMeta } from './field.js';
// Tenancy lives in `tenancy.ts`. Authoring uses the `policy` option
// (`PolicyInput`), which `resolvePolicy` normalizes into the canonical `Tenancy`
// at build time.
import { resolvePolicy, type Tenancy, type ScopedViaRef, type PolicyInput } from './tenancy.js';
export type { ScopedViaRef, Tenancy, PolicyInput } from './tenancy.js';
import { DEFAULT_RESIDENCY, type ModelResidency } from './residency.js';
// The write-conflict disposition. It is plain data (the `onStale` vocabulary) so it
// round-trips through schema serialization, and the engine interprets it when a
// commit is applied.
import type { ConflictAxis } from '../policy/types.js';
export type { ConflictAxis } from '../policy/types.js';

/** Normalize the `entityRoles` option (single | array | undefined) to an array. */
function normalizeEntityRoles(
  input: EntityRole | readonly EntityRole[] | undefined,
): readonly EntityRole[] | undefined {
  if (!input) return undefined;
  return Array.isArray(input) ? input : [input as EntityRole];
}

// ── Load strategies ───────────────────────────────────────────────────────

// Defined in `./loadStrategy.ts`. Imported as well as re-exported: a bare
// `export … from` would not bind the name for the `load` fields below.
import { LoadStrategy, DEFAULT_LOAD_STRATEGY } from './loadStrategy.js';
export { LoadStrategy, DEFAULT_LOAD_STRATEGY, loadsAtBootstrap } from './loadStrategy.js';

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
  /** Relation name pointing at the scope-root entity (e.g. `'workspace'`). */
  scope: string;
}

/** Options for model() */
export interface ModelOptions {
  /**
   * Edges from this model to others, keyed by the accessor name they create. The
   * engine reads them to index foreign keys, to order inserts so a parent row lands
   * before the rows referencing it, and to generate the accessors that let you read
   * `item.project` or `project.items` directly. Built with the {@link relation}
   * factories.
   *
   * ```ts
   * relations: {
   *   project: relation.belongsTo('projects', 'projectId'),
   *   comments: relation.hasMany('comments', 'itemId'),
   * }
   * ```
   */
  relations?: RelationRecord;
  /** When to load this model's data. Default: 'instant' */
  load?: LoadStrategy;
  /** Max records to bootstrap. Default: unlimited. Only applies to 'instant' strategy. */
  bootstrapLimit?: number;
  /** Order to sort by during bootstrap (e.g., 'created_at DESC'). */
  bootstrapOrderBy?: string;
  /**
   * The wire type name for this model — the value that identifies its rows on the
   * wire (the `__typename`). The loader stamps it onto incoming rows and uses it to
   * find the matching model class. It defaults to the schema key (`items` →
   * `'items'`); set it explicitly when the wire shape uses different casing, such as
   * schema key `block` mapping to typename `'Block'`.
   *
   * This is the one value that identifies the model on the wire; the client-side
   * store name, query result references, and delta routing all resolve through it.
   */
  typename?: string;
  /**
   * IndexedDB persistence hints. See {@link PersistOptions}.
   */
  persist?: PersistOptions;
  /**
   * The database table this model maps to. Defaults to the snake_case form of the
   * model name. Set it when the real table name does not follow that convention, so
   * queries read from the right table instead of a guessed name.
   */
  tableName?: string;

  /**
   * Row-access policy — decides which rows a tenant may read at all. A discriminated
   * union on `by`:
   *
   * - `{ by: 'column' }` — the row carries its own tenancy column (the default when
   *   omitted). `column` overrides the column name, which defaults to
   *   `organization_id`.
   * - `{ by: 'parent', fk, parent }` — inherit tenancy through a foreign key when the
   *   table has no tenancy column of its own (for example `blocks` → section →
   *   report → organization). In place of `organization_id = $1` the read emits
   *   `WHERE <table>.<fk> IN (SELECT <parentKey> FROM <parent> WHERE
   *   <parentTenantColumn> = $1)`. Use it for any `load: 'instant'` child table that
   *   would otherwise expose other tenants' rows at bootstrap.
   * - `{ by: 'none' }` — genuinely global or reference data, such as a lookup table.
   *   This makes the whole table readable across tenants, so it is only correct for
   *   tables that have no tenant at all. It is a named branch rather than a falsy
   *   flag, so it cannot be selected by accident.
   *
   * {@link resolvePolicy} normalizes this into the canonical {@link Tenancy} when the
   * model is built.
   */
  policy?: PolicyInput;

  /**
   * Which database a model's rows live in. `tenant` (the default) is tenant data
   * that provisioning places in the customer's own database; `control` is Ablo's own
   * data — the sync log, attribution, and audit records — which never leaves Ablo's
   * database. See {@link ModelResidency}.
   */
  plane?: ModelResidency;

  /**
   * Sync-group routing — decides which delta channels a row fans out to. This is
   * independent of {@link policy}, which governs read access. One object with three
   * optional parts:
   *
   * - `root` — marks this model a scope root, so each of its records forms the group
   *   `<kind>:<id>`. The kind defaults to the lowercased typename (`Report` →
   *   `report:<id>`); pass a string to override it (`root: 'matter'`). Child models
   *   inherit a root's group through their `belongsTo` relations.
   * - `grants` — a membership edge that grants an identity access to a scope root.
   *   Both values name `belongsTo` relations on this model (`subject` names the
   *   identity, `scope` names the scope root). Use it only for sharing within an
   *   organization.
   * - `roles` — explicit record-to-group roles keyed on a plain field, for routing
   *   that does not follow a relation, such as fanning a message into a recipient's
   *   inbox. Accepts one role or many.
   *
   * ```ts
   * // archiveMember: { userId, archiveId }
   * groups: { grants: { subject: 'user', scope: 'workspace' } }
   * // a message → its addressee's inbox, keyed on `toId`
   * groups: { roles: [entityRole({ kind: 'inbox', source: 'toId' })] }
   * ```
   */
  groups?: GroupsInput;

  /**
   * Write-conflict disposition, set per committer kind — decides what happens when a
   * commit collides with another participant's claim or with a stale snapshot of this
   * model. This is independent of {@link policy} (read access) and {@link groups}
   * (delta routing). It is a map keyed by the committer's kind (`user`, `agent`, or
   * `system`), with these outcomes as values:
   *
   * - `'overwrite'` — the write wins; that committer is never blocked.
   * - `'reject'`    — the write is refused; that committer yields.
   * - `'notify'`    — hold the write and hand the current value back so the committer
   *                   re-reads and re-applies (for stale writes only).
   *
   * A kind you omit falls back to the engine default: reject, while honoring
   * `onStale: 'notify'`. The value is plain data that travels with the schema to the
   * server, where the engine interprets it. For example:
   *
   * ```ts
   * // "a human's edit always wins (never blocked); an agent yields"
   * conflict: { user: 'overwrite', agent: 'reject' }
   * ```
   */
  conflict?: ConflictAxis;

  /**
   * Whether clients may create, update, and delete this model's rows through the
   * commit protocol. Defaults to true: declaring a model in your schema is the
   * opt-in, since a synced entity is almost always one you want to write. A model
   * left out of the mutation allowlist rejects writes with
   * `server_execute_unknown_model`.
   *
   * Set `mutable: false` (or use the `readOnly.*` shorthand, which sets it for you)
   * for server-managed projections such as stats, digests, or audit views, so those
   * cannot be written from a client. The server derives its mutation allowlist from
   * this flag; there is no separate hardcoded list to keep in step.
   */
  mutable?: boolean;

  /**
   * Defer setting up MobX observability until the model is first accessed by an
   * observing component. Defaults to false, which observes immediately.
   *
   * Use it for models created in bulk — during an import or a batch bootstrap —
   * where most instances are never rendered. The constructor skips the observability
   * setup, and calling `model.makeObservable()` performs it later when the model
   * enters the render tree. This avoids roughly 10ms of setup per instance when
   * creating hundreds of models that are never observed.
   */
  lazyObservable?: boolean;

  /**
   * Computed getters to install on the model instance. Each key becomes a getter;
   * its function receives the model instance as `self` and returns the computed
   * value.
   *
   * @example
   * model({ title: z.string(), metadata: z.string() }, {
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
   * Fields to back-fill from the connected sync identity when a stored row is missing
   * them, during self-healing of the local store.
   *
   * Healing runs on every row loaded from the local store at hydration and on every
   * delta merge. When a row is missing one of these fields, the engine writes the
   * matching identity value (the `organizationId` or `userId` passed to the sync
   * client) into the row before it is loaded. Without this, rows written by an older
   * version that did not set the field would read as `undefined` and break code that
   * assumes it is present.
   *
   * @example
   * autoFill: [
   *   { field: 'organizationId', from: 'organizationId' },
   *   { field: 'createdBy', from: 'userId' },
   * ]
   */
  autoFill?: readonly AutoFillRule[];

  /**
   * Fields whose absence marks a stored row as orphaned — corrupt enough that the
   * engine drops it instead of loading it.
   *
   * During self-healing, a row missing any listed field is discarded rather than
   * loaded. Use it for foreign keys whose absence would crash code that depends on
   * them — for example a child row that cannot be placed without its parent's id.
   *
   * @example requiredFields: ['sectionId']
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
 * Declares one field to back-fill from the connected sync identity when it is
 * missing from a stored row. The engine repairs rows during self-healing — for
 * example rows written by an older version without an `organizationId` or
 * `createdBy`. Declared per model, so the engine stays product-neutral.
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
   * The wire type name (`__typename`) for this model. When left unset in
   * {@link ModelOptions}, it falls back to the schema key when the schema is
   * assembled. See {@link ModelOptions.typename}.
   */
  readonly typename?: string;
  /** IndexedDB persistence hints. See {@link PersistOptions}. */
  readonly persist?: PersistOptions;
  /** The database table this model maps to. See {@link ModelOptions.tableName}. */
  readonly tableName?: string;
  /** The canonical tenancy descriptor for this model, normalized from the `policy`
   *  option at build time. See {@link ModelOptions.policy}. */
  readonly tenancy: Tenancy;
  /** Which database this model's rows live in — `tenant` (default) can be a
   *  customer's own database; `control` is Ablo's. See {@link ModelOptions.plane}. */
  readonly plane?: ModelResidency;
  /** Scope-root marker. See {@link ModelOptions.groups}. */
  readonly scope?: boolean | string;
  /** Membership edge granting an identity access to a scope root. See {@link ModelOptions.groups}. */
  readonly grants?: GrantsRef;
  /** Explicit record-to-group roles, normalized to an array. See {@link ModelOptions.groups}. */
  readonly entityRoles?: readonly EntityRole[];
  /** The write-conflict disposition per committer kind, carried as plain data. See
   *  {@link ModelOptions.conflict}. */
  readonly conflict?: ConflictAxis;
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
 * Defines a model from a Zod shape and its options. The row type is inferred from
 * the shape; fields built with the {@link field} builders carry extra metadata,
 * while plain Zod fields get metadata inferred from their Zod type. Everything else
 * about the model — its {@link ModelOptions.relations}, its {@link LoadStrategy},
 * the table it maps to — lives in the second argument, so a model that needs one
 * setting never has to name the settings it does not use.
 *
 * ```ts
 * import { z } from 'zod';
 * import { model, relation } from '@abloatai/transaction/schema';
 *
 * // Fields alone
 * const tags = model({ label: z.string() });
 *
 * // Loaded at bootstrap (the default), with an edge to its project
 * const items = model({
 *   title: z.string(),
 *   status: z.enum(['todo', 'doing', 'done']).default('todo'),
 *   projectId: z.string().optional(),
 * }, {
 *   relations: { project: relation.belongsTo('projects', 'projectId') },
 * });
 *
 * // Loaded on first access
 * const blocks = model({ sectionId: z.string(), type: z.string() }, {
 *   relations: { section: relation.belongsTo('sections', 'sectionId') },
 *   load: 'lazy',
 * });
 * ```
 */
export function model<
  Shape extends z.ZodRawShape,
  R extends RelationRecord = Record<string, never>,
  C extends ComputedRecord = Record<string, never>,
>(
  shape: Shape,
  options?: ModelOptions & { relations?: R; computed?: C }
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
    relations: (options?.relations ?? {}) as R,
    load: options?.load ?? DEFAULT_LOAD_STRATEGY,
    bootstrapLimit: options?.bootstrapLimit,
    bootstrapOrderBy: options?.bootstrapOrderBy,
    typename: options?.typename,
    persist: options?.persist,
    tableName: options?.tableName,
    // Normalize the `policy` option into the canonical tenancy descriptor (defaults
    // to a row-local organization column).
    tenancy: resolvePolicy(options?.policy),
    plane: options?.plane ?? DEFAULT_RESIDENCY,
    // Unpack the `groups` option into the individual routing fields the server reads.
    scope: options?.groups?.root,
    grants: options?.groups?.grants,
    entityRoles: normalizeEntityRoles(options?.groups?.roles),
    // The conflict disposition is already plain data, so it passes through unchanged.
    conflict: options?.conflict,
    mutable: options?.mutable ?? true,
    lazyObservable: options?.lazyObservable,
    computed: options?.computed,
    autoFill: options?.autoFill,
    requiredFields: options?.requiredFields,
  };
}

/**
 * Returns the sync-group kind a scope-root model produces, or `undefined` when the
 * model is not a scope root. `scope: true` derives the kind from the lowercased
 * typename (`ReportSection` → `reportsection`); `scope: 'section'` sets it explicitly, which
 * you use when the wire kind must differ from the typename. This is the single place
 * that decides a record's own group, so every layer that reads it agrees.
 */
export function scopeKindOf(
  def: { scope?: boolean | string; typename?: string },
  fallbackKey: string,
): string | undefined {
  if (!def.scope) return undefined;
  return (typeof def.scope === 'string' ? def.scope : (def.typename ?? fallbackKey)).toLowerCase();
}
