/**
 * ModelRegistry is the source of truth for model metadata: which model classes
 * exist, the properties and references declared on each, the back-references
 * used for cascade handling, and a stable hash of the whole schema.
 * {@link Model} instances resolve their metadata through the active registry,
 * and {@link InstanceCache} uses it to map between model names and constructor
 * classes. References resolve lazily, so a model may declare a reference to
 * another model that is registered later.
 */

// Removed Node.js crypto import for browser compatibility
import {
  type ModelMetadata,
  type PropertyMetadata,
  type ReferenceMetadata,
  PropertyType,
  LoadStrategy,
} from '@abloatai/transaction/types';
import { globalRuntime } from './context.js';
import type { RuntimeContext } from './RuntimeContext.js';
import { AbloValidationError } from '@abloatai/transaction/errors';
// Type-only — erased at runtime, so no Model ↔ ModelRegistry module cycle.
import type { Model } from './Model.js';
import type { ConcreteModelConstructor } from './BaseSyncedStore.js';

/**
 * What callers may hand to {@link ModelRegistry.registerModel}: any concrete
 * `Model` subclass constructor. `never[]` params make every subclass
 * constructor assignable (construct-signature params are contravariant).
 */
export type ModelClassInput = new (...args: never[]) => Model;

/**
 * What the registry hands BACK: a registered model class — concretely
 * constructible with an optional data row (`ConcreteModelConstructor`, the
 * SDK's existing Model-vs-row construction seam) and carrying `Model`'s
 * statics (`fromJSON`, …). `Omit<typeof Model, never>` keeps the statics
 * while stripping the ABSTRACT construct signature (mapped types drop
 * construct signatures), so `new registry.getModelByName(n)!(...)` is legal.
 * The one cast from {@link ModelClassInput} lives at the validated
 * registration boundary below.
 */
export type RegisteredModelClass = Omit<typeof Model, never> &
  ConcreteModelConstructor<Model>;

/**
 * {@link ReferenceMetadata} extended with cascade behavior: what happens to a
 * referencing model when the referenced model is deleted or archived.
 */
export interface ExtendedReferenceMetadata extends ReferenceMetadata {
  onDelete?: 'cascade' | 'nullify' | 'restrict';
  onArchive?: 'cascade' | 'nullify';
}

/**
 * Reference metadata in its serialized form — `referencedModel` is
 * resolved to the model NAME (string), not the lazy constructor
 * thunk. Produced by `exportRegistryData()` and other debug-side
 * paths. A class function would be unserializable JSON; the name is
 * what consumers (devtools, schema-hash inputs) actually want.
 */
export interface SerializedReferenceMetadata
  extends Omit<ExtendedReferenceMetadata, 'referencedModel'> {
  referencedModel: string;
}

/**
 * Metadata that records a child model's foreign key to a parent model, used
 * for cascade-aware transaction handling: when the parent is deleted, the
 * child's pending transactions can be cancelled.
 */
export interface BackReferenceMetadata {
  /** The parent model name (e.g., 'Report') */
  parentModel: string;
  /** The foreign key property on this model (e.g., 'reportId') */
  foreignKey: string;
  /** Whether to cascade-cancel transactions when parent is deleted */
  cascadeDelete: boolean;
}

interface PendingReference {
  modelName: string;
  propertyName: string;
  metadata: ExtendedReferenceMetadata;
}

interface RegistryConfig {
  validateOnRegister?: boolean;
  allowLateReferences?: boolean;
  /** The owning client's runtime. Defaults to the module-global bridge. */
  runtime?: RuntimeContext;
}

/**
 * Module-level active registry. Set by createSyncEngine so that Model instances
 * (which don't receive DI) can look up metadata without static maps.
 */
let _activeRegistry: ModelRegistry | null = null;

export function setActiveRegistry(registry: ModelRegistry): void {
  _activeRegistry = registry;
}

/** Get the active ModelRegistry. Throws if none set. */
export function getActiveRegistry(): ModelRegistry {
  if (!_activeRegistry) {
    throw new AbloValidationError(
      'No active ModelRegistry — call createSyncEngine() first',
      { code: 'registry_not_initialized' },
    );
  }
  return _activeRegistry;
}

