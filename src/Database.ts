/**
 * Database - Simplified persistence layer
 * Fixed bootstrap triggering and data flow
 */

import { DatabaseManager, type DatabaseInfo, type WorkspaceMetadata } from './core/DatabaseManager';
import { StoreManager } from './core/StoreManager';
import { ModelRegistry } from './ModelRegistry';
import { LoadStrategy } from './types';
import { getContext } from './context';
import { AbloConnectionError, AbloValidationError } from './errors';
import type { BootstrapHelper, BootstrapData } from './sync/BootstrapHelper';
import { InMemoryObjectStore } from './adapters/inMemoryStorage';

/** Generic record type for model data */
type ModelData = Record<string, unknown>;

/** Server delta format from bootstrap */
interface ServerDelta {
  id: number;
  operation: string;
  modelName: string;
  entityId: string;
  data: ModelData;
}

/** Persisted mutation in a transaction */
interface PersistedMutation {
  type: 'create' | 'update' | 'delete' | 'archive';
  modelData: ModelData;
  modelName: string;
  timestamp: string;
}

/** Persisted transaction for offline/retry support */
interface PersistedTransaction {
  id: string;
  type?: string;
  timestamp?: number;
  createdAt?: number;
  mutations?: PersistedMutation[];
  // LINEAR PATTERN: Persist awaiting_delta transactions so they survive tab close.
  // On next session, WebSocket reconnect + delta catch-up confirms them naturally.
  awaitingDelta?: {
    syncIdNeeded: number;
    modelName: string;
    modelId: string;
    operationType: string;
  };
}

/**
 * Bootstrap strategies (aligned with Linear's architecture):
 *
 * 'full' - Full bootstrap from server
 *   - Fetch complete snapshot from server
 *   - Clear IndexedDB
 *   - Load snapshot data
 *   - Use snapshot's lastSyncId
 *
 * 'local' - Local-only bootstrap (skip server fetch)
 *   - Use existing IndexedDB data
 *   - Hydrate ObjectPool from IndexedDB
 *   - Connect WebSocket with stored lastSyncId
 *   - Receive deltas from lastSyncId+1 onwards
 */
export type BootstrapType = 'full' | 'partial' | 'local';

export interface BootstrapRequirements {
  type: BootstrapType;
  modelsToLoad: string[];
  lastSyncId: number;
  syncGroups: string[];
}

export interface BootstrapResult {
  modelsLoaded: number;
  modelsStored: number;
  /** The raw bootstrap response — callers can apply models directly to ObjectPool */
  bootstrapData: BootstrapData;
  /**
   * Results of applying partial-bootstrap deltas to IDB. Present only when
   * `bootstrapData.type === 'partial'` and deltas were processed. Callers
   * forward these to `syncClient.applyDeltaBatchToPool` so the in-memory
   * pool reflects inserts/updates/deletes that arrived while the client
   * was disconnected — without this, DELETE deltas persist to IDB but
   * ghost entities linger in the pool until a full reload.
   */
  deltaResults?: Array<{
    action: 'add' | 'update' | 'remove' | 'archive' | 'verify';
    modelName: string;
    modelId: string;
    data?: ModelData | null;
  }>;
}

export class Database {
  // Core database components
  private databaseManager: DatabaseManager;
  private storeManager: StoreManager;

  // Injected dependencies
  private modelRegistry: ModelRegistry;
  private bootstrapHelper: BootstrapHelper;

  /** The pre-configured query helper for lazy-loading data from the sync server. */
  get helper(): BootstrapHelper {
    return this.bootstrapHelper;
  }

  // Database state
  private currentDbInfo: DatabaseInfo | null = null;
  private workspaceDb: IDBDatabase | null = null;

  /**
   * Flag to track if database is closing/closed.
   * Used for graceful degradation when operations are attempted during shutdown.
   */
  private isClosing = false;

  /**
   * When set, forces the next requiredBootstrap() call to return 'full' even if offline.
   * Used when a sync group change delta is received — we must re-bootstrap to purge
   * revoked data, even if the device is currently offline (it will bootstrap when online).
   */
  private _forceFullBootstrap = false;

  /** Essential fields that must be preserved during partial UPDATE merges.
   * Sourced from SyncEngineConfig.essentialFields — consumers define their own. */
  private get essentialFields(): Readonly<Record<string, readonly string[]>> {
    return getContext().config.essentialFields;
  }

  /**
   * When true, all IndexedDB operations are replaced with in-memory Maps.
   * Enables the SDK to run headlessly in Node.js / agent workers / tests
   * without requiring a browser environment.
   *
   * Set via createSyncEngine({ storage: inMemoryStorage() }) or directly:
   *   new Database(registry, bootstrap, { inMemory: true })
   */
  private readonly inMemory: boolean;

  /** In-memory stores used when inMemory=true. Keyed by model name. */
  private inMemoryStores = new Map<string, InMemoryObjectStore>();

  /** In-memory workspace metadata when inMemory=true. */
  private inMemoryMetadata: WorkspaceMetadata | null = null;

  constructor(
    modelRegistry: ModelRegistry,
    bootstrapHelper: BootstrapHelper,
    options?: { inMemory?: boolean },
  ) {
    this.databaseManager = new DatabaseManager();
    this.storeManager = new StoreManager(modelRegistry);
    this.modelRegistry = modelRegistry;
    this.bootstrapHelper = bootstrapHelper;
    this.inMemory = options?.inMemory ?? false;
  }

  /** Get store or throw if not found (for operations that require the store) */
  private getRequiredStore(modelName: string) {
    const store = this.storeManager.getStore(modelName);
    if (!store) {
      throw new AbloValidationError(`Store not found: ${modelName}`, {
        code: 'db_store_not_found',
      });
    }
    return store; // TypeScript narrows to non-undefined after the throw
  }

  /** Get store or return null with optional warning (for operations that can skip) */
  private getOptionalStore(modelName: string, context?: string) {
    const store = this.storeManager.getStore(modelName);
    if (!store) {
      getContext().observability.breadcrumb(
        `Store not found for model: ${modelName}`,
        'sync.database',
        'warning',
        {
          context: context || 'unknown',
        }
      );
    }
    return store;
  }

  /** Log preserved fields during partial UPDATE merge (debug helper) */
  private logPreservedFields(
    modelName: string,
    modelId: string,
    existing: ModelData,
    delta: ModelData
  ): void {
    if (modelName === 'Activity') return;

    const requiredFields = this.essentialFields[modelName] || [];
    const preserved = requiredFields.filter(
      (field) => existing[field] !== undefined && delta[field] === undefined
    );

    if (preserved.length > 0) {
      getContext().logger.debug('[Database] UPDATE merged - preserved fields', {
        modelName,
        modelId: modelId.slice(0, 12),
        deltaFields: Object.keys(delta),
        preservedFields: preserved,
      });
    }
  }

