/**
 * Schema ⇄ JSON.
 *
 * A `Schema` is fully serializable apart from its client-only closures — the
 * Zod validators and computed getters. {@link serializeSchema} emits the
 * plain-data JSON form and {@link parseSchema} reconstructs a working `Schema`
 * from it: one `Schema` type with two representations.
 *
 * A hosted, multi-tenant server loads a tenant's schema with `parseSchema(json)`
 * rather than importing it in process. The JSON is what `ablo push` sends and
 * what the server stores per tenant and version.
 *
 * What round-trips:
 *   - all model routing and scoping metadata: typename, tableName, load,
 *     mutable, the `tenancy` descriptor, bootstrap hints, scope, grants,
 *     entityRoles, the routing-only acknowledgement, the `conflict` disposition map, persist, autoFill,
 *     requiredFields, and lazyObservable. The authoring shorthands (`policy`
 *     and `groups`) are normalized into these canonical fields when the model
 *     is built, so only the canonical fields cross here.
 *   - relations, including the resolved `foreignKeyColumn`
 *   - field metadata (names and type tags), from which validators are rebuilt
 *   - identity roles
 *
 * What does not round-trip, because the server never needs it:
 *   - computed getters, which are closures and are dropped
 *   - exact Zod refinements, which are rebuilt as permissive validators from
 *     {@link FieldMeta}; the server does no field-shape validation
 */

import { z } from 'zod';
import { AbloValidationError } from '../errors.js';
import type { FieldMeta } from './field.js';
import { buildFieldRefs } from './schema.js';
import type { Tenancy } from './tenancy.js';
import type { ModelResidency } from './residency.js';
import type { SubjectRule } from './subject.js';
import type {
  ModelDef,
  RelationRecord,
  GrantsRef,
  LoadStrategy,
  PersistOptions,
  AutoFillRule,
  ConflictAxis,
} from './model.js';
import {
  relation,
  type RelationDef,
  type RelationType,
} from './relation.js';
import {
  baseFieldsSchema,
  type Schema,
  type SchemaRecord,
  type IdentityRole,
  type EntityRole,
  type SessionSettings,
} from './schema.js';

/** Current schema-JSON envelope version. Bump this on a breaking change to the
 * JSON shape itself — not to a user's schema. */
const SCHEMA_JSON_VERSION = 3 as const;

// ── Wire types ──────────────────────────────────────────────────────────────

/** A relation in JSON form. Mirrors the serializable members of {@link RelationDef}. */
export interface RelationJSON {
  readonly type: RelationType;
  readonly target: string;
  readonly foreignKey: string;
  readonly foreignKeyColumn: string;
  readonly options?: Record<string, boolean>;
  readonly orderBy?: string;
}

/** A model in JSON form. Everything on {@link ModelDef} except closures. */
export interface ModelJSON {
  readonly fields: Record<string, FieldMeta>;
  readonly relations: Record<string, RelationJSON>;
  readonly load: LoadStrategy;
  readonly typename: string;
  readonly tableName?: string;
  readonly tenancy: Tenancy;
  readonly subject?: SubjectRule;
  /** The database plane the model's rows live in. Optional for backward
   *  compatibility: when absent (an artifact written before this field existed)
   *  it reads as `tenant`, the default. See {@link ModelResidency}. */
  readonly plane?: ModelResidency;
  readonly scope?: boolean | string;
  readonly grants?: GrantsRef;
  readonly entityRoles?: readonly EntityRole[];
  readonly routingOnly?: true;
  /** The declared write-conflict disposition per committer kind. When absent,
   *  the engine falls back to its default. */
  readonly conflict?: ConflictAxis;
  readonly bootstrapLimit?: number;
  readonly bootstrapOrderBy?: string;
  readonly mutable?: boolean;
  readonly lazyObservable?: boolean;
  readonly persist?: PersistOptions;
  readonly autoFill?: readonly AutoFillRule[];
  readonly requiredFields?: readonly string[];
}

/** The JSON form of a {@link Schema}. The `ablo push` payload. */
export interface SchemaJSON {
  readonly v: typeof SCHEMA_JSON_VERSION;
  readonly models: Record<string, ModelJSON>;
  readonly identityRoles: readonly IdentityRole[];
  /** Optional so schemas pushed before ADR 0011 still parse (defaults to `{}`). */
  readonly sessionSettings?: SessionSettings;
}

// ── Serialize ────────────────────────────────────────────────────────────────

