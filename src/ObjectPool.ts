/**
 * ObjectPool - In-memory model cache with deduplication
 *
 * Pure memory management without database or registry dependencies.
 * Uses static ModelRegistry for model class lookup only.
 */

import { makeObservable, observable, action, computed, runInAction, set } from 'mobx';
import { Model } from './Model';
import { ModelRegistry } from './ModelRegistry';
import { getContext } from './context';
import { AbloValidationError } from './errors';
import { ModelScope } from './types';
import { ViewRegistry } from './core/ViewRegistry';
import { QueryView, type QueryViewOptions } from './core/QueryView';

/** Constructor type for Model subclasses - uses abstract to handle variance */
type ModelConstructor<T extends Model> = abstract new (...args: never[]) => T;

// Re-export so existing `import { ModelScope } from './ObjectPool'` still resolves
export { ModelScope };

interface ModelEntry {
  model: Model | null; // null when using WeakRef-based GC
  scope: ModelScope;
  weakRef?: WeakRef<Model>;
}

interface PoolConfig {
  maxSize?: number;
  maxAge?: number;
  gcInterval?: number;
  useWeakRefs?: boolean;
}

interface DeltaInfo {
  action?: string;
  syncId?: number;
}

/**
 * ObjectPool - Pure in-memory model cache with deduplication
 */
export class ObjectPool {
  // Single source of truth for all models (observable for reactivity)
  private entries = observable.map<string, ModelEntry>();
  private typeIndex = observable.map<string, Set<string>>();

  // Non-observable access time tracking — kept outside observable.map so that
  // updating timestamps in get() during React render does NOT trigger MobX
  // reactions (which would cause infinite re-render loops).
  private accessTimes = new Map<string, number>();

  // Deduplication tracking
  private recentAdditions = new Map<string, number>(); // "modelType:modelId" -> timestamp
  private deltaHistory = new Map<
    string,
    {
      lastAction: string;
      lastSyncId: number;
      timestamp: number;
    }
  >();

  // No intermediate cache layer — getByType() reads typeIndex + entries directly.
  // This follows Linear's sync engine pattern: observable data structures ARE the
  // reactivity source. No computed getters with conditional cache invalidation.

  // Foreign key indexes: Map<"ModelType:fieldName", Map<fieldValue, ObservableSet<modelId>>>
  // Enables O(1) lookups like "all SlideLayer models where slideId = X"
  // instead of scanning all models of a type and filtering.
  private foreignKeyIndexes = new Map<string, Map<string, Set<string>>>();
  // Registry of which fields to index: Map<modelName, fieldName[]>
  private foreignKeyConfig = new Map<string, string[]>();

  // Performance tracking
  private metrics = {
    hits: 0,
    misses: 0,
    evictions: 0,
    additions: 0,
    duplicatesSkipped: 0,
  };

  // Configuration
  private config: Required<PoolConfig>;
  private gcTimer?: NodeJS.Timeout;

  // ModelRegistry instance — single source of truth for model metadata
  readonly registry: ModelRegistry;

  // ViewRegistry — tracks active QueryViews for incremental view maintenance
  readonly viewRegistry: ViewRegistry = new ViewRegistry();

  constructor(config: PoolConfig = {}, modelRegistry?: ModelRegistry) {
    this.config = {
      maxSize: config.maxSize ?? 10000,
      // Idle-eviction disabled by default. The 5-minute default used to
      // live here, but with schema-driven dynamic classes not
      // registering `LazyReferenceCollection`s, the
      // `hasObservedCollections()` guard in gc() didn't fire for most
      // actively-rendered models — and they'd evict out from under a
      // user whose tab sat for 10 minutes. Memory pressure relief is
      // handled by the `maxSize` LRU cap (see `evictOldest`), which is
      // the bound that actually matches usage: "keep the most recent N
      // entities, not the entities touched in the last N minutes."
      //
      // Callers who genuinely want time-based eviction can pass an
      // explicit `maxAge`. Leaving the default at Infinity keeps
      // correctness as the default and makes aggressive GC an opt-in.
      maxAge: config.maxAge ?? Number.POSITIVE_INFINITY,
      gcInterval: config.gcInterval ?? 60000, // 1 minute
      useWeakRefs: config.useWeakRefs ?? true,
    };

    // 🔧 PROPER FIX: Store model registry reference
    if (!modelRegistry) {
      throw new AbloValidationError(
        'ObjectPool requires ModelRegistry for production-safe model name lookup',
        { code: 'pool_registry_missing' },
      );
    }
    this.registry = modelRegistry;

    // 🔧 PRODUCTION FIX: Defer type index initialization until first use
    // This allows models to be registered after ObjectPool creation
    // Type indexes will be initialized on first getByType call

    // Linear-style: no computed cache layer. entries + typeIndex are both observable.
    // getByType() reads them directly, so MobX always tracks the dependency.
    makeObservable(this, {
      add: action,
      addBatch: action,
      upsertBatch: action,
      removeBatch: action,
      addToArchive: action,
      remove: action,
      removeFromArchive: action,
      clear: action,
      updateScope: action,
      size: computed,
    });

    this.startGC();
  }