  async open(userId: string, organizationId: string, version: number = 1): Promise<void> {
    // Reset closing flag when opening (in case of reopen)
    this.isClosing = false;

    if (this.workspaceDb && this.currentDbInfo) {
      return;
    }

    // ── In-memory mode: skip IndexedDB entirely ──────────────────
    // Creates InMemoryObjectStore instances for all registered models.
    // Bootstrap via HTTP still works; only local persistence is skipped.
    if (this.inMemory) {
      getContext().logger.debug('Opening in-memory database (headless mode)');
      const allModels = this.modelRegistry.getRegisteredModelNames();
      for (const modelName of allModels) {
        const storeName = `store_${modelName.toLowerCase()}`;
        this.inMemoryStores.set(
          modelName,
          new InMemoryObjectStore(modelName, storeName),
        );
      }
      // Create a __transactions store for the offline queue
      this.inMemoryStores.set(
        '__transactions',
        new InMemoryObjectStore('__transactions', '__transactions'),
      );
      getContext().logger.info(
        `In-memory database opened: ${this.inMemoryStores.size} stores`,
      );
      return;
    }

    // ── Browser mode: IndexedDB (existing behavior, unchanged) ───
    getContext().logger.debug('Opening IndexedDB database');

    // Initialize meta database
    await this.databaseManager.initializeMetaDatabase();

    // Calculate database info
    this.currentDbInfo = await this.databaseManager.calculateDatabaseInfo(
      userId,
      organizationId,
      version
    );

    // Register database
    await this.databaseManager.registerDatabase(this.currentDbInfo);

    // Open workspace database
    this.workspaceDb = await this.databaseManager.openWorkspaceDatabase(
      this.currentDbInfo,
      async (db, tx) => {
        await this.storeManager.createStores(db, tx);
      }
    );

    // Initialize stores
    await this.storeManager.initializeStores(this.workspaceDb);

    const readiness = await this.storeManager.checkReadinessOfStores();
    getContext().logger.info(
      `Database opened: ${this.currentDbInfo.name} (${readiness.readyStores.length}/${readiness.totalStores} stores ready)`
    );
  }

  /**
   * Compact a record before persisting to IndexedDB
   * - Removes null/undefined fields
   * - Removes empty arrays and empty objects
   * - Drops redundant fields: __typename, __class, clientId, syncStatus
   *
   * ARCHITECTURE: By design, this method receives plain objects, not MobX observables:
   * - WebSocket deltas: Already JSON-parsed (SyncedStore.ts:889)
   * - Optimistic updates: Models call toJSON() which uses toJS() (SlideLayer.ts:224)
   * - Bootstrap data: Plain JSON from server
   *
   * Note: We do NOT drop required defaults; server provides them.
   */
  private compactRecord(_modelName: string, data: ModelData): ModelData {
    if (!data || typeof data !== 'object') return data;

    const out: ModelData = {};

    for (const [key, value] of Object.entries(data)) {
      // Drop redundant or ephemeral markers
      if (key === '__typename' || key === '__class' || key === 'clientId' || key === 'syncStatus') {
        continue;
      }

      // FIXED: Only skip undefined, preserve explicit null values
      // Null is semantically meaningful in Prisma schemas (nullable fields)
      if (value === undefined) {
        continue;
      }

      if (Array.isArray(value)) {
        if (value.length === 0) continue;
        out[key] = value;
        continue;
      }

      if (typeof value === 'object') {
        // Preserve explicit null values
        if (value === null) {
          out[key] = null;
          continue;
        }

        // Preserve Date objects (IndexedDB can clone these)
        if (value instanceof Date) {
          out[key] = value;
          continue;
        }

        // For plain objects, drop if empty
        if (Object.keys(value).length === 0) continue;
        out[key] = value;
        continue;
      }

      out[key] = value;
    }

    // Always ensure id is present
    if (!out.id && data.id) out.id = data.id;

    return out;
  }

  /**
   * Mark that the next bootstrap must be a full bootstrap.
   * Called when a sync group change ("G" delta) is received — the client must
   * re-fetch all data from the server to purge models from revoked sync groups.
   */
  markRequiresFullBootstrap(): void {
    this._forceFullBootstrap = true;
    getContext().logger.info('[Database] Marked for forced full bootstrap (sync group change)');
  }

  /**
   * Smart bootstrap requirements based on data freshness
   */
  async requiredBootstrap(): Promise<BootstrapRequirements> {
    if (!this.workspaceDb) {
      throw new AbloConnectionError('Database not opened', {
        code: 'db_not_opened',
      });
    }

    // Sync group change requires full re-bootstrap to purge revoked data
    if (this._forceFullBootstrap) {
      this._forceFullBootstrap = false;
      const instantModels = this.modelRegistry.getModelsByLoadStrategy(LoadStrategy.instant);
      const lazyModels = this.modelRegistry.getModelsByLoadStrategy(LoadStrategy.lazy);
      getContext().logger.info('[Database.requiredBootstrap] Forced FULL bootstrap (sync group change)');
      return {
        type: 'full',
        modelsToLoad: [...instantModels, ...lazyModels],
        lastSyncId: 0,
        syncGroups: [],
      };
    }

    const readiness = await this.storeManager.checkReadinessOfStores();
    const metadata = await this.databaseManager.getWorkspaceMetadata(this.workspaceDb);

    // Get models from registry
    const instantModels = this.modelRegistry.getModelsByLoadStrategy(LoadStrategy.instant);
    const lazyModels = this.modelRegistry.getModelsByLoadStrategy(LoadStrategy.lazy);
    const modelsToLoad = [...instantModels, ...lazyModels];

    const metadataLastSyncId = metadata?.lastSyncId || 0;
    const dataAge = metadata?.updatedAt ? Date.now() - metadata.updatedAt.getTime() : Infinity;

    // ── Zero-style cache-validity check ──────────────────────────
    //
    // The cursor (lastSyncId) is only valid if the data it refers to
    // actually exists in the stores. If IDB was cleared (or this is a
    // fresh in-memory session), the metadata's lastSyncId is stale —
    // sending it to the server would trigger a partial bootstrap that
    // returns zero deltas because the gap is 0, leaving the client
    // with an empty ObjectPool.
    //
    // Zero solves this by co-locating the cursor with the cached data:
    // if the data is gone, the cursor is gone. We achieve the same
    // property by sampling the actual stores — if they're empty, the
    // cursor is meaningless regardless of what metadata claims.
    const dataExists = this.inMemory
      ? false  // In-memory mode: no persistent data across sessions
      : await this.storeManager.hasAnyData();

    // The effective lastSyncId: only trust the metadata cursor when
    // we've confirmed the data it refers to actually exists in the stores.
    const lastSyncId = dataExists ? metadataLastSyncId : 0;

    // 🔍 DIAGNOSTIC: Log database state
    getContext().logger.debug('[Database.requiredBootstrap] State check', {
      readinessReady: readiness.ready,
      hasMetadata: !!metadata,
      metadataLastSyncId,
      effectiveLastSyncId: lastSyncId,
      dataExists,
      dataAge: metadata?.updatedAt ? Math.round(dataAge / 1000) + 's' : 'N/A',
      navigatorOnline: typeof navigator !== 'undefined' ? navigator.onLine : 'N/A',
    });

    // Determine bootstrap type based on connectivity and data state
    const offline = typeof navigator !== 'undefined' && navigator && navigator.onLine === false;
    let type: BootstrapType;

    // hasLocalData: stores actually have records AND we have a valid cursor
    const hasLocalData = readiness.ready && dataExists && lastSyncId > 0;

    if (offline && hasLocalData) {
      // Offline with data - use local bootstrap (only option when offline)
      type = 'local';
      getContext().logger.info('Offline detected with local data - using local bootstrap');
    } else {
      // SERVER-AUTHORITATIVE: Always use full bootstrap when online.
      type = 'full';
      getContext().logger.info('Full bootstrap - server is source of truth', {
        reason: offline ? 'offline_no_data' : 'server_authoritative',
        hasLocalData,
        lastSyncId,
        dataExists,
      });
    }

    return {
      type,
      modelsToLoad,
      lastSyncId,
      syncGroups: metadata?.syncGroups || [],
    };
  }