/** Whether an active ModelRegistry has been set. */
export function hasActiveRegistry(): boolean {
  return _activeRegistry !== null;
}

/** Clear the active ModelRegistry (tests only). */
export function clearActiveRegistry(): void {
  _activeRegistry = null;
}

export class ModelRegistry {
  private models = new Map<string, RegisteredModelClass>();
  private modelMetadata = new Map<string, ModelMetadata>();
  private properties = new Map<string, Map<string, PropertyMetadata>>();
  private references = new Map<string, Map<string, ExtendedReferenceMetadata>>();
  private pendingReferences = new Map<string, PendingReference[]>();

  // Maps a constructor back to its model name. Keyed as `unknown` on purpose:
  // lookups arrive both as `this.constructor` (a Function) and as typed model
  // classes, and both are accepted without a cast.
  private constructorToModelName = new Map<unknown, string>();

  // Back-references for cascade-aware transaction handling. Maps a child model
  // name to the parent models it references. The inverse direction (parent to
  // children) is derived on demand by `getChildModels`; it is populated here.
  private backReferences = new Map<string, BackReferenceMetadata[]>();

  private schemaHash?: string;
  private config: Required<Omit<RegistryConfig, 'runtime'>>;
  private readonly runtime: RuntimeContext;
  private registeredModels = new Set<string>();

  private pendingHashUpdate = false;

  constructor(config: RegistryConfig = {}) {
    this.config = {
      validateOnRegister: config.validateOnRegister ?? true,
      allowLateReferences: config.allowLateReferences ?? true,
    };
    this.runtime = config.runtime ?? globalRuntime;
  }

  private validateModelConstructor(name: string, constructor: unknown): void {
    if (typeof constructor !== 'function') {
      throw new AbloValidationError(
        `Model ${name} constructor must be a function`,
        { code: 'registry_invalid_constructor' },
      );
    }

    const prototype: unknown = constructor.prototype;
    if (!prototype || typeof prototype !== 'object') {
      throw new AbloValidationError(
        `Model ${name} constructor must have a prototype`,
        { code: 'registry_invalid_constructor' },
      );
    }

    const required = ['updateFromData', 'toJSON', 'getModelName'];
    for (const method of required) {
      if (typeof (prototype as Record<string, unknown>)[method] !== 'function') {
        this.runtime.logger.debug('Model missing required method', name, { method });
      }
    }
  }

  private arePropertiesCompatible(existing: PropertyMetadata, incoming: PropertyMetadata): boolean {
    // For reference-generated ID properties, be more lenient
    // Only check core compatibility, not all metadata fields
    return (
      existing.type === incoming.type &&
      (existing.indexed ?? false) === (incoming.indexed ?? false) &&
      (existing.optional ?? false) === (incoming.optional ?? false)
    );
  }

  private addPendingReference(
    modelName: string,
    propertyName: string,
    metadata: ExtendedReferenceMetadata
  ): void {
    let targetName: string;
    try {
      targetName = metadata.referencedModel()?.name || 'Unknown';
    } catch {
      targetName = 'Unknown';
    }

    let pending = this.pendingReferences.get(targetName);
    if (!pending) {
      pending = [];
      this.pendingReferences.set(targetName, pending);
    }

    pending.push({ modelName, propertyName, metadata });

    this.runtime.logger.debug('Reference deferred', `${modelName}.${propertyName}`, { targetModel: targetName });
  }

  private resolvePendingReferences(targetModelName: string): void {
    const pending = this.pendingReferences.get(targetModelName);
    if (!pending) return;

    for (const ref of pending) {
      try {
        this.completeReferenceRegistration(ref.modelName, ref.propertyName, ref.metadata);
        this.runtime.logger.debug('Reference resolved', `${ref.modelName}.${ref.propertyName}`, {
          targetModel: targetModelName,
        });
      } catch (error) {
        this.runtime.observability.breadcrumb(
          `Failed to resolve reference ${ref.modelName}.${ref.propertyName}`,
          'sync.database',
          'error',
          {
            error: error instanceof Error ? error.message : String(error),
          }
        );
      }
    }

    this.pendingReferences.delete(targetModelName);
  }

