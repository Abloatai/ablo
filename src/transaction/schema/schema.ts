/**
 * Schema Definition + Type Inference
 *
 * defineSchema() wraps your models. Types are inferred via Zod — no custom type system.
 *
 * Usage:
 *   import { z } from 'zod';
 *   import { defineSchema, model, relation } from '@abloatai/ablo/schema';
 *
 *   const schema = defineSchema({
 *     tasks: model({
 *       title: z.string(),
 *       status: z.enum(['todo', 'doing', 'done']).default('todo'),
 *       projectId: z.string().optional(),
 *     }, {
 *       project: relation.belongsTo('projects', 'projectId'),
 *     }),
 *   });
 *
 *   type Task = InferModel<typeof schema, 'tasks'>;
 */

import { z } from 'zod';
import type { ModelDef, RelationRecord } from './model.js';
import type { RelationDef } from './relation.js';
import { AbloValidationError } from '../errors.js';
import type { IdentityRole } from './roles.js';
import { scopeSchema, grantsRefSchema } from './roles.js';

// Sync-group roles (identity and entity) are defined in `./roles.js` and
// re-exported here so they can also be imported from this module. See
// `./roles.js` for the full vocabulary.
export {
  type IdentityRole,
  type IdentityRoleSource,
  type IdentityContext,
  type EntityRole,
  type EntityRoleSource,
  type EntityContext,
  type RoleSource,
  type RoleContext,
  type SyncGroup,
  type SyncGroupInput,
  identityRole,
  entityRole,
  extractIdentityIds,
  extractEntityIds,
  composeIdentitySyncGroups,
  composeEntitySyncGroups,
  intersectRequestedWithAllowed,
  syncGroup,
  syncGroupSchema,
  syncGroupInputSchema,
  isSyncGroupInput,
  identityRoleSchema,
  entityRoleSchema,
  roleSchema,
  roleSourceSchema,
  scopeSchema,
  grantsRefSchema,
  groupsInputSchema,
  type GroupsInput,
} from './roles.js';

// ── Casing resolution ─────────────────────────────────────────────────────
//
// Identifier translation, resolved once at schema-build time into
// `rel.foreignKeyColumn` — the database column name the server can interpolate
// into SQL directly, with no transform of its own.
//
// The function form lets consumers with mixed or legacy databases supply their
// own mapping. The string forms cover the two common cases: camelCase columns
// throughout, or snake_case columns paired with camelCase field names.

/** The set of built-in casing conventions supported by `defineSchema`. */
export type CasingConvention = 'snake_case' | 'camelCase';

/** Plug point for custom conventions (e.g. mixed legacy databases). */
export type CasingFn = (jsField: string) => string;

/** `defineSchema`'s casing option. Identity when unset. */
export type Casing = CasingConvention | CasingFn;

function resolveCasing(fn: Casing | undefined): CasingFn {
  if (fn === undefined) return (x) => x;
  if (typeof fn === 'function') return fn;
  switch (fn) {
    case 'snake_case':
      return camelToSnake;
    case 'camelCase':
      return (x) => x;
  }
}

/** Converts a camelCase identifier to snake_case. Kept local so the package
 * carries no database-driver dependency, and so consumers on any stack get the
 * same result. */
function camelToSnake(identifier: string): string {
  return identifier.replace(/[A-Z]/g, (ch) => `_${ch.toLowerCase()}`);
}

/**
 * A server-authored identity value that can fill one of a customer's Postgres
 * session settings. Deliberately a closed set — every member is resolved by Ablo
 * from the authenticated `ek_` and the plane, never from client-supplied data —
 * so a mapping can forward the tenant identity Ablo already trusts but can never
 * widen a writer's scope. Mirrors the fields the engine sets on the direct-write
 * connection (`app.current_org_id`, `app.current_project_id`, …).
 */
export type SessionSettingSource =
  | 'orgId'
  | 'projectId'
  | 'environment'
  | 'sandboxId'
  | 'participantId'
  | 'participantKind';