  /**
   * 🔧 PRODUCTION FIX: Initialize type indexes for all registered models
   * This prevents the "No type index found" error in production where constructor
   * references are lost due to minification.
   */
  private initializeTypeIndexes(): void {
    const names = this.registry.getRegisteredModelNames();
    for (const modelName of names) {
      if (!this.typeIndex.has(modelName)) {
        this.typeIndex.set(modelName, observable.set<string>());
      }
    }
  }

  // No computed getters — getByType() reads typeIndex + entries directly.
  // This eliminates the conditional dependency bug where MobX lost tracking
  // because _cacheInvalid (non-observable) gated whether entries was read.

  // _rebuildCaches and _invalidateCache removed — no cache layer to manage.
  // typeIndex + entries are observable and read directly by getByType().

  private resolveModel(entry: ModelEntry, id?: string): Model | undefined {
    if (entry.model) return entry.model;
    if (entry.weakRef) {
      const model = entry.weakRef.deref();
      if (model) {
        entry.model = model;
        if (id) this.accessTimes.set(id, Date.now());
        return model;
      }
    }
    return undefined;
  }

  get<T extends Model = Model>(id: string): T | undefined {
    const entry = this.entries.get(id);

    if (!entry) {
      runInAction(() => {
        this.metrics.misses++;
      });
      return undefined;
    }

    let model = entry.model as T | undefined;

    if (!model && entry.weakRef) {
      const restoredModel = entry.weakRef.deref();
      if (!restoredModel) {
        runInAction(() => {
          this.entries.delete(id);
          this.removeFromTypeIndex(id, entry.model?.getModelName());
          this.metrics.misses++;
        });
        return undefined;
      }
      model = restoredModel as T;
      runInAction(() => {
        entry.model = restoredModel;
      });
    }

    // Never return disposed models — they are logically removed and may have
    // torn-down internal state. Callers (e.g. flushPendingDeltas) must not
    // receive a disposed reference that will throw on updateFromData().
    if (model?.disposed) {
      return undefined;
    }

    // Update access time in non-observable map — prevents MobX reactions during render
    this.accessTimes.set(id, Date.now());
    this.metrics.hits++;

    return model ?? undefined;
  }

  /**
   * Add model with deduplication support
   */
  add(model: Model, scope: ModelScope = ModelScope.live, deltaInfo?: DeltaInfo): void {
    const id = model.id;
    const modelType = model.getModelName();
    const addKey = `${modelType}:${id}`;

    // Debug logging for InboxItem and Event to track UUIDs (dev only)
    if (
      (modelType === 'InboxItem' || modelType === 'Event') &&
      process.env.NODE_ENV !== 'production'
    ) {
      console.log(`[ObjectPool.add] Adding ${modelType}`, {
        id: typeof id === 'string' && id.length > 10 ? id : `NUMERIC: ${id}`,
        idType: typeof id,
        modelType,
        scope,
      });

      // Check for existing entry with different type
      const existingEntry = this.entries.get(id);
      if (existingEntry) {
        const existingType = existingEntry.model?.getModelName();
        if (existingType && existingType !== modelType) {
          console.error('⚠️ ID COLLISION DETECTED - Different types sharing same ID!', {
            newType: modelType,
            existingType,
            id: id,
            willSkip: !existingEntry.model?.disposed,
          });
        }
      }
    }

    // Debug logging for Dataroom
    if (modelType === 'Dataroom' && process.env.NODE_ENV !== 'production') {
      console.log('[ObjectPool.add] Adding Dataroom', {
        id: (id as string).slice(0, 8),
        modelType,
        scope,
        hasTypeIndex: this.typeIndex.has(modelType),
        typeIndexSize: this.typeIndex.get(modelType)?.size || 0,
      });
    }

    // Ensure type index exists for this model type
    if (!this.typeIndex.has(modelType)) {
      this.typeIndex.set(modelType, observable.set<string>());
      if (modelType === 'Dataroom' && process.env.NODE_ENV !== 'production') {
        console.log('[ObjectPool.add] Created new type index for Dataroom');
      }
    }

    // Check if model already exists to prevent duplicates
    const existingEntry = this.entries.get(id);
    if (existingEntry && existingEntry.model && !existingEntry.model.disposed) {
      // Model already exists and is valid, update its scope if needed
      if (existingEntry.scope !== scope) {
        runInAction(() => {
          this.entries.set(id, { ...existingEntry, scope });
        });
        this.accessTimes.set(id, Date.now());
      }
      this.metrics.duplicatesSkipped++;
      return;
    }

    // Check rapid additions (within 50ms) for better deduplication
    const lastAdded = this.recentAdditions.get(addKey);
    if (lastAdded && Date.now() - lastAdded < 50) {
      this.metrics.duplicatesSkipped++;
      return;
    }

    // Check delta history for duplicate processing
    if (deltaInfo?.syncId) {
      const history = this.deltaHistory.get(addKey);

      if (history) {
        // Skip if we've already processed a newer or equal sync ID
        if (history.lastSyncId >= deltaInfo.syncId) {
          this.metrics.duplicatesSkipped++;
          return;
        }

        // Warn about suspicious patterns
        if (
          deltaInfo.action === 'I' &&
          (history.lastAction === 'U' || history.lastAction === 'D')
        ) {
          if (process.env.NODE_ENV === 'development') {
            console.warn(`ObjectPool.add() SUSPICIOUS: INSERT after ${history.lastAction}`, {
              modelType,
              id,
              syncId: deltaInfo.syncId,
            });
          }
        }
      }

      // Update delta history
      this.deltaHistory.set(addKey, {
        lastAction: deltaInfo.action || 'U',
        lastSyncId: deltaInfo.syncId,
        timestamp: Date.now(),
      });
    }

    // Track this addition
    this.recentAdditions.set(addKey, Date.now());

    // Clean old tracking entries periodically
    if (this.recentAdditions.size > 100) {
      this.cleanupTracking();
    }

    // Note: existingEntry check is now done earlier for better deduplication

    if (this.entries.size >= this.config.maxSize) {
      this.evictOldest();
    }

    const entry: ModelEntry = {
      model,
      scope,
    };

    if (this.config.useWeakRefs && this.isLargeModel(model)) {
      entry.weakRef = new WeakRef(model);
    }

    this.accessTimes.set(id, Date.now());
    runInAction(() => {
      this.entries.set(id, entry);
      this.addToTypeIndex(id, model.getModelName());
      this.metrics.additions++;
    });
    // No cache to invalidate — typeIndex + entries are directly observable

    // Notify views of the addition
    this.viewRegistry.notifyAdded(modelType, model);

    // Debug logging for Dataroom after successful add
    if (modelType === 'Dataroom' && process.env.NODE_ENV !== 'production') {
      console.log('[ObjectPool.add] Dataroom added', {
        id: (id as string).slice(0, 8),
        typeIndexSize: this.typeIndex.get(modelType)?.size || 0,
        typeIndexHasEntry: this.typeIndex.get(modelType)?.has(id),
        totalEntriesInPool: this.entries.size,
      });
    }
  }