function relationToJSON(rel: RelationDef): RelationJSON {
  const options = rel.options as Record<string, boolean> | undefined;
  return {
    type: rel.type,
    target: rel.target,
    foreignKey: rel.foreignKey,
    foreignKeyColumn: rel.foreignKeyColumn,
    options: options && Object.keys(options).length > 0 ? { ...options } : undefined,
    orderBy: rel._orderBy,
  };
}

function modelToJSON(def: ModelDef): ModelJSON {
  const relations: Record<string, RelationJSON> = {};
  for (const [name, rel] of Object.entries(def.relations)) {
    relations[name] = relationToJSON(rel);
  }
  return {
    fields: def.fields,
    relations,
    load: def.load,
    // `defineSchema` always resolves `typename` to the schema key when unset,
    // so it is present on a built ModelDef; fall back defensively anyway.
    typename: def.typename ?? '',
    tableName: def.tableName,
    tenancy: def.tenancy,
    subject: def.subject,
    plane: def.plane,
    scope: def.scope,
    grants: def.grants,
    entityRoles: def.entityRoles,
    routingOnly: def.routingOnly,
    conflict: def.conflict,
    bootstrapLimit: def.bootstrapLimit,
    bootstrapOrderBy: def.bootstrapOrderBy,
    mutable: def.mutable,
    lazyObservable: def.lazyObservable,
    persist: def.persist,
    autoFill: def.autoFill,
    requiredFields: def.requiredFields,
  };
}

/**
 * Project a `Schema` to its JSON form. Drops the client-only closures
 * (validators, `computed`); keeps everything the server and a faithful
 * rebuild need. The result is plain data — `JSON.stringify`-safe.
 */
export function toSchemaJSON(schema: Schema): SchemaJSON {
  const models: Record<string, ModelJSON> = {};
  for (const [key, def] of Object.entries(schema.models)) {
    if (def.typename === '' || def.typename === undefined) {
      // typename '' only happens for a malformed def; surface it loudly
      // rather than ship a model the server can't route.
      models[key] = { ...modelToJSON(def), typename: key };
    } else {
      models[key] = modelToJSON(def);
    }
  }
  return {
    v: SCHEMA_JSON_VERSION,
    models,
    identityRoles: schema.identityRoles,
    ...(Object.keys(schema.sessionSettings).length > 0
      ? { sessionSettings: schema.sessionSettings }
      : {}),
  };
}

/** Serialize a `Schema` to a JSON string (the `ablo push` payload). */
export function serializeSchema(schema: Schema): string {
  return JSON.stringify(toSchemaJSON(schema));
}

// ── Parse ──────────────────────────────────────────────────────────────────

/** Rebuild a Zod validator for a field from its metadata. Permissive by
 * design — the server does no field-shape validation; this exists so a
 * parsed `Schema` is structurally a real `Schema`. */
function zodForField(meta: FieldMeta): z.ZodType {
  let base: z.ZodType;
  switch (meta.type) {
    case 'string':
      base = z.string();
      break;
    case 'number':
      base = z.number();
      break;
    case 'boolean':
      base = z.boolean();
      break;
    case 'date':
      base = z.date();
      break;
    case 'enum':
      base =
        meta.enumValues && meta.enumValues.length > 0
          ? z.enum(meta.enumValues as [string, ...string[]])
          : z.string();
      break;
    case 'json':
    default:
      base = z.unknown();
      break;
  }
  return meta.isOptional ? base.optional() : base;
}

function relationFromJSON(rel: RelationJSON): RelationDef {
  const setColumn = <R extends RelationDef>(definition: R): R => {
    // The builder normally derives this from schema casing. Serialized schemas
    // already carry the resolved database column, so restore that runtime field.
    Reflect.set(definition, 'foreignKeyColumn', rel.foreignKeyColumn);
    return definition;
  };

  switch (rel.type) {
    case 'belongsTo': {
      const options = rel.options;
      return setColumn(relation.belongsTo(rel.target, rel.foreignKey, {
        ...(options?.index === undefined ? {} : { index: options.index }),
        ...(options?.enrich === undefined ? {} : { enrich: options.enrich }),
        ...(options?.defer === undefined ? {} : { defer: options.defer }),
        ...(options?.parent === undefined ? {} : { parent: options.parent }),
        ...(options?.fk === undefined ? {} : { fk: options.fk }),
      }));
    }
    case 'hasMany':
      return setColumn(
        relation.hasMany(
          rel.target,
          rel.foreignKey,
          rel.orderBy === undefined ? undefined : { orderBy: rel.orderBy },
        ),
      );
    case 'hasOne':
      return setColumn(relation.hasOne(rel.target, rel.foreignKey));
  }
}

