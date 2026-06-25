/**
 * BaseSyncedStore — Generic sync store base class for the SDK.
 *
 * Exports the core types, interfaces, and a base class that app-specific
 * stores extend. The base class provides query/mutation/delta/bootstrap
 * orchestration. Subclasses add domain-specific lazy-loading, collaboration
 * events, and model enrichment.
 *
 * Design: The app's SyncedStore extends this and adds its own methods.
 * This file only contains types and the abstract contract — the actual
 * implementation stays in the app's SyncedStore.ts until we incrementally
 * pull generic methods into this base class.
 */

import { makeObservable, observable, action, computed, runInAction } from 'mobx';
import { AbloConnectionError, AbloValidationError, toAbloError } from './errors.js';
import { ConnectionManager } from './sync/ConnectionManager.js';
import { AreaOfInterestManager } from './sync/AreaOfInterestManager.js';
import {
  resolveParticipantSyncGroups,
  type ParticipantScope,
} from './sync/participants.js';
import type { SyncClient } from './SyncClient.js';
import type { Database, BootstrapResult } from './Database.js';
import type { BootstrapData } from './sync/BootstrapHelper.js';
import type { ObjectPool } from './ObjectPool.js';
import { ModelRegistry } from './ModelRegistry.js';
import { PropertyType } from './types/index.js';
import {
  SyncWebSocket,
  type SyncDelta,
  type SyncGroupChangePayload,
  type GroupAddedPayload,
  type GroupRemovedPayload,
  type VersionVector,
  type BootstrapHint,
  type BootstrapDataEvent,
  type PresenceUpdateEvent,
  type EventMap,
  type DefaultCollaborationEvents,
} from './sync/SyncWebSocket.js';
import { QueryProcessor } from './core/QueryProcessor.js';
import { Model, rowAsModel } from './Model.js';
import { getContext } from './context.js';
import { SyncSessionError } from './errors.js';
import { ModelScope } from './ObjectPool.js';
import { LazyReferenceCollection } from './LazyReferenceCollection.js';
import type { Schema } from './schema/schema.js';
import type { SyncStoreContract, LocalMutation } from './react/context.js';
import type { AuthCredentialSource } from './auth/credentialSource.js';

// ── Exported types ──────────────────────────────────────────────────────────

/** Constructor type for Model subclasses (accepts abstract classes) */
export type ModelConstructor<T extends Model> = abstract new (...args: never[]) => T;

/** Concrete constructor type for instantiation */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Constructor args vary per model (PrismaTask, Record<string, unknown>, etc.)
export type ConcreteModelConstructor<T extends Model> = new (data?: any) => T;

/** Generic record type for model data */
export type ModelData = Record<string, unknown>;

/** Query result interface */
export interface QueryResult<T extends Model> {
  data: T[];
  total: number;
  hasMore: boolean;
  fromCache?: boolean;
}

/** A foreign-key index to register on the ObjectPool at construction time. */
export interface ForeignKeyIndexSpec {
  /**
   * The child model name (where the FK field lives) — this is the type
   * that will be passed to `pool.registerForeignKey(modelName, fieldName)`
   * and later to `pool.getByForeignKey(modelName, fieldName, value)`.
   *
   * Use the wire `__typename` casing (e.g., `'SlideLayer'`, not
   * `'slideLayer'`) — that's the value `createFromData` stamps onto
   * models and the pool indexes by.
   */
  readonly modelName: string;
  /** The FK field name on the child model, e.g. `'slideId'`. */
  readonly fieldName: string;
}

/**
 * A declarative enrichment rule for the delta-apply path.
 *
 * When a delta for `modelName` arrives, after the model is constructed
 * the base store reads `data[foreignKey]` from the payload, looks up
 * the matching parent in the ObjectPool, and attaches it as
 * `data[relationKey]`. Best-effort: if the parent isn't yet in the
 * pool (e.g., arrived later in the same bootstrap batch), enrichment
 * silently no-ops.
 *
 * Replaces the previous pattern of overriding `enrichRelations` on a
 * subclass to hardcode per-model enrichment logic.
 */
export interface EnrichmentPlanEntry {
  /** The child model whose incoming deltas should be enriched. */
  readonly modelName: string;
  /** The FK field on the child that points at the parent's id. */
  readonly foreignKey: string;
  /** The property name under which to attach the parent model. */
  readonly relationKey: string;
}

/** Configuration for SyncedStore behavior */
export interface SyncedStoreConfig {
  enableOffline?: boolean;
  enableCache?: boolean;
  enableTelemetry?: boolean;

  /**
   * Initial version vector keys, each seeded to 0. Merged with the
   * schema-derived set (if a schema is provided to the constructor) —
   * explicit keys here layer on top of derived ones. Replaces the
   * subclass pattern of hardcoding `this.versionVector = { tasks: 0, ... }`
   * in the constructor.
   */
  versionVectorKeys?: readonly string[];

  /**
   * Declarative enrichment plan consumed by `enrichRelations`. Replaces
   * the subclass override of `enrichRelations` for per-model parent
   * attachment. Merged with schema-derived entries (relations marked
   * `{ enrich: true }` on `belongsTo`).
   */
  enrichmentPlan?: readonly EnrichmentPlanEntry[];

  /**
   * Foreign-key indexes to register on the ObjectPool at construction
   * time. Replaces the subclass override of `registerForeignKeys` for
   * per-model FK registration. Merged with schema-derived entries
   * (relations marked `{ index: true }` on `belongsTo`). Both sets
   * are registered before the legacy `registerForeignKeys()` hook
   * fires, so subclasses can still add more on top.
   */
  foreignKeyIndexes?: readonly ForeignKeyIndexSpec[];
}

/** Sync status for UI binding */
export interface SyncStatus {
  state: 'idle' | 'syncing' | 'error' | 'offline' | 'reconnecting';
  progress: number;
  error?: Error;
  /** When true, the error is a session/auth error requiring re-authentication. */
  isSessionError: boolean;
  lastSyncAt?: Date;
  pendingChanges: number;
  offlineSince?: Date;
}

/** User context for initialization */
export interface UserContext {
  userId: string;
  organizationId: string;
  role?: string;
  teamIds?: string[];
  /** Participant kind on the wire. Default 'user' for browser
   *  sessions; 'agent' for headless bots / worker processes. The
   *  store routes this to SyncWebSocket so the WS URL carries
   *  `kind=agent` and the server applies capability-token auth. */
  kind?: 'user' | 'agent' | 'system';
  /** Restricted (`rk_`) API key for `kind: 'agent'` — the agent's
   *  bearer credential. Sent in the `ablo.bearer.<token>` WebSocket
   *  subprotocol, never in the URL. (Field name predates the
   *  Biscuit→opaque-key migration.) */
  capabilityToken?: string;
  /** Server-authoritative sync groups, supplied by auth/capability
   *  exchange. The SDK does not invent org/user/default groups; app
   *  structure comes from schema-declared scopes and server-issued
   *  authorization. */
  syncGroups?: readonly string[];
  /**
   * How aggressively this participant should pull baseline state at
   * startup.
   *
   *  - `'full'` (default): pull every delta in scope before `ready()`
   *    resolves. The standard browser/user replica behavior.
   *  - `'none'`: open the WebSocket and process live deltas only.
   *    Reads go through `model.retrieve()` / filtered subscriptions
   *    backfilled by `Covering` deltas. Suitable for transactional
   *    participants — agent-worker, video-pipeline, routine runners —
   *    that don't need a local replica of the org's tenant plane.
   */
  bootstrapMode?: 'full' | 'none';
}

/** Smart sync options */
export interface SmartSyncOptions {
  maxDeltasBeforeBootstrap?: number;
  maxBootstrapSize?: number;
  batchingDelay?: number;
  maxBatchSize?: number;
}

/** Rehydration statistics from bootstrap */
export interface RehydrationStats {
  added: number;
  updated: number;
  removed: number;
  skipped: number;
  healed: number;
  elapsedMs: number;
}

/** Bootstrap timeout configuration */
export const BOOTSTRAP_CONFIG = {
  OVERALL_TIMEOUT_MS: 15_000,
  MAX_RETRY_ATTEMPTS: 3,
  RETRY_DELAY_MS: 500,
} as const;

// Re-export for clean API
export { ModelScope };

// Re-export sync types consumers need
export type {
  SyncDelta,
  SyncGroupChangePayload,
  GroupAddedPayload,
  GroupRemovedPayload,
  VersionVector,
  BootstrapHint,
  BootstrapDataEvent,
  PresenceUpdateEvent,
};

// ── Base class ──────────────────────────────────────────────────────────────

/**
 * BaseSyncedStore — abstract base for app-specific sync stores.
 *
 * Provides the dependency structure, observable status, and protected
 * accessors that subclasses use. The actual sync orchestration (initialize,
 * delta processing, bootstrap, query, save, delete, etc.) lives in the
 * app's concrete subclass for now — methods will be pulled up into this
 * base class incrementally as they are genericized.
 *
 * Subclasses MUST call `super(dependencies, config)` and then set up
 * their own MobX observables.
 *
 * Generic over `TCollaboration` — an app-defined event map for real-time
 * collaboration events (cursors, selections, presence beyond the core set).
 * Subclasses pass their own event map to get typed `subscribe()` calls on
 * the underlying SyncWebSocket without casts:
 *
 * @example
 *   interface AbloEvents {
 *     'sheet:selection': [SheetSelectionEvent];
 *     'slide:cursor':    [SlideCursorEvent];
 *   }
 *   class SyncedStore extends BaseSyncedStore<AbloEvents> {
 *     subscribeToSlideCursor(handler: (e: SlideCursorEvent) => void) {
 *       return this.syncWebSocket?.subscribe('slide:cursor', handler);
 *     }
 *   }
 */

/**
 * Walk a schema and derive the three sync-plan arrays consumed by
 * `BaseSyncedStore`'s constructor: version-vector keys, FK indexes to
 * register on the pool, and the enrichment plan.
 *
 * Version vector keys are derived from each model's `typename` (lowercased
 * to match the server's event-type convention — `'Task'` → `'task'`,
 * `'SlideLayer'` → `'slidelayer'`). A fallback to the schema key applies
 * when `typename` is unset, though `defineSchema()` now always resolves
 * it during assembly so the fallback is defensive-only.
 *
 * FK indexes and enrichment entries are pulled from each `belongsTo`
 * relation where `options.index` / `options.enrich` is set. Relations
 * without those options are skipped — this is an opt-in mechanism so
 * adding a `belongsTo` never silently changes delta or lookup semantics.
 *
 * Pure function: takes a Schema, returns three arrays. No side effects,
 * no class state. Called once at construction time from `BaseSyncedStore`.
 */
export function deriveSyncPlanFromSchema(schema: Schema): {
  versionVectorKeys: string[];
  enrichmentPlan: EnrichmentPlanEntry[];
  foreignKeyIndexes: ForeignKeyIndexSpec[];
} {
  const versionVectorKeys: string[] = [];
  const enrichmentPlan: EnrichmentPlanEntry[] = [];
  const foreignKeyIndexes: ForeignKeyIndexSpec[] = [];

  for (const [modelName, def] of Object.entries(schema.models)) {
    const typename = def.typename ?? modelName;
    versionVectorKeys.push(typename.toLowerCase());

    for (const [relationKey, rel] of Object.entries(def.relations)) {
      if (rel.type === 'belongsTo') {
        if (rel.options?.index) {
          foreignKeyIndexes.push({ modelName: typename, fieldName: rel.foreignKey });
        }
        if (rel.options?.enrich) {
          enrichmentPlan.push({
            modelName: typename,
            foreignKey: rel.foreignKey,
            relationKey,
          });
        }
      } else if (rel.type === 'hasMany' || rel.type === 'hasOne') {
        // hasMany/hasOne: the FK lives on the TARGET model, not the current model.
        // Register the FK index on the target so getByForeignKey works.
        // Target typename is resolved at registration time from the schema.
        const targetDef = schema.models[rel.target];
        const targetTypename = targetDef?.typename ?? rel.target;
        foreignKeyIndexes.push({ modelName: targetTypename, fieldName: rel.foreignKey });
      }
    }
  }

  return { versionVectorKeys, enrichmentPlan, foreignKeyIndexes };
}

export class BaseSyncedStore<
  // The collaboration event map. Each key maps to a handler args tuple.
  // `EventMap<T>` (defined in sync/SyncWebSocket.ts) is a homomorphic mapped
  // type that says "every value is unknown[]" — it accepts both closed
  // interfaces (like Ablo's `AbloCollaborationEvents`) AND open Record types,
  // which `Record<string, unknown[]>` does not (interfaces lack the implicit
  // string index signature that `Record<string, ...>` requires). The default
  // is `DefaultCollaborationEvents` (= `Record<string, never>`), which
  // trivially satisfies `EventMap<T>` because `keyof` is `never`.
  TCollaboration extends EventMap<TCollaboration> = DefaultCollaborationEvents,
  // The app's schema, so `query.<modelKey>` + `create(key, data)` return
  // precisely-typed entities. Defaulting to the erased `Schema` shape lets
  // legacy callers that don't know their schema continue to compile; app
  // subclasses parameterize with `typeof schema` to get real inference.
  TSchema extends Schema = Schema
