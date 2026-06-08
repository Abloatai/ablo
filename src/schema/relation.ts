/**
 * Schema Relation Definitions
 *
 * Declarative relations between models. Used for:
 * - FK index registration (ObjectPool.registerForeignKey)
 * - Model create priority derivation (parents before children)
 * - Query include/join support
 *
 * Usage:
 *   import { relation } from '@abloatai/ablo/schema';
 *
 *   const taskRelations = {
 *     project: relation.belongsTo('projects', 'projectId'),
 *     assignee: relation.belongsTo('users', 'assigneeId'),
 *     comments: relation.hasMany('comments', 'taskId'),
 *   };
 */

// ── Relation options ──────────────────────────────────────────────────────

/**
 * Options for `relation.belongsTo(...)`. All default to `false` — behavior
 * is opt-in per relation.
 *
 * When `index: true`, the sync engine registers an O(1) foreign-key index
 * on the child model's ObjectPool entry at construction time, so that
 * `pool.getByForeignKey(childType, foreignKey, parentId)` becomes constant-
 * time instead of a full scan. Use on hot paths like `SlideLayer.slideId`
 * where you frequently want "all layers for this slide."
 *
 * When `enrich: true`, incoming deltas for the child model have their
 * parent reference auto-populated from the ObjectPool before the model
 * data lands. I.e., a delta for `Task { teamId: 't1' }` picks up the
 * `teams:t1` entity from the pool and attaches it as `data.team`, so
 * consumers can read `task.team` directly without a second lookup.
 * If the parent isn't in the pool yet, enrichment silently no-ops
 * (the child data is still applied) — enrichment is best-effort.
 *
 * When `defer: true`, the FK-create-priority computer (Tarjan SCC in
 * `client/createSyncEngine.ts`) ignores this edge when building the
 * dependency graph. Use on the *soft* side of a real cycle to break it
 * deterministically — i.e. the side where you're willing to insert the
 * child first with the FK left null and patch it in a follow-up
 * UPDATE. The other side of the cycle then becomes a strict topological
 * predecessor, so the child gets a higher priority than the parent
 * instead of being tied with it.
 *
 * `defer` only affects priority computation, not what the engine sends
 * on the wire — it does NOT auto-rewrite an INSERT to (insert-null +
 * update-later). Pair with a Postgres `DEFERRABLE INITIALLY DEFERRED`
 * constraint when you actually want the FK check to be relaxed at the
 * database level. Example use case:
 *
 *   ```ts
 *   layouts: model({ deckId: z.string().nullish() }, {
 *     // The deck-owns-layout link is nullable AND the consumer always
 *     // creates the layout first; mark it `defer` so SlideDeck can
 *     // commit ahead of Layout instead of being trapped in the same
 *     // SCC priority bucket.
 *     deck: relation.belongsTo('slideDecks', 'deckId', { defer: true }),
 *   }),
 *   ```
 */
export interface BelongsToOptions {
  readonly index?: boolean;
  readonly enrich?: boolean;
  readonly defer?: boolean;
  /**
   * Marks the relation's target as this record's **parent** in the Zanzibar/
   * ReBAC sense — the entity it lives in, that scope inherits *from*. Sync-group
   * fan-out routes a record into its parent's group (directly, or transitively
   * up a chain of `parent` edges), so a write reaches everyone subscribed to the
   * owning entity — the same "access inherits from parent" rule OpenFGA/Zanzibar
   * and filesystems use.
   *
   * A reference (provenance/template pointer like `sourceSlideId`, `templateId`)
   * must NOT set this, or the record would leak into an unrelated scope.
   * Optionality is NOT a proxy — many parent FKs are optional (a root folder, an
   * inbox task) — so the parent edge must be declared, not inferred.
   *
   * Reads on the relation: `belongsTo('deck', 'deckId', { parent: true })` —
   * "the deck is the parent."
   */
  readonly parent?: boolean;