  /**
   * Bootstrap database with data from Go server
   */
  async bootstrapFromServer(
    requirements: BootstrapRequirements,
    context: { userId: string; organizationId: string; teamIds?: string[] },
    onProgress?: (loaded: number) => void
  ): Promise<BootstrapResult> {
    getContext().logger.debug('Starting bootstrap fetch', {
      type: requirements.type,
      lastSyncId: requirements.lastSyncId,
      organizationId: context.organizationId,
      modelsToLoad: requirements.modelsToLoad,
    });
    getContext().logger.info('Database: Starting bootstrap from Go server', {
      type: requirements.type,
      organizationId: context.organizationId,
      syncGroups: context.teamIds,
      modelsToLoad: requirements.modelsToLoad,
    });

    try {
      // ✅ FETCH FIRST (before any destructive operations)
      // This prevents data loss if the network request fails
      const startTime = typeof performance !== 'undefined' ? performance.now() : Date.now();

      getContext().logger.info('Fetching bootstrap data from server (before clearing local data)', {
        type: requirements.type,
        lastSyncId: requirements.lastSyncId,
      });

      const bootstrapData = await this.bootstrapHelper.fetchBootstrap(requirements.lastSyncId);

      getContext().logger.debug('Received bootstrap response', {
        type: bootstrapData.type,
        lastSyncId: bootstrapData.lastSyncId,
        hasModels: !!bootstrapData.models,
        hasDeltas: !!bootstrapData.deltas,
        deltaCount: bootstrapData.deltaCount || 0,
      });

      // DEBUG: Log SlideLayer count specifically
      const slideLayerData = bootstrapData.models?.SlideLayer;
      getContext().logger.debug('[Database.bootstrapFromServer] SlideLayer data', {
        hasSlideLayer: !!slideLayerData,
        isArray: Array.isArray(slideLayerData),
        count: Array.isArray(slideLayerData) ? slideLayerData.length : 'N/A',
        firstItem:
          Array.isArray(slideLayerData) && slideLayerData.length > 0
            ? (slideLayerData[0] as Record<string, unknown>)?.id
            : 'none',
      });

      // DEBUG: Log Slide data to track missing slides bug
      const slideData = bootstrapData.models?.Slide;
      if (Array.isArray(slideData)) {
        getContext().observability.breadcrumb(
          'Slide data received from bootstrap',
          'sync.bootstrap',
          'debug',
          {
            totalSlides: slideData.length,
          }
        );
      }

      // ✅ Only clear AFTER successful fetch (transactional safety)
      // IMPORTANT: Clear if the SERVER says it's a full snapshot, regardless of what we asked.
      if (bootstrapData.type === 'full') {
        await this.clear();
      }

      console.warn('[Bootstrap] type:', bootstrapData.type, 'hasModels:', !!bootstrapData.models, 'hasDeltas:', !!bootstrapData.deltas);

      // Handle partial bootstrap (delta batch)
      if (bootstrapData.type === 'partial') {
        const deltas = bootstrapData.deltas || [];

        getContext().logger.info('Processing partial bootstrap with delta batch', {
          deltaCount: deltas.length,
          fromSyncId: requirements.lastSyncId,
          toSyncId: bootstrapData.lastSyncId,
        });

        // Apply deltas to IndexedDB using processDeltaBatch for better
        // performance. Capture the return value so the pool can be updated by
        // the caller — without this, partial-bootstrap DELETEs persist to IDB
        // but don't evict entities from the in-memory ObjectPool, leaving
        // ghost rows visible on the UI until a full reload rebuilds the pool.
        let deltasApplied = 0;
        let deltaResults: BootstrapResult['deltaResults'];

        if (deltas.length > 0) {
          // Convert server delta format to processDelta format
          const formattedDeltas = (deltas as ServerDelta[]).map((delta) => ({
            syncId: delta.id,
            actionType: delta.operation as 'I' | 'U' | 'D' | 'A' | 'V' | 'C' | 'G' | 'S',
            modelName: delta.modelName,
            modelId: delta.entityId,
            data: delta.data,
          }));

          // Use batch processing for better performance
          deltaResults = await this.processDeltaBatch(formattedDeltas);
          deltasApplied = formattedDeltas.length;
          onProgress?.(deltasApplied);
        }

        // Update workspace metadata with new lastSyncId (critical even when 0 deltas)
        await this.updateWorkspaceMetadata({
          lastSyncId: bootstrapData.lastSyncId,
          schemaHash: this.modelRegistry.getSchemaHash(),
          syncGroups: context.teamIds || [],
          updatedAt: new Date(),
        });

        const elapsed =
          (typeof performance !== 'undefined' ? performance.now() : Date.now()) - startTime;
        getContext().logger.info(`Partial bootstrap complete in ${elapsed.toFixed(2)}ms`, {
          deltasApplied,
          lastSyncId: bootstrapData.lastSyncId,
        });

        return { modelsLoaded: 0, modelsStored: deltasApplied, bootstrapData, deltaResults };
      }

      // Full bootstrap: Process model data
      if (!bootstrapData.models) {
        throw new AbloValidationError('Full bootstrap response missing models data', {
          code: 'bootstrap_response_invalid',
        });
      }

      let modelsLoaded = 0;
      let modelsStored = 0;

      // DEBUG: Log all model names received from server
      const receivedModelNames = Object.keys(bootstrapData.models);
      console.warn('[Bootstrap] Models received from server:', receivedModelNames);
      console.warn('[Bootstrap] Has ObjectLink?', 'ObjectLink' in bootstrapData.models, 'count:', Array.isArray(bootstrapData.models.ObjectLink) ? bootstrapData.models.ObjectLink.length : 'not-array-or-missing');
      console.warn('[Bootstrap] Has Company?', 'Company' in bootstrapData.models);
      console.warn('[Bootstrap] Has Contact?', 'Contact' in bootstrapData.models);

      for (const [modelName, modelData] of Object.entries(bootstrapData.models)) {
        // Handle null, undefined, or non-array data
        if (!modelData) {
          getContext().observability.breadcrumb(
            `No data received for ${modelName}`,
            'sync.bootstrap',
            'warning'
          );
          continue;
        }

        if (!Array.isArray(modelData)) {
          getContext().observability.breadcrumb(
            `Skipping non-array data for ${modelName}`,
            'sync.bootstrap',
            'warning'
          );
          continue;
        }

        // Skip empty arrays silently (expected for some models)
        if (modelData.length === 0) {
          getContext().logger.debug(`No ${modelName} items to store (empty array)`);
          continue;
        }

        const store = this.getOptionalStore(modelName, 'bootstrap');
        if (!store) {
          console.warn(`[Bootstrap] NO IDB STORE for ${modelName} — ${modelData.length} items DROPPED`);
          continue;
        }
        console.warn(`[Bootstrap] Storing ${modelName}: ${modelData.length} items`);

        let writeErrors = 0;
        // Store all items to IndexedDB (compacted)
        for (const item of modelData) {
          try {
            const compacted = this.compactRecord(modelName, item as ModelData);
            await store.put(compacted);
            modelsStored++;
            modelsLoaded++;

            // Report progress every 10 items
            if (modelsLoaded % 10 === 0) {
              onProgress?.(modelsLoaded);
            }
          } catch (error) {
            writeErrors++;
            getContext().observability.breadcrumb(
              `Failed to store ${modelName} item`,
              'sync.database',
              'error',
              {
                error: error instanceof Error ? error.message : String(error),
              }
            );
          }
        }

        // Mark model as persisted after successful write
        try {
          await this.setModelPersisted(modelName, true);
        } catch {}
      }

      // Update workspace metadata with bootstrap snapshot's lastSyncId
      // Note: This method is only called for 'full' bootstrap (not 'local')
      // For 'partial' bootstrap (future): would need intelligent merge logic here
      await this.updateWorkspaceMetadata({
        lastSyncId: bootstrapData.lastSyncId,
        schemaHash: this.modelRegistry.getSchemaHash(),
        syncGroups: context.teamIds || [],
        updatedAt: new Date(),
      });

      const elapsed =
        (typeof performance !== 'undefined' ? performance.now() : Date.now()) - startTime;
      getContext().logger.info(
        `Bootstrap complete: ${modelsLoaded} items loaded, ${modelsStored} stored to IndexedDB in ${elapsed.toFixed(2)}ms`
      );
      getContext().analytics?.capture('bootstrap_success', {
        organizationId: context.organizationId,
        responseTime: elapsed,
        modelsLoaded,
      });

      return { modelsLoaded, modelsStored, bootstrapData };
    } catch (error) {
      // Comprehensive error logging for bootstrap failures
      getContext().observability.captureBootstrapFailure(error, {
        type: requirements.type,
        navigatorOnline: typeof navigator !== 'undefined' ? navigator.onLine : undefined,
      });

      // Track bootstrap failure telemetry
      getContext().analytics?.capture('bootstrap_failed', {
        organizationId: context.organizationId,
        bootstrapType: requirements.type,
        lastSyncId: requirements.lastSyncId,
        errorMessage: error instanceof Error ? error.message : String(error),
        errorName: error instanceof Error ? error.name : 'UnknownError',
      });

      throw error;
    }
  }