> {
  // ── Observable sync status for UI ──
  syncStatus: SyncStatus = {
    state: 'idle',
    progress: 0,
    pendingChanges: 0,
    isSessionError: false,
  };

  // ── Injected dependencies ──
  protected readonly syncClient: SyncClient;
  protected readonly database: Database;
  protected readonly objectPool: ObjectPool;
  protected readonly modelRegistry: ModelRegistry;
  protected readonly auth?: AuthCredentialSource;
  /**
   * Schema the store was constructed with. Used by the schema-typed
   * `create(key, data)` factory and model self-healing.
   */
  protected readonly schema?: TSchema;


  // ── Real-time sync ──
  protected syncWebSocket: SyncWebSocket<TCollaboration> | null = null;
  /**
   * Dynamic read interest (area-of-interest) over the connection's sync
   * groups. Lives alongside `syncWebSocket` and is recreated with it; the
   * stable `enterScope`/`leaveScope`/`pinScope`/`unpinScope` methods forward
   * to whichever instance is current, so callers (the React participant
   * hook) never hold a stale reference. Null until `setupWebSocketSync`.
   */
  protected areaOfInterest: AreaOfInterestManager | null = null;
  /** Sync groups whose current state has been backfilled into the pool
   *  (hydrate-on-enter). Cleared when the pool is reset on (re)bootstrap. */
  private readonly hydratedGroups = new Set<string>();
  /** In-flight scoped hydrations, keyed by group — single-flights concurrent
   *  enters of the same scope so they share one fetch. */
  private readonly hydratingGroups = new Map<string, Promise<void>>();
  private _syncServerUrl?: string;

  /**
   * Public accessor for the underlying SyncWebSocket. Used by the
   * factory in `createSyncEngine` to wire the default mutation
   * executor — the executor needs the WS handle to send commit
   * frames, and the factory can't reach `protected` state through
   * normal typing. Returns null until WS is initialized during
   * `initialize()`.
   */
  getSyncWebSocket(): SyncWebSocket<TCollaboration> | null {
    return this.syncWebSocket;
  }

  // ── Area-of-interest (dynamic read subscription) ─────────────────
  //
  // `enterScope`/`leaveScope` move the connection's read interest as the
  // user navigates (open/close a deck, sheet, doc); `pinScope`/`unpinScope`
  // express prominence (an active claim keeps a group subscribed). All four
  // resolve the scope to sync-group strings through the SAME resolver the
  // claim path uses (`resolveParticipantSyncGroups`), so read interest and
  // write claims always agree on the string for a given entity. No-ops
  // before the socket exists. Soft state — they never reject for an offline
  // transport (see `AreaOfInterestManager.reconcile`).

  private scopeToGroups(scope: ParticipantScope): string[] {
    return resolveParticipantSyncGroups(scope, this.schema);
  }

  /**
   * Bring a scope into view → subscribe to its groups. With
   * `{ hydrate: true }`, ALSO backfill the groups' current state into the pool
   * after the subscription is active (the game "spawn snapshot + delta stream"
   * pattern): subscribe-first so no live delta is missed in the gap, then
   * snapshot. Hydration is soft — a failed backfill never rejects `enterScope`
   * and the live tail still flows.
   */
  enterScope(scope: ParticipantScope, opts?: { hydrate?: boolean }): Promise<void> {
    const mgr = this.areaOfInterest;
    if (!mgr) return Promise.resolve();
    const groups = this.scopeToGroups(scope);
    const subscribed = Promise.all(groups.map((g) => mgr.enter(g))).then(() => undefined);
    if (!opts?.hydrate) return subscribed;
    return subscribed.then(() => this.hydrateGroups(groups));
  }

  /**
   * Backfill the current state of `syncGroups` into the pool via a PURE scoped
   * snapshot fetch + the version-guarded, ghost-free scoped apply. Idempotent
   * (skips groups already hydrated) and single-flight (concurrent enters of the
   * same group share one fetch). Soft-fails: on error the groups are NOT marked
   * hydrated, so a later re-enter retries.
   */
  protected async hydrateGroups(syncGroups: readonly string[]): Promise<void> {
    const need = syncGroups.filter(
      (g) => !this.hydratedGroups.has(g) && !this.hydratingGroups.has(g),
    );
    if (need.length === 0) {
      // Nothing new to fetch, but await any in-flight hydration for the
      // requested groups so callers can sequence on completion.
      await Promise.all(
        syncGroups
          .map((g) => this.hydratingGroups.get(g))
          .filter((p): p is Promise<void> => p !== undefined),
      );
      return;
    }
    const work = (async () => {
      try {
        const data = await this.database.fetchScopedBootstrapData(need);
        this.syncClient.applyBootstrapDataToPool(data, undefined, { scoped: true });
        for (const g of need) this.hydratedGroups.add(g);
      } catch (err) {
        getContext().logger.warn('[BaseSyncedStore] scoped hydrate failed', {
          syncGroups: need,
          error: err instanceof Error ? err.message : String(err),
        });
        // Soft-fail — leave `need` un-hydrated so a re-enter retries.
      } finally {
        for (const g of need) this.hydratingGroups.delete(g);
      }
    })();
    for (const g of need) this.hydratingGroups.set(g, work);
    await work;
  }

  /** Leave a scope → its groups go warm (hysteresis), then drop on sweep. */
  leaveScope(scope: ParticipantScope): Promise<void> {
    const mgr = this.areaOfInterest;
    if (!mgr) return Promise.resolve();
    return Promise.all(this.scopeToGroups(scope).map((g) => mgr.leave(g))).then(
      () => undefined,
    );
  }

  /** Pin a scope (active claim / prominence) → never warms while pinned. */
  pinScope(scope: ParticipantScope): Promise<void> {
    const mgr = this.areaOfInterest;
    if (!mgr) return Promise.resolve();
    return Promise.all(this.scopeToGroups(scope).map((g) => mgr.pin(g))).then(
      () => undefined,
    );
  }

  /** Release a pin → the group transitions to warm rather than dropping. */
  unpinScope(scope: ParticipantScope): Promise<void> {
    const mgr = this.areaOfInterest;
    if (!mgr) return Promise.resolve();
    return Promise.all(this.scopeToGroups(scope).map((g) => mgr.unpin(g))).then(
      () => undefined,
    );
  }

  // ── Internal helpers ──
  protected readonly queryProcessor: QueryProcessor;
  /**
   * Runtime behavior flags only — the three schema/config arrays
   * (`versionVectorKeys`, `enrichmentPlan`, `foreignKeyIndexes`) are
   * consumed at construction time and stored on the instance as
   * `versionVector`, `enrichmentPlan`, and pool-registered indexes.
   * They don't need to persist on `this.config`.
   */
  protected readonly config: Required<
    Pick<SyncedStoreConfig, 'enableOffline' | 'enableCache' | 'enableTelemetry'>
  >;
  protected disposers: Array<() => void> = [];
  protected initialized = false;
  protected dataReady = false;

  // ── User context ──
  // Identity context the consumer wired in at construction. The shape
  // (`{userId, organizationId, teamIds}`) is currently a fixed contract
  // because the Go-era bootstrap protocol embedded those keys in scope
  // tokens; the SDK should eventually expose this as an opaque
  // `principal` blob so consumers with different identity models
  // aren't forced into user/org. See the architectural note in the
  // README — "currentUserId" is a domain concept, not an SDK
  // primitive, and the host (apps/web/SyncEngineProvider) is the
  // right place to surface it.
  protected userContext: UserContext | null = null;

  // ── Smart sync ──
  protected versionVector: VersionVector;
  /**
   * Declarative enrichment plan: "for model X, when a delta arrives,
   * read data[foreignKey] and attach the matching parent from the pool
   * as data[relationKey]." Merged from schema-derived + config at
   * construction time. Replaces the `enrichRelations` subclass override
   * pattern.
   */
  protected enrichmentPlan: readonly EnrichmentPlanEntry[] = [];
  protected smartSyncOptions: Required<SmartSyncOptions>;
  protected pendingDeltas: SyncDelta[] = [];
  protected batchTimer: ReturnType<typeof setTimeout> | null = null;
  protected syncPromise: Promise<void> | null = null;
  /** Resume/ack cursor — delegates to the shared SyncPosition (see
   *  sync/syncPosition.ts). Advances only after IDB persistence. */
  protected get lastAckedId(): number {
    return this.syncClient.position.persisted;
  }
  /** Pool-applied cursor — delegates to the shared SyncPosition. */
  protected get highestProcessedSyncId(): number {
    return this.syncClient.position.applied;
  }

  // ── Delta queuing during bootstrap ──
  protected bootstrapDeltaQueue: SyncDelta[] | null = null;
  protected activeBootstrapCount = 0;

  // ── Delete tracking ──
  protected pendingDeletes = new Set<string>();

  // ── Model type hydration ──
  protected modelTypesHydrated = new Set<string>();
  protected modelTypeHydrationInFlight = new Map<string, Promise<void>>();

  constructor(
    dependencies: {
      syncClient: SyncClient;
      database: Database;
      objectPool: ObjectPool;
      modelRegistry: ModelRegistry;
      /**
       * Optional schema. When provided, `deriveSyncPlanFromSchema` walks
       * the schema's models + relations to auto-populate version vector
       * keys, FK indexes, and the enrichment plan from declarative
       * annotations. Class-based subclass users (like Ablo's legacy
       * SyncedStore) typically pass explicit `config.versionVectorKeys`
       * / `config.foreignKeyIndexes` / `config.enrichmentPlan` instead.
       */
      schema?: TSchema;
      /** Sync server URL for WebSocket connection. Converted to wss:// automatically. */
      url?: string;
      /** Shared bearer credential source for every auth-aware transport. */
      auth?: AuthCredentialSource;
    },
    config: SyncedStoreConfig = {}
  ) {
    this.syncClient = dependencies.syncClient;
    this.database = dependencies.database;
    this.objectPool = dependencies.objectPool;
    this.modelRegistry = dependencies.modelRegistry;
    this.auth = dependencies.auth;
    this.schema = dependencies.schema;
    this._syncServerUrl = dependencies.url;

    // Set this store as the global Model store
    Model.setStore(this as Parameters<typeof Model.setStore>[0]);

    // ── Schema-derived sync plan (Phase 2) ─────────────────────────────
    //
    // When a schema is provided, derive version vector keys, FK indexes,
    // and the enrichment plan from declarative annotations on the schema's
    // `belongsTo` relations. Explicit config fields layer on top, so
    // subclasses (like Ablo's SyncedStore) can pass hardcoded arrays
    // without needing a full schema.generated.ts.
    //
    // Order matters: schema-derived first, config second, so that in a
    // future where Ablo passes both (schema AND explicit config), the
    // explicit config entries are registered last and can't be
    // accidentally shadowed by schema derivation.
    const derived = dependencies.schema
      ? deriveSyncPlanFromSchema(dependencies.schema)
      : { versionVectorKeys: [], enrichmentPlan: [], foreignKeyIndexes: [] };

    const mergedForeignKeyIndexes: ForeignKeyIndexSpec[] = [
      ...derived.foreignKeyIndexes,
      ...(config.foreignKeyIndexes ?? []),
    ];
    for (const { modelName, fieldName } of mergedForeignKeyIndexes) {
      this.objectPool.registerForeignKey(modelName, fieldName);
    }

    // Legacy override hook — still called AFTER schema-driven registration
    // so subclasses can add more FKs on top of the declarative set.
    // Kept for backwards compat; subclasses migrate to config at leisure.
    this.registerForeignKeys();

    this.enrichmentPlan = [
      ...derived.enrichmentPlan,
      ...(config.enrichmentPlan ?? []),
    ];

    // Set dependencies for LazyReferenceCollection
    LazyReferenceCollection.setDependencies(this.database, this.objectPool);

    // Apply config defaults
    this.config = {
      enableOffline: config.enableOffline ?? true,
      enableCache: config.enableCache ?? true,
      enableTelemetry: config.enableTelemetry ?? false,
    };

    // Smart sync options
    this.smartSyncOptions = {
      maxDeltasBeforeBootstrap: 1000,
      maxBootstrapSize: 10 * 1024 * 1024,
      batchingDelay: 100,
      maxBatchSize: 50,
    };

    // Version vector: union of schema-derived keys + explicit config keys,
    // each seeded to 0. Empty when neither source supplies keys (unchanged
    // behavior from pre-Phase-2 defaults).
    const mergedVvKeys = [
      ...derived.versionVectorKeys,
      ...(config.versionVectorKeys ?? []),
    ];
    this.versionVector = Object.fromEntries(
      mergedVvKeys.map((k) => [k, 0])
    ) as VersionVector;

    // Create internal helpers
    this.queryProcessor = new QueryProcessor({
      enableCache: this.config.enableCache,
    });

    // Auto-invalidate query cache when SyncClient modifies the pool.
    // Replaces all manual queryProcessor.invalidateCache() calls.
    this.syncClient.on('models:changed', (modelNames: Set<string>) => {
      for (const name of modelNames) {
        this.queryProcessor.invalidateCache(`.*${name}.*`);
      }
    });

    // Make sync status fields observable so consumer code can do
    //   reaction(() => store.isReady, ...)
    //   observer(() => store.isOffline)
    // and actually receive notifications. Without these annotations,
    // `syncStatus` / `dataReady` are plain properties and the derived
    // getters (isReady, isSyncing, isOffline, ...) never emit change
    // signals — a trap that has burned multiple downstream apps
    // (one stuck forever on the loading skeleton because `reaction`
    // to `store.isReady` never fired). Explicit > accidental.
    makeObservable<this, 'dataReady'>(this, {
      syncStatus: observable,
      dataReady: observable,
      isReady: computed,
      isSyncing: computed,
      isOffline: computed,
      isReconnecting: computed,
      isError: computed,
      hasUnsyncedChanges: computed,
    });
  }

  // ── Protected extension points ────────────────────────────────────────────

  /**
   * Register foreign key indexes for O(1) lookups.
   *
   * Legacy override hook — in Phase 2 the preferred way to declare FK
   * indexes is via `config.foreignKeyIndexes` at construction time, or
   * by marking the `belongsTo` relation with `{ index: true }` in the
   * schema. This hook still fires AFTER the schema-derived + config
   * registrations, so subclasses can layer additional FKs on top.
   */
  protected registerForeignKeys(): void {}

  /**
   * Enrich delta data with related models from the ObjectPool.
   *
   * Base implementation walks `this.enrichmentPlan` — entries populated
   * from the schema's `{ enrich: true }` relations and from
   * `config.enrichmentPlan`. Subclasses can still override for bespoke
   * logic, calling `super.enrichRelations(modelName, data)` first to
   * apply the declarative plan before layering on custom work.
   *
   * Enrichment is best-effort: if the parent isn't yet in the pool
   * (e.g., a child delta arrives before its parent in a bootstrap
   * batch), the entry is silently skipped and the data passes through
   * untouched. The next delta for the same child will re-enrich.
   */
  protected enrichRelations(modelName: string, data: ModelData): ModelData {
    for (const entry of this.enrichmentPlan) {
      if (entry.modelName !== modelName) continue;
      const fkValue = data[entry.foreignKey];
      if (typeof fkValue !== 'string') continue;
      const parent = this.objectPool.get(fkValue);
      if (parent) {
        data[entry.relationKey] = parent;
      }
    }
    return data;
  }

  /** Check if a model name represents a custom/dynamic entity type. */
  protected isCustomEntity(modelName: string): boolean {
    return !this.objectPool.registry.getModelByName(modelName);
  }

  /** Create a custom entity instance from delta data. Override for domain-specific custom entities. */
  protected createCustomEntity(_modelName: string, _modelId: string, _data: Record<string, unknown>): Model | null {
    return null;
  }

  /** Called before save for domain-specific validation/self-healing. */
  protected beforeSave(_model: Model): void {}

  /** Connection lifecycle event callback — set by subclass to wire connection state machine. */
  protected onConnectionEvent?: (event: string) => void;

  /**
   * Internal connection FSM. Owns network probe + backoff + reconnect
   * orchestration for the default path. Constructed lazily once we
   * have a user context + a WebSocket (see `wireWebSocketEvents`);
   * driven by the `onConnectionEvent` hook AND browser online/offline
   * events it sets up itself.
   *
   * Every consumer gets production-grade offline-to-online recovery
   * out of the box. Subclasses that want their own lifecycle owner
   * can disable this by overriding `createConnectionManager()` to
   * return null.
   */
  protected connectionManager: import('./sync/ConnectionManager.js').ConnectionManager | null = null;

  /**
   * Re-mint hook for the short-lived access credential (the Stripe-style
   * `ek_`/`rk_`). Wired by the React provider from its `getToken`/`authEndpoint`
   * — the engine owns WHEN to refresh (a stale-credential probe / an external
   * nudge), the integrator owns HOW to mint. Mirrors the `getToken` contract:
   * resolves a token string on success, `null` when the long-lived login is
   * gone (terminal), and THROWS on a transient/offline failure. Used by
   * {@link performCredentialRefresh}. Absent ⇒ no silent re-mint (e.g. a static
   * `apiKey` deployment whose credential source refreshes out-of-band).
   */
  private credentialRefresher: (() => Promise<string | null>) | null = null;

  /** Single-flight guard so a wake nudge + an in-flight request + a probe don't
   *  all mint at once (the classic "token thrash → random logout" bug). */
  private inFlightCredentialRefresh: Promise<'refreshed' | 'session_error' | 'network_error'> | null =
    null;

  /** Teardown for the proactive credential lifecycle (refresh timer + wake/
   *  online/focus listeners) installed by {@link startCredentialLifecycle};
   *  cleared on {@link disconnect}. Null when no resolver is wired. */
  private credentialLifecycleTeardown: (() => void) | null = null;

  /**
   * Listeners registered via `subscribeSessionError()`. Fired when the
   * WebSocket closes with a session-invalid code (1008/4001/4003) or a
   * session-error event is received. Separate from `onConnectionEvent`
   * (which exists for the ConnectionStore FSM) so multiple consumers —
   * typically `<AbloProvider>` and a connection-lifecycle owner — can
   * both react without racing on the single-callback slot.
   */
  protected sessionErrorListeners = new Set<(error: Error) => void>();

  /**
   * Subscribe to session-error events. The returned function removes
   * the listener. Safe to call multiple times from different consumers
   * (each gets its own slot in the listener set).
   */
  subscribeSessionError(listener: (error: Error) => void): () => void {
    this.sessionErrorListeners.add(listener);
    return () => { this.sessionErrorListeners.delete(listener); };
  }

  /**
   * Subscribe to per-mutation failure payloads. Forwarded from the
   * underlying `SyncClient.transactionQueue` so consumers (toast layer,
   * route-level reverted boundaries, telemetry) can react without
   * reaching across the store. Returns an unsubscribe function.
   *
   * Why this lives on the base store rather than SyncClient: the React
   * `<AbloProvider>` binds against this surface, so adding it here
   * keeps the engine's internal wiring private while still giving the
   * SDK a single hook to expose. Mirrors `subscribeSessionError` —
   * same shape, same lifecycle.
   */
  subscribeMutationFailure(
    listener: (payload: {
      transaction: import('./transactions/TransactionQueue.js').Transaction;
      error: Error;
      permanent?: boolean;
    }) => void,
  ): () => void {
    return this.syncClient.onMutationFailure(listener);
  }

  /**
   * Wait for the in-flight transaction for (modelName, modelId) to be
   * confirmed by the server. See `SyncClient.waitForConfirmation` for the
   * lookup contract; resolves immediately if nothing is in flight.
   */
  waitForConfirmation(modelName: string, modelId: string): Promise<void> {
    return this.syncClient.waitForConfirmation(modelName, modelId);
  }

  /**
   * Observe the LOCAL mutation stream for undo recording (see
   * {@link import('./react/context.js').LocalMutation}). Taps the
   * TransactionQueue's `transaction:created` event — fired once per local
   * create/update/delete/archive with `previousData` already captured.
   * Remote/collaborator deltas apply via `applyDeltaBatchToPool` and never
   * emit here, so undo is naturally local-only (you can't undo a teammate).
   */
  subscribeLocalMutations(handler: (mutation: LocalMutation) => void): () => void {
    // Tap the TransactionQueue directly via `onLocalTransaction`. The previous
    // `syncClient.subscribe('transaction:created', …)` route registered the
    // handler on SyncClient's OWN emitter, which never fires that event (only
    // the queue's emitter does) — so undo recorded nothing. See
    // `SyncClient.onLocalTransaction` for the full rationale.
    return this.syncClient.onLocalTransaction((tx) => {
      if (!tx || !tx.type || !tx.modelName || !tx.modelId) return;
      handler({
        type: tx.type,
        modelName: tx.modelName,
        modelId: tx.modelId,
        data: tx.data ?? null,
        previousData: tx.previousData ?? null,
      });
    });
  }

  // ── Bootstrap + Retry ────────────────────────────────────────────────────

  /**
   * Execute a bootstrap function with timeout protection and automatic retry.
   * Prevents the common issue where bootstrap hangs on startup.
   */
  protected async executeBootstrapWithTimeout<T>(
    bootstrapFn: () => Promise<T>,
    _context: UserContext,
    signal?: AbortSignal
  ): Promise<T> {
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= BOOTSTRAP_CONFIG.MAX_RETRY_ATTEMPTS; attempt++) {
      if (signal?.aborted) {
        throw new DOMException('Initialization aborted', 'AbortError');
      }

      // `navigator.onLine === false` is the MDN-reliable "definitely
      // offline" signal. Don't use `!navigator.onLine`: Node 22+ exposes
      // `globalThis.navigator` with `onLine === undefined`, so the
      // negation false-positives every server-side bootstrap (e.g. the
      // server-side agent.run dispatch path through `connectAgent`).
      if (typeof navigator !== 'undefined' && navigator.onLine === false) {
        getContext().observability.breadcrumb(
          `Bootstrap attempt ${attempt} skipped - offline`,
          'sync.bootstrap',
          'warning'
        );
        throw new AbloConnectionError('Bootstrap skipped - device is offline', {
          code: 'bootstrap_offline',
        });
      }

      try {
        getContext().logger.info(
          `[BaseSyncedStore] Bootstrap attempt ${attempt}/${BOOTSTRAP_CONFIG.MAX_RETRY_ATTEMPTS}`
        );

        const result = (await Promise.race([
          bootstrapFn(),
          this.createBootstrapTimeout(attempt),
        ])) as T;

        getContext().logger.info('[BaseSyncedStore] Bootstrap completed successfully', { attempt });
        return result;
      } catch (error) {
        lastError = error as Error;
        const isTimeout = error instanceof Error && error.message.includes('timed out');
        const isAbort = error instanceof DOMException && error.name === 'AbortError';
        const isNetworkError = error instanceof TypeError && error.message.includes('fetch');

        if (isAbort) throw error;
        if (SyncSessionError.isSessionError(error)) throw error;

        if (isNetworkError && typeof navigator !== 'undefined' && navigator.onLine === false) {
          getContext().observability.captureBootstrapFailure(error, { type: 'network-offline' });
          throw error;
        }

        getContext().observability.breadcrumb(
          `Bootstrap attempt ${attempt} failed`,
          'sync.bootstrap',
          'warning',
          { isTimeout, isNetworkError, willRetry: attempt < BOOTSTRAP_CONFIG.MAX_RETRY_ATTEMPTS }
        );

        if (isTimeout && attempt < BOOTSTRAP_CONFIG.MAX_RETRY_ATTEMPTS) {
          getContext().logger.info('[BaseSyncedStore] Resetting state before bootstrap retry');
          this.resetBootstrapState();
          await new Promise((resolve) => setTimeout(resolve, BOOTSTRAP_CONFIG.RETRY_DELAY_MS));
        } else if (!isTimeout && attempt < BOOTSTRAP_CONFIG.MAX_RETRY_ATTEMPTS) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      }
    }

    throw lastError
      ? toAbloError(lastError)
      : new AbloConnectionError('Bootstrap failed after all retry attempts', {
          code: 'bootstrap_fetch_timeout',
        });
  }

  /** Create a timeout promise for bootstrap attempts */
  protected createBootstrapTimeout(attempt: number): Promise<never> {
    const timeoutMs = BOOTSTRAP_CONFIG.OVERALL_TIMEOUT_MS + (attempt - 1) * 3_000;
    return new Promise((_, reject) => {
      setTimeout(() => {
        reject(
          new AbloConnectionError(
            `Bootstrap timed out after ${timeoutMs}ms (attempt ${attempt})`,
            { code: 'bootstrap_fetch_timeout' },
          ),
        );
      }, timeoutMs);
    });
  }

  /** Reset bootstrap-related state for a clean retry */
  protected resetBootstrapState(): void {
    try {
      this.objectPool.clear({ preserveObserved: true });
      this.queryProcessor.clearCache();
      runInAction(() => { this.dataReady = false; });
      this.modelTypesHydrated.clear();
      this.modelTypeHydrationInFlight.clear();
      // The pool is being wiped + re-bootstrapped, so the scoped-hydrate ledger
      // is stale — clear it so re-entered groups backfill again.
      this.hydratedGroups.clear();
      this.hydratingGroups.clear();
      getContext().logger.info('[BaseSyncedStore] Bootstrap state reset complete');
    } catch {
      getContext().observability.breadcrumb('Error resetting bootstrap state', 'sync.bootstrap', 'warning');
    }
  }

  // ── Reconnection ─────────────────────────────────────────────────────────

  /** Perform reconnect: bootstrap + WS reconnect. Returns outcome for state machine. */
  async performReconnect(): Promise<'success' | 'session_error' | 'network_error'> {
    if (!this.userContext) return 'network_error';

    try {
      await this.checkSyncGroupShrinkage();

      const requirements = await this.database.requiredBootstrap();

      if (requirements.type === 'full' || requirements.lastSyncId === 0) {
        this.updateSyncStatus({ state: 'syncing', progress: 0 });
        const bootstrapResult = await this.database.bootstrapFromServer(
          requirements,
          this.resolveSyncGroups(this.userContext),
        );
        this.applyBootstrapToPool(bootstrapResult);
        this.dataReady = true;
      } else if (!this.dataReady) {
        await this.syncClient.hydrateFromDatabase();
        this.dataReady = true;
      }

      if (this.syncWebSocket && !this.syncWebSocket.isConnected()) {
        this.syncWebSocket.resetReconnectAttempts();
        this.syncWebSocket.connect();
      }

      this.updateSyncStatus({ state: 'idle', progress: 100 });
      return 'success';
    } catch (error) {
      getContext().observability.captureBootstrapFailure(error, { type: 'connection-store-reconnect' });

      if (SyncSessionError.isSessionError(error)) {
        this.syncWebSocket?.setSessionErrorDetected();
        this.syncWebSocket?.disconnect();
        this.updateSyncStatus({ state: 'error', error: error as Error });

        // SECURITY: Clear locally cached data when session is invalid
        this.database.clear().catch(() => {});
        this.objectPool.clear();

        return 'session_error';
      }

      if (!this.dataReady && this.objectPool.size === 0) {
        try {
          await this.syncClient.hydrateFromDatabase();
          if (this.objectPool.size > 0) {
            this.dataReady = true;
            getContext().logger.info('[BaseSyncedStore] Hydrated from local fallback', {
              objectPoolSize: this.objectPool.size,
            });
          }
        } catch (fallbackError) {
          getContext().logger.warn('[BaseSyncedStore] Local fallback failed', {
            error: (fallbackError as Error).message,
          });
        }
      }

      return 'network_error';
    }
  }

  /**
   * Register the access-credential re-mint hook. Called by the React provider
   * with a thunk that mints a fresh `ek_`/`rk_` (typically its `getToken`).
   * See {@link credentialRefresher}.
   */
  setCredentialRefresher(refresher: (() => Promise<string | null>) | null): void {
    this.credentialRefresher = refresher;
  }

  /**
   * Re-mint the short-lived access credential and push it into the credential
   * source, reporting a tri-state outcome the {@link ConnectionManager} maps to
   * its FSM. The contract mirrors `getToken` (and PowerSync's `fetchCredentials`
   * / Liveblocks' `authEndpoint`, but made explicit instead of overloading
   * return/throw):
   *   - token string  → `'refreshed'`     (fresh key in place; re-probe & reconnect)
   *   - `null`        → `'session_error'` (login itself is gone → terminal, sign out)
   *   - throw         → `'network_error'` (couldn't reach the mint endpoint → transient)
   *
   * SINGLE-FLIGHT: concurrent callers (a wake nudge, an in-flight request, the
   * probe) share one in-flight promise so we never double-mint — the canonical
   * fix for the "every 401 mints a token → thrash → spurious logout" anti-pattern.
   *
   * No refresher wired ⇒ `'refreshed'` (a no-op re-probe): a static-`apiKey`
   * deployment has no session to re-mint from; its credential source refreshes
   * out-of-band, so we just re-probe with whatever it currently holds.
   */
  async performCredentialRefresh(): Promise<'refreshed' | 'session_error' | 'network_error'> {
    const refresher = this.credentialRefresher;
    if (!refresher) return 'refreshed';
    if (this.inFlightCredentialRefresh) return this.inFlightCredentialRefresh;

    const run = (async (): Promise<'refreshed' | 'session_error' | 'network_error'> => {
      try {
        const token = await refresher();
        if (!token) {
          // null = the long-lived login is gone (mint endpoint answered 401/403).
          // Terminal — the FSM routes this to sign-out.
          return 'session_error';
        }
        this.auth?.setAuthToken(token);
        return 'refreshed';
      } catch (error) {
        // A throw = transient (offline / mint endpoint unreachable / 5xx). The
        // login may be perfectly valid; never sign out for this — back off and
        // retry. Mirrors the `getToken` throw-vs-null contract end-to-end.
        getContext().logger.warn('[BaseSyncedStore] Access-credential re-mint failed (transient)', {
          error: (error as Error)?.message,
        });
        return 'network_error';
      }
    })();

    this.inFlightCredentialRefresh = run;
    try {
      return await run;
    } finally {
      this.inFlightCredentialRefresh = null;
    }
  }

  /**
   * Nudge the connection FSM to re-probe with the current credential. Idempotent
   * and safe in any state (ignored while `connected`). Call after pushing a
   * freshly-minted token via `setAuthToken`, or on an OS-wake signal, so a
   * connection parked in `offline` / `backoff` / `auth_blocked` picks the new
   * credential up immediately instead of waiting for the 30s watchdog.
   */
  nudgeReconnect(): void {
    this.connectionManager?.send({ type: 'CREDENTIAL_REFRESHED' });
  }

  /**
   * Install the access-credential lifecycle the CLIENT owns (this used to live
   * in the React provider — wrong layer). Two parts:
   *   1. REACTIVE — register `getToken` as the re-mint hook the FSM calls when a
   *      probe finds the key stale (`credential_stale`) or on a nudge.
   *   2. PROACTIVE — keep the short-lived key fresh ahead of trouble: a refresh
   *      timer inside the TTL, plus re-mint on OS wake / network-online / tab
   *      focus. Browser-only triggers are env-gated, so Node/agent hosts get
   *      only the timer (a no-op there — agents use a static `apiKey`, no
   *      resolver, so this is never called for them).
   *
   * Config-driven and invisible, like Supabase's `autoRefreshToken` — consumers
   * never call a refresh method. Idempotent (a second call replaces the first);
   * torn down on {@link disconnect}.
   */
  startCredentialLifecycle(getToken: () => Promise<string | null>): void {
    this.stopCredentialLifecycle();
    this.setCredentialRefresher(getToken);

    // Re-mint through the SAME single-flight path the FSM's reactive probe uses
    // (`performCredentialRefresh`) rather than calling `getToken()` directly. Two
    // wins over the old direct call:
    //   - SINGLE-FLIGHT: a wake nudge, an in-flight probe, and this proactive
    //     roll share one in-flight promise — no double-mint thrash.
    //   - The tri-state is HONOURED. The old code did `if (token) {…}` and
    //     dropped a `null` on the floor — a zombie session that re-minted on
    //     every tab focus and logged "signing out" forever without ever signing
    //     out. `session_error` now drives the FSM to actually expire.
    const refresh = async (): Promise<void> => {
      const outcome = await this.performCredentialRefresh();
      if (outcome === 'refreshed') {
        // Fresh key already pushed into the credential source by
        // `performCredentialRefresh`; nudge a parked connection to re-probe.
        this.nudgeReconnect();
      } else if (outcome === 'session_error') {
        // The long-lived login is gone (mint answered 401/403). Surface it —
        // the proactive path's job is to report this, not hide it. A no-op in
        // FSM states that don't accept the event (the probe converges on
        // sign-out there anyway); `session_expired`'s onEnter owns the log.
        this.connectionManager?.send({ type: 'BOOTSTRAP_FAILED_SESSION' });
      }
      // 'network_error' → transient (offline / mint hiccup); the next timer tick
      // or the FSM's own probe retries. Never sign out for it.
    };

    // Comfortably inside the 15m `ek_` TTL; a missed (background-throttled) tick
    // is recovered by the next, or by the reactive probe. The timer is the sole
    // proactive PRE-ROLL — it keeps the key warm ahead of expiry even while the
    // socket sits healthy-`connected` (a state the FSM never probes unprompted).
    const REFRESH_INTERVAL_MS = 10 * 60 * 1000;
    const timer = setInterval(() => void refresh(), REFRESH_INTERVAL_MS);
    const teardowns: Array<() => void> = [() => clearInterval(timer)];

    if (typeof window !== 'undefined') {
      // OS-wake (desktop only): the Electron shell bridges `powerMonitor`
      // 'resume' to this DOM event. This is the ONE event-trigger the lifecycle
      // still owns, because `visibilitychange` does NOT fire on wake-from-sleep
      // and — unlike `online`/`visibilitychange` — the ConnectionManager's own
      // browser listeners (`setupBrowserListeners`) don't cover wake.
      //
      // The `online` and `visibilitychange` listeners that used to live here
      // were REMOVED: the FSM already re-probes on NETWORK_ONLINE / TAB_VISIBLE
      // through this exact credential path, so registering them here too only
      // fired a second, null-swallowing mint per focus — the "session-key
      // POSTed on every tab focus" spam in the console.
      const onWake = (): void => void refresh();
      window.addEventListener('ablo:wake', onWake);
      teardowns.push(() => window.removeEventListener('ablo:wake', onWake));
    }

    this.credentialLifecycleTeardown = (): void => {
      for (const t of teardowns) t();
    };
  }

  /** Tear down the proactive credential lifecycle (idempotent). */
  private stopCredentialLifecycle(): void {
    this.credentialLifecycleTeardown?.();
    this.credentialLifecycleTeardown = null;
  }

  // ── Sync Group Management ────────────────────────────────────────────────

  /**
   * Handle an actionType 'G' delta.
   *
   * The server emits 'G' via two distinct pathways, distinguished by payload
   * shape:
   *
   *   Incremental (EmitGroupAdded):   { group, userId }
   *     - The recipient was added to a single sync group.
   *     - Subsequent 'C' (Covering) deltas deliver each newly-visible entity.
   *     - No re-bootstrap — entities arrive via the normal insert path.
   *
   *   Legacy (EmitGroupChange):       { addedGroups, removedGroups }
   *     - Single delta carrying the full group membership diff.
   *     - Forces a full re-bootstrap (disconnect + reconnect + fetch all).
   *     - Deprecated on the server; kept here for wire-level backward compat.
   */
  protected async handleSyncGroupChange(delta: SyncDelta): Promise<void> {
    const raw = typeof delta.data === 'string' ? JSON.parse(delta.data as string) : delta.data;
    const rawObj = (raw ?? {}) as Record<string, unknown>;

    // Detect incremental payload shape: { group, userId }
    if (typeof rawObj.group === 'string' && typeof rawObj.userId === 'string') {
      const incremental: GroupAddedPayload = {
        group: rawObj.group,
        userId: rawObj.userId,
      };
      await this.handleGroupAdded(incremental, delta.id);
      return;
    }

    // Legacy payload: { addedGroups, removedGroups }
    const payload: SyncGroupChangePayload = {
      removedGroups: (rawObj.removedGroups as string[]) ?? [],
      addedGroups: (rawObj.addedGroups as string[]) ?? [],
    };

    getContext().logger.info('[BaseSyncedStore] Sync group change received (legacy)', {
      removedGroups: payload.removedGroups,
      addedGroups: payload.addedGroups,
      syncId: delta.id,
    });

    // SECURITY: If groups were removed, clear cached data immediately.
    // This prevents revoked data from persisting if the device goes offline
    // before the full re-bootstrap completes.
    if (payload.removedGroups.length > 0) {
      await this.database.clear();
      this.objectPool.clear();
      getContext().logger.info('[BaseSyncedStore] Cleared cached data due to revoked sync groups', {
        removedGroups: payload.removedGroups,
      });
    }

    const updatedGroups = this.computeUpdatedSyncGroups(payload);
    await this.database.updateWorkspaceMetadata({ subscribedSyncGroups: updatedGroups });
    this.forceFullRebootstrap();
  }

  /**
   * Handle an incremental GroupAdded delta.
   *
   * Adds the new group to the subscription metadata without triggering a
   * re-bootstrap. The server will follow up with 'C' (Covering) deltas for
   * each newly-visible entity, which flow through the normal insert path.
   */
  protected async handleGroupAdded(payload: GroupAddedPayload, syncId: number): Promise<void> {
    getContext().logger.info('[BaseSyncedStore] Group added (incremental)', {
      group: payload.group,
      syncId,
    });

    const current = new Set(this.syncWebSocket?.getSyncGroups() ?? []);
    current.add(payload.group);
    await this.database.updateWorkspaceMetadata({ subscribedSyncGroups: Array.from(current) });
    // Note: no forceFullRebootstrap() — covering deltas will bring the entities.
  }

  /**
   * Handle an actionType 'S' (GroupRemoved) delta.
   *
   * Signals that the recipient has lost access to a sync group. Because
   * the client does not track per-entity group membership, we can't
   * selectively purge entities belonging to that group. The safe fallback
   * is the legacy behavior: clear local state and force a re-bootstrap
   * with the updated group list.
   *
   * Future optimization: track group membership in the ObjectPool so 'S'
   * can do a targeted purge instead of a full re-bootstrap.
   */
  protected async handleGroupRemoved(delta: SyncDelta): Promise<void> {
    const raw = typeof delta.data === 'string' ? JSON.parse(delta.data as string) : delta.data;
    const rawObj = (raw ?? {}) as Record<string, unknown>;
    const groupKey = typeof rawObj.group === 'string' ? rawObj.group : undefined;

    if (!groupKey) {
      getContext().logger.warn('[BaseSyncedStore] Group removed delta missing group key', {
        syncId: delta.id,
      });
      return;
    }

    getContext().logger.info('[BaseSyncedStore] Group removed', {
      group: groupKey,
      syncId: delta.id,
    });

    // SECURITY: Clear cached data before re-bootstrap. This prevents
    // revoked-group data from persisting if the device goes offline
    // between receiving 'S' and completing the re-bootstrap.
    await this.database.clear();
    this.objectPool.clear();

    // Update subscription metadata so the re-bootstrap fetches the
    // correct set of groups.
    const current = new Set(this.syncWebSocket?.getSyncGroups() ?? []);
    current.delete(groupKey);
    await this.database.updateWorkspaceMetadata({ subscribedSyncGroups: Array.from(current) });

    this.forceFullRebootstrap();
  }

  /** Compute new sync groups after applying additions and removals */
  protected computeUpdatedSyncGroups(payload: SyncGroupChangePayload): string[] {
    const current = new Set(this.syncWebSocket?.getSyncGroups() ?? []);
    for (const g of payload.removedGroups) current.delete(g);
    for (const g of payload.addedGroups) current.add(g);
    return Array.from(current);
  }

  /** Force a full re-bootstrap via connection lifecycle event.
   *
   * No-op for `bootstrapMode: 'none'` participants — they never pull
   * baseline state, so a "force re-bootstrap" trigger (sync-group
   * shrink, scope revocation) instead just flushes the local pool and
   * relies on covering deltas to repopulate the data they actually
   * subscribe to.
   */
  protected forceFullRebootstrap(): void {
    if (this.userContext?.bootstrapMode === 'none') {
      getContext().logger.info(
        '[BaseSyncedStore] forceFullRebootstrap skipped (bootstrapMode=none)',
      );
      return;
    }
    this.database.markRequiresFullBootstrap();
    this.syncWebSocket?.disconnect();
    this.onConnectionEvent?.('WS_DISCONNECTED');
  }

  /**
   * Single source of truth for the sync-group list this session is
   * subscribed to. Server-issued (`context.syncGroups`) is authoritative.
   * When absent, the SDK subscribes to no explicit groups. Both
   * `checkSyncGroupShrinkage` and `setupWebSocketSync` resolve through
   * here so the WS subscription and the security-critical shrinkage
   * check can never disagree.
   */
  protected resolveSyncGroups(context: UserContext): readonly string[] {
    if (context.syncGroups && context.syncGroups.length > 0) {
      return context.syncGroups;
    }
    return [];
  }

  /** Check if sync groups shrank since last session — force full bootstrap if so */
  protected async checkSyncGroupShrinkage(): Promise<void> {
    if (!this.userContext) return;

    try {
      const metadata = await this.database.getWorkspaceMetadata();
      const stored = metadata?.subscribedSyncGroups ?? [];
      if (stored.length === 0) return;

      const currentGroups = new Set(this.resolveSyncGroups(this.userContext));

      const removedGroups = stored.filter((g: string) => !currentGroups.has(g));

      if (removedGroups.length > 0) {
        getContext().logger.info('[BaseSyncedStore] Sync groups shrank — forcing full bootstrap', {
          removedGroups,
          storedCount: stored.length,
          currentCount: currentGroups.size,
        });

        // SECURITY: Clear cached data before re-bootstrap to prevent
        // revoked-group data from persisting if device goes offline
        await this.database.clear();
        this.objectPool.clear();

        this.database.markRequiresFullBootstrap();
      }

      await this.database.updateWorkspaceMetadata({
        subscribedSyncGroups: Array.from(currentGroups),
      });
    } catch (error) {
      getContext().logger.warn('[BaseSyncedStore] Failed to check sync group shrinkage', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** Apply bootstrap data to the ObjectPool with ghost removal */
  /** Apply bootstrap data to the ObjectPool. Delegates pool writes to SyncClient. */
  protected applyBootstrapToPool(
    bootstrapResult: BootstrapResult,
    protectedIds?: ReadonlySet<string>
  ): RehydrationStats {
    const { bootstrapData } = bootstrapResult;

    // Partial bootstrap: Database.processDeltaBatch already wrote the deltas
    // to IDB. Route the same results through the delta-apply path so the
    // in-memory pool evicts deleted entities (and updates modified ones).
    // Without this, reconnect DELETEs persist to IDB but the canvas keeps
    // showing ghost layers until a full reload.
    if (bootstrapData.type === 'partial') {
      const deltaResults = bootstrapResult.deltaResults;
      if (deltaResults && deltaResults.length > 0) {
        this.syncClient.applyDeltaBatchToPool(
          deltaResults,
          (name, data) => this.enrichRelations(name, data),
        );
      }
      return { added: 0, updated: 0, removed: 0, skipped: 0, healed: 0, elapsedMs: 0 };
    }

    if (!bootstrapData.models) {
      return { added: 0, updated: 0, removed: 0, skipped: 0, healed: 0, elapsedMs: 0 };
    }

    const start = typeof performance !== 'undefined' ? performance.now() : Date.now();

    // SyncClient owns: model creation, healing, pool upsert, ghost removal
    const stats = this.syncClient.applyBootstrapDataToPool(bootstrapData, protectedIds);

    const elapsedMs = Math.round((typeof performance !== 'undefined' ? performance.now() : Date.now()) - start);

    getContext().logger.info('[BaseSyncedStore] Bootstrap applied', {
      ...stats, elapsedMs, poolSize: this.objectPool.size,
    });

    return { ...stats, elapsedMs };
  }

  // ── Initialize + Lifecycle ───────────────────────────────────────────────

  /**
   * Initialize the sync engine with user context.
   * Offline-first: hydrate from IDB → show UI → bootstrap from server in background.
   */
  *initialize(
    context: UserContext,
    signal?: AbortSignal
  ): Generator<Promise<unknown>, { success: boolean; error?: Error }, unknown> {
    if (this.initialized) return { success: true };

    this.userContext = context;

    // Propagate identity to SyncClient. Without this, every mutation
    // silently drops in `processPendingMutations` / `stageMutation` with
    // `userId=null, organizationId=null`. Previously the SDK assumed
    // callers would call `syncClient.initialize()` themselves as a
    // separate step — that never happened from createSyncEngine, and
    // the drop was invisible because both guard sites just early-return
    // rather than throw. The right fix is to do it here where the store
    // receives the context, so identity is one source of truth.
    yield this.syncClient.initialize(
      context.userId,
      context.organizationId,
    );

    try {
      this.updateSyncStatus({ state: 'syncing', progress: 0 });

      // Open database
      yield this.database.open(context.userId, context.organizationId);

      // Hydrate from IndexedDB (fast, cached data)
      let hasLocalData = false;
      try {
        yield this.syncClient.hydrateFromDatabase();
        hasLocalData = this.objectPool.size > 0;
      } catch (hydrateError) {
        getContext().logger.warn('[sync-engine] IDB hydration failed', { error: hydrateError });
        getContext().observability.captureBootstrapFailure(hydrateError, { type: 'hydration-from-idb' });
      }

      // Get sync baseline for WebSocket
      const lastSyncId = (yield this.database.getLastSyncId()) as number;
      this.syncClient.position.advancePersisted(lastSyncId || 0);

      try {
        const versions = (yield this.database.getVersionVector()) as Record<string, number> | null;
        if (versions && typeof versions === 'object') Object.assign(this.versionVector, versions);
      } catch {}

      // If local data available, show UI immediately
      if (hasLocalData) {
        this.dataReady = true;
        this.initialized = true;
        this.updateSyncStatus({ state: 'syncing', progress: 50 });
      }

      // Setup WebSocket
      this.setupWebSocketSync(context, lastSyncId);

      // Bootstrap from server if needed.
      //
      // `bootstrapMode: 'none'` participants (agent-worker, headless
      // task runners) skip baseline replication — they read via
      // `model.retrieve()` round-trips and rely on covering deltas
      // from filtered subscriptions to populate the pool lazily. The
      // WS is already open by `setupWebSocketSync` above, so live
      // delta flow works regardless of this branch.
      const requirements = (yield this.database.requiredBootstrap()) as Awaited<
        ReturnType<typeof this.database.requiredBootstrap>
      >;

      if (context.bootstrapMode === 'none') {
        getContext().logger.info(
          '[BaseSyncedStore] Bootstrap skipped (bootstrapMode=none)',
          { kind: context.kind ?? 'user' },
        );
        // `setupWebSocketSync` above creates the SyncWebSocket and
        // initiates the upgrade, but it does NOT await the 'connected'
        // event — it returns synchronously after wiring listeners.
        // For bootstrapMode='none' consumers (agent-worker, headless
        // task runners), this branch is the entire body of initialize()
        // after the WS is set up, so `ready()` would otherwise resolve
        // while the WS is still in 'connecting' state. The very next
        // `commits.create` then throws "SyncWebSocket not connected".
        //
        // For bootstrapMode='full' consumers we don't need this await:
        // `executeBootstrapWithTimeout` below sends the bootstrap RPC
        // which inherently requires the WS to be open, so it surfaces
        // a connection error if the upgrade hasn't completed.
        //
        // 5s bound is generous (typical connect is <100ms); past that
        // we return anyway and let the next commit attempt fail loudly
        // rather than block initialize() forever.
        yield this.waitForWebSocketConnected(5000);
      } else if (requirements.type !== 'local') {
        if (hasLocalData) {
          // Background bootstrap — don't block UI
          this.performBackgroundBootstrap(requirements, context, signal);
        } else {
          // First load — must wait for server data
          yield this.executeBootstrapWithTimeout(
            async () => {
              await this.database.bootstrapFromServer(
                requirements,
                this.resolveSyncGroups(context),
              );
            },
            context,
            signal
          );
          yield this.syncClient.hydrateFromDatabase();
          this.dataReady = true;
          this.initialized = true;
        }
      }

      if (!this.initialized) this.initialized = true;
      if (!this.dataReady) {
        this.dataReady = true;
      }

      this.updateSyncStatus({ state: 'idle', progress: 100 });
      return { success: true };
    } catch (error) {
      const isAbort = error instanceof DOMException && error.name === 'AbortError';
      if (isAbort) {
        this.dataReady = false;
        this.initialized = false;
        this.updateSyncStatus({ state: 'idle', progress: 0 });
        return { success: false, error: error as Error };
      }

      const isSession = SyncSessionError.isSessionError(error);
      getContext().observability.captureBootstrapFailure(error, { type: 'initialize' });

      if (isSession) {
        this.syncWebSocket?.setSessionErrorDetected();
        this.syncWebSocket?.disconnect();
        this.updateSyncStatus({ state: 'error', error: error as Error });
        return { success: false, error: error as Error };
      }

      // Fallback: show local data if available
      if (this.objectPool.size === 0) {
        try {
          yield this.syncClient.hydrateFromDatabase();
        } catch {}
      }

      if (this.objectPool.size > 0) {
        this.dataReady = true;
        this.initialized = true;
        this.updateSyncStatus(
          this.syncWebSocket?.isConnected()
            ? { state: 'idle', progress: 100 }
            : { state: 'offline', offlineSince: new Date() }
        );
        return { success: true };
      }

      this.updateSyncStatus({ state: 'error', error: error as Error });
      return { success: false, error: error as Error };
    }
  }

  /** Background bootstrap — non-blocking, user sees cached data while this runs */
  protected async performBackgroundBootstrap(
    requirements: Awaited<ReturnType<typeof this.database.requiredBootstrap>>,
    context: UserContext,
    signal?: AbortSignal
  ): Promise<void> {
    await this.withDeltaQueuing(async () => {
      try {
        const preBootstrapIds = new Set(this.objectPool.getAllIds());
        const bootstrapResult = await this.database.bootstrapFromServer(
          requirements,
          this.resolveSyncGroups(context),
        );
        const deltaProtectedIds = this.collectDeltaProtectedIds(preBootstrapIds);
        this.applyBootstrapToPool(bootstrapResult, deltaProtectedIds);
        this.updateSyncStatus({ state: 'idle', progress: 100 });
      } catch (error) {
        getContext().logger.warn('[sync-engine] Background bootstrap failed', {
          error: error instanceof Error ? error.message : String(error),
          cause: error,
        });
        getContext().observability.captureBootstrapFailure(error, { type: 'background' });
        if (SyncSessionError.isSessionError(error)) {
          this.syncWebSocket?.setSessionErrorDetected();
          this.syncWebSocket?.disconnect();
          this.updateSyncStatus({ state: 'error', error: error as Error });
        } else if (!this.syncWebSocket?.isConnected()) {
          this.updateSyncStatus({ state: 'offline', offlineSince: new Date() });
        }
      }
    });
  }

  /** Run bootstrap with delta queuing to prevent race conditions */
  protected async withDeltaQueuing<T>(fn: () => Promise<T>): Promise<T> {
    this.activeBootstrapCount++;
    if (this.bootstrapDeltaQueue === null) this.bootstrapDeltaQueue = [];
    try {
      return await fn();
    } finally {
      this.activeBootstrapCount--;
      if (this.activeBootstrapCount === 0) this.replayQueuedDeltas();
    }
  }

  /** Collect IDs that must survive ghost removal (added by deltas during bootstrap) */
  protected collectDeltaProtectedIds(preBootstrapIds: ReadonlySet<string>): Set<string> {
    const protectedIds = new Set<string>();
    for (const id of this.objectPool.getAllIds()) {
      if (!preBootstrapIds.has(id)) protectedIds.add(id);
    }
    for (const delta of this.bootstrapDeltaQueue ?? []) {
      if (delta.actionType !== 'D' && delta.modelId) protectedIds.add(delta.modelId);
    }
    return protectedIds;
  }

  /** Replay deltas queued during bootstrap */
  protected replayQueuedDeltas(): void {
    const queue = this.bootstrapDeltaQueue;
    this.bootstrapDeltaQueue = null;
    if (!queue || queue.length === 0) return;
    // Deltas that landed during bootstrap are a complete frame — apply
    // them atomically (one flush, one re-render) rather than dribbling
    // each back through the live debounce path.
    this.applyDeltaFrame(queue);
  }

  /**
   * Factory for the internal `ConnectionManager`. Override to return
   * `null` in subclasses that own their own connection lifecycle
   * (tests, headless runners, custom FSM wrappers). Default builds a
   * manager scoped to `_syncServerUrl` with production backoff.
   *
   * **Agent participants get `null`.** The FSM is wired around browser
   * events (`visibilitychange`, `online`/`offline`, watchdog) which are
   * meaningful for human-facing tabs and meaningless for headless agent
   * processes. On agent hosts the FSM has no event source to drive
   * recovery — and worse, its `offline` entry action calls
   * `syncWebSocket.disconnect()` which sets `isManualClose=true` and
   * cancels the reconnect that `SyncWebSocket.onclose` had just
   * scheduled. The two recovery systems fight and the browser-only one
   * wins by destroying the Node-compatible one's work. Returning `null`
   * for agents leaves `SyncWebSocket`'s exponential-backoff
   * `scheduleReconnect()` as the sole recovery path — which is correct
   * for server-side agents whether they run on Node, Bun, Deno, or
   * inside a Docker container with no `window`.
   *
   * Why gate on `kind` and not `typeof window`: env detection by global
   * existence is fragile (SSR polyfills, jsdom, sandboxed hosts). The
   * participant kind is the actual semantic axis — "is this a human-
   * driven session" vs "is this a server agent". The latter never has
   * a tab to lose focus or a network adapter to wake up.
   */
  protected createConnectionManager(kind?: 'user' | 'agent' | 'system'): ConnectionManager | null {
    if (kind === 'agent') return null;
    return new ConnectionManager({
      baseUrl: this._syncServerUrl,
      getAuthToken: () => this.auth?.getAuthToken() ?? this.syncWebSocket?.getAuthToken() ?? null,
    });
  }

  /** Disconnect and clean up all resources */
  async disconnect(): Promise<void> {
    this.stopCredentialLifecycle();
    if (this.batchTimer) { clearTimeout(this.batchTimer); this.batchTimer = null; }
    this.pendingDeltas = [];

    for (const dispose of this.disposers) dispose();
    this.disposers = [];

    if (this.connectionManager) {
      this.connectionManager.dispose();
      this.connectionManager = null;
    }

    try {
      const last = this.syncWebSocket?.getLastSyncId?.() || 0;
      if (last > 0) await this.database.updateWorkspaceMetadata({ lastSyncId: last });
    } catch {}

    if (this.syncWebSocket) { this.syncWebSocket.disconnect(); this.syncWebSocket = null; }
    this.syncClient.disconnect();
    this.queryProcessor.clearCache();
    this.updateSyncStatus({ state: 'offline' });
  }

  /**
   * Destroy every IndexedDB database owned by the sync engine.
   *
   * First disconnects (releases WebSocket + timers + in-memory caches),
   * then walks `indexedDB.databases()` and deletes any database whose
   * name starts with `ablo_` or `ablo-`. This covers:
   *   - `ablo_<hash>` workspace data DBs
   *   - `ablo_databases` meta registry
   *   - `ablo-sync` offline mutation queue
   *
   * Use case: session expiry (previous-user data must not persist on
   * disk before the next sign-in races into a corrupted state) or
   * explicit user-initiated logout.
   *
   * Best-effort: swallows individual delete errors. Some browsers do
   * not support `indexedDB.databases()` — the method returns without
   * deleting in that case, same behavior as the pre-SDK app code.
   */
  async purge(): Promise<void> {
    try {
      await this.disconnect();
    } catch {}

    if (typeof indexedDB === 'undefined' || typeof indexedDB.databases !== 'function') {
      return;
    }

    try {
      const dbs = await indexedDB.databases();
      for (const db of dbs) {
        if (!db.name) continue;
        if (db.name.startsWith('ablo_') || db.name.startsWith('ablo-')) {
          try {
            indexedDB.deleteDatabase(db.name);
          } catch {}
        }
      }
    } catch {}
  }

  // ── WebSocket Setup ───────────────────────────────────────────────────────

  /**
   * Create WebSocket connection and wire all event handlers.
   * Handles: deltas, batches, presence, bootstrap_required, errors, reconnection.
   */
  /**
   * Block until the WebSocket reports a `connected` event, or until
   * `timeoutMs` elapses (returns false on timeout, true on connect).
   * Used by `initialize()` for `bootstrapMode: 'none'` consumers to
   * honor `ready()`'s "WS is connected when this resolves" contract
   * — `setupWebSocketSync` is fire-and-forget on the upgrade, and
   * without an explicit wait the next mutation can race the open.
   *
   * Resolves immediately if the WS is already connected (e.g., warm
   * reconnect after redeploy). Resolves false on timeout rather than
   * throwing so initialize() can complete and let the caller's first
   * mutation attempt surface a clearer error.
   */
  protected async waitForWebSocketConnected(timeoutMs: number): Promise<boolean> {
    const ws = this.syncWebSocket;
    if (!ws) return false;
    if (ws.isConnected()) return true;

    return new Promise<boolean>((resolve) => {
      let resolved = false;
      const unsubscribe = ws.subscribe('connected', () => {
        if (resolved) return;
        resolved = true;
        unsubscribe();
        clearTimeout(timer);
        resolve(true);
      });
      const timer = setTimeout(() => {
        if (resolved) return;
        resolved = true;
        unsubscribe();
        getContext().logger.warn(
          `[BaseSyncedStore] waitForWebSocketConnected timed out after ${timeoutMs}ms — initialize() will return but the next mutation may race the upgrade.`,
        );
        resolve(false);
      }, timeoutMs);
    });
  }

  protected setupWebSocketSync(context: UserContext, lastSyncId: number): void {
    if (!context.userId || !context.organizationId) {
      getContext().observability.breadcrumb(
        'Cannot setup WebSocket sync without user context',
        'sync.websocket',
        'warning'
      );
      return;
    }

    this.syncWebSocket = new SyncWebSocket<TCollaboration>({
      baseUrl: this._syncServerUrl,
      userId: context.userId,
      organizationId: context.organizationId,
      syncGroups: [...this.resolveSyncGroups(context)],
      lastSyncId,
      versions: this.versionVector,
      kind: context.kind,
      capabilityToken: context.capabilityToken,
      getAuthToken: this.auth?.getAuthToken,
      capabilities: {
        partialBootstrap: true,
        compressedDeltas: true,
        streamingBootstrap: true,
        batchedDeltas: true,
      },
    });

    // Area-of-interest manager — owns dynamic read-subscription over this
    // connection. baseGroups (the org/user scopes) are always subscribed;
    // enterScope/leaveScope move per-entity interest. Recreated with the
    // socket; torn down via the disposer pushed below.
    this.areaOfInterest = new AreaOfInterestManager({
      transport: this.syncWebSocket,
      baseGroups: this.resolveSyncGroups(context),
    });

    // Connection events → forward to connection lifecycle callback
    const onConnected = this.syncWebSocket.subscribe('connected', () => {
      this.syncClient.markConnected();
      this.onConnectionEvent?.('WS_CONNECTED');
      if (this.dataReady) {
        this.updateSyncStatus({ state: 'idle', offlineSince: undefined });
      } else {
        this.updateSyncStatus({ offlineSince: undefined });
      }
      // Re-assert read interest on every (re)connect. After a transient
      // reconnect the socket re-sends its URL groups, but interest may have
      // changed while offline; after a full reconnect the new socket's URL
      // carries only base groups. `resync` re-pushes the current desired set
      // so the server-side index matches what the user is actually viewing.
      void this.areaOfInterest?.resync();
    });

    const onDisconnected = this.syncWebSocket.subscribe('disconnected', () => {
      this.syncClient.disconnect();
      this.onConnectionEvent?.('WS_DISCONNECTED');
      this.updateSyncStatus({ state: 'offline', offlineSince: new Date() });
    });

    const onReconnecting = this.syncWebSocket.subscribe('reconnecting', ({ attempt, delay }) => {
      getContext().logger.info('[BaseSyncedStore] WebSocket reconnecting', { attempt, delay });
      this.updateSyncStatus({ state: 'reconnecting' });
    });

    // Delta events → feed into processing pipeline
    const onDelta = this.syncWebSocket.subscribe('delta', (delta: SyncDelta) => {
      this.processDeltaWithBatching(delta);
    });

    const onDeltaBatch = this.syncWebSocket.subscribe('delta_batch', (deltas: SyncDelta[]) => {
      // A catch-up/reconnect frame is already complete — apply it as ONE
      // atomic flush so the gallery re-renders once, not once per 50-delta
      // chunk. See `applyDeltaFrame`.
      this.applyDeltaFrame(deltas);
    });

    // Bootstrap events
    const onBootstrapRequired = this.syncWebSocket.subscribe(
      'bootstrap_required',
      (hint: BootstrapHint) => { this.handleBootstrapRequired(hint); }
    );

    const onBootstrapData = this.syncWebSocket.subscribe('bootstrap_data', (data) => {
      this.handleBootstrapData(data);
    });

    const onPresenceUpdate = this.syncWebSocket.subscribe('presence_update', (data) => {
      this.handlePresenceUpdate(data);
    });

    // Error events
    const onError = this.syncWebSocket.subscribe('error', (error: Error) => {
      if (error.message === 'Network is offline' || error.message === 'WebSocket connection failed') {
        this.updateSyncStatus({ state: 'offline', offlineSince: new Date() });
      } else {
        this.updateSyncStatus({ state: 'error', error });
      }
    });

    const onSessionError = this.syncWebSocket.subscribe('session_error', (error: Error) => {
      getContext().observability.captureWebSocketError({ context: 'session-error', error: error.message });
      this.onConnectionEvent?.('WS_SESSION_ERROR');
      for (const listener of this.sessionErrorListeners) {
        try { listener(error); } catch {}
      }
      this.updateSyncStatus({ state: 'error', error, isSessionError: true });

      // SECURITY: Clear IndexedDB data on session expiry.
      // When auth is revoked, locally cached data must not persist on disk.
      this.database.clear().catch((clearErr) => {
        getContext().logger.error('[BaseSyncedStore] Failed to clear database on session error', clearErr);
      });
      this.objectPool.clear();
    });

    // Handshake failed: WS close before open. The HTTP status is hidden
    // behind close code 1006, so we can't tell whether the server rejected
    // auth (401/403) or the connection never reached the server (DNS/TLS/LB).
    // Forward a dedicated event so the connection-lifecycle owner can run
    // an authenticated HTTP probe to disambiguate.
    const onHandshakeFailed = this.syncWebSocket.subscribe('handshake_failed', () => {
      this.onConnectionEvent?.('WS_HANDSHAKE_FAILED');
      this.updateSyncStatus({ state: 'offline', offlineSince: new Date() });
    });

    const onReconnectFailed = this.syncWebSocket.subscribe('reconnect_failed', ({ attempts }) => {
      getContext().logger.warn('[BaseSyncedStore] WebSocket reconnection gave up', { attempts });
      this.updateSyncStatus({ state: 'reconnecting' });
    });

    this.disposers.push(
      onConnected, onDisconnected, onReconnecting,
      onDelta, onDeltaBatch, onBootstrapRequired,
      onBootstrapData, onPresenceUpdate,
      onError, onSessionError, onHandshakeFailed, onReconnectFailed,
      () => { this.areaOfInterest?.dispose(); this.areaOfInterest = null; },
    );

    // ── Connection FSM ────────────────────────────────────────────
    // Instantiate + start the SDK's ConnectionManager so every
    // consumer gets correct online/offline recovery. Previously this
    // was an external concern (each app rebuilt its own FSM); now
    // it's default behavior. The `onConnectionEvent` hook stays as
    // the bridge — WS events fire the hook, the hook forwards into
    // the FSM.
    this.connectionManager = this.createConnectionManager(context.kind);
    if (this.connectionManager) {
      const manager = this.connectionManager;
      // Preserve any externally-set onConnectionEvent — chain rather
      // than overwrite, so subclasses that wire a secondary consumer
      // still receive events.
      const priorHook = this.onConnectionEvent;
      this.onConnectionEvent = (event: string) => {
        try { priorHook?.(event); } catch { /* don't let subclass crash the FSM */ }
        switch (event) {
          case 'WS_CONNECTED':
            manager.send({ type: 'WS_CONNECTED' });
            break;
          case 'WS_DISCONNECTED':
            manager.send({ type: 'WS_DISCONNECTED' });
            break;
          case 'WS_SESSION_ERROR':
            manager.send({ type: 'WS_SESSION_ERROR' });
            break;
          case 'WS_HANDSHAKE_FAILED':
            manager.send({ type: 'WS_HANDSHAKE_FAILED' });
            break;
        }
      };

      manager.start({
        onReconnect: () => this.performReconnect(),
        onRefreshCredential: () => this.performCredentialRefresh(),
        onSessionExpired: () => {
          const err = new SyncSessionError('Session expired');
          for (const listener of this.sessionErrorListeners) {
            try { listener(err); } catch {}
          }
        },
        onDisconnectWebSocket: () => {
          this.syncWebSocket?.disconnect();
        },
        // Mirror FSM transitions into the visible `syncStatus.state` so
        // the UI can show "Reconnecting…" while the FSM cycles through
        // probing / reconnecting / backoff. Previously these states
        // were opaque to the UI, leaving the sidebar pinned to
        // "offline" for the entire recovery window — exactly the
        // confusing UX the warning log was trying to surface.
        //
        // We only override `state` here; `error` / `progress` / etc.
        // continue to be set by the WebSocket subscription handlers
        // and bootstrap pipeline, which know more than the FSM does.
        onStateChange: (next) => {
          switch (next) {
            case 'connected':
              // Don't clobber an in-flight 'syncing' / 'idle' update
              // that the bootstrap pipeline might be midway through —
              // those handlers run their own `updateSyncStatus`. Only
              // promote out of an offline / reconnecting / error label.
              if (
                this.syncStatus.state === 'offline' ||
                this.syncStatus.state === 'reconnecting' ||
                this.syncStatus.state === 'error'
              ) {
                this.updateSyncStatus({ state: 'idle', offlineSince: undefined });
              }
              break;
            case 'probing_network':
            case 'refreshing_credential':
            case 'reconnecting':
            case 'backoff':
              // Active recovery — the UI should reflect that the FSM
              // is doing work, not that we've given up. (Re-minting a stale
              // access key is just another recovery step, surfaced the same
              // way; the user never sees a credential-level distinction.)
              if (this.syncStatus.state !== 'reconnecting') {
                this.updateSyncStatus({ state: 'reconnecting' });
              }
              break;
            case 'waiting_for_network':
            case 'offline':
              if (this.syncStatus.state !== 'offline') {
                this.updateSyncStatus({
                  state: 'offline',
                  offlineSince: this.syncStatus.offlineSince ?? new Date(),
                });
              }
              break;
            // 'session_expired' / 'validating_session' are handled by
            // the existing session-error / WS subscription paths.
          }
        },
      });
    }

    // Transaction events for pendingChanges tracking
    const unsubCreated = this.syncClient.onTransactionEvent('created', () => { this.incrementPendingChanges(); });
    const unsubCompleted = this.syncClient.onTransactionEvent('completed', () => { this.decrementPendingChanges(); });
    const unsubFailed = this.syncClient.onTransactionEvent('failed', () => { this.decrementPendingChanges(); });
    this.disposers.push(unsubCreated, unsubCompleted, unsubFailed);

    this.syncWebSocket.connect();
  }

  // ── Delta Processing Pipeline ─────────────────────────────────────────────

  /** State signature for delta deduplication */
  private extractStateSignature(delta: SyncDelta): Record<string, unknown> | null {
    if (!delta.data || typeof delta.data !== 'object') return null;

    const data = typeof delta.data === 'string'
      ? (JSON.parse(delta.data) as Record<string, unknown>)
      : (delta.data as Record<string, unknown>);

    // Generic state fields — subclasses can override getStateFields() for model-specific fields
    const fieldsToCheck = this.getStateFields(delta.modelName);
    const signature: Record<string, unknown> = {
      actionType: delta.actionType,
      modelName: delta.modelName,
    };

    for (const field of fieldsToCheck) {
      if (field in data) signature[field] = data[field];
    }

    return signature;
  }

  /** Get fields that represent meaningful state for deduplication. Override for model-specific fields. */
  protected getStateFields(_modelName: string): string[] {
    return ['status', 'state', 'isActive'];
  }

  private isSameState(a: Record<string, unknown> | null, b: Record<string, unknown> | null): boolean {
    if (!a || !b) return false;
    const keys = Object.keys(a);
    if (keys.length !== Object.keys(b).length) return false;
    return keys.every((k) => a[k] === b[k]);
  }

  /** Deduplicate deltas to the same entity — keep meaningful state transitions only */
  protected deduplicateDeltas(deltas: SyncDelta[]): SyncDelta[] {
    const byEntity = new Map<string, SyncDelta[]>();
    for (const d of deltas) {
      const key = `${d.modelName}:${d.modelId}`;
      if (!byEntity.has(key)) byEntity.set(key, []);
      byEntity.get(key)!.push(d);
    }

    const result: SyncDelta[] = [];
    for (const entityDeltas of byEntity.values()) {
      const sorted = entityDeltas.sort((a, b) => a.id - b.id);

      // DELETE wins — it's the final state
      const del = sorted.find((d) => d.actionType === 'D');
      if (del) { result.push(del); continue; }

      // Keep deltas that represent different states
      const unique: SyncDelta[] = [];
      let prev: Record<string, unknown> | null = null;
      for (const d of sorted) {
        const sig = this.extractStateSignature(d);
        if (!this.isSameState(prev, sig)) { unique.push(d); prev = sig; }
      }

      result.push(...(unique.length > 0 ? unique : [sorted[sorted.length - 1]]));
    }

    return result.sort((a, b) => a.id - b.id);
  }

  /** Process incoming delta with smart batching */
  protected processDeltaWithBatching(delta: SyncDelta): void {
    if (!this.enqueueDelta(delta)) return;
    this.scheduleDeltaFlush();
  }

  /**
   * Apply a complete, server-delivered delta frame atomically.
   *
   * A `delta_batch` WS event (reconnect/catch-up replay) already carries
   * the FULL set of missed deltas. Routing it through the per-delta
   * `processDeltaWithBatching` path re-chunks it via the live-traffic
   * debounce timer + `maxBatchSize` force-flush, so a 300-delta catch-up
   * fans out into ~6 separate `flushPendingDeltas` cycles — each its own
   * IDB write, pool mutation, `models:changed` emit, and React re-render.
   * The decks gallery visibly re-sorts and "pops in" once per chunk.
   *
   * Here we run the per-delta bookkeeping (dedup, ack, version vector,
   * watermark, G/S routing, D cascade) for every delta WITHOUT scheduling
   * a flush, then flush ONCE — collapsing the whole frame into a single
   * IDB write + pool mutation + `models:changed` + re-render. Same code
   * for the post-bootstrap replay of deltas queued during bootstrap.
   *
   * (Named `applyDeltaFrame`, not `processDeltaBatch`, to avoid confusion
   * with `Database.processDeltaBatch` — the lower-level IDB write this
   * eventually drives through `flushPendingDeltas`.)
   */
  protected applyDeltaFrame(deltas: SyncDelta[]): void {
    let enqueuedAny = false;
    for (const delta of deltas) {
      // A delta_batch frame is the server's AUTHORITATIVE, ordered answer to
      // "everything in my stream after cursor C" (reconnect/catch-up replay or
      // post-bootstrap drain). Apply every delta it carries — do NOT subject it
      // to the live-traffic watermark dedup (`id <= applied`).
      //
      // That watermark is only valid under in-order delivery, and reconnect
      // breaks the assumption: an in-flight LIVE broadcast for a gap delta can
      // land out of order BEFORE the catch-up fills the ids below it (e.g. the
      // server acks a write, then the test/client reconnects, then that write's
      // pending broadcast arrives on the fresh socket — id 4 live before the
      // catch-up's [2,3,4]). Applying id 4 advances `applied` to 4, and the
      // watermark would then drop 2 and 3 from the catch-up as "already seen" —
      // a poisoned gap and a cursor that lies (applied=4 with rows 2,3 absent).
      //
      // Re-applying a delta the live path already applied is safe: the
      // downstream `Database.processDeltaBatch` + `SyncClient.applyDeltaBatchToPool`
      // are idempotent (echo detection, no row resurrection, conflict
      // resolution), so the redundant id 4 is a no-op while 2 and 3 land.
      if (this.enqueueDelta(delta, { authoritative: true })) enqueuedAny = true;
    }
    if (!enqueuedAny) return;

    // Cancel any pending live-traffic timer — the frame is complete, so
    // there is nothing to wait for. Flush everything in one pass.
    if (this.batchTimer) { clearTimeout(this.batchTimer); this.batchTimer = null; }
    void this.flushPendingDeltas().catch(this.handleFlushError);
  }

  /**
   * Per-delta bookkeeping + enqueue. Returns `true` when the delta was
   * pushed onto `pendingDeltas` (a regular batchable I/U/C/D delta that a
   * subsequent flush must drain), `false` when it was skipped (dedup),
   * deferred (bootstrap queue), or handled immediately out-of-band (G/S
   * sync-group mutations). Does NOT schedule a flush — callers decide
   * whether to debounce (live) or flush atomically (catch-up frame).
   */
  protected enqueueDelta(
    delta: SyncDelta,
    options: { authoritative?: boolean } = {},
  ): boolean {
    // Dedup guard — skip already-processed deltas. The `applied` watermark is a
    // valid skip threshold ONLY for in-order live traffic; an authoritative
    // catch-up frame bypasses it (see `applyDeltaFrame`) so an out-of-order
    // live delta that advanced the watermark can't cause the frame's lower ids
    // to be silently dropped.
    if (!options.authoritative && delta.id > 0 && delta.id <= this.highestProcessedSyncId) {
      return false;
    }

    // Confirm awaiting transactions via sync ID threshold (before batching)
    this.syncClient.onDeltaReceived(delta.id);

    // Update version vector
    const entityType = delta.modelName.toLowerCase();
    if (this.versionVector[entityType] !== undefined) {
      this.versionVector[entityType] = Math.max(this.versionVector[entityType], delta.id);
    }

    // Queue during active bootstrap
    if (this.bootstrapDeltaQueue !== null) {
      this.bootstrapDeltaQueue.push(delta);
      return false;
    }

    // Advance watermark
    this.syncClient.position.advanceApplied(delta.id);

    // Sync group added — handle immediately. Supports both legacy
    // (addedGroups/removedGroups) and incremental (group/userId) payloads.
    if (delta.actionType === 'G') {
      void this.handleSyncGroupChange(delta);
      return false;
    }

    // Sync group removed — handle immediately. Clears affected local state
    // and forces re-bootstrap with the updated group list.
    if (delta.actionType === 'S') {
      void this.handleGroupRemoved(delta);
      return false;
    }

    // DELETE — fire the cascade cancel immediately (O(1) via FK index;
    // must run BEFORE any subsequent update on the same model lands so
    // pending update transactions for soon-deleted children don't race
    // their parent's delete) but route the IDB+pool write through the
    // same batched path as UPDATEs. The previous immediate-flush path
    // produced N IDB writes + N pool mutations + N `models:changed`
    // events when a peer deleted a chart with N layers; the batched
    // path produces one of each per microtask flush. Dedup in
    // `flushPendingDeltas` handles the U-then-D-on-same-model case
    // correctly via arrival-order replay through `processDeltaBatch`.
    if (delta.actionType === 'D') {
      this.cascadeCancelTransactionsForDeletedParent(delta.modelName, delta.modelId);
    }

    this.pendingDeltas.push(delta);
    return true;
  }

  /** Debounce a flush for live single-delta traffic. */
  protected scheduleDeltaFlush(): void {
    if (this.batchTimer) clearTimeout(this.batchTimer);

    if (this.pendingDeltas.length >= this.smartSyncOptions.maxBatchSize) {
      void this.flushPendingDeltas().catch(this.handleFlushError);
    } else {
      this.batchTimer = setTimeout(() => {
        void this.flushPendingDeltas().catch(this.handleFlushError);
      }, this.smartSyncOptions.batchingDelay);
    }
  }

  /**
   * Cancel pending transactions for child entities when a parent is deleted.
   *
   * Uses `pool.getByForeignKey` (O(1) via the FK index registered at
   * schema build time) to find children. The previous implementation did
   * `getByType(ctor).filter(e => e.toJSON()[foreignKey] === parentId)` —
   * a full pool scan per child model + a `toJSON()` allocation per
   * candidate. For a deck delete with 10K layers in the pool, that was
   * 10K toJSON allocations per cascade level. The FK-indexed lookup
   * skips both the scan AND the allocation.
   */
  protected cascadeCancelTransactionsForDeletedParent(parentModelName: string, parentId: string): void {
    const reg = this.objectPool.registry;
    const childModels = reg.getChildModels(parentModelName);
    if (childModels.length === 0) return;

    let totalCancelled = 0;

    for (const { childModel, foreignKey } of childModels) {
      const cancelled = this.syncClient.cancelTransactionsByForeignKey(childModel, foreignKey, parentId);
      totalCancelled += cancelled;

      // O(1) FK-index lookup — skips the prior `getByType().filter(toJSON)` scan.
      const children = this.objectPool.getByForeignKey(childModel, foreignKey, parentId);
      for (const child of children) {
        this.cascadeCancelTransactionsForDeletedParent(childModel, child.id);
      }
    }

    if (totalCancelled > 0) {
      getContext().logger.info('[BaseSyncedStore] Cascade cancelled orphaned transactions', {
        parentModel: parentModelName,
        parentId: parentId.slice(0, 12),
        totalCancelled,
      });
    }
  }

  /** Flush pending deltas with deduplication and batched ObjectPool mutations */
  /** Flush pending deltas with deduplication. Delegates pool writes to SyncClient. */
  protected async flushPendingDeltas(): Promise<void> {
    if (this.pendingDeltas.length === 0) return;

    const deduplicatedDeltas = this.deduplicateDeltas(this.pendingDeltas);

    // Custom entities → apply directly to ObjectPool (skip IDB)
    const customDeltas = deduplicatedDeltas.filter((d) => this.isCustomEntity(d.modelName));
    if (customDeltas.length > 0) {
      runInAction(() => {
        for (const delta of customDeltas) {
          const data = typeof delta.data === 'string'
            ? (JSON.parse(delta.data as string) as Record<string, unknown>)
            : (delta.data as Record<string, unknown>);

          // 'C' (Covering) is treated identically to 'I' here — the client
          // gained permission to see the entity, so we insert it into the
          // pool as if newly created.
          if (delta.actionType === 'I' || delta.actionType === 'U' || delta.actionType === 'C') {
            const existing = this.objectPool.get(delta.modelId);
            if (existing) {
              existing.updateFromData(data);
            } else {
              const model = this.createCustomEntity(delta.modelName, delta.modelId, data);
              if (model) { model.markAsPersisted(); this.objectPool.add(model, ModelScope.live); }
            }
          } else if (delta.actionType === 'D') {
            this.objectPool.remove(delta.modelId);
          }
        }
      });
    }

    // Regular deltas → IDB then ObjectPool via SyncClient.
    // 'G' and 'S' deltas are routed upstream (handleSyncGroupChange,
    // handleGroupRemoved) and never reach flushPendingDeltas, but the
    // Database.processDelta signature accepts them defensively.
    const regularDeltas = deduplicatedDeltas.filter((d) => !this.isCustomEntity(d.modelName));
    const batch = await this.database.processDeltaBatch(
      regularDeltas.map((d) => ({
        syncId: d.id,
        actionType: d.actionType,
        modelName: d.modelName,
        modelId: d.modelId,
        data: typeof d.data === 'string' ? JSON.parse(d.data as string) : d.data,
        // Thread `transactionId` through so the receive layer can
        // recognize echoes of locally-applied transactions and skip
        // the pool mutation. See `OPTIMISTIC_RECONCILIATION.md`.
        transactionId: d.transactionId,
      }))
    );
    const dbResults = batch.results;

    // Delegate ObjectPool writes to SyncClient (owns pool operations)
    this.syncClient.applyDeltaBatchToPool(dbResults, (name, data) => this.enrichRelations(name, data));

    // Acknowledge + advance sync cursor — gated on IDB persistence.
    //
    // We MUST ack `persistedSyncId` (the high-water mark of deltas whose
    // store transaction actually committed), NOT the input batch's last
    // delta id. Acking by input range advances the server's view past
    // deltas that never wrote to IDB; the next catch-up request would
    // then send the advanced cursor and the server replies "you're up
    // to date" — losing the un-persisted delta forever. This is the
    // Replicache "same-transaction" invariant: the cursor and the
    // persisted view must be consistent.
    const persistedSyncId = batch.persistedSyncId;
    if (persistedSyncId > this.lastAckedId) {
      this.syncWebSocket?.acknowledge?.(persistedSyncId);
      this.syncClient.position.advancePersisted(persistedSyncId);
    }

    // Cache invalidation is automatic via SyncClient 'models:changed' event

    this.pendingDeltas = [];
    if (this.batchTimer) { clearTimeout(this.batchTimer); this.batchTimer = null; }
  }

  // ── Core Mutations (thin delegation to SyncClient) ────────────────────────
  //
  // BaseSyncedStore is an orchestrator, not an implementor.
  // SyncClient owns: ObjectPool operations, TransactionQueue, IDB writes.
  // BaseSyncedStore owns: validation, hooks, pending delete tracking.

  /** Check if a model type is local-only (no sync). Override for domain-specific models. */
  protected isLocalOnlyModel(_modelName: string): boolean {
    return false;
  }

  /** Validate model against schema before save */
  protected validateModel(model: Model): void {
    const modelName = model.getModelName();
    const properties = this.modelRegistry.getPropertiesForModel(modelName);
    const modelData = model.toJSON() as Record<string, unknown>;

    for (const [propName, metadata] of properties) {
      if (metadata.type === PropertyType.referenceModel) continue;
      if (metadata.type === PropertyType.ephemeralProperty) continue;

      if (!metadata.optional && (modelData[propName] === null || modelData[propName] === undefined)) {
        throw new AbloValidationError(
          `Required field ${propName} is missing on ${modelName}`,
          { code: 'model_required_field_missing' },
        );
      }
    }
  }

  /**
   * Save a model (create or update).
   *
   * Accepts any entity shape with `{ id: string }` so consumers can pass the
   * Zod-inferred model types from `InferModel<Schema, K>` without knowing
   * about the internal `Model` base class. At runtime, every entity reaching
   * this method came through the object pool (via `store.create`, a query
   * accessor, or an optimistic insert) and IS a `Model` instance — the one
   * cast below preserves that invariant inside the SDK.
   */
  async save<T extends { id: string; createdAt?: Date; updatedAt?: Date }>(
    entity: T,
    options?: { skipValidation?: boolean }
  ): Promise<void> {
    const model = rowAsModel(entity);
    this.beforeSave(model);
    if (!options?.skipValidation) this.validateModel(model);

    if (!model.createdAt) model.createdAt = new Date();

    // SyncClient.add/update handles: optimistic pool add, transaction queue, IDB write
    const isCreate = !this.objectPool.get(model.id);
    if (isCreate) {
      model.updatedAt = new Date();
      this.syncClient.add(model);
    } else {
      this.syncClient.update(model);
    }
  }

  /** Save with an atomic server mutation (e.g., createSlideWithLayers) */
  async saveWithAtomicMutation(
    model: Model,
    mutation: (gql: unknown) => Promise<unknown>
  ): Promise<void> {
    this.objectPool.add(model, ModelScope.live);
    await mutation(this.syncClient.gql);
  }

  /** Delete a model. Accepts schema-inferred entity shapes (see `save`). */
  async delete<T extends { id: string }>(entity: T): Promise<void> {
    const model = rowAsModel(entity);
    this.pendingDeletes.add(model.id);
    // SyncClient.delete handles: pool remove, transaction queue
    this.syncClient.delete(model);
  }

  /** Archive a model. Accepts schema-inferred entity shapes (see `save`). */
  async archive<T extends { id: string; archivedAt?: Date | null }>(entity: T): Promise<void> {
    const model = rowAsModel(entity);
    model.archivedAt = new Date();
    this.syncClient.archive(model);
  }

  /** Unarchive a model. Accepts schema-inferred entity shapes (see `save`). */
  async unarchive<T extends { id: string; archivedAt?: Date | null }>(entity: T): Promise<void> {
    const model = rowAsModel(entity);
    model.archivedAt = null;
    this.syncClient.update(model);
  }


  // ── Query API ────────────────────────────────────────────────────────────
  // `store.query.<model>.*` was DELETED — `ablo.<model>.get/getAll` is the
  // one read surface. Custom mutators still read transactionally through
  // `tx.<model>` (mutators/Transaction.ts), which owns `createReaderActions`.

  /** Retrieve a single entity by id. Synchronous pool read. */
  retrieve(_modelClass: ModelConstructor<Model>, id: string): Model | undefined {
    return this.objectPool.get(id);
  }

  /** Find any entity by ID regardless of type */
  findAnyById(id: string): Model | undefined {
    return this.objectPool.get(id);
  }

  /**
   * Lookup a model by ID alone. Matches the `SyncStoreRef.getById` contract
   * that schema-defined computeds use when they need to resolve a related
   * entity without holding onto its constructor.
   */
  getById(id: string): Model | undefined {
    return this.objectPool.get(id);
  }

  /**
   * Create a model instance locally, typed via the schema.
   *
   * ```ts
   * const sheet = store.create('spreadsheetSheets', { name, spreadsheetId });
   * // sheet: SpreadsheetSheet | null — no cast needed
   * ```
   *
   * The `typename` arg is the schema key (camelCase plural, e.g.
   * `'spreadsheetSheets'`); the returned instance has the
   * `InferModel<Schema, K>` shape including computeds + relation accessors.
   * Wraps `pool.create(...)` — the underlying runtime is unchanged, just
   * type-narrowed.
   */
  create<K extends keyof TSchema['models'] & string>(
    typename: K,
    data: Record<string, unknown>,
  ): import('./schema/schema.js').InferModel<TSchema, K> | null {
    if (!this.schema) {
      throw new AbloValidationError(
        'store.create requires a schema to be passed to the BaseSyncedStore constructor.',
        { code: 'store_create_schema_missing' },
      );
    }
    const modelDef = this.schema.models[typename];
    const wireTypename =
      (modelDef as { typename?: string } | undefined)?.typename ?? typename;
    // Same boundary-cast idiom used by `createReaderActions.findById` — the
    // runtime instance IS the schema-typed shape (the dynamic class was
    // built from the same Zod shape), TypeScript just can't unify the SDK's
    // static `Model` class with the schema's object-literal type.
    return this.objectPool.create(wireTypename, data) as
      | import('./schema/schema.js').InferModel<TSchema, K>
      | null;
  }

  /**
   * Legacy class-based query entry point — kept for callers that still pass
   * a Model constructor + options object. New code should use the typed
   * `store.query.<modelKey>` namespace instead, which returns properly
   * inferred schema types without needing a class value or cast.
   */
  queryByClass(
    modelClass: ModelConstructor<Model>,
    options?: {
      predicate?: (model: Model) => boolean;
      state?: ModelScope;
      orderBy?: keyof Model;
      order?: 'asc' | 'desc';
      limit?: number;
      offset?: number;
    }
  ): QueryResult<Model> {
    const modelName = this.objectPool.registry.getModelNameFromConstructor(modelClass);
    if (!modelName) return { data: [], total: 0, hasMore: false };

    let allModels = this.objectPool.getByType(modelClass, options?.state ?? ModelScope.live);

    // Filter out pending deletes
    allModels = allModels.filter((m) => !this.pendingDeletes.has(m.id));

    // Apply predicate
    if (options?.predicate) {
      allModels = allModels.filter(options.predicate);
    }

    const total = allModels.length;

    // Apply ordering
    if (options?.orderBy) {
      const field = options.orderBy as string;
      const dir = options.order === 'desc' ? -1 : 1;
      allModels.sort((a, b) => {
        const av = a.getField(field);
        const bv = b.getField(field);
        if (av == null || bv == null) return 0;
        return av < bv ? -dir : av > bv ? dir : 0;
      });
    }

    // Apply pagination
    if (options?.offset) allModels = allModels.slice(options.offset);
    const hasMore = options?.limit ? allModels.length > options.limit : false;
    if (options?.limit) allModels = allModels.slice(0, options.limit);

    return { data: allModels, total, hasMore };
  }

  /**
   * Get all models of a type. Returns Model[] honestly — callers that need
   * narrow types should use `useAblo((ablo) => ablo.<model>.list(...))`
   * which does proper inference via `InferModel<S, K>`.
   */
  allModelsOfType(modelClass: ModelConstructor<Model>, scope?: ModelScope): Model[] {
    return this.objectPool.getByType(modelClass, scope ?? ModelScope.live);
  }

  /** Error handler for fire-and-forget flushPendingDeltas calls */
  protected handleFlushError = (error: unknown): void => {
    getContext().observability.captureTransactionFailure({
      context: 'flush-pending-deltas',
      modelName: 'batch',
      modelId: 'batch',
      error: error instanceof Error ? error : new Error(String(error)),
    });
    getContext().logger.error('[BaseSyncedStore] Delta flush error', {
      error: error instanceof Error ? error.message : String(error),
    });
  };

  /** Process a single delta (used for immediate DELETE processing). Override for domain-specific handling. */
  protected async processDelta(delta: SyncDelta): Promise<void> {
    const dbResult = await this.database.processDelta({
      syncId: delta.id,
      actionType: delta.actionType,
      modelName: delta.modelName,
      modelId: delta.modelId,
      data: typeof delta.data === 'string' ? JSON.parse(delta.data as string) : delta.data,
    });

    if (!dbResult) return;

    // Track pending deletes for query filtering
    if (dbResult.action === 'remove') {
      this.pendingDeletes.add(dbResult.modelId);
    }

    // Delegate pool writes to SyncClient (auto-invalidates cache via 'models:changed' event)
    this.syncClient.applyDeltaBatchToPool(
      [dbResult],
      (name, data) => this.enrichRelations(name, data),
    );

    // This path runs after the delta was written to IDB — advance both
    // cursors through the shared position.
    this.syncClient.position.advancePersisted(delta.id);
  }

  /** Handle bootstrap_required event */
  protected handleBootstrapRequired(_hint: BootstrapHint): void {
    // Subclass implements — triggers background bootstrap
  }

  /** Handle bootstrap_data event. Override in subclass. */
  protected handleBootstrapData(_data: BootstrapDataEvent): void {
    this.updateSyncStatus({ state: 'syncing' });
  }

  /** Handle presence_update event. Override in subclass. */
  protected handlePresenceUpdate(_data: PresenceUpdateEvent): void {}

  // ── Pending changes tracking ─────────────────────────────────────────────

  protected incrementPendingChanges(): void {
    runInAction(() => { this.syncStatus.pendingChanges++; });
  }

  protected decrementPendingChanges(): void {
    runInAction(() => {
      if (this.syncStatus.pendingChanges > 0) this.syncStatus.pendingChanges--;
    });
  }

  // ── Status helpers ───────────────────────────────────────────────────────

  protected updateSyncStatus(updates: Partial<SyncStatus>): void {
    runInAction(() => {
      Object.assign(this.syncStatus, updates);
    });
  }

  // ── Accessors ─────────────────────────────────────────────────────────────

  get pool(): ObjectPool {
    return this.objectPool;
  }

  get lastSyncId(): number {
    return this.lastAckedId;
  }

  // ── Status convenience getters ──────────────────────────────────────────
  // Thin wrappers over syncStatus for consumer ergonomics. Previously on
  // SyncedStore; moved here so createSyncEngine consumers get them too.

  get isReady(): boolean {
    // Ready if: fully synced (idle + 100%) OR local data loaded (dataReady + syncing in background)
    return (this.syncStatus.state === 'idle' && this.syncStatus.progress >= 100)
      || (this.dataReady && this.syncStatus.state === 'syncing');
  }

  get isSyncing(): boolean {
    return this.syncStatus.state === 'syncing';
  }

  get isOffline(): boolean {
    return this.syncStatus.state === 'offline';
  }

  get isReconnecting(): boolean {
    return this.syncStatus.state === 'reconnecting';
  }

  get isError(): boolean {
    return this.syncStatus.state === 'error';
  }

  get hasUnsyncedChanges(): boolean {
    return this.syncStatus.pendingChanges > 0;
  }

  /** The SyncWebSocket handle — for collaboration events. */
  get ws(): SyncWebSocket<TCollaboration> | null {
    return this.syncWebSocket;
  }

  /** The Database instance — for demand loaders and direct IDB operations. */
  get db(): Database {
    return this.database;
  }

  /** The SyncClient instance — for assignment operations and other direct sync actions. */
  get sc(): SyncClient {
    return this.syncClient;
  }

  /** The current organization ID — from the last initialize() call. */
  get orgId(): string | undefined {
    return this.userContext?.organizationId;
  }

  /** Count models matching a predicate. */
  count(modelClass: ModelConstructor<Model>, predicate?: (m: Model) => boolean): number {
    const all = this.allModelsOfType(modelClass);
    return predicate ? all.filter(predicate).length : all.length;
  }

  /** Get entities by foreign key (used by Model subclasses via Model.store) */
  getByForeignKey(modelName: string, foreignKey: string, id: string): Model[] {
    return this.objectPool.getByForeignKey(modelName, foreignKey, id);
  }
}