  /**
   * Upsert a model - INSERT if new, UPDATE if exists
   *
   * Unlike add() which ignores data for existing IDs, upsert() will:
   * - Add the model if it doesn't exist
   * - Update the existing model's data if it does exist
   *
   * Use this when you have new data that should replace existing data,
   * such as when processing server deltas.
   */
  upsert(model: Model, scope: ModelScope = ModelScope.live): void {
    const id = model.id;
    const existingEntry = this.entries.get(id);

    if (existingEntry?.model && !existingEntry.model.disposed) {
      // Model exists - update it in-place
      const existingModel = existingEntry.model;

      // Skip updateFromData if same instance - preserves _local changes for client mutations
      if (model !== existingModel) {
        existingModel.updateFromData(model.toJSON());
      }

      // Update scope if different
      if (existingEntry.scope !== scope) {
        runInAction(() => {
          this.entries.set(id, { ...existingEntry, scope });
        });
        this.accessTimes.set(id, Date.now());
      }

      // Notify views of the update
      this.viewRegistry.notifyUpdated(existingModel.getModelName(), existingModel);
    } else {
      // Model doesn't exist - add it (add() already notifies views)
      this.add(model, scope);
    }
  }

  /**
   * Batch add models - optimized for hydration
   * All models are added in a single MobX action to minimize reactivity overhead
   */
  addBatch(models: Model[], scope: ModelScope = ModelScope.live): number {
    if (models.length === 0) return 0;

    let addedCount = 0;
    const now = Date.now();

    // Process all models in a single action to avoid per-item reaction cycles
    for (const model of models) {
      const id = model.id;
      const modelType = model.getModelName();

      // Ensure type index exists
      if (!this.typeIndex.has(modelType)) {
        this.typeIndex.set(modelType, observable.set<string>());
      }

      // Skip if model already exists and is valid
      const existingEntry = this.entries.get(id);
      if (existingEntry && existingEntry.model && !existingEntry.model.disposed) {
        if (existingEntry.scope !== scope) {
          this.entries.set(id, { ...existingEntry, scope });
          this.accessTimes.set(id, now);
        }
        this.metrics.duplicatesSkipped++;
        continue;
      }

      // Evict if at capacity
      if (this.entries.size >= this.config.maxSize) {
        this.evictOldest();
      }

      const entry: ModelEntry = {
        model,
        scope,
      };
      this.accessTimes.set(id, now);

      if (this.config.useWeakRefs && this.isLargeModel(model)) {
        entry.weakRef = new WeakRef(model);
      }

      this.entries.set(id, entry);
      this.addToTypeIndex(id, modelType);
      // Populate the foreign-key indexes. The single-item `add()` path
      // does this; `addBatch()` used to skip it, which meant every
      // layer / sheet cell / message that came in through a bulk
      // loader (`ensureDeckLayers`, `prefetchSlideLayers`, bootstrap
      // hydration) was in the pool but invisible to `hasMany` lookups
      // — `slide.layers` returned `[]` until the user clicked a layer
      // and SOMETHING else ran a non-batch `add` that happened to
      // populate the FK index as a side effect. The UX symptom was
      // "slides show empty until you click on one." Adding this one
      // line closes the gap.
      this.addToForeignKeyIndex(id, model, modelType);
      this.metrics.additions++;
      addedCount++;

      // Notify views of the addition
      this.viewRegistry.notifyAdded(modelType, model);
    }

    // No cache to invalidate — typeIndex + entries are directly observable

    return addedCount;
  }