  // bootstrapSpecificModels removed per request

  /**
   * Process incoming delta from WebSocket - simplified
   *
   * ⚠️ PERFORMANCE NOTE: This method is called for each individual delta.
   * For batch processing, use processDeltaBatch() instead to avoid
   * transaction overhead (2x transactions per delta = major bottleneck).
   *
   * 📝 PARTIAL DELTA PATTERN:
   * - Server sends only changed fields: {id, position: {...}, updatedAt}
   * - UPDATE deltas are MERGED with existing records: {...existing, ...delta}
   * - This preserves fields not included in the delta (e.g., deckId, title)
   * - Explicit null values ARE preserved: {position: null} clears the field
   */
  async processDelta(delta: {
    syncId?: number; // Optional sync id (from server). Enables idempotent gating.
    /**
     * Includes 'G' and 'S' defensively — those are routed upstream by
     * BaseSyncedStore.processDeltaWithBatching and should not reach here,
     * but the switch returns a no-op verify if one slips through (e.g.
     * replayed from the bootstrap queue) rather than crashing the engine.
     */
    actionType: 'I' | 'U' | 'D' | 'A' | 'V' | 'C' | 'G' | 'S';
    modelName: string;
    modelId: string;
    data: ModelData | null;
  }): Promise<{
    action: 'add' | 'update' | 'remove' | 'archive' | 'verify';
    modelName: string;
    modelId: string;
    data?: ModelData | null;
  }> {
    const { actionType, modelName, modelId, data, syncId } = delta;
    const store = this.getOptionalStore(modelName, 'processDelta');
    if (!store) {
      return { action: 'verify', modelName, modelId };
    }

    // Best-practice gating: ignore already-applied deltas by comparing with persisted lastSyncId
    try {
      const lastApplied = await this.getLastSyncId();
      const incomingId = typeof syncId === 'number' ? syncId : undefined;
      if (typeof incomingId === 'number' && incomingId <= lastApplied) {
        return { action: 'verify', modelName, modelId };
      }
    } catch {}

    // Compact data before persistence; do not store redundant type markers.
    // Inject `id` from the envelope — server deltas frequently strip it
    // from the `data` payload as redundant with the envelope's `modelId`,
    // but IDB object stores use keyPath='id' and require it on the record
    // itself (`DataError: key path did not yield a value` otherwise).
    const dataWithId =
      data && typeof data === 'object'
        ? { id: modelId, ...(data as Record<string, unknown>) }
        : data;
    const compacted =
      dataWithId && typeof dataWithId === 'object'
        ? this.compactRecord(modelName, dataWithId as ModelData)
        : dataWithId;

    switch (actionType) {
      // 'C' (Covering) — client gained permission to see an existing entity.
      // End state in the local store is identical to an insert: the row is
      // present. The semantic difference is purely observability — it wasn't
      // newly created, it was newly visible. We fall through to the 'I' case
      // after a debug trace so the two can be disambiguated in logs.
      case 'C':
        getContext().observability.breadcrumb(
          'Applying covering delta (gained permission)',
          'sync.database',
          'info',
          { modelName, modelId: modelId.slice(0, 12) }
        );
        // falls through
      case 'I': {
        // Insert synchronously for durable ack-after-apply semantics
        try {
          await store.put(compacted);
          if (typeof syncId === 'number') {
            await this.updateWorkspaceMetadata({ lastSyncId: syncId });
          }
        } catch (err: any) {
          getContext().observability.breadcrumb(
            `IndexedDB put failed for ${modelName}:${modelId}`,
            'sync.database',
            'error',
            {
              error: err?.message || String(err),
            }
          );
          throw err; // Re-throw to see the actual error
        }
        return { action: 'add', modelName, modelId, data: compacted };
      }

      case 'U': {
        // ✅ UPDATE: MUST merge with existing record (partial delta pattern)
        // Read existing record first
        const existing = await store.get(modelId);

        // CRITICAL FIX: Skip UPDATE if there's no existing record to merge with
        // Creating a record from partial UPDATE data causes corruption (missing deckId, etc.)
        if (!existing) {
          getContext().observability.breadcrumb(
            'Skipping UPDATE delta - no existing record to merge with',
            'sync.database',
            'warning',
            {
              modelName,
              modelId: modelId.slice(0, 12),
            }
          );
          // Return verify action to signal no changes were made
          return { action: 'verify', modelName, modelId, data: null };
        }

        // Shallow merge: delta overrides existing fields (safe - existing is guaranteed)
        const merged = { ...existing, ...compacted };

        // Log preserved fields for debugging partial updates
        if (existing && compacted) {
          this.logPreservedFields(modelName, modelId, existing, compacted);
        }

        // Persist merged record
        try {
          await store.put(merged);
          if (typeof syncId === 'number') {
            await this.updateWorkspaceMetadata({ lastSyncId: syncId });
          }
        } catch (err: any) {
          getContext().observability.breadcrumb(
            `IndexedDB put failed for ${modelName}:${modelId}`,
            'sync.database',
            'error',
            {
              error: err?.message || String(err),
            }
          );
          throw err;
        }
        // Return merged data (not just delta) to preserve essential fields like organizationId
        return { action: 'update', modelName, modelId, data: merged };
      }

      case 'D': {
        // 🐛 DEBUG: Log slide deletions to track unexpected removals
        if (modelName === 'Slide') {
          getContext().observability.breadcrumb('Deleting Slide from IndexedDB', 'sync.database', 'info', {
            modelId: modelId.slice(0, 12),
          });
        }

        // Delete synchronously
        try {
          await store.delete(modelId);
          if (typeof syncId === 'number') {
            await this.updateWorkspaceMetadata({ lastSyncId: syncId });
          }
        } catch (err: any) {
          getContext().observability.breadcrumb(
            `IndexedDB delete failed for ${modelName}:${modelId}`,
            'sync.database',
            'error',
            {
              error: err?.message || String(err),
            }
          );
          // Surface failure so caller does not mutate ObjectPool inconsistently
          throw err;
        }
        return { action: 'remove', modelName, modelId };
      }

      case 'A': {
        // Archive
        const archivedData = this.compactRecord(modelName, { ...data, archivedAt: new Date() });
        try {
          await store.put(archivedData);
          if (typeof syncId === 'number') {
            await this.updateWorkspaceMetadata({ lastSyncId: syncId });
          }
        } catch (err: any) {
          getContext().observability.breadcrumb(
            `IndexedDB archive put failed for ${modelName}:${modelId}`,
            'sync.database',
            'error',
            {
              error: err?.message || String(err),
            }
          );
          throw err;
        }
        return { action: 'archive', modelName, modelId, data: archivedData };
      }

      case 'V': // Verify
        return { action: 'verify', modelName, modelId, data };

      // 'G' (GroupAdded) and 'S' (GroupRemoved) are sync-group membership
      // signals, not entity mutations. They are routed upstream in
      // BaseSyncedStore.processDeltaWithBatching and should never reach
      // processDelta. If one slips through (e.g. replayed from the bootstrap
      // queue), we return a no-op verify rather than crashing the engine.
      case 'G':
      case 'S':
        getContext().observability.breadcrumb(
          `Group membership delta (${actionType}) reached processDelta — should be handled upstream`,
          'sync.database',
          'warning',
          { modelName, modelId: modelId.slice(0, 12), actionType }
        );
        return { action: 'verify', modelName, modelId, data: null };

      default:
        throw new AbloValidationError(`Unknown action type: ${actionType}`, {
          code: 'db_unknown_action_type',
        });
    }
  }

