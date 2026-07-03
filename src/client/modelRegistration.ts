/**
 * Schema → Model-class registration — `registerModelsFromSchema` walks the
 * declarative schema and populates the `ModelRegistry`: a dynamic `Model`
 * subclass per model (`createDynamicModelClass`, with `${field}Json` getters,
 * computed getters, and opt-in MobX field observability), property/relation
 * registration, and IDB index selection.
 *
 * Extracted from `Ablo.ts` — the factory calls `registerModelsFromSchema`
 * right after `createInternalComponents` builds the registry. The zod unwrap
 * helpers stay module-local.
 */

import { z } from 'zod';
import type { Schema } from '../schema/schema.js';
import { baseFieldsSchema } from '../schema/schema.js';
import type { ModelRegistry } from '../ModelRegistry.js';
import { Model } from '../Model.js';
import { LoadStrategy, PropertyType } from '../types/index.js';

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
    // Field-level MobX observability is ON BY DEFAULT. A reactive read like
    // `useAblo((a) => a.documents.get(id))` must re-render when a remote delta
    // mutates the row IN PLACE (the common collaborative case); without
    // per-field observability that update fires no reaction and the UI silently
    // goes stale. Models opt OUT with an explicit `lazyObservable: false` —
    // appropriate only for very large read-only list models where per-field
    // atoms cost more than the QueryView's entry-replaced reactivity already
    // provides. json fields register as `observable.ref` (see
    // `registerModelsFromSchema`), so the default is ~one atom per scalar field
    // per loaded row — cheap — not a deep atom tree per blob.
    const isLazy = modelDef.lazyObservable !== false;
    // Base provenance fields (`organizationId`, `createdBy`) live in
    // `baseFieldsSchema`, not the per-model `shape`. The server stamps + emits
    // them (camelCased on the wire), but hydration (`Model.assignFieldsFromData`)
    // only assigns keys that already exist as an own/prototype property — so
    // without a slot here, `deck.createdBy` / `deck.organizationId` silently read
    // `undefined` (this is why the profile decks tab showed nothing: it filters
    // `decks.filter(d => d.createdBy === userId)`). `id`/`createdAt`/`updatedAt`
    // are already seeded by the base Model constructor, so they're excluded.
    const fieldNames = [
      ...Object.keys(modelDef.shape),
      ...Object.keys(baseFieldsSchema.shape).filter(
        (f) => f !== 'id' && f !== 'createdAt' && f !== 'updatedAt' && !(f in modelDef.shape),
      ),
    ];
    const computed = (modelDef as { computed?: Record<string, (self: Record<string, unknown>) => unknown> }).computed;
    const DynamicModel = createDynamicModelClass(modelName, jsonSubFields, fieldNames, computed, isLazy);

    // Respect the schema's load strategy so lazy models skip IDB hydration + bootstrap
    const loadStrategy = modelDef.load === 'lazy' || modelDef.load === 'manual'
      ? LoadStrategy.lazy
      : LoadStrategy.instant;

    registry.registerModel(modelName, DynamicModel, {
      loadStrategy,
      fields: modelDef.fields,
      autoFill: modelDef.autoFill,
      requiredFields: modelDef.requiredFields,
    });

    // Collect the set of fields that should get an IDB secondary index.
    //
    // Matches Linear's opt-in model (see wzhudev/reverse-linear-sync-engine):
    // `@Reference(..., { indexed: true })`. Only `belongsTo` relations that
    // explicitly set `{ index: true }` in their options get an IDB secondary
    // index. Every other FK (and every scalar) is resolved via in-memory
    // ObjectPool scans, which are fast enough at org-scope sizes (~10k rows)
    // and reactive via MobX.
    //
    // Auto-indexing every belongsTo was wrong: it bloated write amplification
    // for the vast majority of FKs that are never queried by fk. Indexing
    // every scalar (like the legacy Go backend did) is even worse.
    const indexedFields = new Set<string>();
    for (const relDef of Object.values(modelDef.relations)) {
      if (relDef.type === 'belongsTo' && relDef.foreignKey && relDef.options?.index === true) {
        indexedFields.add(relDef.foreignKey);
      }
    }

    // Register fields as properties (from Zod shape).
    for (const [fieldName, rawZodType] of Object.entries(modelDef.shape)) {
      const zodType = rawZodType as z.ZodType;
      const isOptional = zodType.isOptional?.() ?? false;
      // A field is indexed if it's the FK of a `belongsTo({ index: true })`
      // relation. Legacy `description === 'indexed'` still works for
      // consumers using `field.*().indexed()`.
      const isIndexed =
        indexedFields.has(fieldName) || zodType.description === 'indexed';
      // JSON-typed fields (per the schema's wire-type tag) are opaque
      // blobs from MobX's perspective — chart specs, ProseMirror docs,
      // style maps. Deep observability on them recursively walks every
      // nested property and creates an atom for each leaf, producing a
      // microtask storm on every commit/streaming update. `ref` tracks
      // only reassignment, which is how blob consumers actually use them.
      const wireType = modelDef.fields?.[fieldName]?.type;
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
      // v4 deprecates removeDefault in favor of unwrap, but the
      // installed @types declarations only expose removeDefault on
      // ZodDefault. Use it — it's the same runtime function.
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
  const ModelClass = class extends Model {
    private _modelName = modelName;

    constructor(data?: Record<string, unknown>) {
      super(data);
      // Gate `propertyChanged`-via-`observe` tracking during initial
      // hydration. M1 installs a MobX `observe()` listener per schema
      // property that forwards writes to `propertyChanged()` so direct
      // assignments like `layer.position = newPos` still round-trip
      // through the transaction queue. During construction we're writing
      // wire data, NOT user edits — flagging this as "constructing" lets
      // the listener early-return on those writes so `modifiedProperties`
      // doesn't get polluted with every field of every hydrated model.
      //
      // The listener is installed by `makeObservable()` below (inside
      // M1), so writes that happen BEFORE that line won't fire it; this
      // flag is defensive in case a subclass or call path reorders the
      // steps later.
      (this as { _isConstructing?: boolean })._isConstructing = true;
      // MobX 6 requires fields to exist as own properties BEFORE makeObservable().
      // Model base only sets id/createdAt/updatedAt. Schema fields (title, userId, etc.)
      // must be initialized here so M1's annotations can find them.
      for (const field of fieldNames) {
        if (!(field in this)) {
          (this as Record<string, unknown>)[field] = data?.[field] ?? undefined;
        }
      }
      // Per-field MobX observability opt-in via `lazyObservable: true` on
      // the model definition. Defaults to plain objects — reactivity comes
      // from the QueryView "entry replaced" pattern, which is cheap for
      // read-only list UIs but invisible to in-place field mutations.
      //
      // Multiplayer editors need live field-level reactivity so remote
      // deltas AND local drag/resize/rename mutations surface through
      // `observer()` components without the whole pool entry being
      // replaced. Without observability, `layer.position.x = 500` emits
      // nothing and the UI lags until some unrelated state change triggers
      // a pass (toolbar close, deselect).
      //
      // Delegates to `Model.makeObservable()` (the inherited method) so
      // MobX annotations are derived from the same registry that M1 reads.
      // That means computed getters, reference collections, custom
      // getters/setters, and property-change tracking all integrate
      // correctly — reimplementing `makeObservable` inline here would miss
      // those seams.
      if (lazyObservable) {
        this.makeObservable();
      }
      (this as { _isConstructing?: boolean })._isConstructing = false;
    }

    override getModelName(): string {
      return this._modelName;
    }
  };

  // Generate ${field}Json getters for JSON fields with sub-properties.
  //
  // The getter reads the raw JSON string from the instance (set via
  // updateFromData), parses it, applies Zod defaults, and caches by
  // raw value. This replaces the hand-coded metadataObject + sub-property
  // getter pattern that 11+ Ablo models currently repeat.
  //
  // Example: field named 'metadata' with sub-schema { icon: z.string().default('presentation') }
  // → model.metadataJson returns { icon: 'presentation', ... } (typed, cached)
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