/**
 * A map from a Postgres session-setting name the customer's RLS policies read to
 * the Ablo identity that fills it — e.g. `{ 'app.current_org': 'orgId' }`. The
 * setting name is the key (it takes exactly one source), so a duplicate is
 * unrepresentable rather than validated away. See
 * {@link DefineSchemaOptions.sessionSettings} and ADR 0011.
 */
export type SessionSettings = Readonly<Record<string, SessionSettingSource>>;

/**
 * Session settings Ablo already sets on its direct-write connection. A
 * `sessionSettings` entry FORWARDS Ablo's trusted context into a setting the
 * customer's own policies read — it may never reassign one of these, which would
 * let a schema push relax the engine's own scoping, timeouts, or `row_security`.
 * Shared with the engine's direct-write seam so authoring-time validation and
 * the runtime guard read one list. See ADR 0011.
 */
export const RESERVED_SESSION_SETTINGS: readonly string[] = [
  'statement_timeout',
  'lock_timeout',
  'row_security',
  'search_path',
  'app.current_org_id',
  'app.current_project_id',
  'app.current_environment',
  'app.current_sandbox_id',
  'app.current_participant_id',
  'app.current_participant_kind',
  'app.current_user_id',
];

export interface DefineSchemaOptions {
  /**
   * How to translate camelCase JS field names into database column
   * identifiers. Applied once, at schema build, to every relation's
   * `foreignKey` to produce `foreignKeyColumn`. Consumers whose DB
   * columns already match their JS field names can omit this — the
   * default is identity (no transform).
   *
   * Accepts a named convention or a custom function:
   *
   * ```ts
   * defineSchema({ ... }, { casing: 'snake_case' })
   * defineSchema({ ... }, { casing: (key) => key.toUpperCase() })
   * ```
   */
  readonly casing?: Casing;

  /**
   * Identity-anchored sync-group roles. The server's
   * `composeIdentitySyncGroups` reads these to build the set of groups a
   * participant may subscribe to. See {@link IdentityRole} for the shape: you
   * define the `kind` and which identity field supplies the id, with no fixed
   * vocabulary of kinds.
   *
   * Leave this unset for schemas that need no identity-derived scoping, such as
   * fully public read models. When it is unset, `composeIdentitySyncGroups`
   * returns `[]` and callers fall back to whatever explicit sync groups the
   * authentication provider attached to the identity.
   */
  readonly identityRoles?: readonly IdentityRole[];

  /**
   * Extra Postgres session settings Ablo's direct-write connection applies from
   * your authenticated identity, so your row-level-security policies read them
   * (ADR 0011). Before every direct write, Ablo already `SET LOCAL`s a fixed
   * bundle (`app.current_org_id`, `app.current_project_id`, …). If your policies
   * read a differently-named setting your own app sets per-connection — e.g. a
   * restrictive policy on `current_setting('app.current_org')` — map that
   * setting to the identity that fills it, and Ablo sets it too:
   *
   * ```ts
   * defineSchema({ ... }, {
   *   sessionSettings: { 'app.current_org': 'orgId' },
   * })
   * ```
   *
   * The key is the setting name your policies read; the value is a closed set of
   * identities Ablo authenticates, so a mapping can narrow what the writer sees
   * but never widen it. Do NOT carve a policy exception for the writer role —
   * that exempts exactly the writes you want governed. Leave unset when your
   * policies read the settings Ablo already applies (or when a table has no RLS).
   */
  readonly sessionSettings?: SessionSettings;
}

// ── Schema definition ─────────────────────────────────────────────────────

/** A record of model names → model definitions */
export type SchemaRecord = Record<string, ModelDef>;

/**
 * Base fields every synced model gets automatically.
 *
 * Exported (internal) so `parseSchema` can rebuild a model's validator the
 * same way `defineSchema` does — `baseFieldsSchema.merge(modelSchema)` — when
 * reconstructing a `Schema` from its JSON form.
 */
export const baseFieldsSchema = z.object({
  id: z.string(),
  createdAt: z.date(),
  updatedAt: z.date(),
  organizationId: z.string().optional(),
  createdBy: z.string().optional(),
});