  /**
   * ✅ PERFORMANCE FIX: Process multiple deltas in a single IndexedDB transaction
   *
   * This method dramatically improves sync performance by:
   * 1. Batch-reading all existing records for UPDATEs (outside transaction for speed)
   * 2. Opening a single transaction per store for all writes
   * 3. Merging UPDATE deltas with existing data to preserve unmodified fields
   * 4. Updating metadata only once at the end with highest syncId
   *
   * Performance impact: 186 deltas goes from ~372 transactions to just 1 transaction
   *
   * 📝 PARTIAL DELTA MERGE PATTERN:
   * - UPDATE deltas contain only changed fields
   * - We merge with existing: {...existing, ...delta}
   * - Preserves deckId, title, settings etc. when updating just position
   * - Handles explicit null: {field: null} clears the field correctly
   *
   * 🔄 LINEAR-STYLE CONFLICT RESOLUTION:
   * - Builds a map of DELETE deltas with their syncIds
   * - Before processing UPDATE/INSERT, checks for DELETE with higher syncId
   * - Skips stale updates for entities that will be/were deleted
   * - Prevents 404 errors from fetching already-deleted entities
   */
  async processDeltaBatch(
    deltas: Array<{
      syncId?: number;
      /**
       * Includes 'G' and 'S' defensively — they're routed upstream and
       * shouldn't reach batch processing, but the switch inside returns
       * no-op verify for them if one slips through.
       */
      actionType: 'I' | 'U' | 'D' | 'A' | 'V' | 'C' | 'G' | 'S';
      modelName: string;
      modelId: string;
      data: ModelData | null;
    }>
  ): Promise<
    Array<{
      action: 'add' | 'update' | 'remove' | 'archive' | 'verify';
      modelName: string;
      modelId: string;
      data?: ModelData | null;
    }>
  > {
    if (!this.workspaceDb || this.isClosing || deltas.length === 0) {
      return [];
    }

    // Prepare results aligned with input order
    const results: Array<{
      action: 'add' | 'update' | 'remove' | 'archive' | 'verify';
      modelName: string;
      modelId: string;
      data?: ModelData | null;
    }> = new Array(deltas.length);

    // ========================================================================
    // LINEAR-STYLE CONFLICT RESOLUTION: Build DELETE syncId index
    // ========================================================================
    // Per Linear's architecture: "If the syncId of the deleting action is larger,
    // the model will not be created." This prevents processing stale UPDATE deltas
    // for entities that have been cascade-deleted (where DELETE delta exists).
    // ========================================================================
    const deleteSyncIds = new Map<string, number>(); // key: "ModelName:modelId" -> DELETE syncId

    for (const delta of deltas) {
      if (delta.actionType === 'D' && delta.syncId) {
        const key = `${delta.modelName}:${delta.modelId}`;
        const existing = deleteSyncIds.get(key);
        // Normalize to number — postgres sends bigint as string on the wire.
        const n = typeof delta.syncId === 'string' ? Number(delta.syncId) : delta.syncId;
        if (typeof n === 'number' && !isNaN(n) && (!existing || n > existing)) {
          deleteSyncIds.set(key, n);
        }
      }
    }

    if (deleteSyncIds.size > 0) {
      getContext().logger.debug('[Database.processDeltaBatch] Built DELETE index for conflict resolution', {
        deleteCount: deleteSyncIds.size,
        totalDeltas: deltas.length,
      });
    }

    // Group deltas by store for efficient transaction management.
    //
    // Two highwater marks: `highestSyncId` is the total range seen;
    // `highestPersistedSyncId` accumulates only from deltas whose store
    // transaction actually succeeded. The cursor advance (via
    // `updateWorkspaceMetadata`) uses ONLY the persisted one — without
    // this split, a single store-level IDB failure (e.g. missing keyPath
    // field, validation abort) silently advances the cursor past deltas
    // that never wrote to IDB. Next partial bootstrap would then ask
    // "what's new since {advanced cursor}?" and the skipped rows fall
    // into the already-seen range forever.
    const deltasByStore = new Map<string, Array<{ idx: number; delta: (typeof deltas)[number] }>>();
    let highestSyncId = 0;
    let highestPersistedSyncId = 0;
    let skippedDueToConflict = 0;

    deltas.forEach((delta, idx) => {
      // Normalize to number — postgres sends bigint syncIds as strings.
      const deltaSyncIdNum = typeof delta.syncId === 'string'
        ? Number(delta.syncId)
        : delta.syncId;
      if (typeof deltaSyncIdNum === 'number' && !isNaN(deltaSyncIdNum) && deltaSyncIdNum > highestSyncId) {
        highestSyncId = deltaSyncIdNum;
      }

      // ========================================================================
      // CONFLICT CHECK: Skip UPDATE/INSERT if DELETE exists with higher syncId
      // ========================================================================
      if (delta.actionType === 'U' || delta.actionType === 'I' || delta.actionType === 'C') {
        const key = `${delta.modelName}:${delta.modelId}`;
        const deleteSyncId = deleteSyncIds.get(key);

        if (deleteSyncId !== undefined) {
          // DELETE exists for this entity
          const deltaSyncId = delta.syncId || 0;

          if (deleteSyncId >= deltaSyncId) {
            // DELETE has equal or higher syncId - skip this UPDATE/INSERT
            getContext().logger.debug('[Database.processDeltaBatch] Skipping stale delta (DELETE wins)', {
              modelName: delta.modelName,
              modelId: delta.modelId.slice(0, 12),
              actionType: delta.actionType,
              deltaSyncId,
              deleteSyncId,
            });
            results[idx] = { action: 'verify', modelName: delta.modelName, modelId: delta.modelId };
            skippedDueToConflict++;
            return; // Skip this delta
          }
        }
      }

      const store = this.getOptionalStore(delta.modelName, 'processDeltaBatch');
      if (!store) {
        results[idx] = { action: 'verify', modelName: delta.modelName, modelId: delta.modelId };
        return;
      }

      if (!deltasByStore.has(delta.modelName)) {
        deltasByStore.set(delta.modelName, []);
      }
      deltasByStore.get(delta.modelName)!.push({ idx, delta });
    });

    if (skippedDueToConflict > 0) {
      getContext().logger.info('[Database.processDeltaBatch] Conflict resolution summary', {
        skippedDueToConflict,
        totalDeltas: deltas.length,
        deleteCount: deleteSyncIds.size,
      });
    }

    // Process each store's deltas in a single transaction
    for (const [modelName, storeDeltas] of deltasByStore.entries()) {
      const store = this.storeManager.getStore(modelName);
      if (!store) continue;

      try {
        // ✅ BEST PRACTICE: Batch read-modify-write pattern
        // Step 1: Identify which deltas need existing data (UPDATEs)
        const updateDeltas = storeDeltas.filter(({ delta }) => delta.actionType === 'U');
        const updateIds = updateDeltas.map(({ delta }) => delta.modelId);

        // Step 2: Batch read all existing records in a SINGLE IDB transaction
        // This replaces N sequential get() calls with 1 transaction containing N gets
        let existingRecords = new Map<string, ModelData>();
        const missingIds = new Set<string>();

        if (updateIds.length > 0) {
          try {
            existingRecords = await store.getMany(updateIds);
            // Identify missing IDs for self-healing
            for (const id of updateIds) {
              if (!existingRecords.has(id)) {
                missingIds.add(id);
              }
            }
          } catch (error) {
            getContext().observability.breadcrumb(
              `Batch read failed for ${modelName}, falling back to individual reads`,
              'sync.database',
              'warning'
            );
            // Fallback: mark all as missing for self-healing
            for (const id of updateIds) {
              missingIds.add(id);
            }
          }
        }

        // ✅ SELF-HEALING: Fetch missing records for UPDATE deltas
        // Track IDs that failed to fetch (404 = entity deleted, skip the delta)
        const failedToFetch = new Set<string>();

        if (missingIds.size > 0) {
          getContext().logger.info(
            `[Database.processDeltaBatch] Found ${missingIds.size} missing records for ${modelName}, fetching from server...`
          );

          // Fetch sequentially to avoid overwhelming server
          for (const id of missingIds) {
            try {
              const fetchedRecord = await this.bootstrapHelper.fetchEntity(modelName, id);
              if (fetchedRecord) {
                const compacted = this.compactRecord(modelName, fetchedRecord);
                existingRecords.set(id, compacted);
                getContext().logger.debug(
                  `[Database.processDeltaBatch] Successfully fetched missing record: ${modelName}:${id}`
                );
              } else {
                // fetchEntity returns null for 404 — entity was deleted, skip the delta
                failedToFetch.add(id);
                getContext().logger.debug(
                  `[Database.processDeltaBatch] Entity not found (deleted): ${modelName}:${id}`
                );
              }
            } catch (error: unknown) {
              // Unexpected error (5xx, network failure) — mark for skipping and report
              failedToFetch.add(id);
              getContext().observability.breadcrumb(
                `Failed to fetch missing record ${modelName}:${id}`,
                'sync.database',
                'warning',
                {
                  error: error instanceof Error ? error.message : String(error),
                }
              );
            }
          }

          if (failedToFetch.size > 0) {
            getContext().logger.info(
              `[Database.processDeltaBatch] Skipping ${failedToFetch.size} stale UPDATE deltas for deleted entities`,
              {
                modelName,
                failedCount: failedToFetch.size,
                totalMissing: missingIds.size,
              }
            );
          }
        }

        // Re-check after entity fetch loop: close() may have run during network I/O
        if (!this.workspaceDb || this.isClosing) {
          for (const { idx, delta } of storeDeltas) {
            results[idx] = { action: 'verify', modelName, modelId: delta.modelId };
          }
          continue;
        }

        // Step 3: Start a single readwrite transaction for this store
        const tx = this.workspaceDb.transaction([modelName], 'readwrite');
        const objectStore = tx.objectStore(modelName);

        // Stage results for this store; only commit to global results when tx completes successfully
        const stagedResults: Array<{
          action: 'add' | 'update' | 'remove' | 'archive' | 'verify';
          modelName: string;
          modelId: string;
          data?: any;
          idx: number;
        }> = [];

        // Step 4: Process all deltas synchronously within transaction (no await!)
        for (const { idx, delta } of storeDeltas) {
          const { actionType, modelId, data } = delta;
          // Server deltas carry `id` in the envelope (modelId) but often
          // strip it from the `data` payload as redundant. IDB object
          // stores use keyPath='id' on the record itself, so the record
          // MUST have `id` set — otherwise `put()` throws `DataError:
          // Evaluating the object store's key path did not yield a value`
          // and the entire transaction aborts, silently wiping every
          // CREATE/UPDATE in the batch.
          const dataWithId =
            data && typeof data === 'object'
              ? { id: modelId, ...(data as Record<string, unknown>) }
              : data;
          const compacted =
            dataWithId && typeof dataWithId === 'object'
              ? this.compactRecord(modelName, dataWithId as ModelData)
              : dataWithId;

          switch (actionType) {
            case 'C': // Create
            case 'I': // Insert
              objectStore.put(compacted);
              stagedResults.push({
                action: 'add',
                modelName,
                modelId,
                data: compacted,
                idx,
              });
              break;

            case 'U': {
              // ✅ UPDATE: Merge delta with existing record (already fetched)
              const existing = existingRecords.get(modelId);

              // ========================================================================
              // SKIP STALE DELTAS: If entity doesn't exist locally AND failed to fetch
              // from server (404), this is a stale UPDATE for a deleted entity.
              // Per Linear's architecture, skip it instead of creating incomplete data.
              // ========================================================================
              if (!existing && failedToFetch.has(modelId)) {
                getContext().logger.debug('[Database.processDeltaBatch] Skipping UPDATE for deleted entity', {
                  modelName,
                  modelId: modelId.slice(0, 12),
                });
                stagedResults.push({ action: 'verify', modelName, modelId, idx });
                break; // Skip this delta
              }

              // CRITICAL FIX: Skip UPDATE if there's no existing record to merge with
              // Creating a record from partial UPDATE data causes corruption (missing deckId, etc.)
              if (!existing) {
                getContext().observability.breadcrumb(
                  'Batch: Skipping UPDATE delta - no existing record',
                  'sync.database',
                  'warning',
                  {
                    modelName,
                    modelId: modelId.slice(0, 12),
                  }
                );
                stagedResults.push({ action: 'verify', modelName, modelId, idx });
                break; // Skip this delta
              }

              // Safe to merge - existing record is guaranteed
              const merged = { ...existing, ...compacted };

              // Log preserved fields for debugging partial updates
              if (existing && compacted) {
                this.logPreservedFields(modelName, modelId, existing, compacted);
              }

              objectStore.put(merged);
              stagedResults.push({
                action: 'update',
                modelName,
                modelId,
                data: merged, // Return merged data, not just delta
                idx,
              });
              break;
            }

            case 'D': // Delete
              // 🐛 DEBUG: Log slide deletions to track unexpected removals
              if (modelName === 'Slide') {
                getContext().observability.breadcrumb(
                  'Batch: Deleting Slide from IndexedDB',
                  'sync.database',
                  'info',
                  {
                    modelId: modelId.slice(0, 12),
                  }
                );
              }
              objectStore.delete(modelId);
              stagedResults.push({ action: 'remove', modelName, modelId, idx });
              break;

            case 'A': // Archive
              const archivedData = this.compactRecord(modelName, {
                ...data,
                archivedAt: new Date(),
              });
              objectStore.put(archivedData);
              stagedResults.push({
                action: 'archive',
                modelName,
                modelId,
                data: archivedData,
                idx,
              });
              break;

            case 'V': // Verify
              stagedResults.push({ action: 'verify', modelName, modelId, data, idx });
              break;
          }
        }

        // Wait for transaction to complete
        await new Promise<void>((resolve, reject) => {
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        });
        // Only commit staged results to the global results if the transaction
        // succeeded. Also advance `highestPersistedSyncId` ONLY for deltas in
        // this successful tx — so the cursor can't advance past rows that
        // never wrote to IDB.
        for (const r of stagedResults) {
          results[r.idx] = {
            action: r.action,
            modelName: r.modelName,
            modelId: r.modelId,
            data: r.data,
          };
          const rawSyncId = storeDeltas[
            storeDeltas.findIndex(({ idx }) => idx === r.idx)
          ]?.delta.syncId;
          // SyncDelta.syncId is typed as number but postgres serializes bigint
          // to string on the wire — coerce before compare.
          const syncId = typeof rawSyncId === 'string' ? Number(rawSyncId) : rawSyncId;
          if (typeof syncId === 'number' && !isNaN(syncId) && syncId > highestPersistedSyncId) {
            highestPersistedSyncId = syncId;
          }
        }
      } catch (err: any) {
        // Surface the IDB error directly — during interactive debugging the
        // console needs to show the specific failure (`ConstraintError`,
        // `DataError`, `AbortError`) so we can find what's wrong with the
        // `compacted` payload shape or store schema. `captureTransactionFailure`
        // alone routes to Sentry only.
        const idbErr = err instanceof Error ? err : new Error(String(err));
        getContext().logger.warn('[Database.processDeltaBatch] store tx FAILED', {
          modelName,
          storeDeltasCount: storeDeltas.length,
          errorName: idbErr.name,
          message: idbErr.message,
          sampleDeltas: storeDeltas.slice(0, 3).map(({ delta }) => ({
            action: delta.actionType,
            id: delta.modelId.slice(0, 12),
            dataKeys: delta.data && typeof delta.data === 'object'
              ? Object.keys(delta.data as Record<string, unknown>).slice(0, 8)
              : typeof delta.data,
          })),
        });
        getContext().observability.captureTransactionFailure({
          context: 'batch-indexeddb-operation',
          modelName,
          error: idbErr,
        });
        // Mark all store deltas as verify in their original positions
        for (const { idx, delta } of storeDeltas) {
          results[idx] = { action: 'verify', modelName, modelId: delta.modelId };
        }
      }
    }

    // Update metadata only to the highest syncId whose store transaction
    // actually committed. Using `highestSyncId` (the range-seen max) would
    // advance the cursor past deltas that failed to persist — creating a
    // cursor/IDB divergence that makes subsequent partial bootstraps skip
    // the missing rows forever.
    //
    // If `highestPersistedSyncId === 0` (every store tx failed), we leave
    // the metadata alone. Next partial bootstrap will re-deliver the deltas
    // at the original cursor position.
    if (highestPersistedSyncId > 0) {
      try {
        await this.updateWorkspaceMetadata({ lastSyncId: highestPersistedSyncId });
      } catch (err: any) {
        getContext().observability.breadcrumb(
          'Failed to update metadata after batch',
          'sync.database',
          'error',
          {
            error: err?.message || String(err),
          }
        );
      }
    }
    if (highestPersistedSyncId < highestSyncId) {
      // Staging-visibility probe: makes the "some deltas seen but not
      // persisted" signal loud when it actually happens. If this fires
      // repeatedly on the same sync IDs, a specific row is un-writable
      // (validation? compact issue?) and needs fixing at that layer.
      getContext().logger.warn('[Database.processDeltaBatch] cursor withheld due to failed store tx', {
        seen: highestSyncId,
        persisted: highestPersistedSyncId,
        gap: highestSyncId - highestPersistedSyncId,
      });
    }

    return results;
  }

