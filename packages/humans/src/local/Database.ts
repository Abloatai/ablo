/**
 * The local persistence layer for synced models. It stores rows in the
 * browser's IndexedDB (or in-memory maps when run headlessly), applies inbound
 * deltas to that store, and fetches the bootstrap snapshot from your sync
 * server. {@link BaseSyncedStore} drives it, and {@link InstanceCache} holds the
 * in-memory mirror of what this class persists.
 */
import { DatabaseManager, type DatabaseInfo, type WorkspaceMetadata } from './stores/DatabaseManager.js';
import type { PersistenceIdentity } from './stores/persistenceIdentity.js';
import { StoreManager } from './stores/StoreManager.js';
import { ModelRegistry } from './ModelRegistry.js';
import { LoadStrategy } from '@abloatai/transaction/types';
import { globalRuntime } from './context.js';
import type { RuntimeContext } from './RuntimeContext.js';
import type { AppliedChange } from '../plugin.js';
import { AbloConnectionError, AbloValidationError } from '@abloatai/transaction/errors';
import {
  persistenceDatabaseNamesForDeletion,
  purgeIndexedDbPersistence,
} from './stores/persistenceCleanup.js';
import type { BootstrapFetcher, BootstrapData } from './sync/BootstrapFetcher.js';
import { InMemoryObjectStore } from './adapters/inMemoryStorage.js';
import { logPositionSnapshotSchema } from './logPosition.js';
import type { SyncDeltaAction } from '@abloatai/transaction/observation';
import type { BootstrapType } from '@abloatai/transaction/types';
import { highestPersistedPrefixSyncId } from './sync/persistedPrefix.js';
import {
  isAcceptedOutboxPromotion,
  isSameOutboxRecord,
  type PersistedTransaction,
} from './transactions/persistedTransaction.js';

/** Generic record type for model data */
type ModelData = Record<string, unknown>;

/**
 * Carry each input delta's log position onto the change that answers it.
 * `processDeltaBatch` builds its results index-aligned with its input, so the
 * position is stamped once here rather than at every construction site.
 */
function stampSyncIds(
  results: AppliedChange[],
  deltas: readonly { syncId?: number }[],
): AppliedChange[] {
  for (let index = 0; index < results.length; index++) {
    const change = results[index];
    const syncId = deltas[index]?.syncId;
    if (change && typeof syncId === 'number') change.syncId = syncId;
  }
  return results;
}

// Re-exported, not redeclared. `@abloatai/transaction`'s `types` module owns this
// vocabulary and documents what each mode does; this package held a byte-identical
// second copy while its own test fixtures already imported the canonical one.
export type { BootstrapType };

export interface BootstrapRequirements {
  type: BootstrapType;
  modelsToLoad: string[];
  lastSyncId: number;
  syncGroups: string[];
}

export interface BootstrapResult {
  modelsLoaded: number;
  modelsStored: number;
  /** The raw bootstrap response — callers can apply models directly to InstanceCache */
  bootstrapData: BootstrapData;
  /**
   * Results of applying partial-bootstrap deltas to IDB. Present only when
   * `bootstrapData.type === 'partial'` and deltas were processed. Callers
   * forward these to `syncClient.applyDeltaBatchToPool` so the in-memory
   * pool reflects inserts/updates/deletes that arrived while the client
   * was disconnected — without this, DELETE deltas persist to IDB but
   * ghost entities linger in the pool until a full reload.
   */
  deltaResults?: AppliedChange[];
}

export class Database {
  // Core database components
  private databaseManager: DatabaseManager;
  private storeManager: StoreManager;

  // Injected dependencies
  private modelRegistry: ModelRegistry;
  private bootstrapHelper: BootstrapFetcher;

  /** The pre-configured query helper for lazy-loading data from the sync server. */
  get helper(): BootstrapFetcher {
    return this.bootstrapHelper;
  }