/**
 * The base-column names every model carries automatically — the keys of
 * {@link baseFieldsSchema}, kept here as the single source of truth. Code
 * generation reads it to avoid emitting a base column twice, and
 * {@link defineSchema} uses it to reject a model that redeclares one, since
 * merging the user's field over the base field would produce a `string & Date`
 * type and break the build.
 */
export const BASE_FIELDS = [
  'id',
  'createdAt',
  'updatedAt',
  'organizationId',
  'createdBy',
] as const;

/** The base fields type — pure data columns. */
export type BaseModelFields = z.infer<typeof baseFieldsSchema>;

/**
 * Methods every model instance carries. These are intersected into
 * {@link InferModel}, the read-side type, but not into the create or update
 * input types, since methods are not valid input.
 */
export interface BaseModelMethods {
  /** Wire-format model name (e.g. `'Section'`, `'Comment'`). */
  getModelName(): string;
  /** Plain-object serialization suitable for sending over the wire. */
  toJSON(): Record<string, unknown>;
}

/** The schema object returned by defineSchema() */
export interface Schema<S extends SchemaRecord = SchemaRecord> {
  /** The raw model definitions */
  readonly models: S;

  /** Zod schemas with base fields merged in */
  readonly validators: {
    readonly [K in keyof S]: S[K] extends ModelDef<infer Shape>
      ? z.ZodObject<Shape & typeof baseFieldsSchema.shape>
      : never;
  };

  /**
   * Identity-anchored sync-group roles registered via
   * `defineSchema({...}, { identityRoles })`. Empty array when unset.
   * Server's `composeIdentitySyncGroups(identity, schema)` reads this
   * to derive a participant's allowed sync-group set.
   */
  readonly identityRoles: readonly IdentityRole[];

  /**
   * Session settings registered via `defineSchema({...}, { sessionSettings })`
   * (ADR 0011). The engine's direct-write path reads this to `SET LOCAL` each
   * named setting from server-authored context before applying DML, so the
   * customer's RLS governs Ablo's writes. Empty object when unset.
   */
  readonly sessionSettings: SessionSettings;

  /**
   * Set only on a projection produced by `selectModels`/`omitModels`: the
   * content hash of the FULL source schema the subset was cut from. A subset
   * hashes differently from the full schema it belongs to, so a projection-bound
   * client would otherwise always report drift against a server running the full
   * schema. The drift check treats the client as in-sync when the server's active
   * hash matches EITHER this client's own (subset) hash or this source hash — so
   * a current projection stays quiet while a genuinely behind server still warns.
   * Absent on a schema authored directly, where the client's own hash is the
   * deployed hash and plain equality is correct. Excluded from `toSchemaJSON`, so
   * stamping it never perturbs `schemaHash`.
   */
  readonly sourceSchemaHash?: string;
}

// ── Type inference (powered by Zod) ───────────────────────────────────────

/**
 * Infer the full model type from a schema.
 * Includes base fields (id, createdAt, updatedAt, etc.)
 *
 * ```ts
 * type Task = InferModel<typeof schema, 'tasks'>;
 * ```
 */
/** The schema bound via `declare module … interface Register { Schema: … }`
 *  (the `ablo/register.ts` the scaffold writes). `never` when not registered. */
type RegisteredSchema = import('../types/global.js').Register extends {
  Schema: infer S extends Schema;
}
  ? S
  : never;

/**
 * The primary model-type helper. Once your project's `ablo/register.ts`
 * registers the schema, a single argument is all it takes:
 *
 * ```ts
 * type Task = Model<'tasks'>;
 * ```
 *
 * Without that registration, or for a second schema, pass the schema
 * explicitly: `Model<typeof schema, 'tasks'>`.
 */
export type Model<A, B = never> = [B] extends [never]
  ? A extends keyof RegisteredSchema['models']
    ? InferModel<RegisteredSchema, A>
    : never
  : A extends Schema
    ? InferModel<A, B extends keyof A['models'] ? B : never>
    : never;

