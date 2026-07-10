/**
 * Declarative relations between your models — the edges that turn a flat set
 * of models into a graph. You attach relations to a model with the
 * {@link relation} factories; the engine reads them to index foreign keys for
 * fast child lookups, to order inserts so a parent row lands before the rows
 * that reference it, and to generate the accessor properties that let you read
 * `task.project` or `project.tasks` directly.
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
 * Options for `relation.belongsTo`. Each defaults to `false`, so every
 * behavior below is opt-in per relation.
 *
 * `index: true` registers a foreign-key index for the child model when the
 * engine starts, turning "every child that points at this parent" from a full
 * scan into a constant-time lookup. Reach for it on relations you query this
 * way often, such as a slide layer's `slideId`.
 *
 * `enrich: true` auto-populates the parent reference on an incoming change
 * before the child data lands. A change to `Task { teamId: 't1' }` picks up the
 * already-loaded `teams:t1` record and attaches it as `data.team`, so you can
 * read `task.team` without a second lookup. Enrichment is best-effort: if the
 * parent has not loaded yet it quietly does nothing, and the child data still
 * applies.
 *
 * `defer: true` tells the engine to ignore this edge when it works out the
 * order in which to insert rows. Use it on the soft side of a genuine reference
 * cycle — the side where you are willing to insert the child first with the
 * foreign key left null and fill it in with a later update. The other side of
 * the cycle then becomes a strict predecessor, so the child is ordered after
 * the parent rather than tied with it.
 *
 * `defer` changes only that ordering, not what the engine sends on the wire; it
 * does not rewrite an insert into an insert-then-update. Pair it with a Postgres
 * `DEFERRABLE INITIALLY DEFERRED` constraint when you also want the database to
 * relax the foreign-key check itself. For example:
 *
 *   ```ts
 *   layouts: model({ deckId: z.string().nullish() }, {
 *     // The deck-owns-layout link is nullable and the layout is always
 *     // created first; marking it `defer` lets the deck commit ahead of the
 *     // layout instead of sharing its insert-order slot.
 *     deck: relation.belongsTo('slideDecks', 'deckId', { defer: true }),
 *   }),
 *   ```
 */
export interface BelongsToOptions {
  readonly index?: boolean;
  readonly enrich?: boolean;
  readonly defer?: boolean;
  /**
   * Marks the relation's target as this record's parent: the entity the record
   * lives inside and inherits its access scope from. When a record is written,
   * the engine routes it into its parent's sync group — following a chain of
   * `parent` edges all the way up — so the change reaches everyone subscribed to
   * the owning entity. This is the familiar rule that access flows down from a
   * container to the things it holds, as a folder does to its files.
   *
   * Do not set `parent` on a reference that merely points at another record for
   * provenance or as a template, such as `sourceSlideId` or `templateId`; doing
   * so would leak the record into an unrelated scope. The engine also cannot
   * infer the parent from whether a field is optional — many real parent keys
   * are optional, like a root folder or an inbox task — so you must declare the
   * parent edge explicitly.
   *
   * It reads naturally at the call site:
   * `belongsTo('deck', 'deckId', { parent: true })` — the deck is the parent.
   */
  readonly parent?: boolean;

  /**
   * Emit a real Postgres foreign-key constraint for this relation when the
   * engine provisions tables in a customer-owned database. This is independent
   * of `parent`: `parent` decides which subscribers a change reaches, while
   * `fk` decides whether the database enforces referential integrity. A relation
   * may set either, both, or neither.
   *
   * Set `fk: true` only when the target row lives in the same database and is
   * written in the same commit as this row, and points at a strong, contained
   * entity. Leave it off provenance or template pointers (`sourceSlideId`,
   * `templateId`), cross-tenant references, or anything that may be written in a
   * different transaction than its target — a hard constraint there would reject
   * the write and break out-of-order sync. The constraint is emitted as
   * `DEFERRABLE INITIALLY DEFERRED, ON DELETE NO ACTION`: a plain integrity
   * guard, leaving any cascade or null-on-delete behavior to the application.
   */
  readonly fk?: boolean;
}

// ── Relation type brands ──────────────────────────────────────────────────

declare const __relationType: unique symbol;
declare const __relationTarget: unique symbol;
declare const __relationField: unique symbol;

export type RelationType = 'belongsTo' | 'hasMany' | 'hasOne';

/**
 * A relation definition, carrying its type information at both the type and
 * runtime level.
 *
 * The `Options` generic captures a relation's options in the type system; only
 * `belongsTo` uses it, while `hasMany` and `hasOne` leave it empty. The `const`
 * modifier on the `belongsTo` factory preserves literal inference, so
 * `{ enrich: true }` is remembered as `true` rather than widened to `boolean`,
 * letting type-level features read the exact option value.
 *
 * `options` is always present at runtime: the factory substitutes an empty
 * object when you omit it, so reading `options.index` or `options.enrich` needs
 * no null check.
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
   * The field on the child model that holds the parent's id, as a camelCase
   * schema field name. The engine reads `model[foreignKey]` to resolve the
   * relation and to build client-side index keys; it is never interpolated into
   * raw SQL — that is what {@link foreignKeyColumn} is for.
   */
  readonly foreignKey: Field;
  /**
   * The same foreign key expressed as a database column identifier.
   * {@link foreignKey} is translated into this when you configure a `casing`
   * option on `defineSchema` — for example `'snake_case'` turns `messageId`
   * into `message_id`. The server interpolates this column name into SQL
   * directly, because a driver's automatic camelCase-to-snake_case mapping does
   * not reach identifiers embedded in raw SQL; resolving the name once at
   * schema-build time is what makes it available there.
   *
   * Defaults to {@link foreignKey} when no `casing` option is set, so consumers
   * whose database columns already match their field names need no
   * configuration.
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
   * This model has many of another model — for example, a project has many
   * tasks via `Task.projectId`.
   *
   * At runtime the engine adds a getter to the parent model that returns every
   * child whose foreign key matches, and registers the foreign-key index on the
   * child model automatically.
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
   * This model has one of another model — for example, a user has one profile
   * via `Profile.userId`.
   */
  hasOne<Target extends string, Field extends string>(
    target: Target,
    foreignKey: Field
  ): RelationDef<'hasOne', Target, Field> {
    return new RelationBuilder('hasOne', target, foreignKey);
  },
} as const;
