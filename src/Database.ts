/**
 * The local persistence layer for synced models. It stores rows in the
 * browser's IndexedDB (or in-memory maps when run headlessly), applies inbound
 * deltas to that store, and fetches the bootstrap snapshot from your sync
 * server. {@link BaseSyncedStore} drives it, and {@link InstanceCache} holds the
 * in-memory mirror of what this class persists.
 */

import { DatabaseManager, type DatabaseInfo, type WorkspaceMetadata } from './core/DatabaseManager.js';
import { StoreManager } from './core/StoreManager.js';
import { ModelRegistry } from './ModelRegistry.js';
import { LoadStrategy } from './types/index.js';
import { getContext } from './context.js';
import { AbloConnectionError, AbloValidationError } from './errors.js';
import type { BootstrapFetcher, BootstrapData } from './sync/BootstrapFetcher.js';
import { InMemoryObjectStore } from './adapters/inMemoryStorage.js';
import { syncPositionSchema } from './sync/syncPosition.js';
import { highestPersistedPrefixSyncId } from './sync/persistedPrefix.js';

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
  writeOptions?: {
    readAt?: number | null;
    onStale?: 'reject' | 'overwrite' | 'notify' | null;
  };
}

/** Persisted transaction for offline/retry support.
 *
 *  Index signature is part of the contract: this interface targets
 *  the generic record-shaped storage layer (`InMemoryObjectStore.put`
 *  + the IDB ObjectStore equivalent), both of which take
 *  `Record<string, unknown>`. Every declared field below already
 *  satisfies `unknown`; the index signature just makes the
 *  interface assignable to the storage parameter without a cast. */
interface PersistedTransaction {
  id: string;
  type?: string;
  timestamp?: number;
  createdAt?: number;
  mutations?: PersistedMutation[];
  // Persist awaiting-delta transactions so they survive a tab close. On the
  // next session, WebSocket reconnect plus delta catch-up confirms them.
  awaitingDelta?: {
    syncIdNeeded: number;
    modelName: string;
    modelId: string;
    operationType: string;
  };
  [key: string]: unknown;
}

/**
 * Request identity excludes local timing metadata for re-entrant seals: a
 * retry rebuilds its envelope with a fresh `sequence`/seal clock, so comparing
 * those volatile fields would reject every legitimate same-request re-seal as
 * an idempotency conflict. Only the fields that define the wire request count.
 */
function isSameOutboxRecord(
  existing: PersistedTransaction,
  candidate: PersistedTransaction,
): boolean {
  if (
    existing.type === 'http_commit_envelope' &&
    candidate.type === 'http_commit_envelope'
  ) {
    const identity = (record: PersistedTransaction): unknown => ({
      id: record.id,
      type: record.type,
      storageVersion: record.storageVersion,
      idempotencyKey: record.idempotencyKey,
      request: record.request,
      scopeNamespace: record.scopeNamespace,
    });
    return JSON.stringify(identity(existing)) === JSON.stringify(identity(candidate));
  }
  if (
    existing.type === 'commit_envelope' &&
    candidate.type === 'commit_envelope'
  ) {
    const identity = (record: PersistedTransaction): unknown => ({
      id: record.id,
      type: record.type,
      storageVersion: record.storageVersion,
      origin: record.origin,
      idempotencyKey: record.idempotencyKey,
      operations: record.operations,
      sourceMutationIds: record.sourceMutationIds,
      commitOptions: record.commitOptions,
      scope: record.scope,
    });
    return JSON.stringify(identity(existing)) === JSON.stringify(identity(candidate));
  }
  return JSON.stringify(existing) === JSON.stringify(candidate);
}