/**
 * The row type {@link Model} resolves to. Internal: `Model<typeof schema,
 * 'tasks'>` is the published spelling, because it reads as the domain rather
 * than the machinery. This one is no longer exported from any subpath — it
 * stays because `Model` is defined in terms of it, not as a second name for
 * the same idea.
 */
export type InferModel<S extends Schema, ModelName extends keyof S['models']> =
  S['models'][ModelName] extends ModelDef<infer Shape, infer R, infer C>
    ? // `Omit<…, keyof BaseModelFields>` so a model that (wrongly) redeclares a
      // reserved field degrades to "framework field wins" (e.g. `createdAt: Date`)
      // instead of intersecting to `never` (`string & Date`, which then surfaces
      // as a baffling "missing field" error three layers away). defineSchema also
      // throws on such a redeclaration at runtime (code `schema_reserved_field`);
      // this is the type-level belt to that runtime suspenders. No-op for correct
      // schemas — they never carry a base-field key, so nothing is omitted.
      Omit<z.infer<z.ZodObject<Shape>>, keyof BaseModelFields>
        & BaseModelFields
        & BaseModelMethods
        & InferComputed<C>
        & InferRelations<S, R>
    : never;

/**
 * Infer the relation accessor types from a model's relations record.
 *
 * At runtime the engine installs a getter for each declared relation, so this
 * type mirrors them and you can read `section.blocks` and `section.report` without a
 * cast.
 *
 * - `hasMany` → `InferModel<S, Target>[]`
 * - `belongsTo` / `hasOne` → `InferModel<S, Target> | undefined` (undefined
 *   when the foreign key is unset or the parent has not loaded yet)
 *
 * Kept `readonly` because the accessors are getters with no setter — assigning
 * to `section.blocks` would have no effect at runtime.
 */
export type InferRelations<S extends Schema, R extends RelationRecord> =
  // Index-signature short-circuit. The schema-record constraint
  // (`SchemaRecord = Record<string, ModelDef>`) widens every model's
  // captured `R` up to `RelationRecord` (= `Record<string, RelationDef>`)
  // — at that point `keyof R` is just `string`, not the literal relation
  // keys the consumer wrote. A naive mapped `{ readonly [K in keyof R]: …}`
  // would then emit `{ readonly [k: string]: … }`, an index signature
  // that poisons every intersection (`Partial<InferModel>` becomes
  // "[k:string]: undefined", and `id: string` "is incompatible with
  // index signature, expected undefined" at every `update({ id, ... })`).
  // The same widening also affects `model()`'s `Record<string, never>`
  // default. Match both forms via `string extends keyof R` — true for
  // index-keyed records, false for any literal-key set.
  string extends keyof R
    ? unknown
    : {
        readonly [K in keyof R]: R[K] extends RelationDef<infer Type, infer Target>
          ? Target extends keyof S['models']
            ? Type extends 'hasMany'
              ? InferModel<S, Target>[]
              : Type extends 'hasOne' | 'belongsTo'
                ? InferModel<S, Target> | undefined
                : never
            : never
          : never;
      };

// ── Reactive rows ──────────────────────────────────────────────────────────

/**
 * The row shape a reactive read returns: the model's data fields, base fields,
 * and schema computed getters — WITHOUT relation accessors and WITHOUT model
 * methods. Derived from the model definition, exactly like {@link InferModel},
 * mirroring what `toReactiveSnapshot()` produces at runtime.
 *
 * Relations (`hasMany` / `belongsTo`) are store-backed getters that exist only
 * on the pool's model instances, so a reactive row honestly omits them —
 * reading `row.blocks` is a compile error instead of a silent `undefined`.
 * Compose relations through a selector or hook instead.
 *
 * The same pairing other data layers converged on: Zero's data-only `Row<...>`
 * with relations added per-query, Prisma's scalar-only model types with
 * `GetPayload<{ include }>`, mobx-state-tree's `Instance<T>` / `SnapshotOut<T>`.
 */