  /**
   * Batch upsert models - optimized for delta processing.
   * All upserts happen in a single MobX action to minimize reactivity overhead.
   */
  upsertBatch(models: Model[], scope: ModelScope = ModelScope.live): void {
    if (models.length === 0) return;

    for (const model of models) {
      const id = model.id;
      const existingEntry = this.entries.get(id);

      if (existingEntry?.model && !existingEntry.model.disposed) {
        if (model !== existingEntry.model) {
          existingEntry.model.updateFromData(model.toJSON());
        }
        if (existingEntry.scope !== scope) {
          this.entries.set(id, { ...existingEntry, scope });
          this.accessTimes.set(id, Date.now());
        }
        // Notify views of the update
        this.viewRegistry.notifyUpdated(existingEntry.model.getModelName(), existingEntry.model);
      } else {
        // Delegate to inline add logic (same as addBatch internals)
        const modelType = model.getModelName();
        if (!this.typeIndex.has(modelType)) {
          this.typeIndex.set(modelType, observable.set<string>());
        }
        if (this.entries.size >= this.config.maxSize) {
          this.evictOldest();
        }
        const entry: ModelEntry = { model, scope };
        this.accessTimes.set(id, Date.now());
        if (this.config.useWeakRefs && this.isLargeModel(model)) {
          entry.weakRef = new WeakRef(model);
        }
        this.entries.set(id, entry);
        this.addToTypeIndex(id, modelType);
        this.metrics.additions++;
        // Notify views of the addition
        this.viewRegistry.notifyAdded(modelType, model);
      }
    }

    // No cache to invalidate — typeIndex + entries are directly observable
  }

  /**
   * Batch remove models by ID - optimized for delta processing.
   * All removals happen in a single MobX action to minimize reactivity overhead.
   * Returns the number of models actually removed.
   */
  removeBatch(ids: string[]): number {
    if (ids.length === 0) return 0;

    let removedCount = 0;

    for (const id of ids) {
      const entry = this.entries.get(id);
      if (!entry) continue;

      const modelName = entry.model?.getModelName() || entry.weakRef?.deref()?.getModelName();

      this.entries.delete(id);
      this.removeFromTypeIndex(id, modelName);

      // Notify views of the removal before disposing
      if (modelName) {
        this.viewRegistry.notifyRemoved(modelName, id);
      }

      const model = entry.model || entry.weakRef?.deref();
      model?.dispose?.();

      const addKey = modelName ? `${modelName}:${id}` : id;
      this.recentAdditions.delete(addKey);
      this.deltaHistory.delete(addKey);
      this.accessTimes.delete(id);

      removedCount++;
    }

    // No cache to invalidate — typeIndex + entries are directly observable

    return removedCount;
  }

  /**
   * Read-only accessor for entity IDs by model type.
   * Used by applyBootstrapToPool() and rehydrateFromDatabase() for ghost detection.
   */
  getIdsByModelType(modelType: string): ReadonlySet<string> | undefined {
    return this.typeIndex.get(modelType);
  }

  addToArchive(model: Model): void {
    this.add(model, ModelScope.archived);
  }

  remove(id: string): boolean {
    const entry = this.entries.get(id);
    if (!entry) return false;

    const modelName = entry.model?.getModelName() || entry.weakRef?.deref()?.getModelName();

    runInAction(() => {
      this.entries.delete(id);
      this.removeFromTypeIndex(id, modelName);
    });
    // No cache to invalidate — typeIndex + entries are directly observable

    // Notify views of the removal before disposing
    if (modelName) {
      this.viewRegistry.notifyRemoved(modelName, id);
    }

    const model = entry.model || entry.weakRef?.deref();
    model?.dispose?.();

    // Clean tracking
    const addKey = modelName ? `${modelName}:${id}` : id;
    this.recentAdditions.delete(addKey);
    this.deltaHistory.delete(addKey);
    this.accessTimes.delete(id);

    return true;
  }

  removeFromArchive(id: string): boolean {
    const entry = this.entries.get(id);
    if (!entry || entry.scope !== ModelScope.archived) {
      return false;
    }
    return this.remove(id);
  }

  getByType(
    modelClass: ModelConstructor<Model>,
    scope: ModelScope = ModelScope.all
  ): Model[] {
    // Linear-style: read typeIndex + entries directly. Both are observable maps,
    // so MobX always tracks the dependency — no conditional cache path.
    let actualModelName = this.registry.getModelNameFromConstructor(modelClass);
    if (!actualModelName) {
      actualModelName = this.registry.getModelNameFromConstructor(modelClass);

      if (!actualModelName) {
        try {
          const ConcreteClass = modelClass as new (data: Record<string, unknown>) => Model;
          const tempInstance = new ConcreteClass({});
          actualModelName = tempInstance.getModelName();

          // Fallback resolved — hand-coded class not in registry but name matches.
          // This is expected during migration from hand-coded → dynamic models.
        } catch (e) {
          getContext().observability.breadcrumb(
            `Failed to create fallback instance for ${modelClass.name}`,
            'sync.database',
            'error',
            {
              error: e instanceof Error ? e.message : String(e),
            }
          );
          return [];
        }
      }
    }

    // Read from typeIndex (observable) to get IDs for this model type
    const ids = this.typeIndex.get(actualModelName || '');
    if (!ids || ids.size === 0) {
      return [];
    }

    // Resolve each ID from entries (observable) with scope filtering.
    // Note: we do NOT check `instanceof modelClass` because schema-generated
    // dynamic classes and hand-coded classes are different constructors that
    // both represent the same model type. The typeIndex lookup by name is
    // authoritative — if the name matched, the model belongs to this type.
    const result: Model[] = [];
    for (const id of ids) {
      const entry = this.entries.get(id);
      if (!entry) continue;
      if (!this.matchesScope(entry.scope, scope)) continue;

      const model = this.resolveModel(entry, id);
      if (model && !model.disposed) {
        result.push(model);
      }
    }

    return result;
  }

