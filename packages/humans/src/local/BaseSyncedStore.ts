/**
 * The base class that application-specific sync stores extend. It supplies the
 * shared orchestration for reads, writes, delta processing, and bootstrap, and
 * exports the core types those stores build on.
 *
 * A subclass adds its own domain behavior — lazy-loaded relations,
 * collaboration events, and model enrichment — by overriding the protected
 * extension points defined here. The heavy lifting is delegated to injected
 * collaborators: {@link SyncClient} owns pool writes and the transaction
 * queue, {@link Database} owns local persistence, {@link InstanceCache} holds the
 * in-memory models, and {@link ModelRegistry} holds their metadata.
 */

import { makeObservable, observable, action, computed, runInAction } from 'mobx';
import { AbloConnectionError, AbloValidationError, toAbloError } from '@abloatai/transaction/errors';
import type { RecoveryClass } from '@abloatai/transaction/errorCodes';
import { ConnectionManager } from './sync/ConnectionManager.js';
import { contextLogger, contextSocketObservability } from './sync/contextPorts.js';
import { SubscriptionManager } from './sync/SubscriptionManager.js';
import {
  resolveParticipantSyncGroups,
  type ParticipantScope,
} from './sync/participants.js';
import type { SyncClient } from './SyncClient.js';
import type { Database, BootstrapResult, BootstrapRequirements } from './Database.js';
import type { BootstrapData } from './sync/BootstrapFetcher.js';
import type { InstanceCache } from './InstanceCache.js';
import { ModelRegistry } from './ModelRegistry.js';
import { PropertyType } from '@abloatai/transaction/types';
import {
  SyncWebSocket,
  type SyncDelta,
  type SyncGroupChangePayload,
  type GroupAddedPayload,
  type GroupRemovedPayload,
  type BootstrapHint,
  type BootstrapDataEvent,
  type PresenceUpdate,
  type EventMap,
  type DefaultCollaborationEvents,
  type SyncWebSocketEventMap,
} from './sync/SyncWebSocket.js';
import { QueryProcessor } from './query/QueryProcessor.js';
import { Model, rowAsModel } from './Model.js';
import { globalRuntime } from './context.js';
import type { RuntimeContext } from './RuntimeContext.js';
import type { AbloPlugin, AppliedChange } from '../plugin.js';
import { AbloSessionError, isAccessCredentialExpiryCloseReason } from '@abloatai/transaction/errors';
import { ModelScope } from './InstanceCache.js';
import { LazyReferenceCollection } from './LazyReferenceCollection.js';
import type { Schema } from '@abloatai/transaction/schema/schema';
// The store contract types (SyncStoreContract, LocalMutation, SyncStatus)
// live in a React-free core module and are re-exported for React consumers.
import type { SyncStatus, SyncStoreContract, LocalMutation } from './storeContract.js';
import type { AuthCredentialSource } from '@abloatai/transaction/auth/credentialSource';
import type { ModelData } from '@abloatai/transaction/types/modelData';
import { deriveSyncPlanFromSchema } from './sync/syncPlan.js';
import type { EnrichmentPlanEntry, ForeignKeyIndexSpec } from './sync/syncPlan.js';
import { CredentialLifecycle, type CredentialRefresher } from './sync/credentialLifecycle.js';
import { TerminalSessionLifecycle } from './sync/terminalSessionLifecycle.js';
import { wireSocketEvents } from './sync/socketEventWiring.js';
import { performReconnect as runReconnect } from './sync/reconnect.js';
import { initialize as runInitialize } from './sync/initialize.js';
import {
  createConnectionManager as runCreateConnectionManager,
  startConnectionManager as runStartConnectionManager,
  waitForWebSocketConnected as runWaitForWebSocketConnected,
} from './sync/connectionManagerLifecycle.js';
import * as groupChange from './sync/groupChange.js';
import type { GroupChangeContext } from './sync/groupChange.js';
import * as bootstrapApply from './sync/bootstrapApply.js';
import type { PoolContext, RehydrationStats } from './sync/bootstrapApply.js';
import * as deltaPipeline from './sync/deltaPipeline.js';
import type { DeltaPipelineContext } from './sync/deltaPipeline.js';
import type { ParticipantKind } from '@abloatai/transaction/types/participant';
import type { DeliveryPartitionRoute } from '@abloatai/transaction/auth/deliveryPartition';
import { queryByClass as runQueryByClass, countModels } from './store/queryApi.js';
import type { QueuedMutation } from './transactions/mutations/MutationQueue.js';
import type { CommitLatencySample } from './transactions/mutations/commitLatency.js';

// ── Exported types ──────────────────────────────────────────────────────────

/** Constructor type for Model subclasses (accepts abstract classes) */
export type ModelConstructor<T extends Model> = abstract new (...args: never[]) => T;

/** Concrete constructor type for instantiation */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Constructor args vary per model (PrismaTask, Record<string, unknown>, etc.)
export type ConcreteModelConstructor<T extends Model> = new (data?: any) => T;

// ModelData is defined in a separate module to break the type cycle between
// BaseSyncedStore and SyncClient, and is re-exported here.
export type { ModelData } from '@abloatai/transaction/types/modelData';

/** Query result interface */
export interface QueryResult<T extends Model> {
  data: T[];
  total: number;
  hasMore: boolean;
  fromCache?: boolean;
}
// ForeignKeyIndexSpec and EnrichmentPlanEntry are defined alongside
// deriveSyncPlanFromSchema and re-exported here.
export type { ForeignKeyIndexSpec, EnrichmentPlanEntry } from './sync/syncPlan.js';

/** Configuration for SyncedStore behavior */
export interface SyncedStoreConfig {
  enableOffline?: boolean;
  enableCache?: boolean;
  enableTelemetry?: boolean;

  /**
   * Wire message types to surface as collaboration events, e.g.
   * `['document:selection', 'document:cursor']`.
   *
   * The vocabulary belongs to the application, not the SDK — these name the
   * application's own concepts, and a schema with no documents should never see
   * them. Defaults to none, so an application opts in by naming the events it
   * actually broadcasts.
   */
  collaborationEvents?: readonly string[];

  /**
   * Declarative enrichment plan consumed by `enrichRelations`. Replaces
   * the subclass override of `enrichRelations` for per-model parent
   * attachment. Merged with schema-derived entries (relations marked
   * `{ enrich: true }` on `belongsTo`).
   */
  enrichmentPlan?: readonly EnrichmentPlanEntry[];

  /**
   * Foreign-key indexes to register on the InstanceCache at construction
   * time. Replaces the subclass override of `registerForeignKeys` for
   * per-model FK registration. Merged with schema-derived entries
   * (relations marked `{ index: true }` on `belongsTo`). Both sets
   * are registered before the legacy `registerForeignKeys()` hook
   * fires, so subclasses can still add more on top.
   */
  foreignKeyIndexes?: readonly ForeignKeyIndexSpec[];
}
// SyncStatus is defined in the React-free store-contract module, next to
// SyncStoreContract which embeds it, and is re-exported here.
export type { SyncStatus } from './storeContract.js';

