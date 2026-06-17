/**
 * Schema ⇄ JSON
 *
 * A `Schema` is serializable except for client-only closures (Zod
 * validators + computed getters). `serializeSchema` emits the plain-data
 * JSON form; `parseSchema` reconstructs a working `Schema` from it.
 *
 * This is the GraphQL `printSchema` / `buildSchema` model: one `Schema`
 * type, two representations. A hosted multi-tenant server obtains a tenant's
 * `Schema` by `parseSchema(json)` instead of an in-process import — the JSON
 * is what travels over the control plane (`ablo push`) and is stored
 * per `(tenant, version)`.
 *
 * What round-trips:
 *   - all model routing/scoping metadata (typename, tableName, load,
 *     mutable, the canonical `tenancy` descriptor, bootstrap hints, scope,
 *     grants, entityRoles, persist, autoFill, requiredFields, lazyObservable).
 *     NOTE: the authoring sugar (`policy`/`groups`) is normalized away at
 *     `model()`-build; only the canonical wire fields cross here.
 *   - relations (incl. resolved `foreignKeyColumn`)
 *   - field metadata (names + type tags), from which validators are rebuilt
 *   - identity roles (already pure data)
 *
 * What does NOT round-trip (client-only, server never needs it):
 *   - `computed` getters (closures) — dropped
 *   - exact Zod refinements — rebuilt as permissive validators from
 *     `FieldMeta` (the server does no field-shape validation anyway)
 */

import { z } from 'zod';
import { AbloValidationError } from '../errors.js';
import type { FieldMeta } from './field.js';
import type { Tenancy } from './tenancy.js';
import type { SchemaPlane } from './plane.js';
import type {
  ModelDef,
  RelationRecord,
  GrantsRef,
  LoadStrategy,
  PersistOptions,
  AutoFillRule,
} from './model.js';
import type { RelationDef, RelationType } from './relation.js';
import {
  baseFieldsSchema,
  type Schema,
  type SchemaRecord,
  type IdentityRole,
  type EntityRole,
} from './schema.js';

/** Current schema-JSON envelope version. Bump on a breaking change to the
 * JSON shape itself (not the user's schema). v2 replaced the per-model
 * `syncGroupFormat` template string with structured `scope`/`grants`/
 * `entityRoles` (relation-driven sync groups). */
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
  /** Database plane. Optional for back-compat: absent in artifacts written before
   *  the plane axis → read as `tenant` (the default). See `./plane.ts`. */
  readonly plane?: SchemaPlane;
  readonly scope?: boolean | string;
  readonly grants?: GrantsRef;
  readonly entityRoles?: readonly EntityRole[];
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
  for (const [name, rel] of Object.entries(def.relations as RelationRecord)) {
    relations[name] = relationToJSON(rel as RelationDef);
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
    plane: def.plane,
    scope: def.scope,
    grants: def.grants,
    entityRoles: def.entityRoles,
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
export function toSchemaJSON(schema: Schema<SchemaRecord>): SchemaJSON {
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
  return { v: SCHEMA_JSON_VERSION, models, identityRoles: schema.identityRoles };
}

/** Serialize a `Schema` to a JSON string (the `ablo push` payload). */
export function serializeSchema(schema: Schema<SchemaRecord>): string {
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
  // The brand symbols on RelationDef are declare-only (no runtime
  // presence), so a plain object with the runtime members satisfies every
  // server-side reader. Cast through unknown to attach the nominal type.
  return {
    type: rel.type,
    target: rel.target,
    foreignKey: rel.foreignKey,
    foreignKeyColumn: rel.foreignKeyColumn,
    options: rel.options ?? {},
    _orderBy: rel.orderBy,
  } as unknown as RelationDef;
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
    // Absent in pre-plane-axis artifacts → default `tenant` (matches the model
    // builder default + the provisioning fallback), so the round-trip is stable.
    plane: json.plane ?? 'tenant',
    scope: json.scope,
    grants: json.grants,
    entityRoles: json.entityRoles,
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
export function fromSchemaJSON(json: SchemaJSON): Schema<SchemaRecord> {
  const models: Record<string, ModelDef> = {};
  const validators: Record<string, z.ZodObject<z.ZodRawShape>> = {};
  for (const [key, modelJson] of Object.entries(json.models)) {
    const def = modelFromJSON(modelJson);
    models[key] = def;
    validators[key] = baseFieldsSchema.merge(def.schema);
  }
  return {
    models: models as SchemaRecord,
    validators: validators as Schema<SchemaRecord>['validators'],
    identityRoles: json.identityRoles,
  };
}

/** Parse a `Schema` from a JSON string (inverse of {@link serializeSchema}). */
export function parseSchema(json: string): Schema<SchemaRecord> {
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
export function schemaHash(schema: Schema<SchemaRecord>): string {
  const canonical = canonicalJson(toSchemaJSON(schema));
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