  /**
   * Get all models of a given type by string name.
   * Used for custom entity types where multiple entity type names share
   * the same CustomEntityModel constructor (getByType can't disambiguate).
   * Reads from the same typeIndex as getByType — MobX tracks the dependency.
   */
  getByTypeName(modelName: string, scope: ModelScope = ModelScope.all): Model[] {
    const ids = this.typeIndex.get(modelName);
    if (!ids || ids.size === 0) {
      return [];
    }

    const result: Model[] = [];
    for (const id of ids) {
      const entry = this.entries.get(id);
      if (!entry) continue;
      if (!this.matchesScope(entry.scope, scope)) continue;

      const model = this.resolveModel(entry, id);
      if (model && !model.disposed) {
        result.push(model);
      }
    }

    return result;
  }

  *iterateByType(
    modelClass: ModelConstructor<Model>,
    scope: ModelScope = ModelScope.all
  ): Generator<Model, void, unknown> {
    const actualModelName = this.registry.getModelNameFromConstructor(modelClass);
    if (!actualModelName) {
      throw new AbloValidationError(
        `Model class ${modelClass.name} not registered in ModelRegistry`,
        { code: 'pool_model_class_not_registered' },
      );
    }
    const ids = this.typeIndex.get(actualModelName);
    if (!ids) return;

    for (const id of ids) {
      const entry = this.entries.get(id);
      if (!entry) continue;
      if (!this.matchesScope(entry.scope, scope)) continue;

      const model = this.get(id);
      if (model && model instanceof modelClass) {
        yield model;
      }
    }
  }

  updateScope(id: string, scope: ModelScope): void {
    const entry = this.entries.get(id);
    if (entry && entry.scope !== scope) {
      // Re-set the entry so ObservableMap notifies observers of the change.
      // Mutating entry.scope in-place wouldn't trigger MobX (plain object property).
      runInAction(() => {
        this.entries.set(id, { ...entry, scope });
      });
      this.accessTimes.set(id, Date.now());
    }
  }

  /**
   * Create (or update) a model instance locally, given a typename and raw
   * data. Cleaner than `createFromData({ __typename, ...data })` — the
   * typename lives in the arg list, not hidden inside the data object.
   *
   * Used for optimistic local writes: `pool.create('Slide', { id, deckId, ... })`.
   * For hydration from server deltas (where `__typename` already rides on
   * the payload), use `createFromData(data)` directly — that path is kept
   * because the wire format attaches the discriminator to the data itself.
   */
  create(typename: string, data: Record<string, unknown>): Model | null {
    return this.createFromData({ ...data, __typename: typename });
  }

  createFromData(
    data: Record<string, unknown> & {
      __typename?: string;
      __class?: string;
      modelName?: string;
      id?: string;
    },
    ModelClass?: new (data: Record<string, unknown>) => Model
  ): Model | null {
    // Support multiple model identifier fields for backwards compatibility
    const modelName = data.__typename ?? data.__class ?? data.modelName ?? 'Unknown';

    const Constructor = ModelClass || this.registry.getModelByName(modelName);

    if (!Constructor) {
      if (!ModelClass && modelName === 'Unknown') {
        if (process.env.NODE_ENV === 'development') {
          console.warn('ObjectPool.createFromData: No model identifier found', data);
        }
        getContext().modelDebugLogger?.logError('Unknown', 'CREATE', 'No model identifier found', data);
        return null;
      }

      // Debug logging for Dataroom constructor lookup
      if (modelName === 'Dataroom') {
        console.log('[ObjectPool.createFromData Debug] Dataroom constructor lookup:', {
          modelName,
          hasConstructor: !!Constructor,
          constructorName: Constructor?.name,
          modelClassProvided: !!ModelClass,
          dataId: data.id?.slice(0, 8),
        });
      }

      if (process.env.NODE_ENV === 'development') {
        console.warn(
          `ObjectPool.createFromData: No constructor found for model "${modelName}"`,
          data
        );
      }
      getContext().modelDebugLogger?.logError(
        modelName,
        'CREATE',
        `No constructor found for model "${modelName}"`,
        data
      );
      return null;
    }

    // Check if model already exists and UPDATE it instead of creating duplicate
    // LINEAR PATTERN: Keep existing model instances alive, just update their data
    // This preserves React's references and MobX observation tracking
    if (data.id && this.entries.has(data.id)) {
      const existing = this.get(data.id);
      if (existing && existing.getModelName() === modelName) {
        // Same ID and same type - update existing model with new data and return it
        existing.updateFromData(data);
        return existing;
      }
      // Different type with same ID - this is a shared PK scenario (e.g., Project/Dataroom)
      // Don't return existing, create new model (will use composite key for storage)
    }

    // Log model creation attempt
    getContext().modelDebugLogger?.logCreation(modelName, data, Constructor);

    try {
      // Pass data directly to constructor for Prisma-first models
      const model = new Constructor(data);

      return model;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.warn(`[ObjectPool.createFromData] FAILED ${modelName}:`, errorMessage, error instanceof Error ? error.stack : '');
      getContext().observability.captureTransactionFailure({
        context: 'createFromData',
        modelName,
        modelId: data.id as string | undefined,
        error: errorMessage,
      });
      getContext().modelDebugLogger?.logError(modelName, 'CREATE', errorMessage, {
        data,
        constructor: Constructor.name,
      });
      return null;
    }
  }

