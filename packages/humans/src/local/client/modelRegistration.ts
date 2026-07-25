/**
 * Registers model classes from a declarative schema. {@link registerModelsFromSchema}
 * walks the schema and populates the model registry: for each model it builds a
 * dynamic {@link Model} subclass (with `${field}Json` getters, computed getters,
 * and opt-in field-level reactivity) and registers the model's properties,
 * relations, and any local-database indexes.
 */

import { z } from 'zod';
import type { Schema } from '@ablo/transaction/schema/schema';
import { baseFieldsSchema } from '@ablo/transaction/schema/schema';
import type { ModelRegistry } from '../ModelRegistry.js';
import { DEFER_MODEL_OBSERVABILITY, Model } from '../Model.js';
import { PropertyType } from '@ablo/transaction/types';

// ── Auto model registration from schema ───────────────────────────────────

export function registerModelsFromSchema(schema: Schema, registry: ModelRegistry): void {
  registry.startBatch();

  for (const [schemaKey, modelDef] of Object.entries(schema.models)) {
    // Use typename as the model name — this is the wire-format name that
    // the server sends in bootstrap responses and sync deltas. The pool's
    // typeIndex, the ModelRegistry, and getModelName() all use this name.
    // Schema key (camelCase plural) is only for the consumer-facing proxy API.
    const modelName = modelDef.typename ?? schemaKey;

    // Collect JSON sub-property fields to generate ${field}Json getters
    const jsonSubFields: { fieldName: string; subSchema: z.ZodObject<z.ZodRawShape> }[] = [];

    for (const [fieldName, zodType] of Object.entries(modelDef.shape)) {
      const inner = unwrapZodType(zodType as z.ZodType);
      if (isZodObject(inner)) {
        jsonSubFields.push({ fieldName, subSchema: inner });
      }
    }

    // Create a dynamic Model subclass with JSON sub-property getters.
    //
    // Field-level reactivity is on by default. A reactive read must re-render when
    // a remote delta mutates a row in place, which is the common collaborative
    // case; without per-field reactivity that update fires no reaction and the UI
    // silently goes stale. A model opts out with `lazyObservable: false`, which
    // suits only very large read-only list models where per-field atoms cost more
    // than the coarser entry-replaced reactivity already provides. JSON fields
    // register as reference-tracked, so the default is about one atom per scalar
    // field per loaded row — cheap — not a deep atom tree per blob.
    const isLazy = modelDef.lazyObservable !== false;
    // Base provenance fields (`organizationId`, `createdBy`) live in
    // `baseFieldsSchema`, not in the per-model `shape`. The server stamps and emits
    // them (camelCased on the wire), but hydration only assigns keys that already
    // exist as own or prototype properties — so without a slot here, reads like
    // `row.createdBy` or `row.organizationId` would silently be `undefined`.
    // `id`, `createdAt`, and `updatedAt` are already seeded by the base Model
    // constructor, so they are excluded.
    const fieldNames = [
      ...Object.keys(modelDef.shape),
      ...Object.keys(baseFieldsSchema.shape).filter(
        (f) => f !== 'id' && f !== 'createdAt' && f !== 'updatedAt' && !(f in modelDef.shape),
      ),
    ];
    const computed = (modelDef as { computed?: Record<string, (self: Record<string, unknown>) => unknown> }).computed;
    const DynamicModel = createDynamicModelClass(modelName, jsonSubFields, fieldNames, computed, isLazy);

    // The schema's strategy carries straight through — authoring and runtime
    // name the same set, so there is nothing here to translate and nothing to
    // fall out of step. Lazy models skip IDB hydration and bootstrap.
    const loadStrategy = modelDef.load;

    registry.registerModel(modelName, DynamicModel, {
      loadStrategy,
      fields: modelDef.fields,
      autoFill: modelDef.autoFill,
      requiredFields: modelDef.requiredFields,
    });

    // Collect the fields that should get a local-database secondary index.
    //
    // Only `belongsTo` relations that explicitly set `{ index: true }` are indexed.
    // Every other foreign key, and every scalar, is resolved by in-memory scans,
    // which are fast enough at organization-scope sizes (on the order of 10k rows)
    // and stay reactive. Indexing is opt-in deliberately: auto-indexing every
    // foreign key inflates write amplification for the many keys never queried by
    // id, and indexing every scalar is worse still.
    const indexedFields = new Set<string>();
    for (const relDef of Object.values(modelDef.relations)) {
      if (relDef.type === 'belongsTo' && relDef.foreignKey && relDef.options.index === true) {
        indexedFields.add(relDef.foreignKey);
      }
    }

    // Register fields as properties (from Zod shape).
    for (const [fieldName, rawZodType] of Object.entries(modelDef.shape)) {
      const zodType = rawZodType as z.ZodType;
      const isOptional = zodType.isOptional();
      // A field is indexed if it is the foreign key of a
      // `belongsTo({ index: true })` relation. A `description === 'indexed'` tag
      // also works, for consumers using the `field.*().indexed()` builder.
      const isIndexed =
        indexedFields.has(fieldName) || zodType.description === 'indexed';
      // JSON-typed fields (per the schema's wire-type tag) are opaque blobs —
      // chart specs, rich-text documents, style maps. Deep reactivity on them
      // would walk every nested property and create an atom per leaf, producing a
      // storm of updates on each commit or streaming change. Reference tracking
      // watches only reassignment, which is how blob consumers actually use them.
      const wireType = modelDef.fields[fieldName]?.type;
      const observability: 'deep' | 'shallow' | 'ref' | undefined =
        wireType === 'json' ? 'ref' : undefined;
      registry.registerProperty(modelName, fieldName, {
        type: PropertyType.property,
        indexed: isIndexed,
        optional: isOptional,
        observability,
      });
    }

    // Register relations
    for (const [relName, relDef] of Object.entries(modelDef.relations)) {
      if (relDef.type === 'belongsTo') {
        registry.registerReference(modelName, relName, {
          referencedModel: () => {
            const targetModel = registry.getModelByName(relDef.target);
            return targetModel ?? DynamicModel;
          },
          indexed: true,
        });
      } else if (relDef.type === 'hasMany') {
        // Generate a getter on the parent model that returns all children
        // matching the FK via Model.getStore().getByForeignKey(). The FK
        // index on the target model is registered by deriveSyncPlanFromSchema.
        const targetName = relDef.target;
        const foreignKey = relDef.foreignKey;
        const orderByField = relDef._orderBy;

        // Resolve the target typename from the schema (might differ from the key)
        const targetDef = schema.models[targetName];
        const targetTypename = targetDef?.typename ?? targetName;

        Object.defineProperty(DynamicModel.prototype, relName, {
          get(this: Model) {
            const store = Model.getStore();
            if (!store) return [];
            const results = store.getByForeignKey(targetTypename, foreignKey, this.id);
            if (orderByField && results.length > 1) {
              return [...results].sort((a, b) => {
                // `orderByField` is a runtime string from the schema's
                // hasMany({ orderBy }) — Models have dynamic typed
                // fields produced by createDynamicModelClass, so the
                // static type doesn't carry an index signature for
                // arbitrary field reads. `Reflect.get` is the typed
                // bridge — returns `unknown`, narrowed below.
                const va: unknown = Reflect.get(a, orderByField);
                const vb: unknown = Reflect.get(b, orderByField);
                if (typeof va === 'number' && typeof vb === 'number') return va - vb;
                if (typeof va === 'string' && typeof vb === 'string') return va.localeCompare(vb);
                return 0;
              });
            }
            return results;
          },
          enumerable: true,
          configurable: true,
        });
      }
    }
  }

  registry.endBatch();
}