/**
 * How a session establishes its baseline state at startup.
 *
 * 'full' — Fetch a complete snapshot from the server, clear the local store,
 *   load the snapshot, and adopt its `lastSyncId`.
 *
 * 'partial' — Fetch only the deltas since the stored `lastSyncId` and apply
 *   them on top of the existing local data.
 *
 * 'local' — Skip the server entirely: hydrate the {@link InstanceCache} from the
 *   local store, connect the WebSocket with the stored `lastSyncId`, and
 *   receive deltas from there onward. Used when offline with valid local data.
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
  deltaResults?: {
    action: 'add' | 'update' | 'remove' | 'archive' | 'verify';
    modelName: string;
    modelId: string;
    data?: ModelData | null;
  }[];
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
    bootstrapHelper: BootstrapFetcher,
    options?: { inMemory?: boolean },
  ) {
    this.databaseManager = new DatabaseManager();
    this.storeManager = new StoreManager(modelRegistry);
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
      getContext().observability.breadcrumb(
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
      getContext().logger.debug('[Database] UPDATE merged - preserved fields', {
        modelName,
        modelId: modelId.slice(0, 12),
        deltaFields: Object.keys(delta),
        preservedFields: preserved,
      });
    }
  }

  async open(userId: string, organizationId: string, version = 1): Promise<void> {
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

    for (const [key, value] of Object.entries(data)) {
      // Drop redundant or ephemeral markers
      if (key === '__typename' || key === '__class' || key === 'clientId' || key === 'syncStatus') {
        continue;
      }

      // Skip only `undefined`; preserve explicit `null`, which is a
      // meaningful value for a nullable column.
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

    // Gate the PERSISTED cursor through the sync-position schema field —
    // the one trust boundary for resume state. IDB can hand back anything
    // (a corrupted negative/float cursor would previously pass `|| 0`,
    // which only catches falsy, and get sent to the server as the resume
    // point). Invalid → 0 → full bootstrap, the safe degradation.
    const metadataLastSyncId =
      syncPositionSchema.shape.persisted.safeParse(metadata?.lastSyncId).data ?? 0;
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
      // The server is the source of truth: always use a full bootstrap
      // when online.
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
    getContext().logger.debug('Starting bootstrap fetch', {
      type: requirements.type,
      lastSyncId: requirements.lastSyncId,
      modelsToLoad: requirements.modelsToLoad,
    });
    getContext().logger.info('Database: Starting bootstrap from Go server', {
      type: requirements.type,
      syncGroups,
      modelsToLoad: requirements.modelsToLoad,
    });

    try {
      // Fetch before any destructive operation, so a failed network
      // request can't leave the local store empty.
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

        getContext().logger.info('Processing partial bootstrap with delta batch', {
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
          // Convert server delta format to processDelta format
          const formattedDeltas = (deltas as ServerDelta[]).map((delta) => ({
            syncId: delta.id,
            actionType: delta.operation as 'I' | 'U' | 'D' | 'A' | 'V' | 'C' | 'G' | 'S' | 'M',
            modelName: delta.modelName,
            modelId: delta.entityId,
            data: delta.data,
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

        const store = this.getStore(modelName, 'bootstrap');
        if (!store) {
          getContext().logger.debug(
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
        syncGroups: [...syncGroups],
        updatedAt: new Date(),
      });

      const elapsed =
        (typeof performance !== 'undefined' ? performance.now() : Date.now()) - startTime;
      getContext().logger.info(
        `Bootstrap complete: ${modelsLoaded} items loaded, ${modelsStored} stored to IndexedDB in ${elapsed.toFixed(2)}ms`
      );
      getContext().analytics?.capture('bootstrap_success', {
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
   * omits (such as deckId or title), and an explicit null is kept as a value,
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
    actionType: 'I' | 'U' | 'D' | 'A' | 'V' | 'C' | 'G' | 'S' | 'M';
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
        getContext().observability.breadcrumb(
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
          if (typeof syncId === 'number') {
            await this.updateWorkspaceMetadata({ lastSyncId: syncId });
          }
        } catch (err) {
          getContext().observability.breadcrumb(
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
        // (missing deckId, and so on).
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
        } catch (err) {
          getContext().observability.breadcrumb(
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
          if (typeof syncId === 'number') {
            await this.updateWorkspaceMetadata({ lastSyncId: syncId });
          }
        } catch (err) {
          getContext().observability.breadcrumb(
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
          if (typeof syncId === 'number') {
            await this.updateWorkspaceMetadata({ lastSyncId: syncId });
          }
        } catch (err) {
          getContext().observability.breadcrumb(
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
      actionType: 'I' | 'U' | 'D' | 'A' | 'V' | 'C' | 'G' | 'S' | 'M';
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
    results: {
      action: 'add' | 'update' | 'remove' | 'archive' | 'verify';
      modelName: string;
      modelId: string;
      data?: ModelData | null;
      transactionId?: string;
    }[];
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
    // and `workspaceDb`. In inMemory mode (agent-worker, tests) those
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
      const inMemResults: {
        action: 'add' | 'update' | 'remove' | 'archive' | 'verify';
        modelName: string;
        modelId: string;
        data?: ModelData | null;
        transactionId?: string;
      }[] = [];
      let inMemPersistedSyncId = 0;
      for (const delta of deltas) {
        const single = await this.processDelta({
          syncId: delta.syncId,
          actionType: delta.actionType,
          modelName: delta.modelName,
          modelId: delta.modelId,
          data: delta.data,
        });
        inMemResults.push({ ...single, transactionId: delta.transactionId });
        // inMemory has no IDB tx that can fail — every non-'verify'
        // single result is durable in the in-memory store. Advance the
        // persisted-cursor watermark to the input delta's syncId so the
        // ack path can move forward.
        if (single.action !== 'verify' && typeof delta.syncId === 'number' && delta.syncId > inMemPersistedSyncId) {
          inMemPersistedSyncId = delta.syncId;
        }
      }
      return { results: inMemResults, persistedSyncId: inMemPersistedSyncId };
    }

    // Prepare results aligned with input order
    const results = new Array<{
      action: 'add' | 'update' | 'remove' | 'archive' | 'verify';
      modelName: string;
      modelId: string;
      data?: ModelData | null;
      transactionId?: string;
    }>(deltas.length);

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
      getContext().logger.debug('[Database.processDeltaBatch] Built DELETE index for conflict resolution', {
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
        delta.actionType === 'C' ||
        delta.actionType === 'M'
      ) {
        const key = `${delta.modelName}:${delta.modelId}`;
        const deleteSyncId = deleteSyncIds.get(key);

        if (deleteSyncId !== undefined) {
          // DELETE exists for this entity
          const deltaSyncId = delta.syncId ?? 0;

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

        // Self-heal by fetching missing records for update deltas.
        // Track ids that failed to fetch (a 404 means the entity was deleted,
        // so its delta is skipped).
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
        const stagedResults: {
          action: 'add' | 'update' | 'remove' | 'archive' | 'verify';
          modelName: string;
          modelId: string;
          data?: any;
          idx: number;
        }[] = [];

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
                getContext().logger.debug('[Database.processDeltaBatch] Skipping UPDATE for deleted entity', {
                  modelName,
                  modelId: modelId.slice(0, 12),
                });
                stagedResults.push({ action: 'verify', modelName, modelId, idx });
                break; // Skip this delta
              }

              // Skip the update when there's no existing record to merge with:
              // building a record from partial update data would corrupt it
              // (missing deckId, and so on).
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
        // Surface the IDB error directly — `captureTransactionFailure`
        // routes to Sentry, but during interactive debugging the console
        // needs to show the specific failure (e.g. `ConstraintError`,
        // `DataError`, `AbortError`) so we can find what's wrong with
        // the `compacted` payload shape or store schema.
        const idbErr = err instanceof Error ? err : new Error(String(err));
        getContext().logger.debug('[Database.processDeltaBatch] store tx FAILED', {
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
        getContext().observability.breadcrumb(
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
      getContext().logger.debug('[Database.processDeltaBatch] cursor withheld due to failed store tx', {
        seen: highestSyncId,
        persisted: highestPersistedSyncId,
        gap: highestSyncId - highestPersistedSyncId,
      });
    }

    return { results, persistedSyncId: highestPersistedSyncId };
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
        throw new AbloValidationError('Commit outbox key already identifies a different request', {
          code: 'idempotency_conflict',
        });
      }
      if (!existing) {
        const sources = await Promise.all(
          consumedRecordIds.map((id) => store.get(id)),
        );
        if (sources.some((source) => source === undefined)) {
          throw new AbloValidationError(
            'Commit outbox source mutations were already claimed by another envelope',
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
      throw new AbloConnectionError('Database not opened for commit outbox', {
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
              'Commit outbox key already identifies a different request',
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
              'Commit outbox source mutations were already claimed by another envelope',
              { code: 'idempotency_conflict' },
            );
            tx.abort();
            return;
          }
          if (!existing) store.add(record);
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
            new Error('Commit outbox transaction aborted'),
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
      if (tx.type === 'commit_envelope' || tx.type === 'pending_mutation') {
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

  async clear(options: { includeWriteJournal?: boolean } = {}): Promise<void> {
    await this.storeManager.clearAllStores();
    if (options.includeWriteJournal) {
      await this.transactionStore.clear();
    }
    getContext().logger.info('All stores cleared');
  }
}