  /**
   * Emit a real Postgres FOREIGN KEY for this relation when provisioning a
   * customer-owned (BYO / dedicated) database. **Independent of `parent`:**
   * `parent` governs sync-group fan-out / visibility (control plane); `fk`
   * governs physical referential integrity (data plane). The two are orthogonal
   * — a relation may set either, both, or neither (mirrors Drizzle's
   * `relations()` vs `references()` split; Zanzibar's `parent` is permission-only
   * and "says nothing about data ownership or lifecycle").
   *
   * Set `fk: true` ONLY when the target row is co-located in the SAME database
   * AND written in the SAME commit as this row, and the reference is to a
   * strong / contained entity. Do NOT set it on provenance / template pointers
   * (`sourceSlideId`, `templateId`), cross-tenant refs, or anything that may be
   * written in a different transaction than its target — a hard FK there would
   * reject the write and break out-of-order sync. Emitted as `DEFERRABLE
   * INITIALLY DEFERRED, ON DELETE NO ACTION` — a pure integrity guard; cascade /
   * nullify is owned by the app-layer mutation pipeline, not the DB. See
   * `foreignKeyStatements` in `ddl.ts`.
   */
  readonly fk?: boolean;
}

// ── Relation type brands ──────────────────────────────────────────────────

declare const __relationType: unique symbol;
declare const __relationTarget: unique symbol;
declare const __relationField: unique symbol;

export type RelationType = 'belongsTo' | 'hasMany' | 'hasOne';

/**
 * A relation definition with embedded type information.
 *
 * The 4th generic `Options` captures per-relation options at the type
 * level (currently only `belongsTo` uses this — `hasMany`/`hasOne`
 * default to empty). The `const Opts` modifier on the `belongsTo`
 * factory preserves literal inference: `{ enrich: true }` narrows to
 * `true`, not `boolean`, so future type-level features (like
 * `InferModel` auto-adding enriched-parent properties) can read the
 * literal value off the relation def at compile time.
 *
 * `options` is always present at runtime — the factory assigns an
 * empty object when the caller omits it, which keeps
 * `relation.options.index` / `relation.options.enrich` safe to read
 * without a null guard downstream.
 */
export interface RelationDef<
  Type extends RelationType = RelationType,
  Target extends string = string,
  Field extends string = string,
  Options extends BelongsToOptions = BelongsToOptions,
> {
  readonly [__relationType]: Type;
  readonly [__relationTarget]: Target;
  readonly [__relationField]: Field;

  /** Runtime metadata */
  readonly type: Type;
  readonly target: Target;
  /**
   * The child model's JS field that holds the parent's id. Always the
   * camelCase schema field name — used by the client ObjectPool to read
   * `model[foreignKey]`, by `LazyReferenceCollection` for IndexedDB
   * index keys, and by `ModelRegistry` for cascade wiring. Never used
   * verbatim in raw SQL.
   */
  readonly foreignKey: Field;
  /**
   * The same foreign key expressed as a database column identifier. Set
   * by `defineSchema` when a `casing` option is configured (e.g.
   * `'snake_case'` produces `message_id` from `messageId`). Used by
   * server-side SQL compilers to interpolate the real column name into
   * queries — `postgres.camel`-style data-layer transforms do NOT rewrite
   * identifiers embedded in raw SQL, so the translation has to happen
   * somewhere, and schema-build time is the one-place-once answer.
   *
   * Defaults to {@link foreignKey} when `casing` is unset (identity) —
   * the SDK stays backward-compatible for consumers whose DB columns
   * already match their JS field names.
   */
  readonly foreignKeyColumn: string;
  readonly options: Options;
  /**
   * Optional sort field for `hasMany` relations. When set, the
   * generated relation getter sorts results by this field. Populated
   * by `relation.hasMany(target, fk, { orderBy: 'fieldName' })`.
   */
  readonly _orderBy?: string;
}

// ── Internal relation builder ─────────────────────────────────────────────

class RelationBuilder<
  Type extends RelationType,
  Target extends string,
  Field extends string,
  Options extends BelongsToOptions = BelongsToOptions,