  /** Get raw data for hydration */
  async hydrateModels(modelName: string): Promise<ModelData[]> {
    const store = this.getOptionalStore(modelName, 'hydrate');
    if (!store) {
      return [];
    }
    return store.getAll();
  }

  /** Put a single record to IndexedDB (for self-healing corrupted records) */
  async putRecord(modelName: string, id: string, data: Record<string, unknown>): Promise<void> {
    const store = this.getOptionalStore(modelName, 'putRecord');
    if (!store) {
      getContext().observability.breadcrumb(
        `Store not found for putRecord: ${modelName}`,
        'sync.database',
        'warning'
      );
      return;
    }
    const compacted = this.compactRecord(modelName, data);
    await store.put(compacted);
  }

  /** Get data by index */
  async getDataByIndex(modelName: string, indexName: string, value: unknown): Promise<ModelData[]> {
    const store = this.getRequiredStore(modelName);
    return await store.getAllFromIndex(indexName, value);
  }

  /**
   * Update workspace metadata
   */
  /**
   * Get the last sync ID from workspace metadata
   */
  /** Read workspace metadata from IDB (returns null if db not open). */
  async getWorkspaceMetadata(): Promise<WorkspaceMetadata | null> {
    if (this.inMemory) return this.inMemoryMetadata;
    if (!this.workspaceDb) return null;
    return this.databaseManager.getWorkspaceMetadata(this.workspaceDb);
  }