  /**
   * Fetch the current rows of the given sync groups as a side-effect-free
   * snapshot, used to hydrate a scope as the user enters it. Unlike
   * {@link bootstrapFromServer}, it does not persist to IndexedDB and does not
   * change the connection's subscribed sync groups. The caller applies the
   * result to the pool through the scoped apply path.
   */
  async fetchScopedBootstrapData(
    syncGroups: readonly string[],
  ): Promise<BootstrapData> {
    // No lastSyncId → a full snapshot of exactly these groups.
    return this.bootstrapHelper.fetchBootstrap(undefined, syncGroups);
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
    return this.runtime.config.essentialFields;
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

  private readonly runtime: RuntimeContext;

  /** In-memory stores used when inMemory=true. Keyed by model name. */
  private inMemoryStores = new Map<string, InMemoryObjectStore>();

  /** In-memory workspace metadata when inMemory=true. */
  private inMemoryMetadata: WorkspaceMetadata | null = null;

  constructor(
    modelRegistry: ModelRegistry,
    bootstrapHelper: BootstrapFetcher,
    options?: { inMemory?: boolean; runtime?: RuntimeContext },
  ) {
    this.runtime = options?.runtime ?? globalRuntime;
    this.databaseManager = new DatabaseManager(this.runtime);
    this.storeManager = new StoreManager(modelRegistry, this.runtime);
    this.modelRegistry = modelRegistry;
    this.bootstrapHelper = bootstrapHelper;
    this.inMemory = options?.inMemory ?? false;
  }

  /**
   * Get store for a model, or `undefined` if no store exists.
   *
   * Routes to `inMemoryStores` in inMemory mode and `storeManager`
   * otherwise. Both implementations satisfy `ObjectStoreContract`, so
   * callers don't branch on which one they got back.
   *
   * Pass `context` to emit an observability breadcrumb when the store
   * is missing — useful for hot paths (bootstrap, delta apply, hydrate)
   * where a missing store points to silent data loss. Callers that
   * already expect optional behavior (e.g. lazy lookups) can omit it.
   */
  getStore(modelName: string, context?: string) {
    const store = this.inMemory
      ? this.inMemoryStores.get(modelName)
      : this.storeManager.getStore(modelName);
    if (!store && context) {
      this.runtime.observability.breadcrumb(
        `Store not found for model: ${modelName}`,
        'sync.database',
        'warning',
        { context },
      );
    }
    return store;
  }

  /** Get store or throw if not found (for operations that require the store). */
  private getRequiredStore(modelName: string) {
    const store = this.getStore(modelName);
    if (!store) {
      throw new AbloValidationError(`Store not found: ${modelName}`, {
        code: 'db_store_not_found',
      });
    }
    return store; // TypeScript narrows to non-undefined after the throw
  }

  /** Log preserved fields during partial UPDATE merge (debug helper) */
  private logPreservedFields(
    modelName: string,
    modelId: string,
    existing: ModelData,
    delta: ModelData
  ): void {
    if (modelName === 'Activity') return;

    const requiredFields = this.essentialFields[modelName] ?? [];
    const preserved = requiredFields.filter(
      (field) => existing[field] !== undefined && delta[field] === undefined
    );

    if (preserved.length > 0) {
      this.runtime.logger.debug('[Database] UPDATE merged - preserved fields', {
        modelName,
        modelId: modelId.slice(0, 12),
        deltaFields: Object.keys(delta),
        preservedFields: preserved,
      });
    }
  }

  async open(identity: PersistenceIdentity, version = 1): Promise<void> {
    this.isClosing = false;

    if (this.workspaceDb && this.currentDbInfo) {
      return;
    }

    // ── In-memory mode: skip IndexedDB entirely ──────────────────
    // Creates InMemoryObjectStore instances for all registered models.
    // Bootstrap via HTTP still works; only local persistence is skipped.
    if (this.inMemory) {
      this.runtime.logger.debug('Opening in-memory database (headless mode)');
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
      this.runtime.logger.info(
        `In-memory database opened: ${this.inMemoryStores.size} stores`,
      );
      return;
    }

    // ── Browser mode: IndexedDB (existing behavior, unchanged) ───
    this.runtime.logger.debug('Opening IndexedDB database');

    // Initialize meta database
    await this.databaseManager.initializeMetaDatabase();

    this.currentDbInfo = await this.databaseManager.calculateDatabaseInfo(
      identity,
      version
    );

    // Register database
    await this.databaseManager.registerDatabase(this.currentDbInfo);

    // Open workspace database
    this.workspaceDb = await this.databaseManager.openWorkspaceDatabase(
      this.currentDbInfo,
      async (db) => {
        await this.storeManager.createStores(db);
      }
    );

    // Initialize stores
    await this.storeManager.initializeStores(this.workspaceDb);

    const readiness = await this.storeManager.checkReadinessOfStores();
    this.runtime.logger.info(
      `Database opened: ${this.currentDbInfo.name} (${readiness.readyStores.length}/${readiness.totalStores} stores ready)`
    );
  }

  /**
   * Shrink a record before persisting it. Drops `undefined` fields, empty
   * arrays, empty objects, and the redundant markers `__typename`, `__class`,
   * `clientId`, and `syncStatus`. Explicit `null` values are preserved, since
   * a null is a meaningful "clear this field" in a nullable column.
   *
   * By design this receives plain objects, never live observables: WebSocket
   * deltas arrive already parsed, optimistic updates come through `toJSON()`,
   * and bootstrap data is plain JSON from the server.
   */
  private compactRecord(_modelName: string, data: ModelData): ModelData {
    if (!data || typeof data !== 'object') return data;

    const out: ModelData = {};

    for (const key in data) {
      if (!Object.prototype.hasOwnProperty.call(data, key)) continue;
      this.compactAssign(out, key, data[key]);
    }

    // Always ensure id is present
    if (!out.id && data.id) out.id = data.id;

    return out;
  }

  /**
   * The one definition of the per-key compaction rule: drops the redundant
   * markers `__typename`, `__class`, `clientId`, and `syncStatus`, drops
   * `undefined`, empty arrays, and empty plain objects, and preserves
   * explicit `null` (a meaningful "clear this field" for a nullable column)
   * and `Date` instances (IndexedDB can clone these). `compactRecord` applies
   * it into a fresh object; the batched in-memory delta path applies it
   * directly onto the merge target so a delta costs one object, not four.
   */
  private compactAssign(out: ModelData, key: string, value: unknown): void {
    if (key === '__typename' || key === '__class' || key === 'clientId' || key === 'syncStatus') {
      return;
    }

    if (value === undefined) return;

    if (Array.isArray(value)) {
      if (value.length === 0) return;
      out[key] = value;
      return;
    }

    if (typeof value === 'object') {
      if (value === null) {
        out[key] = null;
        return;
      }

      if (value instanceof Date) {
        out[key] = value;
        return;
      }

      if (Object.keys(value).length === 0) return;
      out[key] = value;
      return;
    }

    out[key] = value;
  }

  /**
   * Compact a wire delta's payload in one pass, mirroring
   * `compactRecord({ id: modelId, ...data })` exactly: the id key is
   * processed first with the payload's own `id` winning over the envelope's,
   * then each payload key in order. Passing an existing record as `out`
   * makes this the update merge — compacted keys override, dropped keys
   * leave the existing values untouched — without the intermediate
   * id-injected and compacted copies the spread form allocates.
   */
  private compactDeltaRecord(
    modelId: string,
    data: Record<string, unknown>,
    out: ModelData = {},
  ): ModelData {
    const hasOwnId = Object.prototype.hasOwnProperty.call(data, 'id');
    this.compactAssign(out, 'id', hasOwnId ? data.id : modelId);

    for (const key in data) {
      if (key === 'id') continue;
      if (!Object.prototype.hasOwnProperty.call(data, key)) continue;
      this.compactAssign(out, key, data[key]);
    }

    if (!out.id) {
      const idValue = hasOwnId ? data.id : modelId;
      if (idValue) out.id = idValue;
    }

    return out;
  }

  /**
   * Mark that the next bootstrap must be a full bootstrap.
   * Called when a sync group change ("G" delta) is received — the client must
   * re-fetch all data from the server to purge models from revoked sync groups.
   */
  markRequiresFullBootstrap(): void {
    this._forceFullBootstrap = true;
    this.runtime.logger.info('[Database] Marked for forced full bootstrap (sync group change)');
  }

  /**
   * Smart bootstrap requirements based on data freshness
   */
  async requiredBootstrap(): Promise<BootstrapRequirements> {
    // In-memory mode (server-side agents, headless workers): there's
    // no `workspaceDb` by design — `open()` returns early after
    // initializing `inMemoryStores`. Persistent data never exists
    // across sessions, so the right answer is always a full bootstrap
    // from the server. Mirrors the `inMemory` short-circuit in
    // `setModelPersisted` / `isModelPersisted` / `getMetadata`.
    if (this.inMemory) {
      const instantModels = this.modelRegistry.getModelsByLoadStrategy(LoadStrategy.instant);
      const lazyModels = this.modelRegistry.getModelsByLoadStrategy(LoadStrategy.lazy);
      return {
        type: 'full',
        modelsToLoad: [...instantModels, ...lazyModels],
        lastSyncId: 0,
        syncGroups: [],
      };
    }

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
      this.runtime.logger.info('[Database.requiredBootstrap] Forced FULL bootstrap (sync group change)');
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

    // Gate the PERSISTED cursor through the sync-position schema field —
    // the one trust boundary for resume state. IDB can hand back anything
    // (a corrupted negative/float cursor would previously pass `|| 0`,
    // which only catches falsy, and get sent to the server as the resume
    // point). Invalid → 0 → full bootstrap, the safe degradation.
    const metadataLastSyncId =
      logPositionSnapshotSchema.shape.persisted.safeParse(metadata?.lastSyncId).data ?? 0;
    const dataAge = metadata?.updatedAt ? Date.now() - metadata.updatedAt.getTime() : Infinity;

    // ── Cache-validity check ─────────────────────────────────────
    //
    // The cursor (lastSyncId) is only valid if the data it refers to
    // actually exists in the stores. If the local store was cleared (or
    // this is a fresh in-memory session), the metadata's lastSyncId is
    // stale — sending it to the server would trigger a partial bootstrap
    // that returns zero deltas because the gap is 0, leaving the client
    // with an empty InstanceCache.
    //
    // The fix is to sample the actual stores: if they hold no rows, the
    // cursor is meaningless regardless of what the metadata claims.
    const dataExists = this.inMemory
      ? false  // In-memory mode: no persistent data across sessions
      : await this.storeManager.hasAnyData();

    // The effective lastSyncId: only trust the metadata cursor when
    // we've confirmed the data it refers to actually exists in the stores.
    const lastSyncId = dataExists ? metadataLastSyncId : 0;

    // Log the resolved database state for diagnostics.
    this.runtime.logger.debug('[Database.requiredBootstrap] State check', {
      readinessReady: readiness.ready,
      hasMetadata: !!metadata,
      metadataLastSyncId,
      effectiveLastSyncId: lastSyncId,
      dataExists,
      dataAge: metadata?.updatedAt ? Math.round(dataAge / 1000) + 's' : 'N/A',
      navigatorOnline: typeof navigator !== 'undefined' ? navigator.onLine : 'N/A',
    });

    // Determine bootstrap type based on connectivity and data state
    const offline = typeof navigator !== 'undefined' && navigator && !navigator.onLine;
    let type: BootstrapType;

    // hasLocalData: stores actually have records AND we have a valid cursor
    const hasLocalData = readiness.ready && dataExists && lastSyncId > 0;

    if (offline && hasLocalData) {
      // Offline with data - use local bootstrap (only option when offline)
      type = 'local';
      this.runtime.logger.info('Offline detected with local data - using local bootstrap');
    } else {
      // The server is the source of truth: always use a full bootstrap
      // when online.
      type = 'full';
      this.runtime.logger.info('Full bootstrap - server is source of truth', {
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
      syncGroups: metadata?.syncGroups ?? [],
    };
  }

  /**
   * Fetch a bootstrap snapshot (or delta batch) from the sync server and load
   * it into the local store, then return a {@link BootstrapResult} the caller
   * applies to the {@link InstanceCache}.
   */
  async bootstrapFromServer(
    requirements: BootstrapRequirements,
    /** Full sync-group subscription list — what the WS subscribes to
     *  AND what gets persisted as `subscribedSyncGroups` for the
     *  shrinkage check. Caller supplies the complete list, not just
     *  team-derived groups. */
    syncGroups: readonly string[],
    onProgress?: (loaded: number) => void
  ): Promise<BootstrapResult> {
    this.runtime.logger.debug('Starting bootstrap fetch', {
      type: requirements.type,
      lastSyncId: requirements.lastSyncId,
      modelsToLoad: requirements.modelsToLoad,
    });
    this.runtime.logger.info('Database: Starting bootstrap from Go server', {
      type: requirements.type,
      syncGroups,
      modelsToLoad: requirements.modelsToLoad,
    });

    try {
      // Fetch before any destructive operation, so a failed network
      // request can't leave the local store empty.
      const startTime = typeof performance !== 'undefined' ? performance.now() : Date.now();

      this.runtime.logger.info('Fetching bootstrap data from server (before clearing local data)', {
        type: requirements.type,
        lastSyncId: requirements.lastSyncId,
      });

      const bootstrapData = await this.bootstrapHelper.fetchBootstrap(requirements.lastSyncId);

      this.runtime.logger.debug('Received bootstrap response', {
        type: bootstrapData.type,
        lastSyncId: bootstrapData.lastSyncId,
        hasModels: !!bootstrapData.models,
        hasDeltas: !!bootstrapData.deltas,
        deltaCount: bootstrapData.deltaCount ?? 0,
      });

      // Clear only after a successful fetch, for transactional safety.
      // Clear when the server says the response is a full snapshot,
      // regardless of what type was requested.
      if (bootstrapData.type === 'full') {
        await this.clear();
      }

      // Handle partial bootstrap (delta batch)
      if (bootstrapData.type === 'partial') {
        const deltas = bootstrapData.deltas ?? [];

        this.runtime.logger.info('Processing partial bootstrap with delta batch', {
          deltaCount: deltas.length,
          fromSyncId: requirements.lastSyncId,
          toSyncId: bootstrapData.lastSyncId,
        });

        // Apply deltas to IndexedDB using processDeltaBatch for better performance.
        // Capture the return value so the pool can be updated by the caller —
        // without this, partial-bootstrap DELETEs persist to IDB but don't
        // evict entities from the in-memory InstanceCache, leaving ghost rows
        // visible on the canvas until a full reload rebuilds the pool.
        let deltasApplied = 0;
        let deltaResults: BootstrapResult['deltaResults'];

        if (deltas.length > 0) {
          // Narrow the wire delta to what processDelta reads. The field names
          // are the wire's own — the only change is `id` becoming `syncId`.
          // A group-change frame carries its payload as a JSON string, decoded
          // here exactly as the live delta path does in BaseSyncedStore.
          const formattedDeltas = deltas.map((delta) => ({
            syncId: delta.id,
            actionType: delta.actionType,
            modelName: delta.modelName,
            modelId: delta.modelId,
            data:
              typeof delta.data === 'string'
                ? (JSON.parse(delta.data) as ModelData)
                : delta.data,
          }));

          // Use batch processing for better performance
          const batch = await this.processDeltaBatch(formattedDeltas);
          deltaResults = batch.results;
          deltasApplied = formattedDeltas.length;
          onProgress?.(deltasApplied);
        }

        // Update workspace metadata with new lastSyncId (critical even when 0 deltas)
        await this.updateWorkspaceMetadata({
          lastSyncId: bootstrapData.lastSyncId,
          schemaHash: this.modelRegistry.getSchemaHash(),
          syncGroups: [...syncGroups],
          updatedAt: new Date(),
        });

        const elapsed =
          (typeof performance !== 'undefined' ? performance.now() : Date.now()) - startTime;
        this.runtime.logger.info(`Partial bootstrap complete in ${elapsed.toFixed(2)}ms`, {
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

      for (const [modelName, modelData] of Object.entries(bootstrapData.models)) {
        // Handle null, undefined, or non-array data
        if (!modelData) {
          this.runtime.observability.breadcrumb(
            `No data received for ${modelName}`,
            'sync.bootstrap',
            'warning'
          );
          continue;
        }

        if (!Array.isArray(modelData)) {
          this.runtime.observability.breadcrumb(
            `Skipping non-array data for ${modelName}`,
            'sync.bootstrap',
            'warning'
          );
          continue;
        }

        // Skip empty arrays silently (expected for some models)
        if (modelData.length === 0) {
          this.runtime.logger.debug(`No ${modelName} items to store (empty array)`);
          continue;
        }

        const store = this.getStore(modelName, 'bootstrap');
        if (!store) {
          this.runtime.logger.debug(
            `[Bootstrap] NO IDB STORE for ${modelName} — ${modelData.length} items DROPPED`,
          );
          continue;
        }
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
            this.runtime.observability.breadcrumb(
              `Failed to store ${modelName} item`,
              'sync.database',
              'error',
              {
                error: error instanceof Error ? error.message : String(error),
              }
            );
          }
        }

        // The model is marked persisted below whether or not every item landed,
        // because a partial store is still what the next sync reconciles
        // against. Counted and surfaced here so a partial does not read as a
        // clean bootstrap.
        if (writeErrors > 0) {
          this.runtime.observability.breadcrumb(
            `Stored ${modelName} with ${writeErrors} of ${modelData.length} items dropped`,
            'sync.database',
            'warning',
          );
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
        syncGroups: [...syncGroups],
        updatedAt: new Date(),
      });

      const elapsed =
        (typeof performance !== 'undefined' ? performance.now() : Date.now()) - startTime;
      this.runtime.logger.info(
        `Bootstrap complete: ${modelsLoaded} items loaded, ${modelsStored} stored to IndexedDB in ${elapsed.toFixed(2)}ms`
      );
      this.runtime.analytics?.capture('bootstrap_success', {
        responseTime: elapsed,
        modelsLoaded,
      });

      return { modelsLoaded, modelsStored, bootstrapData };
    } catch (error) {
      // Comprehensive error logging for bootstrap failures
      this.runtime.observability.captureBootstrapFailure(error, {
        type: requirements.type,
        navigatorOnline: typeof navigator !== 'undefined' ? navigator.onLine : undefined,
      });

      // Track bootstrap failure telemetry
      this.runtime.analytics?.capture('bootstrap_failed', {
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
   * Apply a single inbound delta from the WebSocket to the local store.
   *
   * This handles one delta at a time. To apply several, prefer
   * {@link processDeltaBatch}, which commits them in one IndexedDB transaction
   * rather than two transactions per delta.
   *
   * Update deltas carry only the changed fields, so they are merged onto the
   * existing record rather than replacing it. That preserves fields the delta
   * omits (such as reportId or title), and an explicit null is kept as a value,
   * clearing that field.
   */
  async processDelta(delta: {
    syncId?: number; // Optional sync id (from server). Enables idempotent gating.
    /**
     * Includes 'G' and 'S' defensively — those are routed upstream by
     * BaseSyncedStore.processDeltaWithBatching and should not reach here,
     * but the switch returns a no-op verify if one slips through (e.g.
     * replayed from the bootstrap queue) rather than crashing the engine.
     */
    actionType: SyncDeltaAction;
    modelName: string;
    modelId: string;
    data: ModelData | null;
  }, options: { updateCursor?: boolean } = {}): Promise<AppliedChange> {
    const { actionType, modelName, modelId, data, syncId } = delta;
    const store = this.getStore(modelName, 'processDelta');
    if (!store) {
      return { action: 'verify', modelName, modelId };
    }

    // Idempotency gate: ignore already-applied deltas by comparing with the persisted lastSyncId
    try {
      const lastApplied = await this.getLastSyncId();
      const incomingId = typeof syncId === 'number' ? syncId : undefined;
      if (typeof incomingId === 'number' && incomingId <= lastApplied) {
        return { action: 'verify', modelName, modelId };
      }
    } catch {}

    // Compact data before persistence; do not store redundant type markers.
    // Inject `id` from the envelope — server deltas frequently strip it
    // from the `data` payload, but IDB object stores use keyPath='id'
    // and require it on the record itself. See `processDeltaBatch` for
    // the same rationale on the batch path.
    const dataWithId =
      data && typeof data === 'object'
        ? { id: modelId, ...(data as Record<string, unknown>) }
        : data;
    const compacted =
      dataWithId && typeof dataWithId === 'object'
        ? this.compactRecord(modelName, dataWithId)
        : dataWithId;

    switch (actionType) {
      // 'C' (Covering) — client gained permission to see an existing entity.
      // End state in the local store is identical to an insert: the row is
      // present. The semantic difference is purely observability — it wasn't
      // newly created, it was newly visible. We fall through to the 'I' case
      // after a debug trace so the two can be disambiguated in logs.
      case 'C':
        this.runtime.observability.breadcrumb(
          'Applying covering delta (gained permission)',
          'sync.database',
          'info',
          { modelName, modelId: modelId.slice(0, 12) }
        );
        // falls through
      case 'I': {
        // Skip when the delta payload was empty/null. IDB rejects
        // non-record `put` arguments at runtime; the previous `any`
        // typing on `ObjectStore.put` was silently letting that
        // through. Real I-deltas always carry a row body.
        if (!compacted || typeof compacted !== 'object') {
          return { action: 'add', modelName, modelId, data: null };
        }
        // Insert synchronously for durable ack-after-apply semantics
        try {
          await store.put(compacted);
          if (options.updateCursor !== false && typeof syncId === 'number') {
            await this.updateWorkspaceMetadata({ lastSyncId: syncId });
          }
        } catch (err) {
          this.runtime.observability.breadcrumb(
            `IndexedDB put failed for ${modelName}:${modelId}`,
            'sync.database',
            'error',
            {
              error: err instanceof Error ? err.message : String(err),
            }
          );
          throw err; // Re-throw to see the actual error
        }
        return { action: 'add', modelName, modelId, data: compacted };
      }

      case 'U': {
        // Update: merge onto the existing record (partial-delta pattern).
        // Read the existing record first.
        const existing = await store.get(modelId);

        // Skip the update when there's no existing record to merge with:
        // building a record from partial update data would corrupt it
        // (missing reportId, and so on).
        if (!existing) {
          this.runtime.observability.breadcrumb(
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
          if (options.updateCursor !== false && typeof syncId === 'number') {
            await this.updateWorkspaceMetadata({ lastSyncId: syncId });
          }
        } catch (err) {
          this.runtime.observability.breadcrumb(
            `IndexedDB put failed for ${modelName}:${modelId}`,
            'sync.database',
            'error',
            {
              error: err instanceof Error ? err.message : String(err),
            }
          );
          throw err;
        }
        // Return merged data (not just delta) to preserve essential fields like organizationId
        return { action: 'update', modelName, modelId, data: merged };
      }

      case 'D': {
        // Delete synchronously
        try {
          await store.delete(modelId);
          if (options.updateCursor !== false && typeof syncId === 'number') {
            await this.updateWorkspaceMetadata({ lastSyncId: syncId });
          }
        } catch (err) {
          this.runtime.observability.breadcrumb(
            `IndexedDB delete failed for ${modelName}:${modelId}`,
            'sync.database',
            'error',
            {
              error: err instanceof Error ? err.message : String(err),
            }
          );
          // Surface failure so caller does not mutate InstanceCache inconsistently
          throw err;
        }
        return { action: 'remove', modelName, modelId };
      }

      case 'A': {
        // Archive
        const archivedData = this.compactRecord(modelName, { ...data, archivedAt: new Date() });
        try {
          await store.put(archivedData);
          if (options.updateCursor !== false && typeof syncId === 'number') {
            await this.updateWorkspaceMetadata({ lastSyncId: syncId });
          }
        } catch (err) {
          this.runtime.observability.breadcrumb(
            `IndexedDB archive put failed for ${modelName}:${modelId}`,
            'sync.database',
            'error',
            {
              error: err instanceof Error ? err.message : String(err),
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
        this.runtime.observability.breadcrumb(
          `Group membership delta (${actionType}) reached processDelta — should be handled upstream`,
          'sync.database',
          'warning',
          { modelName, modelId: modelId.slice(0, 12), actionType }
        );
        return { action: 'verify', modelName, modelId, data: null };

      default: {
        // The switch above is exhaustive over the declared action types, so
        // this branch is only reachable when a value escapes the type — hence
        // stringifying whatever actually arrived rather than the `never`.
        const _exhaustive: never = actionType;
        void _exhaustive;
        throw new AbloValidationError(
          `Unknown action type: ${JSON.stringify(actionType)}`,
          { code: 'db_unknown_action_type' }
        );
      }
    }
  }

  /**
   * Apply many deltas to the local store in as few IndexedDB transactions as
   * possible. Deltas are grouped by store, and each store's writes commit in a
   * single transaction, so a batch of 186 deltas becomes roughly one
   * transaction per store instead of two per delta.
   *
   * The method reads the existing records for update deltas up front, then
   * merges each update onto its existing record so fields the delta omits are
   * preserved and an explicit null still clears its field. It advances the
   * persisted sync cursor once, to the highest committed sync id.
   *
   * Conflict resolution follows a delete-wins rule: it first indexes the
   * delete deltas by entity, then skips any insert or update whose sync id is
   * at or below a delete for the same entity. This avoids resurrecting a
   * deleted entity and avoids fetching one that no longer exists.
   */
  async processDeltaBatch(
    deltas: {
      syncId?: number;
      /**
       * Includes 'G' and 'S' defensively — they're routed upstream and
       * shouldn't reach batch processing, but the switch inside returns
       * no-op verify for them if one slips through.
       */
      actionType: SyncDeltaAction;
      modelName: string;
      modelId: string;
      data: ModelData | null;
      /**
       * Server-stamped transaction id from the originating client's
       * commit op. Threaded through to the result so the receive
       * pipeline can recognize echoes of the local client's own
       * mutations and skip the pool mutation in
       * `SyncClient.applyDeltaBatchToPool`. Optional because system-
       * emitted deltas (sync_group changes, schema-derived ops) don't
       * have a client transaction.
       */
      transactionId?: string;
    }[]
  ): Promise<{
    results: AppliedChange[];
    /**
     * Highest syncId whose IDB store transaction actually committed in this
     * batch. The runtime delta cursor (WS `lastSyncId`, server-side
     * `lastAckedSyncId`) must only advance to this value — not the input
     * batch's range max — or it diverges from the persisted view and the
     * next catch-up request skips the un-persisted gap forever. Mirrors
     * the metadata-cursor invariant at `updateWorkspaceMetadata` below.
     * 0 when nothing persisted.
     */
    persistedSyncId: number;
  }> {
    if ((!this.workspaceDb && !this.inMemory) || this.isClosing || deltas.length === 0) {
      return { results: [], persistedSyncId: 0 };
    }

    // ── inMemory short-circuit ───────────────────────────────────────
    //
    // The batched IDB transaction path below assumes `this.storeManager`
    // and `workspaceDb`. In inMemory mode (headless workers, tests) those
    // don't exist. Without this branch, every live delta arriving over
    // the WebSocket is silently dropped — the local pool never updates,
    // `subscribe()` autoruns never re-fire, lazy-model dispatchers
    // never claim incoming work.
    //
    // Fall through to the single-delta path (`processDelta`), which
    // uses `getStore` and is inMemory-compatible. Same return
    // shape, sequential apply per delta — fine since inMemory mode
    // doesn't need IDB transaction batching for performance.
    if (this.inMemory) {
      const inMemResults = new Array<AppliedChange>(deltas.length);
      let inMemPersistedSyncId = 0;
      const lastApplied = this.inMemoryMetadata?.lastSyncId ?? 0;

      // InMemoryObjectStore mutates synchronously. Calling the async
      // single-delta facade once per row creates several promises and
      // continuations per delta, which becomes the dominant cost under a
      // catch-up frame. Apply the already-ordered batch directly, matching the
      // synchronous request scheduling used by the IndexedDB transaction path.
      for (const [index, delta] of deltas.entries()) {
        const { actionType, modelName, modelId, data, syncId, transactionId } = delta;
        const store = this.getStore(modelName, 'processDeltaBatch');
        let single: AppliedChange;

        if (!store || (typeof syncId === 'number' && syncId <= lastApplied)) {
          single = { action: 'verify', modelName, modelId, transactionId };
        } else {
          const memoryStore = store as InMemoryObjectStore;

          switch (actionType) {
            case 'C':
            case 'I': {
              const compacted =
                data && typeof data === 'object'
                  ? this.compactDeltaRecord(modelId, data)
                  : data;
              if (compacted && typeof compacted === 'object') {
                memoryStore.putSync(compacted);
              }
              single = { action: 'add', modelName, modelId, data: compacted, transactionId };
              break;
            }
            case 'U': {
              const existing = memoryStore.getSync(modelId);
              if (!existing) {
                single = { action: 'verify', modelName, modelId, data: null, transactionId };
              } else {
                const merged: ModelData = { ...existing };
                if (data && typeof data === 'object') {
                  this.compactDeltaRecord(modelId, data, merged);
                }
                memoryStore.putSync(merged);
                single = { action: 'update', modelName, modelId, data: merged, transactionId };
              }
              break;
            }
            case 'D':
              memoryStore.deleteSync(modelId);
              single = { action: 'remove', modelName, modelId, transactionId };
              break;
            case 'A': {
              const archivedData = this.compactRecord(modelName, {
                ...data,
                id: modelId,
                archivedAt: new Date(),
              });
              memoryStore.putSync(archivedData);
              single = { action: 'archive', modelName, modelId, data: archivedData, transactionId };
              break;
            }
            case 'V':
            case 'G':
            case 'S':
              single = { action: 'verify', modelName, modelId, data, transactionId };
              break;
          }
        }

        inMemResults[index] = single;
        if (
          single.action !== 'verify' &&
          typeof syncId === 'number' &&
          syncId > inMemPersistedSyncId
        ) {
          inMemPersistedSyncId = syncId;
        }
      }

      if (inMemPersistedSyncId > 0) {
        this.inMemoryMetadata = {
          ...(this.inMemoryMetadata ?? {
            lastSyncId: 0,
            firstSyncId: 0,
            backendDatabaseVersion: 0,
            subscribedSyncGroups: [],
            updatedAt: new Date(),
          }),
          lastSyncId: inMemPersistedSyncId,
          updatedAt: new Date(),
        };
      }
      return {
        results: stampSyncIds(inMemResults, deltas),
        persistedSyncId: inMemPersistedSyncId,
      };
    }

    // Prepare results aligned with input order
    const results = new Array<AppliedChange>(deltas.length);

    // Build a delete index for conflict resolution. When a delete has a sync
    // id at or above a later insert or update for the same entity, that entity
    // is not (re)created — which drops stale updates for cascade-deleted
    // entities.
    const deleteSyncIds = new Map<string, number>(); // key: "ModelName:modelId" -> delete syncId

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
      this.runtime.logger.debug('[Database.processDeltaBatch] Built DELETE index for conflict resolution', {
        deleteCount: deleteSyncIds.size,
        totalDeltas: deltas.length,
      });
    }

    // Group deltas by store for efficient transaction management.
    //
    // The method tracks the total range seen plus the exact input indexes whose
    // store transaction committed. The cursor is derived from their ordered
    // prefix after every store finishes; a maximum alone is unsafe because a
    // later store can succeed after an earlier store failed.
    //
    // Without this split, a single store-level failure (a compacted record
    // missing a required field, a validation abort) would advance the cursor
    // past deltas that never wrote to IndexedDB. The next partial bootstrap
    // would ask "what's new since {advanced cursor}?", the skipped rows would
    // fall into the already-seen range forever, and the local store would stay
    // permanently behind the server with no way to recover on reload.
    const deltasByStore = new Map<string, { idx: number; delta: (typeof deltas)[number] }[]>();
    let highestSyncId = 0;
    const persistedIndexes = new Set<number>();
    let skippedDueToConflict = 0;

    deltas.forEach((delta, idx) => {
      // Normalize to number — postgres sends bigint syncIds as strings.
      const deltaSyncIdNum = typeof delta.syncId === 'string'
        ? Number(delta.syncId)
        : delta.syncId;
      if (typeof deltaSyncIdNum === 'number' && !isNaN(deltaSyncIdNum) && deltaSyncIdNum > highestSyncId) {
        highestSyncId = deltaSyncIdNum;
      }

      // Conflict check: skip an insert or update when a delete for the same
      // entity has an equal or higher sync id.
      if (
        delta.actionType === 'U' ||
        delta.actionType === 'I' ||
        delta.actionType === 'C'
      ) {
        const key = `${delta.modelName}:${delta.modelId}`;
        const deleteSyncId = deleteSyncIds.get(key);

        if (deleteSyncId !== undefined) {
          // DELETE exists for this entity
          const deltaSyncId = delta.syncId ?? 0;

          if (deleteSyncId >= deltaSyncId) {
            // DELETE has equal or higher syncId - skip this UPDATE/INSERT
            this.runtime.logger.debug('[Database.processDeltaBatch] Skipping stale delta (DELETE wins)', {
              modelName: delta.modelName,
              modelId: delta.modelId.slice(0, 12),
              actionType: delta.actionType,
              deltaSyncId,
              deleteSyncId,
            });
            results[idx] = { action: 'verify', modelName: delta.modelName, modelId: delta.modelId };
            // The later delete in this same ordered frame supersedes this
            // value, so the stale predecessor requires no separate write.
            persistedIndexes.add(idx);
            skippedDueToConflict++;
            return; // Skip this delta
          }
        }
      }

      const store = this.getStore(delta.modelName, 'processDeltaBatch');
      if (!store) {
        results[idx] = { action: 'verify', modelName: delta.modelName, modelId: delta.modelId };
        return;
      }

      const groupedDeltas = deltasByStore.get(delta.modelName);
      if (groupedDeltas) {
        groupedDeltas.push({ idx, delta });
      } else {
        deltasByStore.set(delta.modelName, [{ idx, delta }]);
      }
    });

    if (skippedDueToConflict > 0) {
      this.runtime.logger.info('[Database.processDeltaBatch] Conflict resolution summary', {
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
        // Batch read-modify-write.
        // Step 1: Identify which deltas need existing data (updates)
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
          } catch {
            this.runtime.observability.breadcrumb(
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

        // Self-heal by fetching missing records for update deltas.
        // Track ids that failed to fetch (a 404 means the entity was deleted,
        // so its delta is skipped).
        const failedToFetch = new Set<string>();

        if (missingIds.size > 0) {
          this.runtime.logger.info(
            `[Database.processDeltaBatch] Found ${missingIds.size} missing records for ${modelName}, fetching from server...`
          );

          // Fetch sequentially to avoid overwhelming server
          for (const id of missingIds) {
            try {
              const fetchedRecord = await this.bootstrapHelper.fetchEntity(modelName, id);
              if (fetchedRecord) {
                const compacted = this.compactRecord(modelName, fetchedRecord);
                existingRecords.set(id, compacted);
                this.runtime.logger.debug(
                  `[Database.processDeltaBatch] Successfully fetched missing record: ${modelName}:${id}`
                );
              } else {
                // fetchEntity returns null for 404 — entity was deleted, skip the delta
                failedToFetch.add(id);
                this.runtime.logger.debug(
                  `[Database.processDeltaBatch] Entity not found (deleted): ${modelName}:${id}`
                );
              }
            } catch (error: unknown) {
              // Unexpected error (5xx, network failure) — mark for skipping and report
              failedToFetch.add(id);
              this.runtime.observability.breadcrumb(
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
            this.runtime.logger.info(
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
        const stagedResults: (AppliedChange & { idx: number })[] = [];

        // Step 4: Process all deltas synchronously within transaction (no await!)
        for (const { idx, delta } of storeDeltas) {
          const { actionType, modelId, data } = delta;
          // Server deltas carry `id` in the envelope (modelId) but often
          // strip it from the `data` payload as redundant. IDB object
          // stores use keyPath='id' on the record itself, so the record
          // MUST have `id` set. Inject it before `compactRecord` so the
          // record is self-describing.
          const dataWithId =
            data && typeof data === 'object'
              ? { id: modelId, ...(data as Record<string, unknown>) }
              : data;
          const compacted =
            dataWithId && typeof dataWithId === 'object'
              ? this.compactRecord(modelName, dataWithId)
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
              // Update: merge the delta onto the existing record (already fetched).
              const existing = existingRecords.get(modelId);

              // Skip a stale update: if the entity is neither in the local
              // store nor fetchable from the server (a 404), it was deleted,
              // so skip it rather than create an incomplete record.
              if (!existing && failedToFetch.has(modelId)) {
                this.runtime.logger.debug('[Database.processDeltaBatch] Skipping UPDATE for deleted entity', {
                  modelName,
                  modelId: modelId.slice(0, 12),
                });
                stagedResults.push({ action: 'verify', modelName, modelId, idx });
                break; // Skip this delta
              }

              // Skip the update when there's no existing record to merge with:
              // building a record from partial update data would corrupt it
              // (missing reportId, and so on).
              if (!existing) {
                this.runtime.observability.breadcrumb(
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
          tx.oncomplete = () => { resolve(); };
          tx.onerror = () => { reject(tx.error); };
        });
        // Only commit staged results to the global results if the transaction
        // succeeded. Record input indexes rather than a maximum sync id; the
        // durable cursor is the prefix through these indexes.
        for (const r of stagedResults) {
          // Resolve the originating delta so we can carry its
          // transactionId through to the result. Echo detection in
          // `SyncClient.applyDeltaBatchToPool` reads it.
          const sourceDelta = deltas[r.idx];
          results[r.idx] = {
            action: r.action,
            modelName: r.modelName,
            modelId: r.modelId,
            data: r.data,
            transactionId: sourceDelta?.transactionId,
          };
          persistedIndexes.add(r.idx);
        }
      } catch (err) {
        // Surface the IDB error directly — `captureMutationFailure`
        // routes to Sentry, but during interactive debugging the console
        // needs to show the specific failure (e.g. `ConstraintError`,
        // `DataError`, `AbortError`) so we can find what's wrong with
        // the `compacted` payload shape or store schema.
        const idbErr = err instanceof Error ? err : new Error(String(err));
        this.runtime.logger.debug('[Database.processDeltaBatch] store tx FAILED', {
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
        this.runtime.observability.captureMutationFailure({
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

    // Advance only through the durable INPUT PREFIX. IDs need not be
    // numerically contiguous because other tenants and filtered sync groups
    // occupy gaps; the server-delivered order is the relevant sequence.
    const highestPersistedSyncId = highestPersistedPrefixSyncId(
      deltas,
      persistedIndexes,
    );

    // Using `highestSyncId` (the range-seen max) would advance past an earlier
    // failed store transaction and permanently skip its delta.
    //
    // If `highestPersistedSyncId === 0` (every store tx failed), we leave
    // the metadata alone. Next partial bootstrap will re-deliver the
    // deltas at the original cursor position.
    if (highestPersistedSyncId > 0) {
      try {
        await this.updateWorkspaceMetadata({ lastSyncId: highestPersistedSyncId });
      } catch (err) {
        this.runtime.observability.breadcrumb(
          'Failed to update metadata after batch',
          'sync.database',
          'error',
          {
            error: err instanceof Error ? err.message : String(err),
          }
        );
      }
    }
    if (highestPersistedSyncId < highestSyncId) {
      // Staging-visibility probe: makes the "some deltas seen but not
      // persisted" signal loud when it actually happens. If this fires
      // repeatedly on the same sync IDs, a specific row is un-writable
      // (validation? compact issue?) and needs fixing at that layer.
      this.runtime.logger.debug('[Database.processDeltaBatch] cursor withheld due to failed store tx', {
        seen: highestSyncId,
        persisted: highestPersistedSyncId,
        gap: highestSyncId - highestPersistedSyncId,
      });
    }

    return { results: stampSyncIds(results, deltas), persistedSyncId: highestPersistedSyncId };
  }

  /** Get raw data for hydration */
  async hydrateModels(modelName: string): Promise<ModelData[]> {
    const store = this.getStore(modelName, 'hydrate');
    if (!store) {
      return [];
    }
    return store.getAll();
  }

  /** Put a single record to IndexedDB (for self-healing corrupted records) */
  async putRecord(modelName: string, id: string, data: Record<string, unknown>): Promise<void> {
    const store = this.getStore(modelName, 'putRecord');
    if (!store) {
      this.runtime.observability.breadcrumb(
        `Store not found for putRecord: ${modelName}`,
        'sync.database',
        'warning'
      );
      return;
    }
    const compacted = this.compactRecord(modelName, data);
    await store.put(compacted);
  }

  /** Get data by index. `value` is an IDB key — string, number, Date,
   *  BufferSource, or array thereof. */
  async getDataByIndex(modelName: string, indexName: string, value: IDBValidKey): Promise<ModelData[]> {
    const store = this.getRequiredStore(modelName);
    return await store.getAllFromIndex(indexName, value);
  }

  /** Read workspace metadata from IndexedDB. Returns null when the database is not open. */
  async getWorkspaceMetadata(): Promise<WorkspaceMetadata | null> {
    if (this.inMemory) return this.inMemoryMetadata;
    if (!this.workspaceDb) return null;
    return this.databaseManager.getWorkspaceMetadata(this.workspaceDb);
  }

  async getLastSyncId(): Promise<number> {
    if (this.inMemory) return this.inMemoryMetadata?.lastSyncId ?? 0;
    if (!this.workspaceDb) {
      return 0;
    }

    const metadata = await this.databaseManager.getWorkspaceMetadata(this.workspaceDb);
    return metadata?.lastSyncId ?? 0;
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
      };
      return;
    }

    // Graceful degradation: skip if database is closing or not open
    // This prevents "Database not opened" errors during React Strict Mode cleanup
    if (!this.workspaceDb || this.isClosing) {
      this.runtime.observability.breadcrumb(
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

  /** Transaction persistence for offline/retry support.
   *  Returns either the IDB-backed ObjectStore or its in-memory twin
   *  (`InMemoryObjectStore`) — both expose the same async put/get/
   *  delete/getAll/getAllFromIndex surface, so callers don't need to
   *  branch on which one they got back. */
  private get transactionStore() {
    return this.getRequiredStore('__transactions');
  }

  async saveTransaction(transaction: PersistedTransaction): Promise<void> {
    await this.transactionStore.put(transaction);
  }

  /** Persist one burst of journal rows in a single strict durability group. */
  async saveTransactions(transactions: readonly PersistedTransaction[]): Promise<void> {
    if (transactions.length === 0) return;
    if (this.inMemory) {
      await Promise.all(transactions.map((transaction) => this.transactionStore.put(transaction)));
      return;
    }
    const db = this.workspaceDb;
    if (!db || this.isClosing) {
      throw new AbloConnectionError('Database not opened for mutation journal', {
        code: 'db_not_opened',
      });
    }
    await new Promise<void>((resolve, reject) => {
      try {
        const tx = db.transaction(['__transactions'], 'readwrite', {
          durability: 'strict',
        });
        const store = tx.objectStore('__transactions');
        for (const transaction of transactions) store.put(transaction);
        tx.oncomplete = () => { resolve(); };
        tx.onabort = () => {
          reject(tx.error ?? new Error('Mutation journal transaction aborted'));
        };
        tx.onerror = () => {
          // onabort owns rejection.
        };
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  async removeTransaction(id: string): Promise<void> {
    await this.transactionStore.delete(id);
  }

  async getPersistedTransactions(): Promise<PersistedTransaction[]> {
    const rows = await this.transactionStore.getAll();
    // Storage layer returns the centralized `Record<string, unknown>`
    // shape from `ObjectStoreContract`. PersistedTransaction adds an
    // index signature so each row already structurally satisfies the
    // narrower type — runtime invariant: only saveTransaction writes
    // here, and it only accepts PersistedTransaction.
    return rows as PersistedTransaction[];
  }

  async getPersistedTransaction(id: string): Promise<PersistedTransaction | undefined> {
    return (await this.transactionStore.get(id)) as PersistedTransaction | undefined;
  }

  /**
   * Atomically seal one exact commit request and consume the staged mutation
   * records it replaces. The read, optional add, and deletes share one strict
   * IndexedDB transaction, so a crash can expose the staged records or the
   * sealed envelope, never a missing handoff. Returns the pre-existing record
   * when the envelope id was already sealed (retry/re-entrant call).
   */
  async sealTransactionRecord(
    record: PersistedTransaction,
    consumedRecordIds: readonly string[],
  ): Promise<PersistedTransaction | undefined> {
    const recordId = record.id;
    if (!recordId) {
      throw new AbloValidationError('A sealed transaction record must carry an id', {
        code: 'invalid_body',
      });
    }

    if (this.inMemory) {
      const store = this.transactionStore;
      const existing = (await store.get(recordId)) as PersistedTransaction | undefined;
      if (existing && !isSameOutboxRecord(existing, record)) {
        throw new AbloValidationError('Pending-write key already identifies a different request', {
          code: 'idempotency_conflict',
        });
      }
      if (isAcceptedOutboxPromotion(existing, record)) {
        await store.put(record);
      }
      if (!existing) {
        const sources = await Promise.all(
          consumedRecordIds.map((id) => store.get(id)),
        );
        if (sources.some((source) => source === undefined)) {
          throw new AbloValidationError(
            'Pending-write source mutations were already claimed by another write',
            { code: 'idempotency_conflict' },
          );
        }
        await store.add(record);
      }
      for (const id of consumedRecordIds) {
        if (id !== recordId) await store.delete(id);
      }
      return existing;
    }

    const db = this.workspaceDb;
    if (!db || this.isClosing) {
      throw new AbloConnectionError('Database not opened for durable writes', {
        code: 'db_not_opened',
      });
    }

    return new Promise((resolve, reject) => {
      try {
        const tx = db.transaction(['__transactions'], 'readwrite', {
          durability: 'strict',
        });
        const store = tx.objectStore('__transactions');
        const getRequest = store.get(recordId);
        const sourceIds = [...new Set(consumedRecordIds)].filter(
          (id) => id !== recordId,
        );
        const sourceRequests = sourceIds.map((id) => store.get(id));
        const sourceExists = new Array<boolean>(sourceRequests.length).fill(false);
        let existing: PersistedTransaction | undefined;
        let collisionError: Error | undefined;
        let envelopeRead = false;
        let sourcesRead = 0;
        let promotionStarted = false;

        const promote = (): void => {
          if (
            promotionStarted ||
            !envelopeRead ||
            sourcesRead !== sourceRequests.length
          ) return;
          promotionStarted = true;
          if (existing && !isSameOutboxRecord(existing, record)) {
            collisionError = new AbloValidationError(
              'Pending-write key already identifies a different request',
              { code: 'idempotency_conflict' },
            );
            tx.abort();
            return;
          }
          // A new envelope owns promotion only while every source row still
          // exists. This is the fleet/tab execution claim: a second tab that
          // restored the same journal entries under another key loses here and
          // cannot dispatch. An identical existing envelope is an idempotent
          // retry, so its already-consumed sources may be absent.
          if (!existing && sourceExists.some((exists) => !exists)) {
            collisionError = new AbloValidationError(
              'Pending-write source mutations were already claimed by another write',
              { code: 'idempotency_conflict' },
            );
            tx.abort();
            return;
          }
          if (!existing) {
            store.add(record);
          } else if (isAcceptedOutboxPromotion(existing, record)) {
            store.put(record);
          }
          for (const id of sourceIds) store.delete(id);
        };

        getRequest.onsuccess = () => {
          existing = getRequest.result as PersistedTransaction | undefined;
          envelopeRead = true;
          promote();
        };
        getRequest.onerror = () => {
          tx.abort();
        };
        sourceRequests.forEach((request, index) => {
          request.onsuccess = () => {
            sourceExists[index] = request.result !== undefined;
            sourcesRead += 1;
            promote();
          };
          request.onerror = () => {
            tx.abort();
          };
        });
        tx.oncomplete = () => { resolve(existing); };
        tx.onabort = () => {
          reject(
            collisionError ??
            tx.error ??
            getRequest.error ??
            new Error('Durable-write transaction aborted'),
          );
        };
        tx.onerror = () => {
          // onabort owns rejection so the promise settles exactly once.
        };
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  async cleanupOldTransactions(maxAge: number): Promise<number> {
    const store = this.transactionStore;

    const rows = (await store.getAll()) as PersistedTransaction[];
    const cutoff = Date.now() - maxAge;
    let cleaned = 0;

    for (const tx of rows) {
      // Live write intent has no safe age-based expiry. In particular, server
      // idempotency retention may already have elapsed, so silently deleting or
      // blindly replaying an old envelope would both be unsafe. Restoration
      // owns quarantine/reconciliation for these records.
      if (
        tx.type === 'commit_envelope' ||
        tx.type === 'http_commit_envelope' ||
        tx.type === 'pending_mutation'
      ) {
        continue;
      }
      if (typeof tx.timestamp === 'number' && tx.timestamp < cutoff) {
        await store.delete(tx.id);
        cleaned++;
      }
    }
    return cleaned;
  }

  /**
   * Store management
   *
   * `getStore(modelName, context?)` is defined near the top of this
   * class — single accessor for both inMemory and IDB modes.
   */
  getAllStores() {
    if (this.inMemory) {
      return this.inMemoryStores;
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

  isOpen(): boolean {
    return this.workspaceDb !== null;
  }

  async close(): Promise<void> {
    this.isClosing = true;
    this.storeManager.markAllStoresAsClosing();

    if (this.workspaceDb) {
      this.workspaceDb.close();
      this.workspaceDb = null;
    }

    await this.databaseManager.close();
    this.currentDbInfo = null;

    this.runtime.logger.debug('Database closed');
  }

  /** Delegate authenticated local-state teardown to the persistence owner. */
  async purgePersistence(): Promise<void> {
    this.bootstrapHelper.clearCache();
    if (this.inMemory) {
      this.inMemoryStores.clear();
      this.inMemoryMetadata = null;
      this.currentDbInfo = null;
      return;
    }
    const current = this.currentDbInfo;
    let registryCleanupError: unknown;
    try {
      await this.databaseManager.unregisterDatabases(
        persistenceDatabaseNamesForDeletion(current),
      );
    } catch (error) {
      registryCleanupError = error;
    }
    await this.close();
    await purgeIndexedDbPersistence(current);
    if (registryCleanupError) {
      throw registryCleanupError instanceof Error
        ? registryCleanupError
        : new Error('IndexedDB registry cleanup failed', {
            cause: registryCleanupError,
          });
    }
  }

  async clear(options: { includeWriteJournal?: boolean } = {}): Promise<void> {
    await this.storeManager.clearAllStores();
    if (options.includeWriteJournal) {
      await this.transactionStore.clear();
    }
    this.runtime.logger.info('All stores cleared');
  }
}