// ── JSON sub-property helpers ─────────────────────────────────────────────

/**
 * Unwrap a Zod schema through .optional(), .nullable(), .default(),
 * .readonly() to find the innermost type. Needed to detect whether a
 * field.json() call wraps a ZodObject (has sub-properties) or a plain
 * type (ZodUnknown, ZodArray, etc.).
 *
 * Uses Zod's public `.unwrap()` API per wrapper type — no `_def`
 * digging. Bounded loop guards against pathological self-referential
 * wrappers.
 */
function unwrapZodType(schema: z.ZodType): z.ZodType {
  let current: z.ZodType = schema;
  for (let i = 0; i < 10; i++) {
    if (current instanceof z.ZodOptional) {
      current = current.unwrap() as z.ZodType;
      continue;
    }
    if (current instanceof z.ZodNullable) {
      current = current.unwrap() as z.ZodType;
      continue;
    }
    if (current instanceof z.ZodDefault) {
      // Zod v4 unwraps a default via `.unwrap()`, the same runtime function older
      // versions exposed as `removeDefault`.
      current = current.unwrap() as z.ZodType;
      continue;
    }
    if (current instanceof z.ZodReadonly) {
      current = current.unwrap() as z.ZodType;
      continue;
    }
    break;
  }
  return current;
}

/** Type guard: is this a ZodObject with a .shape property? */
function isZodObject(schema: z.ZodType): schema is z.ZodObject<z.ZodRawShape> {
  return schema instanceof z.ZodObject;
}

