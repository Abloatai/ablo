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

// Sync-group roles (identity + entity) live in `./roles.js`. Re-exported here
// so the long-standing `@ablo/schema` / `./schema.js` import paths keep working
// after the rehome — see roles.ts for the full vocabulary.
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
} from './roles.js';

// ── Casing resolution ─────────────────────────────────────────────────────
//
// One-place-once identifier translation, modeled after Drizzle's `casing`
// option. Applied at schema-build time to produce `rel.foreignKeyColumn`
// — a resolved DB-column identifier that server-side SQL compilers can
// interpolate directly without needing a transform of their own.
//
// A function-form option lets exotic consumers handle mixed legacy DBs
// without forking the SDK. The string forms cover the two cases every
// Postgres + TypeScript shop hits: camelCase everywhere, or the Postgres-
// convention snake_case columns with camelCase JS fields.

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

/** Pure camelCase → snake_case. Matches postgres.fromCamel semantics but
 * kept local so the SDK stays free of any driver dependency — consumers
 * using Prisma/Drizzle/raw pg should all get the same result. */
function camelToSnake(identifier: string): string {
  return identifier.replace(/[A-Z]/g, (ch) => `_${ch.toLowerCase()}`);
}

/** Options for `defineSchema`. */
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
   * Identity-anchored sync-group roles. Server's
   * `composeIdentitySyncGroups` iterates these to build the
   * participant's allowed-set, replacing the prior hardcoded
   * `org:/user:/team:` triad in `@ablo/schema`. See {@link IdentityRole}
   * for the open-registration shape — no closed enum, consumer fully
   * controls both the template string and the extractor function.
   *
   * Leave unset for schemas that don't need identity-derived scoping
   * (e.g. fully public read models). When unset, `composeIdentitySyncGroups`
   * returns `[]` and consumers fall back to whatever explicit
   * `syncGroups` the AuthProvider attaches to the Identity.
   */
  readonly identityRoles?: readonly IdentityRole[];
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

/** The base fields type — pure data columns. */
export type BaseModelFields = z.infer<typeof baseFieldsSchema>;

/**
 * Methods every dynamic model class inherits from `Model`. Intersected
 * into `InferModel` (the read-side type) but NOT into `InferCreate` /
 * `UpdatePatch` — methods aren't legal create/update inputs.
 */