function modelFromJSON(json: ModelJSON): ModelDef {
  // `z.ZodRawShape` is a readonly index signature in Zod v4, so build a
  // mutable record and cast once when handing it to `z.object`/`ModelDef`.
  const shapeMut: Record<string, z.ZodType> = {};
  for (const [name, meta] of Object.entries(json.fields)) {
    shapeMut[name] = zodForField(meta);
  }
  const shape = shapeMut as z.ZodRawShape;
  const relations: RelationRecord = {};
  for (const [name, rel] of Object.entries(json.relations)) {
    relations[name] = relationFromJSON(rel);
  }
  return {
    schema: z.object(shape),
    shape,
    fields: json.fields,
    relations,
    load: json.load,
    bootstrapLimit: json.bootstrapLimit,
    bootstrapOrderBy: json.bootstrapOrderBy,
    typename: json.typename,
    persist: json.persist,
    tableName: json.tableName,
    tenancy: json.tenancy,
    subject: json.subject,
    // Absent in older artifacts → default `tenant`, matching the model builder
    // and provisioning defaults so the round-trip stays stable.
    plane: json.plane ?? 'tenant',
    scope: json.scope,
    grants: json.grants,
    entityRoles: json.entityRoles,
    routingOnly: json.routingOnly,
    // Absent in older artifacts → undefined, so the commit path falls through to
    // the function registry or the engine default.
    conflict: json.conflict,
    mutable: json.mutable,
    lazyObservable: json.lazyObservable,
    // computed getters are closures and intentionally not serialized; a
    // parsed schema (server-side) has none.
    computed: undefined,
    autoFill: json.autoFill,
    requiredFields: json.requiredFields,
  };
}

/**
 * Reconstruct a working `Schema` from its JSON form. Validators are rebuilt
 * permissively from field metadata (the server never validates field shapes);
 * `computed` getters are absent. Everything the server reads — routing,
 * scoping, relations, identity roles — is restored exactly.
 */
export function fromSchemaJSON(json: SchemaJSON): Schema {
  const models: Record<string, ModelDef> = {};
  const validators: Record<string, z.ZodObject<z.ZodRawShape>> = {};
  for (const [key, modelJson] of Object.entries(json.models)) {
    const def = modelFromJSON(modelJson);
    models[key] = def;
    validators[key] = baseFieldsSchema.merge(def.schema);
  }
  return {
    models: models,
    // A schema rebuilt from JSON carries references too — the shapes are here.
    fields: buildFieldRefs(models),
    validators: validators as Schema['validators'],
    identityRoles: json.identityRoles,
    sessionSettings: json.sessionSettings ?? {},
  };
}

/** Parse a `Schema` from a JSON string (inverse of {@link serializeSchema}). */
export function parseSchema(json: string): Schema {
  const parsed = JSON.parse(json) as SchemaJSON;
  if (parsed.v !== SCHEMA_JSON_VERSION) {
    throw new AbloValidationError(
      `parseSchema: unsupported schema-JSON version ${parsed.v} (expected ${SCHEMA_JSON_VERSION})`,
      { code: 'schema_definition_invalid' },
    );
  }
  return fromSchemaJSON(parsed);
}

// ── Hash ─────────────────────────────────────────────────────────────────────

/**
 * Stable content hash of a `Schema`'s JSON form. FNV-1a over a canonical
 * (sorted-key) encoding — deterministic across runs and order-invariant, no
 * `crypto` dependency. Used for connect-time version gating: the client sends
 * the hash it was built against, the server compares it to the tenant's
 * active schema hash. Not a security primitive.
 */
export function schemaHash(schema: Schema): string {
  return fnv1a(canonicalJson(toSchemaJSON(schema)));
}

/**
 * Content hash of ONE serialized model — the unit of the semantic drift check.
 * Two schemas agree on a model exactly when these match, which is what lets a
 * client compare only the models it declares instead of welding itself to the
 * whole-schema hash (where any additive push reads as drift). Computed over the
 * model's `SchemaJSON` entry with the same canonicalization and hash as
 * {@link schemaHash}, on both the client and the server's `GET /api/schema`.
 */
export function modelHash(modelJson: unknown): string {
  return fnv1a(canonicalJson(modelJson));
}

/** FNV-1a over an already-canonical string — shared by both hashes above. */
function fnv1a(canonical: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < canonical.length; i++) {
    h ^= canonical.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** Stable JSON: object keys sorted recursively, `undefined` dropped. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}