  async getLastSyncId(): Promise<number> {
    if (!this.workspaceDb) {
      return 0;
    }

    const metadata = await this.databaseManager.getWorkspaceMetadata(this.workspaceDb);
    return metadata?.lastSyncId || 0;
  }

  async getVersionVector(): Promise<Record<string, number> | null> {
    if (!this.workspaceDb) return null;
    const metadata = await this.databaseManager.getWorkspaceMetadata(this.workspaceDb);
    return (
      (metadata as WorkspaceMetadata & { versions?: Record<string, number> })?.versions || null
    );
  }

  async updateWorkspaceMetadata(metadata: Partial<WorkspaceMetadata>): Promise<void> {
    // In-memory mode: store in local variable
    if (this.inMemory) {
      this.inMemoryMetadata = {
        ...(this.inMemoryMetadata ?? {
          lastSyncId: 0, firstSyncId: 0, backendDatabaseVersion: 0,
          subscribedSyncGroups: [], updatedAt: new Date(),
        }),
        ...metadata,
        updatedAt: new Date(),
      } as WorkspaceMetadata;
      return;
    }

    // Graceful degradation: skip if database is closing or not open
    // This prevents "Database not opened" errors during React Strict Mode cleanup
    if (!this.workspaceDb || this.isClosing) {
      getContext().observability.breadcrumb(
        'updateWorkspaceMetadata: Database not open or closing',
        'sync.database',
        'warning',
        {
          hasDb: !!this.workspaceDb,
          isClosing: this.isClosing,
        }
      );
      return;
    }

    const current = await this.databaseManager.getWorkspaceMetadata(this.workspaceDb);

    // Re-check after await: close() may have been called during getWorkspaceMetadata,
    // or the browser may have closed the IDB connection (tab background, navigation).
    // Without this, setWorkspaceMetadata would hit "The database connection is closing".
    if (!this.workspaceDb || this.isClosing) {
      return;
    }

    const updated = {
      ...current,
      ...metadata,
      updatedAt: new Date(),
    } as WorkspaceMetadata;

    await this.databaseManager.setWorkspaceMetadata(this.workspaceDb, updated);
  }