export type InferRow<S extends Schema, ModelName extends keyof S['models']> =
  S['models'][ModelName] extends ModelDef<infer Shape, RelationRecord, infer C>
    ? // Same reserved-field guard as InferModel — see the comment there.
      Omit<z.infer<z.ZodObject<Shape>>, keyof BaseModelFields>
        & BaseModelFields
        & InferComputed<C>
    : never;

/**
 * The reactive-row companion to {@link Model}. Once your project's
 * `ablo/register.ts` registers the schema, a single argument is all it takes:
 *
 * ```ts
 * type SectionRow = Row<'sections'>;    // data fields + computeds, no relations
 * type Section    = Model<'sections'>;  // the pool's model instance
 * ```
 *
 * Without that registration, or for a second schema, pass the schema
 * explicitly: `Row<typeof schema, 'sections'>`.
 */
export type Row<A, B = never> = [B] extends [never]
  ? A extends keyof RegisteredSchema['models']
    ? InferRow<RegisteredSchema, A>
    : never
  : A extends Schema
    ? InferRow<A, B extends keyof A['models'] ? B : never>
    : never;

/**
 * Infer the return types of computed getters.
 * Maps each computed function's return type into a readonly property.
 *
 * ```ts
 * // Given: computed: { displayTitle: (self) => self.title || 'Untitled' }
 * // Infers: { readonly displayTitle: string }
 * ```
 */
export type InferComputed<C> =
  // Same index-signature poison story as `InferRelations`. The schema
  // record widens captured `C` to `ComputedRecord` (=
  // `Record<string, (self: any) => any>`); the empty-default
  // `Record<string, never>` widens the same way. `string extends keyof C`
  // catches both — true for index-keyed records, false for literal-key
  // computed sets like `{ displayTitle: ..., metadataObject: ... }`.
  string extends keyof C
    ? unknown
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    : { readonly [K in keyof C]: C[K] extends (...args: any[]) => infer R ? R : never };

/**
 * Infer the create input type. Only schema-defined fields are accepted —
 * base fields (id, createdAt, updatedAt) are auto-generated by the SDK
 * and cannot be passed by the consumer.
 *
 * The only exception is `id`: consumers can optionally provide one for
 * client-generated IDs (useful for optimistic UI that needs to reference
 * the entity before the server confirms).
 *
 * ```ts
 * type CreateTask = InferCreate<typeof schema, 'tasks'>;
 * // { title: string; status?: 'todo' | 'doing' | 'done'; id?: string }
 * // createdAt, updatedAt are NOT accepted — they're auto-generated
 * ```
 */
export type InferCreate<S extends Schema, ModelName extends keyof S['models']> =
  S['models'][ModelName] extends ModelDef<infer Shape>
    ? // Same reserved-field guard as InferModel: drop any (wrongly) redeclared
      // base field so the input degrades to "framework field wins" rather than
      // collapsing to `never`. No-op for correct schemas.
      Omit<z.input<z.ZodObject<Shape>>, keyof BaseModelFields> & Partial<BaseModelFields>
    : never;

/**
 * Extract all model names from a schema.
 */
export type InferModelNames<S extends Schema> = keyof S['models'] & string;

// ── CRUD value types ──────────────────────────────────────────────────────

/**
 * The value type for inserting a new row. Same shape as {@link InferCreate}:
 * the fields you can write, plus an optional `id` for client-generated ids.
 */
export type InsertValue<S extends Schema, ModelName extends keyof S['models']> =
  InferCreate<S, ModelName>;

/**
 * The value type for upserting (insert or overwrite). Same shape as
 * {@link InsertValue} — a full row. If a row with the same `id` exists,
 * it gets overwritten.
 */
export type UpsertValue<S extends Schema, ModelName extends keyof S['models']> =
  InsertValue<S, ModelName>;

/**
 * The value type for updating an existing row. `id` is required (identifies
 * the row to update); all other fields are optional (only provided fields
 * are changed).
 */
export type UpdateValue<S extends Schema, ModelName extends keyof S['models']> =
  S['models'][ModelName] extends ModelDef<infer Shape>
    ? { id: string } & Partial<z.input<z.ZodObject<Shape>>>
    : never;