/** User context for initialization */
export interface UserContext {
  userId: string;
  organizationId: string;
  /** Authenticated data-plane coordinates used to isolate local persistence. */
  projectId?: string | null;
  /** Immutable branch target. Authoritative whenever present. */
  branchId: string;
  /** True only when branchId is the project's production root. */
  branchRoot?: boolean;
  /** Server-resolved WebSocket gateway route; never an authorization claim. */
  deliveryPartition?: DeliveryPartitionRoute | null;
  role?: string;
  teamIds?: string[];
  /** Participant kind on the wire. Default 'user' for browser
   *  sessions; 'agent' for headless bots / worker processes. The
   *  store routes this to SyncWebSocket so the WS URL carries
   *  `kind=agent` and the server applies capability-token auth. */
  kind?: ParticipantKind;
  /** Restricted (`rk_`) API key for `kind: 'agent'` — the agent's
   *  bearer credential. Sent in the `ablo.bearer.<token>` WebSocket
   *  subprotocol, never in the URL. */
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
   *    Reads go through `model.get()` / filtered subscriptions
   *    backfilled by `Covering` deltas. Suitable for transactional
   *    participants — headless workers, video pipelines, routine runners —
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
  /**
   * Upper bound on deltas revealed per apply slice. A large flush batch is
   * split at TRANSACTION boundaries into slices of at most this many deltas,
   * with the event loop yielded between slices, so a catch-up wave never
   * holds the thread for one long synchronous apply. A transaction larger
   * than the bound still applies whole — the commit stays the atomic unit of
   * visibility. `Infinity` restores single-slice behavior.
   */
  applySliceDeltas?: number;
}

// RehydrationStats is defined alongside the bootstrap-apply path and is
// re-exported here.
export type { RehydrationStats } from './sync/bootstrapApply.js';

