/**
 * ModelRegistry - Type-safe model metadata management
 *
 * Key improvements:
 * - Instance-based for better testing
 * - Validation at registration
 * - Lazy reference resolution
 * - Crypto-based schema hashing
 * - Comprehensive error reporting
 * - Best practices from Linear Sync Engine
 */

// Removed Node.js crypto import for browser compatibility
import {
  ModelMetadata,
  PropertyMetadata,
  ReferenceMetadata,
  PropertyType,
  LoadStrategy,
} from './types/index.js';
import { getContext } from './context.js';
import { AbloValidationError } from './errors.js';

/**
 * Extended ReferenceMetadata with additional Linear-style options
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
 * BackReference metadata for cascade-aware transaction handling
 * Linear pattern: When parent is deleted, cancel pending transactions for children
 */
export interface BackReferenceMetadata {
  /** The parent model name (e.g., 'SlideDeck') */
  parentModel: string;
  /** The foreign key property on this model (e.g., 'deckId') */
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
}

/**
 * Module-level active registry. Set by createSyncEngine so that Model instances
 * (which don't receive DI) can look up metadata without static maps.
 */
let _activeRegistry: ModelRegistry | null = null;

/** Set the active ModelRegistry instance (called by createSyncEngine) */
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
  private models = new Map<string, any>();
  private modelMetadata = new Map<string, ModelMetadata>();
  private properties = new Map<string, Map<string, PropertyMetadata>>();
  private references = new Map<string, Map<string, ExtendedReferenceMetadata>>();
  private pendingReferences = new Map<string, PendingReference[]>();

  // 🔧 PROPER FIX: Static mapping from constructor to model name
  private constructorToModelName = new Map<any, string>();

  // LINEAR PATTERN: BackReferences for cascade-aware transaction handling.
  // Maps childModelName → BackReferenceMetadata[] (which parent models
  // own this child). The inverse direction (parentModelName → children)
  // is derived on demand by `getChildModels`, populated only here.
  private backReferences = new Map<string, BackReferenceMetadata[]>();

  private schemaHash?: string;
  private config: Required<RegistryConfig>;
  private registeredModels = new Set<string>();

  private batchMode = false;
  private pendingHashUpdate = false;

  constructor(config: RegistryConfig = {}) {
    this.config = {
      validateOnRegister: config.validateOnRegister ?? true,
      allowLateReferences: config.allowLateReferences ?? true,
    };
  }

  private validateModelConstructor(name: string, constructor: any): void {
    if (typeof constructor !== 'function') {
      throw new AbloValidationError(
        `Model ${name} constructor must be a function`,
        { code: 'registry_invalid_constructor' },
      );
    }

    if (!constructor.prototype) {
      throw new AbloValidationError(
        `Model ${name} constructor must have a prototype`,
        { code: 'registry_invalid_constructor' },
      );
    }

    // Check for required methods
    const required = ['updateFromData', 'toJSON', 'getModelName'];
    for (const method of required) {
      if (typeof constructor.prototype[method] !== 'function') {
        getContext().logger.debug('Model missing required method', name, { method });
      }
    }
  }

  private arePropertiesCompatible(existing: PropertyMetadata, incoming: PropertyMetadata): boolean {
    // For reference-generated ID properties, be more lenient
    // Only check core compatibility, not all metadata fields
    return (
      existing.type === incoming.type &&
      // For indexed, treat undefined as false for comparison
      (existing.indexed ?? false) === (incoming.indexed ?? false) &&
      // For optional, treat undefined as false for comparison
      (existing.optional ?? false) === (incoming.optional ?? false)
    );
  }

  private addPendingReference(
    modelName: string,
    propertyName: string,
    metadata: ExtendedReferenceMetadata
  ): void {
    // Get target model name
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

    getContext().logger.debug('Reference deferred', `${modelName}.${propertyName}`, { targetModel: targetName });
  }

  private resolvePendingReferences(targetModelName: string): void {
    const pending = this.pendingReferences.get(targetModelName);
    if (!pending) return;

    for (const ref of pending) {
      try {
        this.completeReferenceRegistration(ref.modelName, ref.propertyName, ref.metadata);
        getContext().logger.debug('Reference resolved', `${ref.modelName}.${ref.propertyName}`, {
          targetModel: targetModelName,
        });
      } catch (error) {
        getContext().observability.breadcrumb(
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
    // Store reference
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

    // Register model property
    this.registerProperty(modelName, propertyName, {
      type: PropertyType.referenceModel,
      optional: metadata.nullable || false,
    });

    this.schemaHash = undefined;
  }

  /**
   * Register a model with validation
   */
  registerModel(
    name: string,
    constructor: any,
    metadata: ModelMetadata = { loadStrategy: LoadStrategy.instant }
  ): void {
    // Validate
    if (this.config.validateOnRegister) {
      this.validateModelConstructor(name, constructor);
    }

    // Check for duplicate
    if (this.models.has(name)) {
      getContext().logger.debug('Model already registered, skipping', name);
      return;
    }

    getContext().logger.debug('Registering model', name);

    // Register
    this.models.set(name, constructor);
    this.modelMetadata.set(name, metadata);

    // 🔧 PROPER FIX: Create reverse mapping from constructor to model name
    this.constructorToModelName.set(constructor, name);

    // Initialize property maps
    if (!this.properties.has(name)) {
      this.properties.set(name, new Map());
    }
    if (!this.references.has(name)) {
      this.references.set(name, new Map());
    }

    // Mark as registered
    this.registeredModels.add(name);

    // Resolve pending references to this model
    this.resolvePendingReferences(name);

    // Invalidate schema hash
    this.schemaHash = undefined;

    getContext().logger.debug('Model registered', name, metadata);
  }

  /**
   * Register property with validation
   */
  registerProperty(modelName: string, propertyName: string, metadata: PropertyMetadata): void {
    // Validate model exists
    if (!this.models.has(modelName) && this.config.validateOnRegister) {
      throw new AbloValidationError(
        `Cannot register property for unknown model: ${modelName}`,
        { code: 'registry_unknown_model' },
      );
    }

    // Get or create property map
    let props = this.properties.get(modelName);
    if (!props) {
      props = new Map();
      this.properties.set(modelName, props);
    }

    // Check for conflicts
    const existing = props.get(propertyName);
    if (existing) {
      if (this.arePropertiesCompatible(existing, metadata)) {
        // Properties are compatible, skip re-registration
        getContext().logger.debug('Property already registered (compatible)', `${modelName}.${propertyName}`);
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

    getContext().logger.debug('Property registered', `${modelName}.${propertyName}`, metadata);
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

    // Validate target exists or defer
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

    // Complete registration
    this.completeReferenceRegistration(modelName, propertyName, metadata);
  }

  /**
   * LINEAR PATTERN: Register a back-reference for cascade-aware transaction handling
   *
   * When a parent model is deleted, the TransactionQueue will cancel pending
   * transactions for all child models that have a backReference to that parent.
   *
   * @param childModelName - The model that has a FK to the parent (e.g., 'Slide')
   * @param metadata - BackReference configuration
   */
  registerBackReference(childModelName: string, metadata: BackReferenceMetadata): void {
    // Add to instance map
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

    getContext().logger.debug('BackReference registered', `${childModelName} -> ${metadata.parentModel}`, {
      foreignKey: metadata.foreignKey,
      cascadeDelete: metadata.cascadeDelete,
    });
  }

  /** Get all models with specific load strategy. */
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
  getModelNameFromConstructor(constructor: any): string | undefined {
    return this.constructorToModelName.get(constructor);
  }

  /** Get properties for a model. */
  getPropertiesForModel(modelName: string): Map<string, PropertyMetadata> {
    return this.properties.get(modelName) || new Map();
  }

  /**
   * Get all registered model names for this instance
   */
  getRegisteredModelNames(): string[] {
    return Array.from(this.models.keys());
  }

  /** Get model constructor by name */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getModelByName(name: string): any {
    return this.models.get(name);
  }

  /** Check if model is registered */
  hasModel(name: string): boolean {
    return this.models.has(name);
  }

  /** Get model metadata by name */
  getMetadata(name: string): ModelMetadata | undefined {
    return this.modelMetadata.get(name);
  }

  /** Get properties for a model */
  getProperties(name: string): Map<string, PropertyMetadata> {
    return this.properties.get(name) || new Map();
  }

  /** Get references for a model */
  getReferences(name: string): Map<string, ExtendedReferenceMetadata> {
    return this.references.get(name) || new Map();
  }

  /** Get indexed properties for a model */
  getIndexedProperties(modelName: string): string[] {
    const properties = this.getProperties(modelName);
    const indexed: string[] = [];
    for (const [propName, metadata] of properties) {
      if (metadata.indexed) indexed.push(propName);
    }
    return indexed;
  }

  /** Get back-references for a child model */
  getBackReferences(childModelName: string): BackReferenceMetadata[] {
    return this.backReferences.get(childModelName) || [];
  }

  /** Get child models for a parent */
  getChildModels(parentModelName: string): Array<{ childModel: string; foreignKey: string }> {
    // Derive from backReferences
    const children: Array<{ childModel: string; foreignKey: string }> = [];
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
   * Calculate schema hash using crypto
   */
  getSchemaHash(): string {
    if (this.schemaHash) return this.schemaHash;

    const schema: any = {};

    // Build schema object
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

    // Sort and stringify
    const sorted = JSON.stringify(schema, Object.keys(schema).sort());

    // Create hash - browser-compatible simple hash
    this.schemaHash = this.simpleHash(sorted);

    getContext().logger.debug('Schema hash updated', this.schemaHash);

    return this.schemaHash;
  }

  /**
   * Browser-compatible hash function
   */
  private simpleHash(str: string): string {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash = hash & hash; // Convert to 32bit integer
    }
    return Math.abs(hash).toString(16).padStart(8, '0');
  }

  /**
   * Static wrapper for backward compatibility
   */

  /**
   * Validate all references
   */
  validateReferences(): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    // Check pending references
    for (const [target, pending] of this.pendingReferences) {
      for (const ref of pending) {
        errors.push(`Unresolved reference: ${ref.modelName}.${ref.propertyName} -> ${target}`);
      }
    }

    // Check resolved references
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
      getContext().logger.info('All model references are valid');
    } else {
      getContext().observability.breadcrumb('Reference validation failed', 'sync.database', 'error');
    }

    return {
      valid: isValid,
      errors,
    };
  }

  /**
   * Static wrapper for backward compatibility
   */

  /**
   * Start batch registration mode to optimize performance
   */
  startBatch(): void {
    this.batchMode = true;
    this.pendingHashUpdate = false;
  }

  /**
   * Static wrapper for backward compatibility
   */

  /**
   * End batch registration mode and update schema hash if needed
   */
  endBatch(): void {
    this.batchMode = false;
    if (this.pendingHashUpdate) {
      this.getSchemaHash(); // This will recalculate if needed
      this.pendingHashUpdate = false;
    }
  }

  /**
   * Static wrapper for backward compatibility
   */

  /**
   * Clear registry
   */
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
    this.batchMode = false;
    this.pendingHashUpdate = false;

    getContext().logger.info('ModelRegistry cleared');
  }

  /**
   * Static wrapper for backward compatibility
   */

  /**
   * Export for debugging
   */
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

  /**
   * Export registry data for debugging (backward compatibility)
   */
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

    // Export models
    for (const [name, constructor] of this.models) {
      models[name] = constructor.name;
    }

    // Export properties
    for (const [modelName, propertyMap] of this.properties) {
      properties[modelName] = {};
      for (const [propName, propMetadata] of propertyMap) {
        properties[modelName][propName] = propMetadata;
      }
    }

    // Export references
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

    // Export metadata
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

  /**
   * Static wrapper for backward compatibility
   */
}