  private completeReferenceRegistration(
    modelName: string,
    propertyName: string,
    metadata: ExtendedReferenceMetadata
  ): void {
    let refs = this.references.get(modelName);
    if (!refs) {
      refs = new Map();
      this.references.set(modelName, refs);
    }
    refs.set(propertyName, metadata);

    // Register ID property (skip organizationId as it's handled by models themselves)
    const idPropName = propertyName.endsWith('Id') ? propertyName : `${propertyName}Id`;
    if (idPropName !== 'organizationId') {
      this.registerProperty(modelName, idPropName, {
        type: PropertyType.reference,
        indexed: metadata.indexed || false,
        optional: metadata.nullable || false,
      });
    }

    this.registerProperty(modelName, propertyName, {
      type: PropertyType.referenceModel,
      optional: metadata.nullable || false,
    });

    this.schemaHash = undefined;
  }

  registerModel(
    name: string,
    constructor: ModelClassInput,
    metadata: ModelMetadata = { loadStrategy: LoadStrategy.instant }
  ): void {
    if (this.config.validateOnRegister) {
      this.validateModelConstructor(name, constructor);
    }

    if (this.models.has(name)) {
      this.runtime.logger.debug('Model already registered, skipping', name);
      return;
    }

    this.runtime.logger.debug('Registering model', name);

    // Register. The one cast in this file: input is any Model-subclass
    // constructor (validated above); registered classes are concrete
    // subclasses constructible with `data?` and carrying Model's statics —
    // the shape `RegisteredModelClass` names for every read site.
    const modelClass = constructor as RegisteredModelClass;
    this.models.set(name, modelClass);
    this.modelMetadata.set(name, metadata);

    // Record the reverse mapping from constructor to model name
    this.constructorToModelName.set(constructor, name);

    if (!this.properties.has(name)) {
      this.properties.set(name, new Map());
    }
    if (!this.references.has(name)) {
      this.references.set(name, new Map());
    }

    this.registeredModels.add(name);

    this.resolvePendingReferences(name);

    // Invalidate schema hash
    this.schemaHash = undefined;

    this.runtime.logger.debug('Model registered', name, metadata);
  }

  registerProperty(modelName: string, propertyName: string, metadata: PropertyMetadata): void {
    if (!this.models.has(modelName) && this.config.validateOnRegister) {
      throw new AbloValidationError(
        `Cannot register property for unknown model: ${modelName}`,
        { code: 'registry_unknown_model' },
      );
    }

    let props = this.properties.get(modelName);
    if (!props) {
      props = new Map();
      this.properties.set(modelName, props);
    }

    const existing = props.get(propertyName);
    if (existing) {
      if (this.arePropertiesCompatible(existing, metadata)) {
        // Properties are compatible, skip re-registration
        this.runtime.logger.debug('Property already registered (compatible)', `${modelName}.${propertyName}`);
        return;
      } else {
        throw new AbloValidationError(
          `Property ${modelName}.${propertyName} already registered with incompatible metadata`,
          { code: 'registry_property_conflict' },
        );
      }
    }

    props.set(propertyName, metadata);

    this.schemaHash = undefined;

    this.runtime.logger.debug('Property registered', `${modelName}.${propertyName}`, metadata);
  }

  /**
   * Register reference with lazy resolution
   */
  registerReference(
    modelName: string,
    propertyName: string,
    metadata: ExtendedReferenceMetadata
  ): void {
    // Try to resolve target model
    let targetModelName: string;
    try {
      const targetModel = metadata.referencedModel();
      targetModelName = targetModel?.name;
    } catch {
      // Defer resolution
      if (this.config.allowLateReferences) {
        this.addPendingReference(modelName, propertyName, metadata);
        return;
      }
      throw new AbloValidationError(
        `Cannot resolve reference ${modelName}.${propertyName}`,
        { code: 'registry_reference_unresolved' },
      );
    }

    if (!this.models.has(targetModelName)) {
      if (this.config.allowLateReferences) {
        this.addPendingReference(modelName, propertyName, metadata);
        return;
      }
      throw new AbloValidationError(
        `Reference ${modelName}.${propertyName} points to unknown model ${targetModelName}`,
        { code: 'registry_reference_unknown_target' },
      );
    }

    this.completeReferenceRegistration(modelName, propertyName, metadata);
  }