  /**
   * Clear the object pool
   * @param options.preserveObserved - If true, keep models that are being observed by React
   *                                   This prevents React components from holding stale references
   *                                   after bootstrap/rehydration
   */
  clear(options: { preserveObserved?: boolean } = {}): void {
    const preserveObserved = options.preserveObserved ?? false;
    const preservedIds: string[] = [];
    const preservedEntries: Array<[string, ModelEntry]> = [];
    let disposedCount = 0;
    let checkedCount = 0;

    for (const [id, entry] of this.entries) {
      const model = entry.model || entry.weakRef?.deref();
      checkedCount++;

      // Check if this model should be preserved (has active React observers)
      if (
        preserveObserved &&
        model &&
        typeof model.hasObservedCollections === 'function' &&
        model.hasObservedCollections()
      ) {
        // Keep this model alive - React is still using it
        preservedIds.push(id);
        preservedEntries.push([id, entry]);
        continue;
      }

      model?.dispose?.();
      disposedCount++;
    }

    // Save access times for preserved entries before clearing
    const preservedAccessTimes = new Map<string, number>();
    for (const [id] of preservedEntries) {
      const time = this.accessTimes.get(id);
      if (time) preservedAccessTimes.set(id, time);
    }

    runInAction(() => {
      this.entries.clear();
      this.typeIndex.clear();
      // Clear foreign key index data (preserves config/structure, just empties the value maps)
      for (const index of this.foreignKeyIndexes.values()) {
        index.clear();
      }
      this.recentAdditions.clear();
      this.deltaHistory.clear();
      this.metrics = {
        hits: 0,
        misses: 0,
        evictions: 0,
        additions: 0,
        duplicatesSkipped: 0,
      };

      // Re-add preserved entries (also rebuilds foreign key indexes via addToTypeIndex)
      for (const [id, entry] of preservedEntries) {
        this.entries.set(id, entry);
        const model = entry.model || entry.weakRef?.deref();
        if (model) {
          this.addToTypeIndex(id, model.getModelName());
        }
      }
    });

    // Restore access times: clear then re-add preserved
    this.accessTimes.clear();
    for (const [id, time] of preservedAccessTimes) {
      this.accessTimes.set(id, time);
    }
    // No cache to invalidate — typeIndex + entries are directly observable
  }

  has(id: string): boolean {
    return this.entries.has(id);
  }

  /**
   * Touch a model to update its access time (prevents premature GC)
   * Used by LazyReferenceCollection to keep parent models alive during active usage
   */
  touch(id: string): boolean {
    const entry = this.entries.get(id);
    if (!entry) {
      return false;
    }

    this.accessTimes.set(id, Date.now());
    return true;
  }

  getAllIds(): string[] {
    return Array.from(this.entries.keys());
  }

  getAllModels(): Model[] {
    const results: Model[] = [];
    for (const [id] of this.entries) {
      const model = this.get(id);
      if (model) {
        results.push(model);
      }
    }
    return results;
  }

  get size(): number {
    return this.entries.size;
  }

  get hitRate(): number {
    const total = this.metrics.hits + this.metrics.misses;
    return total > 0 ? (this.metrics.hits / total) * 100 : 0;
  }

  getStats() {
    const scopeCounts = { live: 0, archived: 0 };
    const typeCounts = new Map<string, number>();

    for (const [, entry] of this.entries) {
      if (entry.scope === ModelScope.live) scopeCounts.live++;
      else if (entry.scope === ModelScope.archived) scopeCounts.archived++;

      const modelName = entry.model?.getModelName() || entry.weakRef?.deref()?.getModelName();
      if (modelName) {
        typeCounts.set(modelName, (typeCounts.get(modelName) || 0) + 1);
      }
    }

    return {
      size: this.size,
      hitRate: this.hitRate,
      metrics: { ...this.metrics },
      scopeCounts,
      typeCounts: Object.fromEntries(typeCounts),
      deltaHistorySize: this.deltaHistory.size,
      recentAdditionsSize: this.recentAdditions.size,
      config: { ...this.config },
    };
  }

  clearDeltaHistory(olderThanMs: number = 3600000): void {
    const now = Date.now();
    const toDelete: string[] = [];

    for (const [key, history] of this.deltaHistory) {
      if (now - history.timestamp > olderThanMs) {
        toDelete.push(key);
      }
    }

    toDelete.forEach((key) => this.deltaHistory.delete(key));

    // Delta history entries cleared silently
  }

  private cleanupTracking(): void {
    const now = Date.now();
    for (const [key, time] of this.recentAdditions) {
      if (now - time > 1000) {
        this.recentAdditions.delete(key);
      }
    }
  }