/**
 * The value type for deleting a row. Just the primary key.
 */
// `ModelName` completes the two-arg signature that mirrors InsertValue /
// UpsertValue / UpdateValue — apps/sync-server calls `DeleteId<S, Model>`. A
// delete payload is only the primary key, so the name isn't read in the body.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export interface DeleteId<S extends Schema, ModelName extends keyof S['models']> { id: string }

// ── Factory ───────────────────────────────────────────────────────────────

/**
 * Define a sync engine schema.
 *
 * ```ts
 * const schema = defineSchema({
 *   tasks: model({ title: z.string(), status: z.string().default('todo') }),
 *   projects: model({ name: z.string() }),
 * });
 * ```
 */
/**
 * Rejects field names that will not survive the sync driver's snake_case ↔
 * camelCase round-trip. The driver maps identifiers like this:
 *
 *   `content_json`       → `contentJson`   (snake → camel)
 *   `contentJson`        → `content_json`  (camel → snake)
 *   `contentJSON`        → `content_j_s_o_n` (does not round-trip)
 *
 * A name that does not round-trip through this pair of transforms will silently
 * fail to populate on the client: the wire delivers one casing, the model reads
 * another, and the field lands as `undefined`. Catching it here surfaces the
 * problem when the schema is defined rather than at runtime.
 *
 * The rule: a standard camelCase identifier has runs of a single uppercase
 * letter followed by lowercase letters, never two uppercase letters in a row.
 * `contentJSON` has `JSON` in all caps, so it is rejected.
 */
function assertRoundTrippableCamelCase(modelName: string, fieldName: string): void {
  // Base fields merged in by defineSchema are already validated; skip.
  if (fieldName === 'id') return;
  // Leading-lowercase constraint: fields must be camelCase, not PascalCase.
  // PascalCase is reserved for typenames.
  const first = fieldName.charAt(0);
  if (first >= 'A' && first <= 'Z') {
    throw new AbloValidationError(
      `[defineSchema] ${modelName}.${fieldName}: field names must start lowercase ` +
        `(camelCase). Use "${first.toLowerCase()}${fieldName.slice(1)}" instead.`,
      { code: 'schema_field_not_camelcase' },
    );
  }
  // Two-consecutive-uppercase check. The classic failure mode is
  // `contentJSON`, `contentHTML`, `myURLParam`, etc. These don't round-trip
  // through `postgres.camel` — the snake_case intermediate would be
  // `content_j_s_o_n`, which is not a column that exists.
  for (let i = 0; i < fieldName.length - 1; i++) {
    const a = fieldName.charAt(i);
    const b = fieldName.charAt(i + 1);
    const aUpper = a >= 'A' && a <= 'Z';
    const bUpper = b >= 'A' && b <= 'Z';
    if (aUpper && bUpper) {
      throw new AbloValidationError(
        `[defineSchema] ${modelName}.${fieldName}: two consecutive uppercase ` +
          `letters ("${a}${b}") will not round-trip through the ` +
          `snake_case ↔ camelCase transform used by the sync driver. ` +
          `The wire delivers camelCase (lowercase after the first letter of ` +
          `each word); a field named "${fieldName}" would never receive its ` +
          `value and read as undefined on the client. Use standard ` +
          `camelCase (e.g. "contentJson" instead of "contentJSON").`,
        { code: 'schema_field_consecutive_caps' },
      );
    }
  }
}