  /**
   * Register a back-reference for cascade-aware transaction handling.
   *
   * When a parent model is deleted, the transaction queue cancels pending
   * transactions for every child model that declares a back-reference to that
   * parent.
   *
   */
  registerBackReference(childModelName: string, metadata: BackReferenceMetadata): void {
    let refs = this.backReferences.get(childModelName);
    if (!refs) {
      refs = [];
      this.backReferences.set(childModelName, refs);
    }

    // Avoid duplicates
    const exists = refs.some(
      (r) => r.parentModel === metadata.parentModel && r.foreignKey === metadata.foreignKey
    );
    if (!exists) {
      refs.push(metadata);
    }
    // Reverse lookup (parent → children) is derived on demand by
    // `getChildModels`, which scans this map.

    this.runtime.logger.debug('BackReference registered', `${childModelName} -> ${metadata.parentModel}`, {
      foreignKey: metadata.foreignKey,
      cascadeDelete: metadata.cascadeDelete,
    });
  }

  getModelsByLoadStrategy(strategy: LoadStrategy): string[] {
    const models: string[] = [];
    for (const [modelName, metadata] of this.modelMetadata) {
      if (metadata.loadStrategy === strategy) {
        models.push(modelName);
      }
    }
    return models;
  }

  /** Get model name from constructor (production-safe). */
  getModelNameFromConstructor(constructor: unknown): string | undefined {
    return this.constructorToModelName.get(constructor);
  }

  getPropertiesForModel(modelName: string): Map<string, PropertyMetadata> {
    return this.properties.get(modelName) || new Map();
  }

  getRegisteredModelNames(): string[] {
    return Array.from(this.models.keys());
  }

  getModelByName(name: string): RegisteredModelClass | undefined {
    return this.models.get(name);
  }

  hasModel(name: string): boolean {
    return this.models.has(name);
  }

  getMetadata(name: string): ModelMetadata | undefined {
    return this.modelMetadata.get(name);
  }

  getProperties(name: string): Map<string, PropertyMetadata> {
    return this.properties.get(name) || new Map();
  }

  getReferences(name: string): Map<string, ExtendedReferenceMetadata> {
    return this.references.get(name) || new Map();
  }

  getIndexedProperties(modelName: string): string[] {
    const properties = this.getProperties(modelName);
    const indexed: string[] = [];
    for (const [propName, metadata] of properties) {
      if (metadata.indexed) indexed.push(propName);
    }
    return indexed;
  }

  getBackReferences(childModelName: string): BackReferenceMetadata[] {
    return this.backReferences.get(childModelName) || [];
  }

  getChildModels(parentModelName: string): { childModel: string; foreignKey: string }[] {
    // Derive from backReferences
    const children: { childModel: string; foreignKey: string }[] = [];
    for (const [childModel, refs] of this.backReferences) {
      for (const ref of refs) {
        if (ref.parentModel === parentModelName) {
          children.push({ childModel, foreignKey: ref.foreignKey });
        }
      }
    }
    return children;
  }

  /**
   * Compute a stable hash of the registered schema — model names, property
   * types, and their indexed and optional flags. Memoized until the schema
   * changes.
   */
  getSchemaHash(): string {
    if (this.schemaHash) return this.schemaHash;

    const schema: Record<
      string,
      Record<string, { type: PropertyType; indexed: boolean; optional: boolean }>
    > = {};

    for (const [modelName, props] of this.properties) {
      schema[modelName] = {};
      for (const [propName, meta] of props) {
        schema[modelName][propName] = {
          type: meta.type,
          indexed: meta.indexed || false,
          optional: meta.optional || false,
        };
      }
    }

    const canonical = Object.keys(schema)
      .sort()
      .map((modelName) => {
        const props = schema[modelName]!;
        const orderedProps = Object.keys(props)
          .sort()
          .map((propName) => [propName, props[propName]]);
        return [modelName, orderedProps];
      });
    const sorted = JSON.stringify(canonical);

    this.schemaHash = this.simpleHash(sorted);

    this.runtime.logger.debug('Schema hash updated', this.schemaHash);

    return this.schemaHash;
  }