  private gc(): number {
    return runInAction(() => {
      const now = Date.now();
      const toRemove: string[] = [];
      let evicted = 0;
      let skippedObserved = 0;

      for (const [id, entry] of this.entries) {
        // Check if model has expired based on last access time
        const lastAccessed = this.accessTimes.get(id) || 0;
        if (now - lastAccessed > this.config.maxAge) {
          // CRITICAL: Check if model has observed collections before GC
          // Following MobX best practice: don't dispose models being observed by React
          // See: https://mobx.js.org/lazy-observables.html
          const model = entry.model || entry.weakRef?.deref();
          if (
            model &&
            typeof model.hasObservedCollections === 'function' &&
            model.hasObservedCollections()
          ) {
            // Model has active React observers - refresh access time and skip GC
            this.accessTimes.set(id, now);
            skippedObserved++;
            continue;
          }

          toRemove.push(id);
          continue;
        }

        // Strong-to-weak-ref demotion at `maxAge / 2` used to live here,
        // in service of memory-pressure relief: idle entries would lose
        // their strong reference, V8 would collect them, and the next
        // access would re-hydrate from IDB/network. In practice it
        // caused silent data loss — any model actively being rendered
        // through a schema-driven dynamic class (i.e., most of them)
        // would be demoted, collected, and the next render's
        // `weakRef.deref()` returned undefined, so layers / cells /
        // messages "disappeared" after ~10 min of idle.
        //
        // The `hasObservedCollections()` guard used by the eviction
        // branch above only protects models that explicitly register a
        // LazyReferenceCollection; plain observer() components reading
        // properties don't register, so for typical UI usage the guard
        // didn't apply. Rather than try to make React-observation
        // globally visible to the pool, we drop the demotion phase
        // entirely — hard eviction at `maxAge` (with its own guard) is
        // the only automated removal now. If memory-pressure relief is
        // needed later, gate it on an explicit policy (e.g.,
        // `documenthidden` + `performance.memory.usedJSHeapSize`) rather
        // than a time-based tick.
      }

      for (const id of toRemove) {
        if (this.remove(id)) {
          evicted++;
          this.metrics.evictions++;
        }
      }

      // Log skipped models in development for debugging
      if (process.env.NODE_ENV === 'development' && skippedObserved > 0) {
        console.log(
          `[ObjectPool GC] Skipped ${skippedObserved} models with active React observers`
        );
      }

      // Also clean up old tracking data
      this.clearDeltaHistory();
      this.cleanupTracking();

      return evicted;
    });
  }

  private startGC(): void {
    if (this.gcTimer) return;
    this.gcTimer = setInterval(() => this.gc(), this.config.gcInterval);
  }

  stopGC(): void {
    if (this.gcTimer) {
      clearInterval(this.gcTimer);
      this.gcTimer = undefined;
    }
  }

  private evictOldest(): void {
    runInAction(() => {
      let oldest: [string, ModelEntry] | undefined;
      let oldestTime = Date.now();

      for (const [id, entry] of this.entries) {
        // Skip models that are being observed by React - they must stay alive
        const model = entry.model || entry.weakRef?.deref();
        if (
          model &&
          typeof model.hasObservedCollections === 'function' &&
          model.hasObservedCollections()
        ) {
          continue;
        }

        const entryAccessTime = this.accessTimes.get(id) || 0;
        if (entryAccessTime < oldestTime) {
          oldest = [id, entry];
          oldestTime = entryAccessTime;
        }
      }

      if (oldest) {
        this.remove(oldest[0]);
        this.metrics.evictions++;
      }
    });
  }

  private isLargeModel(model: Model): boolean {
    try {
      const size = JSON.stringify(model).length;
      return size > 10240;
    } catch {
      return false;
    }
  }

  // ========== FOREIGN KEY INDEX ==========

  /**
   * Register a foreign key field for indexing on a model type.
   * Call once during app initialization (e.g., after model registration).
   *
   * Example: registerForeignKey('SlideLayer', 'slideId')
   * This enables getByForeignKey('SlideLayer', 'slideId', someSlideId) → O(1) lookup
   */
  registerForeignKey(modelName: string, fieldName: string): void {
    const fields = this.foreignKeyConfig.get(modelName) ?? [];
    if (!fields.includes(fieldName)) {
      fields.push(fieldName);
      this.foreignKeyConfig.set(modelName, fields);
    }
    // Initialize the index map
    const indexKey = `${modelName}:${fieldName}`;
    if (!this.foreignKeyIndexes.has(indexKey)) {
      this.foreignKeyIndexes.set(indexKey, observable.map<string, Set<string>>());
    }
    console.warn('[ObjectPool.registerForeignKey]', { modelName, fieldName, indexKey });
  }

  /**
   * Check whether a foreign key index exists for a given typename + field.
   * Used by QueryView to decide whether to use FK-index for initial scan.
   */
  hasForeignKeyIndex(typename: string, fieldName: string): boolean {
    const indexKey = `${typename}:${fieldName}`;
    return this.foreignKeyIndexes.has(indexKey);
  }

  /**
   * Create a QueryView — an incrementally maintained materialized view.
   * The view registers itself with the ViewRegistry and receives
   * incremental updates when models of the given typename change.
   */
  createView<T extends Record<string, unknown>>(
    typename: string,
    options?: QueryViewOptions<T>,
  ): QueryView<T> {
    return new QueryView<T>(typename, this, this.viewRegistry, options);
  }