export function defineSchema<const S extends SchemaRecord>(
  models: S,
  options?: DefineSchemaOptions,
): Schema<S> {
  // Build validators with base fields merged in, and resolve defaults for
  // `typename` and `persist.store` so downstream code (the loader and the
  // hydration pipeline) can rely on these fields being set without re-deriving
  // them at every call site.
  //
  // Defaults:
  //   typename      ← schema key (e.g. `block` → `'block'`)
  //   persist.store ← typename (only resolved when `persist` was provided)
  //
  // A consumer that passes `typename: 'Block'` explicitly (common when
  // the wire shape uses PascalCase while the schema key is camelCase) keeps
  // that value — the fallback only fires when the field is unset.
  //
  // The models record is rebuilt rather than mutated in place because
  // `ModelDef`'s fields are `readonly`. The rebuild is a shallow spread per
  // entry, so the inferred shape/relations/fields metadata references are
  // preserved (no type inference regression at consumer call sites).
  const validators: Record<string, z.ZodObject<z.ZodRawShape>> = {};
  const resolvedModels: Record<string, ModelDef> = {};
  const casing = resolveCasing(options?.casing);

  for (const [name, def] of Object.entries(models)) {
    // Catch round-trip-hostile field names at definition time. Deferring
    // this check to runtime means every affected field silently reads
    // `undefined` on the client — and the author only notices when a UI
    // that depends on the field goes blank. Throwing here makes the
    // failure immediate and unambiguous.
    for (const fieldName of Object.keys(def.shape)) {
      assertRoundTrippableCamelCase(name, fieldName);
      // Reserved base columns are merged in below via `baseFieldsSchema.merge`,
      // and Zod `.merge` silently OVERWRITES the base field with the user's —
      // e.g. a model declaring `createdAt: z.string()` ends up with a field
      // typed `string & Date`, which breaks the build. Reject the collision at
      // definition time so the author sees an unambiguous error instead.
      if ((BASE_FIELDS as readonly string[]).includes(fieldName)) {
        throw new AbloValidationError(
          `[defineSchema] ${name}.${fieldName}: field \`${fieldName}\` collides with a ` +
            `reserved field that the SDK provides automatically ` +
            `(${BASE_FIELDS.join(', ')}). Remove it from your model — redeclaring it ` +
            `produces a \`string & Date\` type and breaks the build.`,
          { code: 'schema_reserved_field', param: `${name}.${fieldName}` },
        );
      }
    }

    validators[name] = baseFieldsSchema.merge(def.schema);

    // Resolve every relation's `foreignKeyColumn` once, now. The builder
    // constructs each RelationDef with `foreignKeyColumn = foreignKey`
    // (identity) so this is a no-op when `casing` is unset — existing
    // consumers get the same behavior they had before the option landed.
    // When `casing: 'snake_case'` is set, every FK flips to its
    // snake_case DB column name here and nowhere else. A field-level
    // `.from(column)` override wins over the convention, so legacy
    // columns stay declared in the artifact instead of rediscovered by
    // SQL compilers. Server-side SQL compilers read the resolved value
    // directly.
    for (const rel of Object.values(def.relations as Record<string, RelationDef>)) {
      const fieldColumn = def.fields[rel.foreignKey]?.column;
      (rel as { foreignKeyColumn: string }).foreignKeyColumn = fieldColumn ?? casing(rel.foreignKey);
    }

    const typename = def.typename ?? name;
    const persist = def.persist
      ? { ...def.persist, store: def.persist.store ?? typename }
      : undefined;
    // Physical table defaults to the schema key — the SAME rule the
    // provisioner/planner use (`tableName ?? key`), resolved here once so the
    // serialized artifact always carries it. Required now that models are
    // mutable by default: the server's `buildModelMap` rejects a mutable
    // model with no `tableName`, which would otherwise break every commit.
    const tableName = def.tableName ?? name;

    resolvedModels[name] = { ...def, typename, tableName, persist };
  }

  validateSyncGroupSchema(resolvedModels);
  validateSessionSettings(options?.sessionSettings ?? {});

  return {
    // Cast back to S: we only added values to optional fields that were
    // already part of ModelDef, so the shape is structurally unchanged.
    models: resolvedModels as unknown as S,
    validators: validators as Schema<S>['validators'],
    identityRoles: options?.identityRoles ?? [],
    sessionSettings: options?.sessionSettings ?? {},
  };
}

/**
 * Reject session-setting mappings that couldn't do what the author intends —
 * caught here at definition time rather than silently dropped on the write path.
 * Each key must name a non-empty setting the customer's policies read, and must
 * not reassign one Ablo already manages. Uniqueness needs no check: the map is
 * keyed by the setting name, so a duplicate is unrepresentable.
 */