  private simpleHash(str: string): string {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash = hash & hash;
    }
    return Math.abs(hash).toString(16).padStart(8, '0');
  }


  validateReferences(): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    for (const [target, pending] of this.pendingReferences) {
      for (const ref of pending) {
        errors.push(`Unresolved reference: ${ref.modelName}.${ref.propertyName} -> ${target}`);
      }
    }

    for (const [modelName, refs] of this.references) {
      for (const [propName, meta] of refs) {
        try {
          const target = meta.referencedModel();
          if (!this.models.has(target.name)) {
            errors.push(`Invalid reference: ${modelName}.${propName} -> ${target.name}`);
          }
        } catch (error) {
          errors.push(`Cannot resolve reference: ${modelName}.${propName}`);
        }
      }
    }

    const isValid = errors.length === 0;
    if (isValid) {
      this.runtime.logger.info('All model references are valid');
    } else {
      this.runtime.observability.breadcrumb('Reference validation failed', 'sync.database', 'error');
    }

    return {
      valid: isValid,
      errors,
    };
  }


  startBatch(): void {
    this.pendingHashUpdate = false;
  }


  /**
   * End batch registration mode and update schema hash if needed
   */
  endBatch(): void {
    if (this.pendingHashUpdate) {
      this.getSchemaHash(); // This will recalculate if needed
      this.pendingHashUpdate = false;
    }
  }


  clear(): void {
    this.models.clear();
    this.modelMetadata.clear();
    this.properties.clear();
    this.references.clear();
    this.pendingReferences.clear();
    this.registeredModels.clear();
    this.backReferences.clear();
    this.constructorToModelName.clear();
    this.schemaHash = undefined;
    this.pendingHashUpdate = false;

    this.runtime.logger.info('ModelRegistry cleared');
  }


  export() {
    return {
      models: Array.from(this.models.keys()),
      metadata: Object.fromEntries(this.modelMetadata),
      properties: Object.fromEntries(
        Array.from(this.properties.entries()).map(([name, props]) => [
          name,
          Object.fromEntries(props),
        ])
      ),
      references: Object.fromEntries(
        Array.from(this.references.entries()).map(([name, refs]) => [
          name,
          Object.fromEntries(refs),
        ])
      ),
      pending: Object.fromEntries(
        Array.from(this.pendingReferences.entries()).map(([name, refs]) => [
          name,
          refs.map((r) => `${r.modelName}.${r.propertyName}`),
        ])
      ),
      schemaHash: this.getSchemaHash(),
    };
  }

  exportRegistryData(): {
    models: Record<string, string>;
    properties: Record<string, Record<string, PropertyMetadata>>;
    references: Record<string, Record<string, SerializedReferenceMetadata>>;
    metadata: Record<string, ModelMetadata>;
    schemaHash: string;
  } {
    const models: Record<string, string> = {};
    const properties: Record<string, Record<string, PropertyMetadata>> = {};
    const references: Record<string, Record<string, SerializedReferenceMetadata>> = {};
    const metadata: Record<string, ModelMetadata> = {};

    for (const [name, constructor] of this.models) {
      models[name] = constructor.name;
    }

    for (const [modelName, propertyMap] of this.properties) {
      properties[modelName] = {};
      for (const [propName, propMetadata] of propertyMap) {
        properties[modelName][propName] = propMetadata;
      }
    }

    for (const [modelName, referenceMap] of this.references) {
      references[modelName] = {};
      for (const [refName, refMetadata] of referenceMap) {
        try {
          references[modelName][refName] = {
            ...refMetadata,
            referencedModel: refMetadata.referencedModel().name,
          };
        } catch {
          references[modelName][refName] = {
            ...refMetadata,
            referencedModel: 'Unresolved',
          };
        }
      }
    }

    for (const [modelName, modelMetadata] of this.modelMetadata) {
      metadata[modelName] = modelMetadata;
    }

    return {
      models,
      properties,
      references,
      metadata,
      schemaHash: this.getSchemaHash(),
    };
  }

}