/** Create a Model subclass for a schema-defined model */
function createDynamicModelClass(
  modelName: string,
  jsonSubFields: { fieldName: string; subSchema: z.ZodObject<z.ZodRawShape> }[],
  fieldNames: string[],
  computed?: Record<string, (self: Record<string, unknown>) => unknown>,
  lazyObservable = false,
) {
  // Names `toReactiveSnapshot` materializes onto plain snapshots: every
  // `${field}Json` getter plus every schema-declared computed. Without this,
  // snapshot rows silently drop getters that the schema's inferred row type
  // declares — reads like `snapshot.settingsObject` would be `undefined`.
  const derivedGetterNames: readonly string[] = Object.freeze([
    ...jsonSubFields.map(({ fieldName }) => `${fieldName}Json`),
    ...Object.keys(computed ?? {}),
  ]);

  const ModelClass = class extends Model {
    private _modelName = modelName;

    override getDerivedGetterNames(): readonly string[] {
      return derivedGetterNames;
    }

    constructor(data?: Record<string, unknown>) {
      super(data);
      const deferObservability =
        Reflect.get(data ?? {}, DEFER_MODEL_OBSERVABILITY) === true;
      // Suppress change tracking during initial hydration. `makeObservable()`
      // installs a listener per schema property that forwards writes to the
      // transaction queue, so direct assignments like `row.position = next` still
      // round-trip. During construction we are writing wire data, not user edits,
      // so this flag lets that listener skip these writes and keeps the set of
      // modified properties from filling up with every field of every hydrated row.
      //
      // The listener is installed by `makeObservable()` below, so writes before
      // that line never reach it; this flag is defensive in case a subclass or call
      // path later reorders the steps.
      (this as { _isConstructing?: boolean })._isConstructing = true;
      // Reactive fields must exist as own properties before `makeObservable()` runs.
      // The base Model sets only id, createdAt, and updatedAt, so schema fields
      // (title, userId, and so on) are initialized here for the annotations to find.
      for (const field of fieldNames) {
        if (!(field in this)) {
          (this as Record<string, unknown>)[field] = data?.[field] ?? undefined;
        }
      }
      // When field-level reactivity is enabled (the default; a model turns it off
      // with `lazyObservable: false`), make each field observable. Without it,
      // reactivity comes only from the coarser entry-replaced pattern, which is
      // cheap for read-only lists but invisible to in-place field mutations.
      //
      // Collaborative editors need field-level reactivity so both remote deltas and
      // local edits surface through observer components without the whole cache
      // entry being replaced. Otherwise an in-place mutation such as
      // `row.position.x = 500` emits nothing and the UI lags until an unrelated
      // change triggers a pass.
      //
      // This delegates to the inherited `Model.makeObservable()` so the annotations
      // come from the same registry the rest of the model reads, keeping computed
      // getters, reference collections, custom getters and setters, and change
      // tracking all consistent; reimplementing it inline here would miss those.
      if (lazyObservable) {
        if (deferObservability) this.deferObservability();
        else this.makeObservable();
      }
      (this as { _isConstructing?: boolean })._isConstructing = false;
    }

    override getModelName(): string {
      return this._modelName;
    }
  };

  // Generate `${field}Json` getters for JSON fields that have sub-properties.
  //
  // Each getter reads the raw JSON from the instance, parses it, applies the
  // sub-schema's defaults, and caches the result keyed by the raw value.
  //
  // Example: a field named `metadata` with sub-schema
  // `{ icon: z.string().default('presentation') }` yields a `metadataJson` getter
  // returning `{ icon: 'presentation', ... }` — typed and cached.
  for (const { fieldName, subSchema } of jsonSubFields) {
    const getterName = `${fieldName}Json`;
    const cacheKey = `__${fieldName}JsonCache`;

    Object.defineProperty(ModelClass.prototype, getterName, {
      get(this: Record<string, unknown>) {
        const raw = this[fieldName];

        // Cache check: same raw value → same parsed result
        const cache = this[cacheKey] as { raw: unknown; parsed: unknown } | undefined;
        if (cache && cache.raw === raw) return cache.parsed;

        // Parse: handle string (from DB/wire), object (already parsed), null/undefined
        let input: unknown;
        try {
          if (typeof raw === 'string') {
            input = JSON.parse(raw);
          } else if (raw && typeof raw === 'object') {
            input = raw;
          } else {
            input = {};
          }
        } catch {
          input = {};
        }

        // Apply Zod parse for type coercion + defaults. safeParse so
        // malformed metadata doesn't crash — falls back to all defaults.
        const result = subSchema.safeParse(input);
        const parsed = result.success ? result.data : subSchema.safeParse({}).data ?? {};

        this[cacheKey] = { raw, parsed };
        return parsed;
      },
      enumerable: true,
      configurable: true,
    });
  }

  // Install schema-declared computed getters on the prototype.
  // Each getter receives `this` (the model instance) and returns the computed value.
  if (computed) {
    for (const [name, fn] of Object.entries(computed)) {
      Object.defineProperty(ModelClass.prototype, name, {
        get(this: Record<string, unknown>) {
          return fn(this);
        },
        enumerable: true,
        configurable: true,
      });
    }
  }

  return ModelClass;
}