/** Bench-diagnostic slice-bound override; absent everywhere but the bench. */
function benchApplySliceOverride(): number | undefined {
  const host = globalThis as { process?: { env?: Record<string, string | undefined> } };
  const raw = host.process?.env?.ABLO_APPLY_SLICE_DELTAS;
  if (!raw) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * Bootstrap retry configuration.
 *
 * There is deliberately no overall timeout here. How long one attempt may run
 * is not a policy this layer gets to invent — it is a property of the fetcher's
 * watchdogs, read from `BootstrapFetcher.budgetMs`. A second number kept here
 * would only be able to disagree with them, which is exactly what it used to do.
 */
export const BOOTSTRAP_CONFIG = {
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
  BootstrapHint,
  BootstrapDataEvent,
  PresenceUpdate,
};

// deriveSyncPlanFromSchema derives a sync plan from a schema and is
// re-exported here.
export { deriveSyncPlanFromSchema } from './sync/syncPlan.js';

// ── Base class ──────────────────────────────────────────────────────────────

/**
 * The abstract base class that application-specific sync stores extend. It
 * carries the injected collaborators, the observable sync status, and the
 * orchestration for initialization, delta processing, bootstrap, and the
 * read and write API. A subclass supplies its own domain behavior by
 * overriding the protected extension points defined here and by typing its
 * collaboration events through the generic parameter.
 *
 * A subclass must call `super(dependencies, config)` and then set up its own
 * MobX observables.
 *
 * Generic over `TCollaboration` — an app-defined event map for real-time
 * collaboration events (cursors, selections, presence beyond the core set).
 * Subclasses pass their own event map to get typed `subscribe()` calls on
 * the underlying SyncWebSocket without casts:
 *
 * @example
 *   interface EditorEvents {
 *     'document:selection': [SelectionEvent];
 *     'document:cursor':    [CursorEvent];
 *   }
 *   class EditorStore extends BaseSyncedStore<EditorEvents> {
 *     subscribeToCursor(handler: (e: CursorEvent) => void) {
 *       return this.syncWebSocket.subscribe('document:cursor', handler);
 *     }
 *   }
 */
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
  // callers that don't know their schema continue to compile; app
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
  /** The owning client's runtime; the module-global bridge when constructed directly. */
  protected readonly runtime: RuntimeContext;
  /** The installed plugins the delta pipeline dispatches stage handlers to. */
  protected readonly stagePlugins: readonly AbloPlugin[];
  protected readonly syncClient: SyncClient;
  protected readonly database: Database;
  protected readonly objectPool: InstanceCache;
  protected readonly modelRegistry: ModelRegistry;
  protected readonly auth?: AuthCredentialSource;
  /**
   * Schema the store was constructed with. Used by the schema-typed
   * `create(key, data)` factory and model self-healing.
   */
  protected readonly schema?: TSchema;


  // ── Real-time sync ──
  /**
   * The connection, owned by whoever built this store (ADR 0016 follow-up
   * 3b): the host constructs it and hands it in, the store seeds its late
   * values during `initialize()` and owns the lifecycle from there. One
   * instance for the store's whole lifetime — reconnects replace the socket
   * inside it, never the object.
   */
  protected readonly syncWebSocket: SyncWebSocket<TCollaboration>;
  /**
   * Dynamic read interest (area-of-interest) over the connection's sync
   * groups. Constructed with the connection; the permanent base scopes are
   * seeded in `setupWebSocketSync` once identity resolves.
   */
  protected readonly areaOfInterest: SubscriptionManager;
  /** Sync groups whose current state has been backfilled into the pool
   *  (hydrate-on-enter). Cleared when the pool is reset on (re)bootstrap. */
  private readonly hydratedGroups = new Set<string>();
  /** In-flight scoped hydrations, keyed by group — single-flights concurrent
   *  enters of the same scope so they share one fetch. */
  private readonly hydratingGroups = new Map<string, Promise<void>>();
  private _syncServerUrl?: string;
  /** Application-declared collaboration event types; empty unless configured. */
  private _collaborationEvents: readonly string[] = [];

  /**
   * Public accessor for the underlying SyncWebSocket. Used by the
   * factory in `createSyncEngine` to wire the default mutation
   * executor — the executor needs the WS handle to send commit
   * frames, and the factory can't reach `protected` state through
   * normal typing.
   */
  getSyncWebSocket(): SyncWebSocket<TCollaboration> {
    return this.syncWebSocket;
  }

  /**
   * Subscribe to pushed frames — deltas, presence updates, claim grants and
   * losses, connection changes, and this store's collaboration events.
   * Durable by construction: the connection object exists for the store's
   * whole lifetime (reconnects replace only the socket inside it), so a
   * subscription made before the first connect starts delivering when the
   * socket opens and keeps delivering across every reconnect. Returns the
   * unsubscribe function.
   */
  subscribe<K extends keyof SyncWebSocketEventMap<TCollaboration>>(
    event: K,
    handler: (...args: SyncWebSocketEventMap<TCollaboration>[K]) => void,
  ): () => void {
    return this.syncWebSocket.subscribe(event, handler);
  }

  /**
   * Send a collaboration event (an app-specific real-time message from this
   * store's `TCollaboration` map). A no-op while the connection is down —
   * presence-grade traffic is not queued.
   */
  sendCollaborationEvent<K extends string & keyof TCollaboration>(
    messageType: K,
    payload: TCollaboration[K] extends [infer P]
      ? Omit<P & Record<string, unknown>, 'timestamp'>
      : never,
  ): void {
    this.syncWebSocket.sendCollaborationEvent(messageType, payload);
  }

  // ── Area-of-interest (dynamic read subscription) ─────────────────
  //
  // `enterScope`/`leaveScope` move the connection's read interest as the
  // user navigates (open or close a record); `pinScope`/`unpinScope`
  // express prominence (an active claim keeps a group subscribed). All four
  // resolve the scope to sync-group strings through the same resolver the
  // claim path uses (`resolveParticipantSyncGroups`), so read interest and
  // write claims always agree on the string for a given entity. Before the
  // connection opens they record interest without a wire send, and they
  // never reject when the transport is offline (see
  // {@link SubscriptionManager.reconcile}); the on-connect `resync` pushes
  // whatever interest accumulated.

  private scopeToGroups(scope: ParticipantScope): string[] {
    return resolveParticipantSyncGroups(scope, this.schema);
  }

  /**
   * Bring a scope into view and subscribe to its sync groups. With
   * `{ hydrate: true }`, also backfill the groups' current state into the pool
   * once the subscription is active. The order matters: subscribing first
   * guarantees no live delta is missed in the gap before the snapshot lands.
   * Hydration is best-effort — a failed backfill never rejects `enterScope`,
   * and the live delta stream keeps flowing regardless.
   */
  enterScope(scope: ParticipantScope, opts?: { hydrate?: boolean }): Promise<void> {
    const groups = this.scopeToGroups(scope);
    const subscribed = Promise.all(groups.map((g) => this.areaOfInterest.enter(g))).then(
      () => undefined,
    );
    if (!opts?.hydrate) return subscribed;
    return subscribed.then(() => this.hydrateGroups(groups));
  }

  /**
   * Backfill the current state of `syncGroups` into the pool with a side-effect-free
   * scoped snapshot fetch followed by the version-guarded scoped apply. The call
   * is idempotent (it skips groups already hydrated) and single-flight (concurrent
   * enters of the same group share one fetch). On error the groups are left
   * unmarked, so a later re-enter retries.
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
        this.runtime.logger.debug('[BaseSyncedStore] scoped hydrate failed', {
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
    return Promise.all(
      this.scopeToGroups(scope).map((g) => this.areaOfInterest.leave(g)),
    ).then(() => undefined);
  }

  /** Pin a scope (active claim / prominence) → never warms while pinned. */
  pinScope(scope: ParticipantScope): Promise<void> {
    return Promise.all(
      this.scopeToGroups(scope).map((g) => this.areaOfInterest.pin(g)),
    ).then(() => undefined);
  }

  /** Release a pin → the group transitions to warm rather than dropping. */
  unpinScope(scope: ParticipantScope): Promise<void> {
    return Promise.all(
      this.scopeToGroups(scope).map((g) => this.areaOfInterest.unpin(g)),
    ).then(() => undefined);
  }

  // ── Internal helpers ──
  protected readonly queryProcessor: QueryProcessor;
  /**
   * Runtime behavior flags only — the schema/config arrays
   * (`enrichmentPlan`, `foreignKeyIndexes`) are consumed at construction
   * time and stored on the instance as `enrichmentPlan` and
   * pool-registered indexes. They don't need to persist on `this.config`.
   */
  protected readonly config: Required<
    Pick<SyncedStoreConfig, 'enableOffline' | 'enableCache' | 'enableTelemetry'>
  >;
  protected disposers: (() => void)[] = [];
  protected initialized = false;
  protected dataReady = false;

  // ── User context ──
  // The identity the consumer supplied to `initialize()`: user id,
  // organization id, and optional team ids. Reads are scoped to this
  // identity, and the sync-group subscription is derived from it.
  protected userContext: UserContext | null = null;

  // ── Smart sync ──
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
  /** Resume/ack cursor — delegates to the shared LogPosition (see
   *  logPosition.ts). Advances only after IDB persistence. */
  protected get lastAckedId(): number {
    return this.syncClient.position.persisted;
  }
  /** Pool-applied cursor — delegates to the shared LogPosition. */
  protected get highestProcessedSyncId(): number {
    return this.syncClient.position.applied;
  }

  // ── Delta queuing during bootstrap ──
  protected bootstrapDeltaQueue: SyncDelta[] | null = null;
  protected activeBootstrapCount = 0;
  /** The live deadline for the bootstrap attempt in flight, if any. */
  private bootstrapDeadlineTimer: ReturnType<typeof setTimeout> | null = null;

  // ── Delete tracking ──
  protected pendingDeletes = new Set<string>();

  // ── Model type hydration ──
  protected modelTypesHydrated = new Set<string>();
  protected modelTypeHydrationInFlight = new Map<string, Promise<void>>();

  constructor(
    dependencies: {
      syncClient: SyncClient;
      database: Database;
      objectPool: InstanceCache;
      modelRegistry: ModelRegistry;
      /**
       * The connection, built by the host. When omitted, the store constructs
       * its own from `url` and the collaboration-event config — the
       * self-contained path subclasses and tests use. Either way the store
       * owns the lifecycle from here: it seeds the late values (identity,
       * read scope, resume cursor) during `initialize()` and releases the
       * first connect.
       */
      syncWebSocket?: SyncWebSocket<TCollaboration>;
      /**
       * Optional schema. When provided, {@link deriveSyncPlanFromSchema} walks
       * the schema's models and relations to auto-populate foreign-key indexes
       * and the enrichment plan from their declarative annotations. Subclasses
       * that register model classes directly can instead pass explicit
       * `config.foreignKeyIndexes` / `config.enrichmentPlan`.
       */
      schema?: TSchema;
      /** Sync server URL for WebSocket connection. Converted to wss:// automatically. */
      url?: string;
      /** Shared bearer credential source for every auth-aware transport. */
      auth?: AuthCredentialSource;
      /** The owning client's runtime. Defaults to the module-global bridge. */
      runtime?: RuntimeContext;
      /**
       * The installed plugins, whose declared stage handlers the delta
       * pipeline dispatches. Empty on direct construction — the store's own
       * apply is then the whole pipeline.
       */
      stagePlugins?: readonly AbloPlugin[];
    },
    config: SyncedStoreConfig = {}
  ) {
    this.runtime = dependencies.runtime ?? globalRuntime;
    this.stagePlugins = dependencies.stagePlugins ?? [];
    this.syncClient = dependencies.syncClient;
    this.database = dependencies.database;
    this.objectPool = dependencies.objectPool;
    this.modelRegistry = dependencies.modelRegistry;
    this.auth = dependencies.auth;
    this.schema = dependencies.schema;
    this.terminalSessionLifecycle = new TerminalSessionLifecycle({
      runtime: this.runtime,
      listeners: this.sessionErrorListeners,
      purgeAuthenticatedState: () => this.purge(),
      updateSyncStatus: (updates) => { this.updateSyncStatus(updates); },
    });
    this._syncServerUrl = dependencies.url;
    this._collaborationEvents = config.collaborationEvents ?? [];

    // The connection exists from construction (ADR 0016 follow-up 3b): the
    // host hands one in, or the store builds its own. `deferConnect` holds
    // it closed until `initialize()` has seeded identity and read scope, so
    // nothing can open an unscoped connection in between.
    this.syncWebSocket =
      dependencies.syncWebSocket ??
      new SyncWebSocket<TCollaboration>({
        baseUrl: this._syncServerUrl,
        collaborationEvents: [...this._collaborationEvents],
        getAuthToken: this.auth?.getAuthToken,
        deferConnect: true,
        capabilities: {
          partialBootstrap: true,
          compressedDeltas: true,
          streamingBootstrap: true,
          batchedDeltas: true,
        },
      });
    this.areaOfInterest = new SubscriptionManager({ transport: this.syncWebSocket });
    this.wireSocketEvents();

    // QueuedMutation events for pendingChanges tracking — connection-
    // independent, wired once for the store's lifetime.
    this.disposers.push(
      this.syncClient.onTransactionEvent('created', () => { this.incrementPendingChanges(); }),
      this.syncClient.onTransactionEvent('completed', () => { this.decrementPendingChanges(); }),
      this.syncClient.onTransactionEvent('failed', () => { this.decrementPendingChanges(); }),
    );

    // Set this store as the global Model store
    Model.setStore(this as Parameters<typeof Model.setStore>[0]);

    // ── Schema-derived sync plan ───────────────────────────────────────
    //
    // When a schema is provided, derive foreign-key indexes and the
    // enrichment plan from the declarative annotations on its `belongsTo`
    // relations. Explicit config fields layer on top, so a subclass can
    // pass hardcoded arrays without supplying a full schema.
    //
    // Order matters: schema-derived entries are registered first and
    // config entries second, so that when a caller supplies both, the
    // explicit config entries win and are never shadowed by derivation.
    const derived = dependencies.schema
      ? deriveSyncPlanFromSchema(dependencies.schema)
      : { enrichmentPlan: [], foreignKeyIndexes: [] };

    const mergedForeignKeyIndexes: ForeignKeyIndexSpec[] = [
      ...derived.foreignKeyIndexes,
      ...(config.foreignKeyIndexes ?? []),
    ];
    for (const { modelName, fieldName } of mergedForeignKeyIndexes) {
      this.objectPool.registerForeignKey(modelName, fieldName);
    }

    // Override hook — called after schema-driven registration so a subclass
    // can add more foreign keys on top of the declarative set.
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
      // The inbound-delta flush debounce. Under sustained traffic the
      // `maxBatchSize` force-flush governs batching, so this timer decides
      // exactly one thing: how long the FINAL partial batch of a burst sits
      // before it materializes. At 100 ms it was the largest single term in
      // the observer's drain tail on the throughput bench; 10 ms coalesces a
      // trickle just as well and keeps burst tails inside the drain budget.
      batchingDelay: 10,
      maxBatchSize: 50,
      // ~600 deltas ≈ 9 to 14 ms of apply — inside a no-visible-stall
      // budget, and a full 500-op commit reveals in one slice. The yield
      // itself is TIME-budgeted in the pipeline (one or two yields per
      // batch), because a host yield costs milliseconds under load.
      // History: the "sliced-apply wedge" that briefly held this at
      // Infinity was kernel memory limits against the bench's many-isolate
      // process (semispace commits refused at stock max_map_count /
      // CommitLimit), not this pipeline — with the limits raised, the
      // sliced path ran the full certification load with zero errors and
      // cut writer ack latency threefold. `ABLO_APPLY_SLICE_DELTAS` remains
      // the bench-diagnostic override.
      applySliceDeltas: benchApplySliceOverride() ?? 600,
    };

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

    // Make the sync-status fields observable so consumer code can do
    //   reaction(() => store.isReady, ...)
    //   observer(() => store.isOffline)
    // and actually receive notifications. Without these annotations,
    // `syncStatus` and `dataReady` are plain properties, and the derived
    // getters (isReady, isSyncing, isOffline, and the rest) never emit
    // change signals — so a `reaction` on `store.isReady` would never fire.
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
   * Register foreign-key indexes for constant-time lookups.
   *
   * This is an override hook. The preferred way to declare a foreign-key
   * index is `config.foreignKeyIndexes` at construction time, or marking the
   * `belongsTo` relation with `{ index: true }` in the schema. The hook fires
   * after the schema-derived and config registrations, so a subclass can
   * layer additional indexes on top.
   */
  protected registerForeignKeys(): void {}

  /**
   * Enrich delta data with related models from the InstanceCache.
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
   * Access-credential re-mint + proactive pre-roll — extracted to
   * sync/credentialLifecycle.ts. Owns the refresher hook, the single-flight
   * guard, and the browser-only refresh timer / wake listener; talks back
   * through three lazily-resolved callbacks (the ConnectionManager doesn't
   * exist until `setupWebSocketSync`). The `setCredentialRefresher` /
   * `performCredentialRefresh` / `startCredentialLifecycle` methods below
   * are thin delegates so the store's public surface is unchanged.
   */
  private readonly credentialLifecycle = new CredentialLifecycle(
    {
      setAuthToken: (token) => { this.auth?.setAuthToken(token); },
      nudgeReconnect: () => { this.nudgeReconnect(); },
      reportSessionExpired: () => {
        this.connectionManager?.send({ type: 'BOOTSTRAP_FAILED_SESSION' });
      },
    },
    contextLogger,
  );

  /**
   * Listeners registered via `subscribeSessionError()`. Fired when the
   * WebSocket closes with a session-invalid code (1008/4001/4003) or a
   * session-error event is received. Separate from `onConnectionEvent`
   * (which exists for the ConnectionStore FSM) so multiple consumers —
   * typically `<AbloProvider>` and a connection-lifecycle owner — can
   * both react without racing on the single-callback slot.
   */
  protected sessionErrorListeners = new Set<(error: Error) => void>();
  private readonly terminalSessionLifecycle: TerminalSessionLifecycle;

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
   * underlying `SyncClient.mutationQueue` so consumers (toast layer,
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
      transaction: QueuedMutation;
      error: Error;
      permanent?: boolean;
    }) => void,
  ): () => void {
    return this.syncClient.onMutationFailure(listener);
  }

  /**
   * Subscribe to commit round-trip latency. Forwarded from the underlying
   * `SyncClient` for the same reason as `subscribeMutationFailure` — the
   * React provider binds against this surface, so the engine's wiring stays
   * private while the SDK keeps one hook to expose.
   */
  subscribeCommitLatency(
    listener: (
      sample: CommitLatencySample,
    ) => void,
  ): () => void {
    return this.syncClient.onCommitLatency(listener);
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
   * {@link import('./storeContract.js').LocalMutation}). Taps the
   * MutationQueue's `transaction:created` event — fired once per local
   * create/update/delete/archive with `previousData` already captured.
   * Remote/collaborator deltas apply via `applyDeltaBatchToPool` and never
   * emit here, so undo is naturally local-only (you can't undo a teammate).
   */
  subscribeLocalMutations(handler: (mutation: LocalMutation) => void): () => void {
    // Tap the MutationQueue directly via `onLocalTransaction`. The previous
    // `syncClient.subscribe('transaction:created', …)` route registered the
    // handler on SyncClient's OWN emitter, which never fires that event (only
    // the queue's emitter does) — so undo recorded nothing. See
    // `SyncClient.onLocalTransaction` for the full rationale.
    return this.syncClient.onLocalTransaction((tx) => {
      if (!tx.modelName || !tx.modelId) return;
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

    // An aborted initialize has to stop the transfer, not just stop waiting for
    // it. Without this the caller returns while a cold start keeps downloading,
    // and those chunks are still in flight when the next initialize begins.
    const onCallerAbort = (): void => { this.database.helper.abort(); };
    signal?.addEventListener('abort', onCallerAbort, { once: true });

    try {
      for (let attempt = 1; attempt <= BOOTSTRAP_CONFIG.MAX_RETRY_ATTEMPTS; attempt++) {
        if (signal?.aborted) {
          throw new DOMException('Initialization aborted', 'AbortError');
        }

        // `navigator.onLine === false` is the MDN-reliable "definitely
        // offline" signal. Don't use `!navigator.onLine`: Node 22+ exposes
        // `globalThis.navigator` with `onLine === undefined`, so the
        // negation false-positives every server-side bootstrap (e.g. the
        // server-side agent.run dispatch path through `connectAgent`).
        const navigatorOnline: unknown =
          typeof navigator === 'undefined' ? undefined : navigator.onLine;
        if (navigatorOnline === false) {
          this.runtime.observability.breadcrumb(
            `Bootstrap attempt ${attempt} skipped - offline`,
            'sync.bootstrap',
            'warning'
          );
          throw new AbloConnectionError('Bootstrap skipped - device is offline', {
            code: 'bootstrap_offline',
          });
        }

        try {
          this.runtime.logger.info(
            `[BaseSyncedStore] Bootstrap attempt ${attempt}/${BOOTSTRAP_CONFIG.MAX_RETRY_ATTEMPTS}`
          );

          const result = (await Promise.race([
            bootstrapFn(),
            this.createBootstrapTimeout(attempt),
          ])) as T;

          this.runtime.logger.info('[BaseSyncedStore] Bootstrap completed successfully', { attempt });
          return result;
        } catch (error) {
          lastError = error as Error;
          const isTimeout = error instanceof Error && error.message.includes('timed out');
          const isAbort = error instanceof DOMException && error.name === 'AbortError';
          const isNetworkError = error instanceof TypeError && error.message.includes('fetch');

          if (isAbort) throw error;
          if (AbloSessionError.isSessionError(error)) throw error;

          const navigatorOnline: unknown =
            typeof navigator === 'undefined' ? undefined : navigator.onLine;
          if (isNetworkError && navigatorOnline === false) {
            this.runtime.observability.captureBootstrapFailure(error, { type: 'network-offline' });
            throw error;
          }

          this.runtime.observability.breadcrumb(
            `Bootstrap attempt ${attempt} failed`,
            'sync.bootstrap',
            'warning',
            { isTimeout, isNetworkError, willRetry: attempt < BOOTSTRAP_CONFIG.MAX_RETRY_ATTEMPTS }
          );

          if (isTimeout && attempt < BOOTSTRAP_CONFIG.MAX_RETRY_ATTEMPTS) {
            this.runtime.logger.info('[BaseSyncedStore] Resetting state before bootstrap retry');
            this.resetBootstrapState();
            await new Promise((resolve) => setTimeout(resolve, BOOTSTRAP_CONFIG.RETRY_DELAY_MS));
          } else if (!isTimeout && attempt < BOOTSTRAP_CONFIG.MAX_RETRY_ATTEMPTS) {
            await new Promise((resolve) => setTimeout(resolve, 1000));
          }
        } finally {
          // Disarm this attempt's deadline the moment it settles — a live timer
          // would abort whatever the next attempt puts in flight.
          this.clearBootstrapDeadline();
        }
      }

      throw lastError
        ? toAbloError(lastError)
        : new AbloConnectionError('Bootstrap failed after all retry attempts', {
            code: 'bootstrap_fetch_timeout',
          });
    } finally {
      signal?.removeEventListener('abort', onCallerAbort);
      this.clearBootstrapDeadline();
    }
  }

  /**
   * The outer deadline for one bootstrap attempt.
   *
   * The length is DERIVED from the fetcher's own watchdog budget, not chosen. A
   * chosen number is what broke this: the previous fixed 15s was shorter than a
   * single model chunk's allowance — 20s waiting for response headers plus 15s
   * of stall grace — so on any workspace with one slow model the deadline fired
   * before the watchdogs it was meant to backstop, and every attempt timed out
   * by construction. The watchdogs below are progress-based and already
   * guarantee termination; this deadline exists only for a hang somewhere other
   * than the network, so it must sit above them, and it can only do that
   * reliably by asking them how long they take.
   *
   * Reaching it aborts the work in flight. `Promise.race` merely stops waiting:
   * without the abort the losing bootstrap keeps running, keeps its sockets, and
   * races the retry that replaced it — which is how one page load turned into
   * dozens of overlapping requests.
   */
  protected createBootstrapTimeout(attempt: number): Promise<never> {
    const timeoutMs = this.database.helper.budgetMs;
    return new Promise((_, reject) => {
      this.clearBootstrapDeadline();
      this.bootstrapDeadlineTimer = setTimeout(() => {
        this.database.helper.abort();
        reject(
          new AbloConnectionError(
            `Bootstrap timed out after ${timeoutMs}ms (attempt ${attempt})`,
            { code: 'bootstrap_fetch_timeout' },
          ),
        );
      }, timeoutMs);
    });
  }

  /** Disarm the deadline once its attempt has settled. Load-bearing now that
   *  firing it aborts real work: a leftover timer would cancel a later,
   *  unrelated bootstrap. */
  private clearBootstrapDeadline(): void {
    if (this.bootstrapDeadlineTimer !== null) {
      clearTimeout(this.bootstrapDeadlineTimer);
      this.bootstrapDeadlineTimer = null;
    }
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
      this.runtime.logger.info('[BaseSyncedStore] Bootstrap state reset complete');
    } catch {
      this.runtime.observability.breadcrumb('Error resetting bootstrap state', 'sync.bootstrap', 'warning');
    }
  }

  // ── Reconnection ─────────────────────────────────────────────────────────

  /** Perform reconnect: bootstrap + WS reconnect. Returns outcome for state machine. */
  async performReconnect(): Promise<'success' | 'session_error' | 'network_error'> {
    const thisStore = this;
    return runReconnect({
      get userContext() { return thisStore.userContext; },
      database: this.database,
      syncClient: this.syncClient,
      objectPool: this.objectPool,
      syncWebSocket: this.syncWebSocket,
      runtime: this.runtime,
      get dataReady() { return thisStore.dataReady; },
      set dataReady(value: boolean) { thisStore.dataReady = value; },
      checkSyncGroupShrinkage: () => this.checkSyncGroupShrinkage(),
      resolveSyncGroups: (context) => this.resolveSyncGroups(context),
      applyBootstrapToPool: (result) => this.applyBootstrapToPool(result),
      updateSyncStatus: (updates) => { this.updateSyncStatus(updates); },
    });
  }
  /**
   * Register the access-credential re-mint hook. Called by the React provider
   * with a thunk that mints a fresh `ek_`/`rk_` (typically its `getToken`).
   * See {@link CredentialLifecycle.setRefresher}.
   */
  setCredentialRefresher(refresher: CredentialRefresher | null): void {
    this.credentialLifecycle.setRefresher(refresher);
  }

  /**
   * Re-mint the short-lived access credential and push it into the credential
   * source, reporting a tri-state outcome the {@link ConnectionManager} maps to
   * its FSM. Single-flight; no refresher wired ⇒ `'refreshed'` (a no-op
   * re-probe). Full contract on {@link CredentialLifecycle.refresh}.
   */
  async performCredentialRefresh(): Promise<'refreshed' | 'session_error' | 'network_error'> {
    return this.credentialLifecycle.refresh();
  }

  /**
   * The authentication-recovery path for HTTP transports, such as the lazy
   * query lane. It runs a single-flight credential re-mint driven by the
   * rejection's recovery class, routing outcomes through the same state
   * machine the WebSocket probe uses. `'retry'` means a fresh credential is
   * now in the credential source and the request should be replayed once.
   * Full contract on {@link CredentialLifecycle.recoverFromAuthRejection}.
   */
  async recoverFromAuthRejection(recovery: RecoveryClass): Promise<'retry' | 'stop'> {
    return this.credentialLifecycle.recoverFromAuthRejection(recovery);
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
   * Install the client-owned access-credential lifecycle: register `getToken`
   * as the reactive re-mint hook and arm the browser-only proactive refresh
   * (a refresh timer plus an OS-wake re-mint). Idempotent — a second call
   * replaces the first — and torn down on {@link disconnect}. Full rationale
   * on {@link CredentialLifecycle.start}.
   */
  startCredentialLifecycle(
    getToken: CredentialRefresher,
    opts?: { proactiveInNode?: boolean },
  ): void {
    this.credentialLifecycle.start(getToken, opts);
  }

  /** Tear down the proactive credential lifecycle (idempotent). */
  private stopCredentialLifecycle(): void {
    this.credentialLifecycle.stop();
  }

  // ── Sync group management ────────────────────────────────────────────────
  //
  // The implementation lives in the sync/groupChange module. The methods
  // below are thin protected delegates that keep their signatures, so
  // subclass override points still work; the module routes cross-handler
  // calls back through `groupChangeContext()` to preserve dynamic dispatch.

  /** Narrow context the group-change leaf talks back through. */
  private groupChangeContext(): GroupChangeContext {
    return {
      runtime: this.runtime,
      database: this.database,
      objectPool: this.objectPool,
      getSubscribedSyncGroups: () => this.syncWebSocket.getSyncGroups(),
      getCurrentSyncGroups: () =>
        this.userContext ? this.resolveSyncGroups(this.userContext) : null,
      getBootstrapMode: () => this.userContext?.bootstrapMode,
      disconnectWebSocket: () => { this.syncWebSocket.disconnect(); },
      emitConnectionEvent: (event) => { this.onConnectionEvent?.(event); },
      handleGroupAdded: (payload, syncId) => this.handleGroupAdded(payload, syncId),
      computeUpdatedSyncGroups: (payload) => this.computeUpdatedSyncGroups(payload),
      forceFullRebootstrap: () => { this.forceFullRebootstrap(); },
    };
  }

  /**
   * Handle an actionType 'G' delta — incremental `{ group, userId }` or
   * legacy `{ addedGroups, removedGroups }` payloads. Full pathway doc on
   * {@link groupChange.handleSyncGroupChange}.
   */
  protected async handleSyncGroupChange(delta: SyncDelta): Promise<void> {
    return groupChange.handleSyncGroupChange(this.groupChangeContext(), delta);
  }

  /**
   * Handle an incremental GroupAdded delta — metadata only, no re-bootstrap
   * (covering deltas bring the entities). See {@link groupChange.handleGroupAdded}.
   */
  protected async handleGroupAdded(payload: GroupAddedPayload, syncId: number): Promise<void> {
    return groupChange.handleGroupAdded(this.groupChangeContext(), payload, syncId);
  }

  /**
   * Handle an actionType 'S' (GroupRemoved) delta: for safety, clear the
   * revoked local state and trigger a full re-bootstrap. See
   * {@link groupChange.handleGroupRemoved}.
   */
  protected async handleGroupRemoved(delta: SyncDelta): Promise<void> {
    return groupChange.handleGroupRemoved(this.groupChangeContext(), delta);
  }

  /** Compute new sync groups after applying additions and removals */
  protected computeUpdatedSyncGroups(payload: SyncGroupChangePayload): string[] {
    return groupChange.computeUpdatedSyncGroups(this.groupChangeContext(), payload);
  }

  /** Force a full re-bootstrap via connection lifecycle event (no-op for
   *  `bootstrapMode: 'none'` participants — see {@link groupChange.forceFullRebootstrap}). */
  protected forceFullRebootstrap(): void {
    groupChange.forceFullRebootstrap(this.groupChangeContext());
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
    return groupChange.resolveSyncGroups(context);
  }

  /** Check if sync groups shrank since last session — force full bootstrap if so */
  protected async checkSyncGroupShrinkage(): Promise<void> {
    return groupChange.checkSyncGroupShrinkage(this.groupChangeContext());
  }

  // ── Bootstrap apply ──────────────────────────────────────────────────────
  //
  // The implementation lives in the sync/bootstrapApply module. The protected
  // delegates below keep their signatures and subclass overridability; the
  // module talks back through `poolContext()`, with enrichment pre-bound to
  // `this.enrichRelations` so that override point still applies.

  /** Narrow context the bootstrap-apply leaf talks back through. */
  private poolContext(): PoolContext {
    const store = this;
    return {
      runtime: this.runtime,
      applyDeltaBatchToPool: (results) =>
        { this.syncClient.applyDeltaBatchToPool(
          results,
          (name, data) => this.enrichRelations(name, data),
        ); },
      applyBootstrapDataToPool: (bootstrapData, protectedIds) =>
        this.syncClient.applyBootstrapDataToPool(bootstrapData, protectedIds),
      getPoolSize: () => this.objectPool.size,
      getAllPoolIds: () => this.objectPool.getAllIds(),
      get bootstrapDeltaQueue() { return store.bootstrapDeltaQueue; },
      set bootstrapDeltaQueue(queue) { store.bootstrapDeltaQueue = queue; },
      applyDeltaFrame: (deltas) => { this.applyDeltaFrame(deltas); },
    };
  }

  /** Apply bootstrap data to the {@link InstanceCache}, removing entities that are no longer present (ghost removal). Pool writes are delegated to {@link SyncClient}. */
  protected applyBootstrapToPool(
    bootstrapResult: BootstrapResult,
    protectedIds?: ReadonlySet<string>
  ): RehydrationStats {
    return bootstrapApply.applyBootstrapToPool(this.poolContext(), bootstrapResult, protectedIds);
  }

  // ── Initialize + Lifecycle ───────────────────────────────────────────────

  /**
   * Initialize the sync engine with user context.
   * Offline-first: hydrate from IDB → show UI → bootstrap from server in background.
   */
  *initialize(
    context: UserContext,
    signal?: AbortSignal,
  ): Generator<Promise<void | number | boolean | BootstrapRequirements>, { success: boolean; error?: Error }, void | number | boolean | BootstrapRequirements> {
    const thisStore = this;
    return yield* runInitialize<TCollaboration>({
      get initialized() { return thisStore.initialized; },
      set initialized(value: boolean) { thisStore.initialized = value; },
      get userContext() {
        const value = thisStore.userContext;
        if (!value) throw new Error('User context is unavailable during initialization');
        return value;
      },
      set userContext(value: UserContext) { thisStore.userContext = value; },
      get dataReady() { return thisStore.dataReady; },
      set dataReady(value: boolean) { thisStore.dataReady = value; },
      runtime: this.runtime,
      database: this.database,
      syncClient: this.syncClient,
      objectPool: this.objectPool,
      syncWebSocket: this.syncWebSocket,
      updateSyncStatus: (updates) => { this.updateSyncStatus(updates); },
      setupWebSocketSync: (nextContext, lastSyncId) => { this.setupWebSocketSync(nextContext, lastSyncId); },
      waitForWebSocketConnected: (timeoutMs) => this.waitForWebSocketConnected(timeoutMs),
      performBackgroundBootstrap: (requirements, nextContext, nextSignal) =>
        this.performBackgroundBootstrap(requirements, nextContext, nextSignal),
      executeBootstrapWithTimeout: (fn, nextContext, nextSignal) =>
        this.executeBootstrapWithTimeout(fn, nextContext, nextSignal),
      resolveSyncGroups: (nextContext) => this.resolveSyncGroups(nextContext),
    }, context, signal);
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
        this.runtime.logger.debug('[sync-engine] Background bootstrap failed', {
          error: error instanceof Error ? error.message : String(error),
          cause: error,
        });
        this.runtime.observability.captureBootstrapFailure(error, { type: 'background' });
        if (AbloSessionError.isSessionError(error)) {
          this.syncWebSocket.setSessionErrorDetected();
          this.syncWebSocket.disconnect();
          this.updateSyncStatus({ state: 'error', error: error });
        } else if (!this.syncWebSocket.isConnected()) {
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
    return bootstrapApply.collectDeltaProtectedIds(this.poolContext(), preBootstrapIds);
  }

  /** Replay deltas queued during bootstrap (atomically, via `applyDeltaFrame`). */
  protected replayQueuedDeltas(): void {
    bootstrapApply.replayQueuedDeltas(this.poolContext());
  }

  protected createConnectionManager(kind?: ParticipantKind): ConnectionManager | null {
    return runCreateConnectionManager<TCollaboration>({
      syncServerUrl: this._syncServerUrl,
      auth: this.auth,
      syncWebSocket: this.syncWebSocket,
    }, kind);
  }

  /**
   * Disconnect and clean up all resources. Terminal: this means "the client
   * is finished", not "close and reopen later" — the connection object stays
   * assigned but closed, the event wiring is torn down, and nothing
   * re-initializes a disconnected store. (Mid-session closes during recovery
   * go through the connection FSM's `onDisconnectWebSocket`, which closes
   * the transport without touching the store.)
   */
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
      const last = this.syncWebSocket.getLastSyncId();
      if (last > 0) await this.database.updateWorkspaceMetadata({ lastSyncId: last });
    } catch {}

    this.syncWebSocket.disconnect();
    this.syncClient.disconnect();
    this.queryProcessor.clearCache();
    // Stop the pool's GC interval — the one timer the pool arms itself.
    // Without this a discarded store retains its whole pool via the interval
    // closure (and a Node process without `unref` support can't exit).
    this.objectPool.stopGC();
    this.updateSyncStatus({ state: 'offline' });
  }

  /** Stop access and await deletion of this identity's local state. */
  async purge(): Promise<void> {
    // Clear the bearer first so no request started during teardown can carry
    // the terminal credential.
    this.auth?.setAuthToken(null);
    await this.disconnect();
    this.objectPool.clear();
    this.queryProcessor.clearCache();
    await this.database.purgePersistence();
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
    return runWaitForWebSocketConnected<TCollaboration>({
      syncWebSocket: this.syncWebSocket,
      runtime: this.runtime,
    }, timeoutMs);
  }

  /**
   * Seed the connection's late values and open it. The socket itself exists
   * from construction; what identity resolution supplies — the participant
   * kind, the credential, the read scope, and the resume cursor — is seeded
   * here, and only then is the held first connect released. A retried
   * `initialize()` after a failed `ready()` re-runs this against the same
   * connection object: the reconnect counter is reset for a clean slate,
   * while the session-error latch deliberately survives (only the
   * credential-expiry recovery clears it).
   */
  protected setupWebSocketSync(context: UserContext, lastSyncId: number): void {
    if (!context.userId || !context.organizationId) {
      this.runtime.observability.breadcrumb(
        'Cannot setup WebSocket sync without user context',
        'sync.websocket',
        'warning'
      );
      return;
    }

    if (context.kind) this.syncWebSocket.setKind(context.kind);
    if (context.capabilityToken) {
      this.syncWebSocket.setCapabilityToken(context.capabilityToken);
    }
    const syncGroups = this.resolveSyncGroups(context);
    this.syncWebSocket.setSyncGroups(syncGroups);
    this.syncWebSocket.setDeliveryPartition(context.deliveryPartition ?? null);
    this.syncWebSocket.setLastSyncId(lastSyncId || 0);
    // The permanent base scopes for read interest — same set the connection
    // subscribes to at upgrade, so the two can never disagree.
    this.areaOfInterest.setBaseGroups(syncGroups);

    // ── Connection FSM ────────────────────────────────────────────
    // Instantiate + start the SDK's ConnectionManager so every consumer
    // gets correct online/offline recovery. Guarded: a retried
    // `initialize()` reuses the manager it already started.
    if (!this.connectionManager) this.startConnectionManager(context.kind);

    this.syncWebSocket.resetReconnectAttempts();
    this.syncWebSocket.allowConnect();
    this.syncWebSocket.connect();
  }

  /**
   * Wire the store's handlers onto the connection. Runs once, at
   * construction — the connection object is stable for the store's
   * lifetime, so the wiring is too.
   */
  protected wireSocketEvents(): void {
    const thisStore = this;
    wireSocketEvents({
      syncWebSocket: this.syncWebSocket,
      syncClient: this.syncClient,
      database: this.database,
      objectPool: this.objectPool,
      areaOfInterest: this.areaOfInterest,
      runtime: this.runtime,
      get dataReady() { return thisStore.dataReady; },
      connectionManager: this.connectionManager,
      disposers: this.disposers,
      onConnectionEvent: this.onConnectionEvent,
      updateSyncStatus: (updates) => { this.updateSyncStatus(updates); },
      processDeltaWithBatching: (delta) => { this.processDeltaWithBatching(delta); },
      applyDeltaFrame: (deltas) => { this.applyDeltaFrame(deltas); },
      handleBootstrapRequired: (hint) => { this.handleBootstrapRequired(hint); },
      handleBootstrapData: (data) => { this.handleBootstrapData(data); },
      handlePresenceUpdate: (data) => { this.handlePresenceUpdate(data); },
      performCredentialRefresh: () => this.performCredentialRefresh(),
      handleTerminalSessionError: (error) => { this.terminalSessionLifecycle.start(error); },
      nudgeReconnect: () => { this.nudgeReconnect(); },
    });
  }

  /*
   * Kept as a distinct method so subclasses retain the original override
   * point; transport wiring itself lives in sync/socketEventWiring.ts.
   */
  /**
   * Build and start the connection FSM. The `onConnectionEvent` hook is the
   * bridge — WS events fire the hook, the hook forwards into the FSM. Called
   * from `setupWebSocketSync` because the FSM's shape depends on the resolved
   * participant kind (agents get none — see {@link createConnectionManager}).
   */
  private startConnectionManager(kind?: ParticipantKind): void {
    const thisStore = this;
    runStartConnectionManager<TCollaboration>({
      get connectionManager() { return thisStore.connectionManager; },
      set connectionManager(value) { thisStore.connectionManager = value; },
      get onConnectionEvent() { return thisStore.onConnectionEvent; },
      set onConnectionEvent(value) { thisStore.onConnectionEvent = value; },
      syncWebSocket: this.syncWebSocket,
      get syncStatus() { return thisStore.syncStatus; },
      createConnectionManager: (nextKind) => this.createConnectionManager(nextKind),
      performReconnect: () => this.performReconnect(),
      performCredentialRefresh: () => this.performCredentialRefresh(),
      handleTerminalSessionError: (error) => { this.terminalSessionLifecycle.start(error); },
      updateSyncStatus: (updates) => { this.updateSyncStatus(updates); },
      runtime: this.runtime,
    }, kind);
  }

  // ── Delta processing pipeline ─────────────────────────────────────────────
  //
  // The implementation lives in the sync/deltaPipeline module (deduplication,
  // enqueue bookkeeping, debounce, flush). The methods below are thin protected
  // delegates with unchanged signatures, and the module routes every call to a
  // protected override point back through `deltaPipelineContext`, so subclass
  // dynamic dispatch is preserved. `applyDeltaFrame`, the authoritative-apply
  // correctness point, deliberately stays here.

  /** Memoized pipeline context — `enqueueDelta` runs once per delta, so the
   *  accessor object is built once and reused (the get/set accessors always
   *  read the live host fields). */
  private _deltaPipelineContext: DeltaPipelineContext | null = null;

  private get deltaPipelineContext(): DeltaPipelineContext {
    if (this._deltaPipelineContext) return this._deltaPipelineContext;
    const store = this;
    this._deltaPipelineContext = {
      runtime: this.runtime,
      stagePlugins: this.stagePlugins,
      // Shared pipeline state, backed by the host fields.
      get pendingDeltas() { return store.pendingDeltas; },
      set pendingDeltas(deltas) { store.pendingDeltas = deltas; },
      get batchTimer() { return store.batchTimer; },
      set batchTimer(timer) { store.batchTimer = timer; },
      get bootstrapDeltaQueue() { return store.bootstrapDeltaQueue; },
      get smartSyncOptions() { return store.smartSyncOptions; },
      get highestProcessedSyncId() { return store.highestProcessedSyncId; },
      get lastAckedId() { return store.lastAckedId; },
      // SyncClient position/transaction bookkeeping.
      onDeltaReceived: (syncId, transactionId, correlationId) => {
        this.syncClient.onDeltaReceived(syncId, transactionId, correlationId);
      },
      advanceApplied: (syncId) => { this.syncClient.position.advanceApplied(syncId); },
      advancePersisted: (syncId) => { this.syncClient.position.advancePersisted(syncId); },
      // Persistence + pool writes.
      processDeltaBatch: (deltas) => this.database.processDeltaBatch(deltas),
      projectDeltaBatchForPool: (results) =>
        this.syncClient.projectDeltaBatchForPool(results),
      applyDeltaBatchToPool: (results) => { this.applyChangesToPool(results); },
      acknowledge: (syncId) => { this.syncWebSocket.acknowledge(syncId); },
      get objectPool() { return store.objectPool; },
      // Dynamic-dispatch hooks — protected override points on this class.
      getStateFields: (modelName) => this.getStateFields(modelName),
      isCustomEntity: (modelName) => this.isCustomEntity(modelName),
      createCustomEntity: (modelName, modelId, data) =>
        this.createCustomEntity(modelName, modelId, data),
      deduplicateDeltas: (deltas) => this.deduplicateDeltas(deltas),
      flushPendingDeltas: () => this.flushPendingDeltas(),
      handleFlushError: (error) => { this.handleFlushError(error); },
      handleSyncGroupChange: (delta) => this.handleSyncGroupChange(delta),
      handleGroupRemoved: (delta) => this.handleGroupRemoved(delta),
      forceFullRebootstrap: () => { this.forceFullRebootstrap(); },
      cascadeCancelTransactionsForDeletedParent: (parentModelName, parentId) => {
        this.cascadeCancelTransactionsForDeletedParent(parentModelName, parentId);
      },
    };
    return this._deltaPipelineContext;
  }

  /**
   * Lands persisted changes in the in-memory pool, with this store's
   * relation enrichment bound. The one apply path: the pipeline's bridge
   * (no plugins installed) and the `humans()` apply handler both call it.
   */
  applyChangesToPool(changes: readonly AppliedChange[]): void {
    this.syncClient.applyDeltaBatchToPool(
      changes,
      (name, data) => this.enrichRelations(name, data),
    );
  }

  /** Get fields that represent meaningful state for deduplication. Override for model-specific fields. */
  protected getStateFields(_modelName: string): string[] {
    return ['status', 'state', 'isActive'];
  }

  /** Deduplicate deltas to the same entity — keep meaningful state transitions only */
  protected deduplicateDeltas(deltas: SyncDelta[]): SyncDelta[] {
    return deltaPipeline.deduplicateDeltas(this.deltaPipelineContext, deltas);
  }

  /** Process incoming delta with smart batching */
  protected processDeltaWithBatching(delta: SyncDelta): void {
    if (!this.enqueueDelta(delta)) return;
    this.scheduleDeltaFlush();
  }

  /**
   * Apply a complete, server-delivered delta frame atomically.
   *
   * A `delta_batch` WebSocket event (a reconnect or catch-up replay) already
   * carries the full set of missed deltas. Routing it through the per-delta
   * `processDeltaWithBatching` path would re-chunk it via the live-traffic
   * debounce timer and `maxBatchSize` force-flush, so a 300-delta catch-up
   * would fan out into several separate `flushPendingDeltas` cycles — each its
   * own local write, pool mutation, `models:changed` emit, and re-render, so
   * the UI visibly repaints once per chunk.
   *
   * Instead, this runs the per-delta bookkeeping (deduplication, ack, version
   * vector, watermark, group-change routing, delete cascade) for every delta
   * without scheduling a flush, then flushes once — collapsing the whole frame
   * into a single local write, pool mutation, `models:changed` emit, and
   * re-render. The post-bootstrap replay of deltas queued during bootstrap
   * uses the same path.
   *
   * It is named `applyDeltaFrame`, not `processDeltaBatch`, to avoid confusion
   * with {@link Database.processDeltaBatch} — the lower-level local write this
   * eventually drives through `flushPendingDeltas`.
   */
  protected applyDeltaFrame(deltas: SyncDelta[]): void {
    deltaPipeline.applyDeltaFrame(this.deltaPipelineContext, deltas);
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
    return deltaPipeline.enqueueDelta(this.deltaPipelineContext, delta, options);
  }

  /** Debounce a flush for live single-delta traffic. */
  protected scheduleDeltaFlush(): void {
    deltaPipeline.scheduleDeltaFlush(this.deltaPipelineContext);
  }

  /**
   * Cancel pending transactions for child entities when a parent is deleted.
   *
   * Uses `pool.getByForeignKey` (O(1) via the FK index registered at
   * schema build time) to find children. The previous implementation did
   * `getByType(ctor).filter(e => e.toJSON()[foreignKey] === parentId)` —
   * a full pool scan per child model + a `toJSON()` allocation per
   * candidate. For a report delete with 10K blocks in the pool, that was
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
      this.runtime.logger.info('[BaseSyncedStore] Cascade cancelled orphaned transactions', {
        parentModel: parentModelName,
        parentId: parentId.slice(0, 12),
        totalCancelled,
      });
    }
  }

  /** Flush pending deltas with deduplication. Pool writes are delegated to {@link SyncClient}. */
  protected async flushPendingDeltas(): Promise<void> {
    return deltaPipeline.flushPendingDeltas(this.deltaPipelineContext);
  }

  // ── Core mutations (thin delegation to SyncClient) ────────────────────────
  //
  // This class orchestrates; it does not implement the writes. {@link SyncClient}
  // owns the object-pool operations, the transaction queue, and local writes.
  // This class owns validation, lifecycle hooks, and pending-delete tracking.

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
   * Zod-inferred model types from `Model<Schema, K>` without knowing
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

  /** Save with an atomic server mutation (e.g., createSectionWithBlocks) */
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
  // `ablo.<model>.local.get` / `.local.list` is the read surface for
  // application code. Custom mutators read transactionally through
  // `tx.<model>`, backed by `createReaderActions`.

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
   * const ledger = store.create('ledgers', { name, reportId });
   * // ledger: Ledger | null — no cast needed
   * ```
   *
   * The `typename` arg is the schema key (camelCase plural, e.g.
   * `'ledgers'`); the returned instance has the
   * `Model<Schema, K>` shape including computeds + relation accessors.
   * Wraps `pool.create(...)` — the underlying runtime is unchanged, just
   * type-narrowed.
   */
  create<K extends keyof TSchema['models'] & string>(
    typename: K,
    data: Record<string, unknown>,
  ): import('@abloatai/transaction/schema/schema').Model<TSchema, K> | null {
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
      | import('@abloatai/transaction/schema/schema').Model<TSchema, K>
      | null;
  }

  /**
   * Query entry point for callers that hold a {@link Model} constructor and an
   * options object. It filters, orders, and paginates the matching models from
   * the pool. Prefer the schema-typed read surface (`ablo.<model>.list`) where
   * you can, since it infers concrete row types without a class value or cast.
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
    return runQueryByClass(this.objectPool, this.pendingDeletes, modelClass, options);
  }

  /**
   * Get all models of a type. Returns Model[] honestly — callers that need
   * narrow types should use `useAblo((ablo) => ablo.<model>.list(...))`
   * which does proper inference via `Model<S, K>`.
   */
  allModelsOfType(modelClass: ModelConstructor<Model>, scope?: ModelScope): Model[] {
    return this.objectPool.getByType(modelClass, scope ?? ModelScope.live);
  }

  /** Error handler for fire-and-forget flushPendingDeltas calls */
  protected handleFlushError = (error: unknown): void => {
    this.runtime.observability.captureMutationFailure({
      context: 'flush-pending-deltas',
      modelName: 'batch',
      modelId: 'batch',
      error: error instanceof Error ? error : new Error(String(error)),
    });
    this.runtime.logger.debug('[BaseSyncedStore] Delta flush error', {
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
      data: typeof delta.data === 'string' ? JSON.parse(delta.data) : delta.data,
    });

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
  protected handlePresenceUpdate(_data: PresenceUpdate): void {}

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

  get pool(): InstanceCache {
    return this.objectPool;
  }

  get lastSyncId(): number {
    return this.lastAckedId;
  }

  // ── Status convenience getters ──────────────────────────────────────────
  // Thin wrappers over `syncStatus` for consumer ergonomics.

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
    return countModels(this.objectPool, modelClass, this.pendingDeletes, predicate);
  }

  /** Get entities by foreign key (used by Model subclasses via Model.store) */
  getByForeignKey(modelName: string, foreignKey: string, id: string): Model[] {
    return this.objectPool.getByForeignKey(modelName, foreignKey, id);
  }
}