  /** Transaction persistence for offline/retry support */
  private get transactionStore() {
    if (this.inMemory) {
      return this.inMemoryStores.get('__transactions') as unknown as ReturnType<StoreManager['getStore']>;
    }
    return this.storeManager.getStore('__transactions');
  }

  async saveTransaction(transaction: PersistedTransaction): Promise<void> {
    await this.transactionStore?.put(transaction);
  }

  async removeTransaction(id: string): Promise<void> {
    await this.transactionStore?.delete(id);
  }

  async getPersistedTransactions(): Promise<PersistedTransaction[]> {
    return (await this.transactionStore?.getAll()) ?? [];
  }

  async cleanupOldTransactions(maxAge: number): Promise<number> {
    const store = this.transactionStore;
    if (!store) return 0;

    const all = await store.getAll();
    const cutoff = Date.now() - maxAge;
    let cleaned = 0;

    for (const tx of all) {
      if (tx.timestamp && tx.timestamp < cutoff) {
        await store.delete(tx.id);
        cleaned++;
      }
    }
    return cleaned;
  }

  /**
   * Store management
   */
  getStore(modelName: string) {
    // In-memory mode: return InMemoryObjectStore if available
    if (this.inMemory) {
      return this.inMemoryStores.get(modelName) as unknown as ReturnType<StoreManager['getStore']>;
    }
    return this.storeManager.getStore(modelName);
  }

  getAllStores() {
    if (this.inMemory) {
      return this.inMemoryStores as unknown as ReturnType<StoreManager['getAllStores']>;
    }
    return this.storeManager.getAllStores();
  }

  /**
   * Model persistence tracking
   */
  async setModelPersisted(modelName: string, persisted: boolean): Promise<void> {
    if (this.inMemory) return; // No persistence tracking in memory mode
    if (!this.workspaceDb) {
      throw new AbloConnectionError('Database not opened', {
        code: 'db_not_opened',
      });
    }

    await this.databaseManager.setModelPersisted(this.workspaceDb, modelName, persisted);
  }

  async isModelPersisted(modelName: string): Promise<boolean> {
    if (this.inMemory) return false; // In-memory = nothing persisted
    if (!this.workspaceDb) {
      throw new AbloConnectionError('Database not opened', {
        code: 'db_not_opened',
      });
    }

    return await this.databaseManager.isModelPersisted(this.workspaceDb, modelName);
  }

  /**
   * Statistics
   */
  async getStats() {
    const storeStats = await this.storeManager.getComprehensiveStats();

    return {
      database: this.currentDbInfo,
      stores: storeStats,
      metadata: this.workspaceDb
        ? await this.databaseManager.getWorkspaceMetadata(this.workspaceDb)
        : null,
    };
  }

  /**
   * Lifecycle
   */
  isOpen(): boolean {
    return this.workspaceDb !== null;
  }

  async close(): Promise<void> {
    // Mark database as closing FIRST to enable graceful degradation
    // This allows in-flight operations to bail out gracefully
    this.isClosing = true;

    // Mark all stores as closing to prevent new operations
    this.storeManager.markAllStoresAsClosing();

    if (this.workspaceDb) {
      this.workspaceDb.close();
      this.workspaceDb = null;
    }

    await this.databaseManager.close();
    this.currentDbInfo = null;

    getContext().logger.debug('Database closed');
  }

  async clear(): Promise<void> {
    await this.storeManager.clearAllStores();
    getContext().logger.info('All stores cleared');
  }
}
