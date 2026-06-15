/**
 * Claim-first shorthand for `model(...)` — the Modal-inspired DX layer.
 *
 * The factory verbs encode the two orthogonal axes that matter for
 * safety and bootstrap behavior:
 *
 *   - **Writability** (axis 1): `mutable.*` means clients may send
 *     CREATE/UPDATE/DELETE over the `commit` wire protocol.
 *     `readOnly.*` means the model is server-managed — deltas stream
 *     to clients but clients cannot mutate.
 *   - **Load strategy** (axis 2): `.instant` loads at bootstrap,
 *     `.lazy` loads on first access, `.manual` requires explicit
 *     queries.
 *
 * The two-token form (`mutable.lazy({...})`) reads the safety claim
 * in the first token and the load shape in the second — you know both
 * key facts about the entity before scanning its fields.
 *
 * This is additive: the original `model(...)` factory keeps working.
 * New entities should prefer the verbs; existing entities can migrate
 * entity-by-entity.
 *
 * Example:
 * ```ts
 * // Before — 7 options to read before the fields make sense
 * tasks: model({ title: z.string() }, { ... }, {
 *   typename: 'Task', tableName: 'tasks', mutable: true,
 *   load: 'lazy', lazyObservable: true, computed: tasksComputed,
 * }),
 *
 * // After — claim reads off the verb; options carry only the
 * // fields that actually diverge from defaults
 * tasks: mutable.lazy({ title: z.string() }, {
 *   typename: 'Task', tableName: 'tasks',
 *   relations: { ... },
 *   computed: tasksComputed,
 * }),
 * ```
 */

import type { z } from 'zod';
import {
  model,
  type ModelDef,
  type ModelOptions,
  type ComputedRecord,
  type RelationRecord,
} from './model.js';

/**
 * Options accepted by every sugar verb. A strict subset of
 * {@link ModelOptions} — anything the verb infers (`mutable`, `load`,
 * `lazyObservable`) is deliberately absent so the call site can't
 * contradict its verb.
 */
export interface SugarOptions<
  R extends RelationRecord = RelationRecord,
  C extends ComputedRecord = ComputedRecord,
> {
  /** Relations to other models. Same shape as `model()`'s second arg. */
  relations?: R;
  /** Computed getters installed on the model class prototype. */
  computed?: C;
  /**
   * Wire `__typename` (PascalCase, e.g. `'Task'`). Defaults to the schema
   * key via `defineSchema` — override when the wire shape differs from
   * the camelCase schema key.
   */
  typename?: string;
  /**
   * Actual Postgres table name. Override when Prisma's `@@map` diverges
   * from the naive snake_case of the typename (e.g. `Member` maps to
   * `'member'` singular, not `'members'`).
   */
  tableName?: string;
  /**
   * Whether the table has an `organization_id` column. Default: `true`.
   * Set `false` for system-scoped tables (subscriptions, teams, etc.).
   */
  orgScoped?: boolean;
  /**
   * Scope rows via a parent table when this table has no
   * `organization_id` column. See {@link ModelOptions.scopedVia}.
   */
  scopedVia?: ModelOptions['scopedVia'];
  /**
   * Override the row-local tenancy column name. See
   * {@link ModelOptions.orgColumn}.
   */
  orgColumn?: ModelOptions['orgColumn'];
  /** Canonical tenancy descriptor. See {@link ModelOptions.tenancy}. */
  tenancy?: ModelOptions['tenancy'];
  /**
   * Mark this model a scope root — its records form the group `<kind>:<id>`
   * (kind defaults from typename). See {@link ModelOptions.scope}.
   */
  scope?: ModelOptions['scope'];
  /**
   * Membership edge granting identity → scope-root access. Both fields are
   * relation names on this model. See {@link ModelOptions.grants}.
   */
  grants?: ModelOptions['grants'];
  /**
   * Explicit non-relational record→group roles (e.g. inbox fan-out keyed on a
   * field). See {@link ModelOptions.entityRoles}.
   */
  entityRoles?: ModelOptions['entityRoles'];
  /** Max rows loaded during bootstrap. Only applies to `.instant`. */
  bootstrapLimit?: number;
  /** Bootstrap sort order (e.g. `'created_at DESC'`). */
  bootstrapOrderBy?: string;
  /** IndexedDB persistence hints — see {@link ModelOptions.persist}. */
  persist?: ModelOptions['persist'];
  /**
   * Defer MobX observability to first access. Override the verb's
   * default when a `.lazy` model is small enough that eager MobX setup
   * is fine, or a `.instant` model is hot enough to justify deferral.
   */
  lazyObservable?: boolean;
}