> implements RelationDef<Type, Target, Field, Options>
{
  declare readonly [__relationType]: Type;
  declare readonly [__relationTarget]: Target;
  declare readonly [__relationField]: Field;

  readonly type: Type;
  readonly target: Target;
  readonly foreignKey: Field;
  /**
   * Starts out identical to {@link foreignKey}. `defineSchema` overwrites
   * this when a `casing` option is set — it's declared as a mutable
   * (non-readonly on the implementation side) so the schema builder can
   * resolve it once at build time without allocating a new object per
   * relation. Consumers see it typed as `readonly` on {@link RelationDef}.
   */
  foreignKeyColumn: string;
  readonly options: Options;
  /**
   * Stashed by `hasMany` when the caller provides `{ orderBy }`. Read
   * back in `createSyncEngine` to install the sort comparator on the
   * generated relation getter. Declared on the builder so both writer
   * and reader stay type-safe — no `as unknown as Record<...>` smuggle.
   */
  _orderBy?: string;

  constructor(type: Type, target: Target, foreignKey: Field, options?: Options) {
    this.type = type;
    this.target = target;
    this.foreignKey = foreignKey;
    this.foreignKeyColumn = foreignKey;
    this.options = (options ?? ({} as Options));
  }
}

// ── Public relation factories ─────────────────────────────────────────────

export const relation = {
  /**
   * This model belongs to another model via a foreign key.
   * e.g., Task belongs to Project via projectId
   *
   * ```ts
   * // Simple reference (no options)
   * project: relation.belongsTo('projects', 'projectId'),
   *
   * // Register an FK index for O(1) child lookups
   * slide: relation.belongsTo('slides', 'slideId', { index: true }),
   *
   * // Auto-populate the parent on delta arrival
   * team: relation.belongsTo('teams', 'teamId', { enrich: true }),
   *
   * // Both
   * parent: relation.belongsTo('threads', 'parentId', { index: true, enrich: true }),
   *
   * // Mark the soft side of a cycle so the priority computer breaks
   * // the cycle deterministically instead of tying the two models.
   * deck: relation.belongsTo('slideDecks', 'deckId', { defer: true }),
   * ```
   */
  belongsTo<
    Target extends string,
    Field extends string,
    const Opts extends BelongsToOptions = Record<string, never>,
  >(
    target: Target,
    foreignKey: Field,
    options?: Opts
  ): RelationDef<'belongsTo', Target, Field, Opts> {
    return new RelationBuilder('belongsTo', target, foreignKey, options ?? ({} as Opts));
  },

  /**
   * This model has many of another model.
   * e.g., Project has many Tasks (via Task.projectId)
   *
   * At runtime, generates a getter on the parent model that returns
   * all child models matching the FK via ObjectPool.getByForeignKey.
   * The FK index on the child model is auto-registered.
   *
   * ```ts
   * slides: relation.hasMany('slideLayers', 'slideId'),
   * // → deck.slides returns all SlideLayer[] where slideId === deck.id
   *
   * slides: relation.hasMany('slideLayers', 'slideId', { orderBy: 'zIndex' }),
   * // → deck.slides returns SlideLayer[] sorted by zIndex ascending
   * ```
   */
  hasMany<Target extends string, Field extends string>(
    target: Target,
    foreignKey: Field,
    options?: { orderBy?: string },
  ): RelationDef<'hasMany', Target, Field> {
    const builder = new RelationBuilder('hasMany', target, foreignKey);
    if (options?.orderBy) {
      builder._orderBy = options.orderBy;
    }
    return builder;
  },

  /**
   * This model has one of another model.
   * e.g., User has one Profile (via Profile.userId)
   */
  hasOne<Target extends string, Field extends string>(
    target: Target,
    foreignKey: Field
  ): RelationDef<'hasOne', Target, Field> {
    return new RelationBuilder('hasOne', target, foreignKey);
  },
} as const;