function validateSessionSettings(settings: SessionSettings): void {
  for (const setting of Object.keys(settings)) {
    const name = setting.trim();
    if (name === '') {
      throw new AbloValidationError(
        `[defineSchema] sessionSettings: a key is empty. Name the Postgres ` +
          `setting your row-level-security policies read, e.g. ` +
          `\`{ 'app.current_org': 'orgId' }\`.`,
        { code: 'schema_definition_invalid', param: 'sessionSettings' },
      );
    }
    if (RESERVED_SESSION_SETTINGS.includes(name)) {
      throw new AbloValidationError(
        `[defineSchema] sessionSettings: \`${name}\` is a setting Ablo already ` +
          `manages on its write connection, so a mapping can't reassign it — ` +
          `that would let a schema relax the engine's own scoping. Point your ` +
          `policies at a setting your app owns (e.g. \`app.current_org\`) and ` +
          `map Ablo's trusted identity into that instead. Reserved: ` +
          `${RESERVED_SESSION_SETTINGS.join(', ')}.`,
        { code: 'schema_definition_invalid', param: `sessionSettings.${name}` },
      );
    }
  }
}

/**
 * Validates the relation-driven sync-group declarations (`scope` and `grants`)
 * at schema-build time, so a mistyped membership edge fails here — with a
 * structured error (`code`, `param`, `doc_url`) pointing at the exact
 * declaration — rather than silently mis-routing changes at runtime.
 */
function validateSyncGroupSchema(models: Record<string, ModelDef>): void {
  for (const [name, def] of Object.entries(models)) {
    // Shape-validate the `scope` declaration via the shared Zod schema.
    if (def.scope !== undefined && !scopeSchema.safeParse(def.scope).success) {
      throw new AbloValidationError(
        `Model "${name}": scope kind "${String(def.scope)}" must be a lowercase identifier (e.g. 'workspace').`,
        { code: 'schema_scope_kind_invalid', param: `${name}.scope` },
      );
    }

    if (!def.grants) continue;

    // Shape-validate the `grants` edge via the shared Zod schema before the
    // cross-field (relation-exists / belongsTo) checks below.
    if (!grantsRefSchema.safeParse(def.grants).success) {
      throw new AbloValidationError(
        `Model "${name}": grants must be { subject, scope } naming two relations on this model.`,
        { code: 'schema_grants_shape_invalid', param: `${name}.grants` },
      );
    }

    const relations = def.relations as Record<string, RelationDef>;
    for (const role of ['subject', 'scope'] as const) {
      const relName = def.grants[role];
      const rel = relations?.[relName];
      if (!rel) {
        throw new AbloValidationError(
          `Model "${name}": grants.${role} "${relName}" is not a relation on this model. ` +
            `Declare a \`belongsTo\` relation named "${relName}" first.`,
          { code: 'schema_grants_relation_missing', param: `${name}.grants.${role}` },
        );
      }
      if (rel.type !== 'belongsTo') {
        throw new AbloValidationError(
          `Model "${name}": grants.${role} "${relName}" must be a \`belongsTo\` relation ` +
            `(got "${rel.type}"). A membership edge points at a single subject/scope row.`,
          { code: 'schema_grants_relation_kind', param: `${name}.grants.${role}` },
        );
      }
    }

    // The scope edge must target a model that is actually a scope root —
    // otherwise the resolved `<kind>:<id>` group is one nothing fans into.
    const scopeRel = relations[def.grants.scope];
    // Unreachable: the role loop above already threw if the scope relation
    // is missing — this narrows the indexed access for the checks below.
    if (!scopeRel) continue;
    const target = models[scopeRel.target];
    if (target && !target.scope) {
      throw new AbloValidationError(
        `Model "${name}": grants.scope "${def.grants.scope}" targets "${scopeRel.target}", ` +
          `which is not a scope root. Add \`scope: true\` to the "${scopeRel.target}" model.`,
        { code: 'schema_grants_target_not_scope_root', param: `${scopeRel.target}.scope` },
      );
    }
  }
}