/** Internal helper — builds a ModelDef with baseline safety+load flags applied. */
function build<
  Shape extends z.ZodRawShape,
  R extends RelationRecord,
  C extends ComputedRecord,
>(
  shape: Shape,
  opts: SugarOptions<R, C> | undefined,
  baseline: Pick<ModelOptions, 'mutable' | 'load' | 'lazyObservable'>,
): ModelDef<Shape, R, C> {
  return model(shape, (opts?.relations ?? {}) as R, {
    mutable: baseline.mutable,
    load: baseline.load,
    lazyObservable: opts?.lazyObservable ?? baseline.lazyObservable,
    typename: opts?.typename,
    tableName: opts?.tableName,
    orgScoped: opts?.orgScoped,
    scopedVia: opts?.scopedVia,
    orgColumn: opts?.orgColumn,
    tenancy: opts?.tenancy,
    scope: opts?.scope,
    grants: opts?.grants,
    entityRoles: opts?.entityRoles,
    bootstrapLimit: opts?.bootstrapLimit,
    bootstrapOrderBy: opts?.bootstrapOrderBy,
    persist: opts?.persist,
    computed: opts?.computed,
  });
}

/**
 * Client-writable entities. `mutable.*` is the opt-in signal for wire
 * mutations via `commit` — equivalent to setting
 * `{ mutable: true, load: X }` on `model()`.
 *
 * Pick the load suffix by data-access pattern:
 *   - `.instant`  — small, always-needed (Theme, Layout, StatusGroup)
 *   - `.lazy`     — large collections fetched on first query
 *     (SlideLayer, Message, Task)
 *   - `.manual`   — never auto-loaded; explicit queries only
 */
export const mutable = {
  instant: <
    Shape extends z.ZodRawShape,
    R extends RelationRecord = Record<string, never>,
    C extends ComputedRecord = Record<string, never>,
  >(
    shape: Shape,
    opts?: SugarOptions<R, C>,
  ): ModelDef<Shape, R, C> =>
    build(shape, opts, { mutable: true, load: 'instant', lazyObservable: false }),

  lazy: <
    Shape extends z.ZodRawShape,
    R extends RelationRecord = Record<string, never>,
    C extends ComputedRecord = Record<string, never>,
  >(
    shape: Shape,
    opts?: SugarOptions<R, C>,
  ): ModelDef<Shape, R, C> =>
    build(shape, opts, { mutable: true, load: 'lazy', lazyObservable: true }),

  manual: <
    Shape extends z.ZodRawShape,
    R extends RelationRecord = Record<string, never>,
    C extends ComputedRecord = Record<string, never>,
  >(
    shape: Shape,
    opts?: SugarOptions<R, C>,
  ): ModelDef<Shape, R, C> =>
    build(shape, opts, { mutable: true, load: 'manual', lazyObservable: true }),
};

/**
 * Server-managed entities. `readOnly.*` means clients subscribe to
 * deltas but cannot emit mutations — any `commit` op for this model
 * is rejected at the server with "Unknown model."
 *
 * Use for:
 *   - Server-written state: `sync_deltas`, `presence`, version vectors
 *   - Ingestion pipelines: digest entries, filing jobs
 *   - Audit surfaces: anything where clients watch but only the server
 *     writes
 */
export const readOnly = {
  instant: <
    Shape extends z.ZodRawShape,
    R extends RelationRecord = Record<string, never>,
    C extends ComputedRecord = Record<string, never>,
  >(
    shape: Shape,
    opts?: SugarOptions<R, C>,
  ): ModelDef<Shape, R, C> =>
    build(shape, opts, { mutable: false, load: 'instant', lazyObservable: false }),

  lazy: <
    Shape extends z.ZodRawShape,
    R extends RelationRecord = Record<string, never>,
    C extends ComputedRecord = Record<string, never>,
  >(
    shape: Shape,
    opts?: SugarOptions<R, C>,
  ): ModelDef<Shape, R, C> =>
    build(shape, opts, { mutable: false, load: 'lazy', lazyObservable: true }),

  /**
   * Internal-only: never auto-loaded, never written by clients. The
   * strongest safety posture — use for tables the SDK must know about
   * (for type inference) but that should never flow over the wire.
   */
  internal: <
    Shape extends z.ZodRawShape,
    R extends RelationRecord = Record<string, never>,
    C extends ComputedRecord = Record<string, never>,
  >(
    shape: Shape,
    opts?: SugarOptions<R, C>,
  ): ModelDef<Shape, R, C> =>
    build(shape, opts, { mutable: false, load: 'manual', lazyObservable: true }),
};