  /**
   * O(1) lookup of models by foreign key value.
   * Returns model instances, filtered to live scope by default.
   */
  getByForeignKey(modelName: string, fieldName: string, fieldValue: string): Model[] {
    const indexKey = `${modelName}:${fieldName}`;
    const index = this.foreignKeyIndexes.get(indexKey);
    // Both empty-path early-returns below are NORMAL states, not errors:
    // a model with no FK index yet (not populated), or an index with no
    // entry for this specific parent id (entity genuinely has no
    // children). These used to `console.warn` diagnostic dumps on every
    // call, which turned into hundreds of log lines per second during
    // cursor hover / rapid re-renders on the deck page. If a caller
    // needs visibility into "why is this empty," wire an opt-in
    // `logger.debug` at the specific call site rather than re-adding
    // a blanket warn here.
    if (!index) return [];

    const ids = index.get(fieldValue);
    if (!ids || ids.size === 0) return [];

    const result: Model[] = [];
    let droppedNoEntry = 0;
    let droppedScope = 0;
    let droppedDisposed = 0;
    for (const id of ids) {
      const entry = this.entries.get(id);
      if (!entry) { droppedNoEntry++; continue; }
      if (!this.matchesScope(entry.scope, ModelScope.live)) { droppedScope++; continue; }
      const model = this.resolveModel(entry, id);
      if (model && !model.disposed) {
        result.push(model);
      } else if (model?.disposed) {
        droppedDisposed++;
      }
    }
    if (droppedNoEntry || droppedScope || droppedDisposed) {
      console.warn('[ObjectPool.getByForeignKey] ROWS DROPPED', {
        modelName,
        fieldName,
        fieldValue,
        matched: ids.size,
        returned: result.length,
        droppedNoEntry,
        droppedScope,
        droppedDisposed,
      });
    }
    return result;
  }

  /**
   * Add a model to foreign key indexes (called from addToTypeIndex path)
   */
  private addToForeignKeyIndex(id: string, model: Model, modelName: string): void {
    // Silent no-ops for "no config / non-string value / missing index"
    // — all three are legitimate states (non-indexed model, optional
    // nullable FK, index not yet registered because the batch ran
    // before schema registration completed). Diagnostic warns that
    // used to live here spammed the console on every hot-path load.
    const fields = this.foreignKeyConfig.get(modelName);
    if (!fields) return;

    for (const fieldName of fields) {
      const fieldValue = (model as unknown as Record<string, unknown>)[fieldName];
      if (typeof fieldValue !== 'string') continue;

      const indexKey = `${modelName}:${fieldName}`;
      const index = this.foreignKeyIndexes.get(indexKey);
      if (!index) continue;

      let ids = index.get(fieldValue);
      if (!ids) {
        ids = observable.set<string>();
        index.set(fieldValue, ids);
      }
      ids.add(id);
    }
  }

  /**
   * Remove a model from foreign key indexes (called from removeFromTypeIndex path)
   */
  private removeFromForeignKeyIndex(id: string, modelName?: string): void {
    if (!modelName) return;
    const fields = this.foreignKeyConfig.get(modelName);
    if (!fields) return;

    // We need the model to read the foreign key value
    const entry = this.entries.get(id);
    const model = entry?.model ?? entry?.weakRef?.deref();
    if (!model) return;

    for (const fieldName of fields) {
      const fieldValue = (model as unknown as Record<string, unknown>)[fieldName];
      if (typeof fieldValue !== 'string') continue;

      const indexKey = `${modelName}:${fieldName}`;
      const index = this.foreignKeyIndexes.get(indexKey);
      if (!index) continue;

      const ids = index.get(fieldValue);
      if (ids) {
        ids.delete(id);
        if (ids.size === 0) {
          index.delete(fieldValue);
        }
      }
    }
  }

  private addToTypeIndex(id: string, modelName?: string): void {
    if (!modelName) return;

    let ids = this.typeIndex.get(modelName);
    if (!ids) {
      ids = observable.set<string>();
      this.typeIndex.set(modelName, ids);
    }
    ids.add(id);

    // Update foreign key indexes
    const entry = this.entries.get(id);
    const model = entry?.model ?? entry?.weakRef?.deref();
    if (model) {
      this.addToForeignKeyIndex(id, model, modelName);
    } else if (modelName === 'SlideLayer' || modelName === 'SlideLayoutLayer') {
      console.warn('[ObjectPool.addToTypeIndex] NO MODEL for hot type — FK index skipped', {
        modelName,
        id,
        hasEntry: !!entry,
        hasModel: !!entry?.model,
        hasWeakRef: !!entry?.weakRef,
      });
    }
  }

  private removeFromTypeIndex(id: string, modelName?: string): void {
    if (!modelName) return;

    // Remove from foreign key indexes BEFORE removing from entries
    this.removeFromForeignKeyIndex(id, modelName);

    const ids = this.typeIndex.get(modelName);
    if (ids) {
      ids.delete(id);
      if (ids.size === 0) {
        this.typeIndex.delete(modelName);
      }
    }
  }

  private matchesScope(entryScope: ModelScope, queryScope: ModelScope): boolean {
    switch (queryScope) {
      case ModelScope.all:
        return true;
      case ModelScope.live:
        return entryScope === ModelScope.live;
      case ModelScope.archived:
        return entryScope === ModelScope.archived;
      default:
        return entryScope === queryScope;
    }
  }
}