export interface BaseModelMethods {
  /** Wire-format model name (e.g. `'Slide'`, `'Comment'`). */
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
 * THE model type helper. With the scaffold's `ablo/register.ts` registration
 * in place, one parameter is all it takes:
 *
 * ```ts
 * type Task = Model<'tasks'>;
 * ```
 *
 * Without registration (or for a second schema), pass the schema explicitly:
 * `Model<typeof schema, 'tasks'>`.
 */
export type Model<A, B = never> = [B] extends [never]
  ? A extends keyof RegisteredSchema['models']
    ? InferModel<RegisteredSchema, A>
    : never
  : A extends Schema
    ? InferModel<A, B extends keyof A['models'] ? B : never>
    : never;

/**
 * @deprecated Use {@link Model} — `type Task = Model<typeof schema, 'tasks'>`
 * reads as the domain ("the Task model from my schema"), not the machinery.
 * Drizzle deprecated its own `InferModel` for the same reason. Kept as an
 * alias; no behavior difference.
 */
export type InferModel<S extends Schema, ModelName extends keyof S['models']> =
  S['models'][ModelName] extends ModelDef<infer Shape, infer R, infer C>
    ? z.infer<z.ZodObject<Shape>>
        & BaseModelFields
        & BaseModelMethods
        & InferComputed<C>
        & InferRelations<S, R>
    : never;

/**
 * Infer relation accessor types from a model's relations record.
 *
 * The dynamic class installs prototype getters for each declared relation in
 * `createSyncEngine.ts` (`hasMany` → `store.getByForeignKey(...)`, `belongsTo`
 * → pool lookup by FK). This type mirrors those installations so callers can
 * write `slide.layers` and `slide.deck` without manual casts.
 *
 * - `hasMany` → `InferModel<S, Target>[]`
 * - `belongsTo` / `hasOne` → `InferModel<S, Target> | undefined` (undefined
 *   when the FK is unset or the parent isn't in the pool yet)
 *
 * Kept as `readonly` because the accessors are prototype-level getters with
 * no setter — writing to `slide.layers = [...]` would be a no-op at runtime.
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
        readonly [K in keyof R]: R[K] extends RelationDef<infer Type, infer Target, infer _F, infer _O>
          ? Target extends keyof S['models']
            ? Type extends 'hasMany'
              ? InferModel<S, Target>[]
              : Type extends 'hasOne' | 'belongsTo'
                ? InferModel<S, Target> | undefined
                : never
            : never
          : never;
      };

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
    ? z.input<z.ZodObject<Shape>> & Partial<BaseModelFields>
    : never;

/**
 * Extract all model names from a schema.
 */
export type InferModelNames<S extends Schema> = keyof S['models'] & string;

// ── CRUD value types (power TransactionMutate in /server) ────────────────

/**
 * The value type for inserting a new row. Same shape as {@link InferCreate}:
 * consumer-writable fields + optional `id` for client-generated IDs.
 *
 * Matches Zero's `InsertValue<TableSchema>` from `zql/src/mutate/crud.ts`.
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
 *
 * Matches Zero's `UpdateValue<TableSchema>` from `zql/src/mutate/crud.ts`.
 */
export type UpdateValue<S extends Schema, ModelName extends keyof S['models']> =
  S['models'][ModelName] extends ModelDef<infer Shape>
    ? { id: string } & Partial<z.input<z.ZodObject<Shape>>>
    : never;

/**
 * The value type for deleting a row. Just the primary key.
 *
 * Matches Zero's `DeleteID<TableSchema>` from `zql/src/mutate/crud.ts`.
 */
export type DeleteId<S extends Schema, ModelName extends keyof S['models']> =
  { id: string };

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
 * Lowercase-first camelCase round-trip check. Must match the convention used
 * by `postgres.camel` in the client driver (porsager/postgres), which is:
 *
 *   `content_json`       → `contentJson`  (snake → camel)
 *   `contentJson`        → `content_json` (camel → snake)
 *   `contentJSON`        → `content_j_s_o_n` (BROKEN — doesn't round-trip)
 *
 * Any field name that doesn't round-trip under this pair of transforms will
 * silently fail to populate on the client: the wire delivers one casing,
 * the dynamic class's constructor reads another, and the field lands as
 * `undefined`. We catch it here so schema authors see an error at
 * definition time rather than at runtime.
 *
 * Rule: a standard camelCase identifier has runs of one uppercase letter
 * followed by lowercase letters — never two consecutive uppercase letters.
 * `contentJSON` has `JSON` all-uppercase, so we reject it.
 */
function assertRoundTrippableCamelCase(modelName: string, fieldName: string): void {
  // Base fields merged in by defineSchema are already validated; skip.
  if (fieldName === 'id') return;
  // Leading-lowercase constraint: fields must be camelCase, not PascalCase.
  // PascalCase is reserved for typenames.
  if (fieldName[0] >= 'A' && fieldName[0] <= 'Z') {
    throw new AbloValidationError(
      `[defineSchema] ${modelName}.${fieldName}: field names must start lowercase ` +
        `(camelCase). Use "${fieldName[0].toLowerCase()}${fieldName.slice(1)}" instead.`,
      { code: 'schema_field_not_camelcase' },
    );
  }
  // Two-consecutive-uppercase check. The classic failure mode is
  // `contentJSON`, `contentHTML`, `myURLParam`, etc. These don't round-trip
  // through `postgres.camel` — the snake_case intermediate would be
  // `content_j_s_o_n`, which is not a column that exists.
  for (let i = 0; i < fieldName.length - 1; i++) {
    const a = fieldName[i];
    const b = fieldName[i + 1];
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
  // `typename` and `persist.store` so downstream code (the generic loader,
  // the hydration pipeline, the Go named-query registry) can rely on these
  // fields being set without re-deriving them at every call site.
  //
  // Defaults:
  //   typename      ← schema key (e.g. `slideLayer` → `'slideLayer'`)
  //   persist.store ← typename (only resolved when `persist` was provided)
  //
  // A consumer that passes `typename: 'SlideLayer'` explicitly (common when
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
    for (const relName of Object.keys(def.relations)) {
      const rel = (def.relations as Record<string, RelationDef>)[relName];
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

  return {
    // Cast back to S: we only added values to optional fields that were
    // already part of ModelDef, so the shape is structurally unchanged.
    models: resolvedModels as unknown as S,
    validators: validators as Schema<S>['validators'],
    identityRoles: options?.identityRoles ?? [],
  };
}

/**
 * Validate the relation-driven sync-group declarations (`scope` / `grants`)
 * at schema-build time, so a mistyped membership edge fails *here* — with a
 * Stripe-shaped error (`code` + `param` + `doc_url`) pointing at the exact
 * declaration — instead of silently mis-routing deltas at runtime.
 */
function validateSyncGroupSchema(models: Record<string, ModelDef>): void {
  for (const [name, def] of Object.entries(models)) {
    // Shape-validate the `scope` declaration via the shared Zod schema.
    if (def.scope !== undefined && !scopeSchema.safeParse(def.scope).success) {
      throw new AbloValidationError(
        `Model "${name}": scope kind "${String(def.scope)}" must be a lowercase identifier (e.g. 'dataroom').`,
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

