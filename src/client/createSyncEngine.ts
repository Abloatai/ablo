/**
 * createSyncEngine — The one-liner consumer API.
 *
 * Hides all internal wiring (ObjectPool, Database, SyncClient, WebSocket,
 * bootstrap, offline queue, DI adapters) behind a single function call.
 *
 * Usage:
 *   import { createSyncEngine } from '@ablo/sync-engine/client';
 *   import { schema } from './schema';
 *
 *   const sync = createSyncEngine({ url: 'wss://my-server.com', schema });
 *
 *   const tasks = sync.tasks.findMany({ where: { status: 'todo' } });
 *   await sync.tasks.create({ title: 'Fix bug' });
 *   await sync.tasks.update(taskId, { status: 'done' });
 *   await sync.tasks.delete(taskId);
 */

import { z } from 'zod';
import type { Schema, SchemaRecord, InferModel, InferCreate, InferModelNames } from '../schema/schema';
import type { ModelDef } from '../schema/model';
import type {
  SyncEngineConfig,
  SyncLogger,
  MutationExecutor,
  MutationDispatcher,
  MutationOptions,
  SyncObservabilityProvider,
  SyncAnalytics,
  SessionErrorDetector,
  OnlineStatusProvider,
} from '../interfaces';
import { AbloError, AbloConnectionError, AbloValidationError, translateHttpError } from '../errors';
import { LoadStrategy, PropertyType } from '../types';
import { initSyncEngine } from '../context';
import {
  noopObservability,
  browserOnlineStatus,
  defaultSessionErrorDetector,
  noopAnalytics,
} from '../SyncEngineContext';
import { alwaysOnline } from '../adapters/alwaysOnline';
import { ModelRegistry, setActiveRegistry } from '../ModelRegistry';
import { ObjectPool, ModelScope } from '../ObjectPool';
import type { SyncStoreContract } from '../react/context';
import type { SyncWebSocket } from '../sync/SyncWebSocket';
import { Database } from '../Database';
import { SyncClient } from '../SyncClient';
import { BootstrapHelper } from '../sync/BootstrapHelper';
import { Model } from '../Model';
import { BaseSyncedStore, type SyncStatus } from '../BaseSyncedStore';

// ── Options ───────────────────────────────────────────────────────────────

export interface SyncEngineOptions<S extends SchemaRecord = SchemaRecord> {
  /** WebSocket/HTTP URL of the sync server */
  url: string;

  /** Schema defined with defineSchema() */
  schema: Schema<S>;

  /**
   * Authenticated user context. Required so the sync engine can scope
   * IndexedDB, attribute mutations, and load the right data.
   *
   * If your app has no concept of "users" (e.g., a single-player local tool),
   * pass a stable device identifier like `{ id: 'local-device-1' }`.
   */
  user: {
    id: string;
    organizationId?: string;
    teamIds?: string[];
  };

  /** API key for managed cloud (sk_live_...). Mutually exclusive with auth. */
  apiKey?: string;

  /** Auth token or function returning a token */
  auth?: string | (() => string | Promise<string>);

  /** Custom logger (default: console) */
  logger?: SyncLogger;

  /** ObjectPool size limit (default: 10000) */
  maxPoolSize?: number;

  /** Enable offline support with IndexedDB (default: true) */
  offline?: boolean;

  /**
   * Use in-memory storage instead of IndexedDB. Enables headless usage
   * in Node.js, agent workers, and the sync-server sidecar.
   *
   * When true: all IndexedDB operations use in-memory Maps instead.
   * Bootstrap via HTTP still works; only local persistence is skipped.
   * When false (default): IndexedDB is used for offline persistence.
   *
   * This is the DI seam that makes createSyncEngine work in Node.js.
   * See Path C Phase 1 and packages/sync-engine/src/interfaces/headless.ts.
   */
  inMemory?: boolean;

  /**
   * If true, initialization starts immediately in the background so
   * `sync.tasks.findMany()` works after `await sync.ready()`.
   *
   * If false (default), the consumer MUST call `await sync.ready()` before
   * using the engine — any query before that returns empty results.
   *
   * Default: false (explicit is better — prevents silent init failures).
   */
  autoStart?: boolean;

  // ── Advanced DI overrides ────────────────────────────────────────────────
  //
  // The fields below let an integrator replace the SDK's noop defaults with
  // their own implementations. They exist so first-party apps (like Ablo's
  // web client) can dogfood `createSyncEngine` without losing the structured
  // observability, analytics, and auth-aware mutation executor they already
  // wired up by hand. External consumers can ignore all of these — the
  // built-in defaults work for the documented zero-config call shape.

  /**
   * Custom observability provider (Sentry, Honeycomb, OTel, etc.).
   * Default: a noop implementation that drops all breadcrumbs and spans.
   */
  observability?: SyncObservabilityProvider;

  /**
   * Custom analytics provider (PostHog, Amplitude, Segment, etc.).
   * Default: a noop implementation that drops all events.
   */
  analytics?: SyncAnalytics;

  /**
   * Detect whether an error from a mutation/bootstrap response means the
   * user's session has expired. Used to surface re-auth prompts. Default:
   * heuristic that matches `401 Unauthorized` and a few common error shapes.
   */
  sessionErrorDetector?: SessionErrorDetector;

  /**
   * Detect whether the browser is currently online. Default: reads
   * `navigator.onLine` and listens to the `online`/`offline` events.
   */
  onlineStatus?: OnlineStatusProvider;

  /**
   * Replace the built-in `MutationExecutor` (which posts a hardcoded
   * `commit` method against `${url}/graphql`) with one that uses your own
   * GraphQL client, auth headers, retry policy, and observability hooks.
   *
   * Default: a fetch-based executor that targets `${url}/graphql` with
   * `credentials: 'include'` (cookie auth) when no `apiKey` is set.
   */
  mutationExecutor?: MutationExecutor;

  /**
   * Replace the built-in `MutationDispatcher` (used by the offline queue
   * to replay mutations on reconnect). If you override `mutationExecutor`
   * you almost always want to override this too so the two paths share
   * the same auth/retry behavior.
   *
   * Default: a thin dispatcher that routes to the built-in executor.
   */
  mutationDispatcher?: MutationDispatcher;

  /**
   * Partial overrides for the auto-derived `SyncEngineConfig`. Merged on
   * top of `deriveConfigFromSchema(schema)`. Use this when you need
   * specific `modelCreatePriority`, `batchableModels`, or
   * `essentialFields` settings that the schema cannot express.
   */
  configOverrides?: Partial<SyncEngineConfig>;

  /**
   * Sync groups to subscribe to during bootstrap. Used to scope which
   * deltas the server sends. Default: `['default']` (resolved by
   * `BootstrapHelper`). Ablo passes `['default', 'org:X', 'user:Y',
   * 'team:Z']` to receive Inbox/Subscriptions data.
   */
  syncGroups?: string[];

  /**
   * Override the bootstrap endpoint base URL. Use this when your sync
   * server's HTTP API lives on a different host than the WebSocket URL.
   *
   * Must include the `/api` prefix — `BootstrapHelper` appends
   * `/sync/bootstrap` directly. Example:
   * `'http://api.example.com/api'` → `http://api.example.com/api/sync/bootstrap`.
   *
   * Default: `${url.replace(/^ws/, 'http')}/api`.
   */
  bootstrapBaseUrl?: string;
}

// ── Model proxy types ─────────────────────────────────────────────────────

/** Operations available on each model in the sync engine */
export interface ModelOperations<T, CreateInput> {
  /** Find a single entity by ID */
  findById(id: string): T | undefined;

  /** Find many entities with optional filter */
  findMany(options?: {
    where?: Partial<T>;
    orderBy?: { [K in keyof T]?: 'asc' | 'desc' };
    limit?: number;
    offset?: number;
  }): T[];

  /** Find the first entity matching a filter */
  findFirst(options?: { where?: Partial<T> }): T | undefined;

  /** Count entities matching a filter */
  count(options?: { where?: Partial<T> }): number;

  /**
   * Create a new entity — **optimistic, offline-first**.
   *
   * The returned Promise resolves once the mutation is:
   * 1. Applied to the local ObjectPool (UI updates immediately)
   * 2. Queued in IndexedDB (survives tab close, replays on reconnect)
   *
   * It does **NOT** wait for server confirmation. This is intentional: it
   * lets mutations work offline and keeps the UI responsive. The mutation
   * is sent to the server in the background via the transaction queue.
   *
   * If the server rejects the mutation later, the sync engine automatically
   * rolls back the optimistic update (ObjectPool + IndexedDB) — watch
   * `sync.syncStatus` for transitions to detect rejections.
   *
   * ```ts
   * await sync.tasks.create({ title: 'Fix bug' });
   * // UI already shows the task. Server will confirm async.
   * ```
   */
  create(data: CreateInput, options?: MutationOptions): Promise<T>;

  /**
   * Update an entity by ID — **optimistic, offline-first**.
   *
   * Same semantics as `create()`: resolves when queued locally, not when
   * the server confirms. See {@link create} for the full contract.
   *
   * @param options - See {@link MutationOptions}. Passing
   *   `{ idempotencyKey }` ties retries to a single server-side
   *   result; `{ label }` tags the mutation in audit logs.
   */
  update(id: string, data: Partial<T>, options?: MutationOptions): Promise<T>;

  /**
   * Delete an entity by ID — **optimistic, offline-first**.
   *
   * Same semantics as `create()`: resolves when queued locally, not when
   * the server confirms. See {@link create} for the full contract.
   */
  delete(id: string, options?: MutationOptions): Promise<void>;

  /** Subscribe to changes (callback called on every change) */
  subscribe(
    callback: (entities: T[]) => void,
    options?: { where?: Partial<T> }
  ): () => void;
}

/** The typed sync engine client — one property per model in the schema */
export type SyncEngine<S extends SchemaRecord> = {
  readonly [K in keyof S & string]: ModelOperations<
    InferModel<Schema<S>, K>,
    InferCreate<Schema<S>, K>
  >;
} & {
  /**
   * Wait for the sync engine to finish its initial bootstrap.
   * Resolves once entity data is loaded and the WebSocket is connected.
   *
   * ```ts
   * const sync = createSyncEngine({ schema, user });
   * await sync.ready();
   * const tasks = sync.tasks.findMany(); // data is available
   * ```
   *
   * If bootstrap fails, this rejects with the underlying error (unreachable
   * server, invalid API key, 500 from bootstrap endpoint, etc.).
   *
   * Idempotent — calling it multiple times returns the same promise.
   */
  ready(): Promise<void>;

  /**
   * Wait for all pending mutations to be confirmed by the server.
   *
   * Sync engine mutations (`create`/`update`/`delete`) are optimistic and
   * resolve immediately. Use this when you need to know the server has
   * acknowledged everything before continuing — for example, before
   * navigating away, before triggering a server-side workflow, or in tests.
   *
   * Resolves when `syncStatus.pendingChanges` reaches 0. If the engine is
   * offline, this waits until reconnect + flush completes.
   *
   * ```ts
   * await sync.tasks.create({ title: 'A' });
   * await sync.tasks.create({ title: 'B' });
   * await sync.waitForFlush(); // server has both tasks
   * ```
   *
   * @param timeoutMs - Optional timeout. Default: no timeout (wait forever).
   *                    Throws `Error('Flush timeout')` if reached with pending changes.
   */
  waitForFlush(timeoutMs?: number): Promise<void>;

  /** Disconnect and clean up */
  dispose(): Promise<void>;

  /**
   * Destroy every IndexedDB database owned by this engine. Disconnects
   * the WebSocket, releases timers, and deletes all `ablo_*` / `ablo-*`
   * databases. Use on session expiry or explicit logout. Best-effort.
   */
  purge(): Promise<void>;

  /**
   * Subscribe to session-error events (server rejected the session).
   * Returns an unsubscribe function. Multiple subscribers supported.
   * Typically called by `<AbloProvider>`, which calls `purge()` on fire
   * and forwards to the consumer's `onSessionExpired` callback.
   */
  onSessionError(listener: (error: Error) => void): () => void;

  /**
   * Reactive sync status — a MobX observable.
   *
   * Single source of truth for "what's the sync engine doing?" Contains:
   * - `state`: `'idle' | 'syncing' | 'error' | 'offline' | 'reconnecting'`
   * - `progress`: 0-100 for bootstrap progress
   * - `error?`: Error object when `state === 'error'`
   * - `pendingChanges`: Number of unconfirmed mutations in the queue
   * - `lastSyncAt?`: Timestamp of the last successful delta processing
   * - `offlineSince?`: When the connection dropped
   * - `isSessionError`: True when the error requires re-authentication
   *
   * React components using `observer()` re-render automatically when
   * any field changes — no manual subscription or polling needed.
   *
   * ```tsx
   * import { observer } from 'mobx-react-lite';
   *
   * const SyncIndicator = observer(() => {
   *   if (sync.syncStatus.state === 'syncing') return <Spinner />;
   *   if (sync.syncStatus.state === 'error') return <Error msg={sync.syncStatus.error} />;
   *   if (sync.syncStatus.state === 'offline') return <OfflineBadge />;
   *   return null;
   * });
   * ```
   */
  readonly syncStatus: SyncStatus;

  /** The underlying schema */
  readonly schema: Schema<S>;

  // ── Internal accessors for framework integration ─────────────────

  /**
   * The internal BaseSyncedStore. Implements SyncStoreContract — pass to
   * SyncContext.Provider so the SDK's useModel/useModels/useMutations hooks
   * can access it. Also satisfies useSyncStore() consumers during migration.
   */
  readonly _store: SyncStoreContract;

  /** The ObjectPool — for demand loaders and direct pool operations. */
  readonly _pool: ObjectPool;

  /**
   * The SyncWebSocket handle — for collaboration events (slide selection,
   * cursor broadcast). Null until the engine connects.
   */
  readonly _ws: SyncWebSocket | null;
};

// ── Config derivation from schema ─────────────────────────────────────────

function deriveConfigFromSchema(schema: Schema): SyncEngineConfig {
  const models = Object.keys(schema.models);
  const priority = new Map<string, number>();
  const belongsToTargets = new Set<string>();

  // Walk relations to determine parent/child ordering
  for (const [modelName, modelDef] of Object.entries(schema.models)) {
    for (const rel of Object.values(modelDef.relations)) {
      if (rel.type === 'belongsTo') {
        belongsToTargets.add(rel.target);
      }
    }
  }

  // Parents get priority 10, children get 20, others get 15
  for (const name of models) {
    if (belongsToTargets.has(name)) {
      priority.set(name, 10); // parent
    } else {
      const hasParent = Object.values(schema.models[name].relations)
        .some(r => r.type === 'belongsTo');
      priority.set(name, hasParent ? 20 : 15);
    }
  }

  // Commit payload projection is done directly inside `TransactionQueue`
  // — see `projectCommitPayload` there. Each model's field metadata
  // rides on `ModelRegistry` (populated by `registerModelsFromSchema`),
  // so there's no config-layer shim: the queue asks the registry for
  // the declared fields and serializes accordingly.
  return {
    modelCreatePriority: priority,
    defaultCreatePriority: 30,
    defaultNonCreatePriority: 50,
    batchableModels: new Set(models.map(n => n.toLowerCase())),
    dedicatedDeleteModels: new Set(),
    essentialFields: {},
    classNameFallbackMap: {},
    preserveCaseModels: new Set(),
  };
}

// ── Auto model registration from schema ───────────────────────────────────

function registerModelsFromSchema(schema: Schema, registry: ModelRegistry): void {
  registry.startBatch();

  for (const [schemaKey, modelDef] of Object.entries(schema.models)) {
    // Use typename as the model name — this is the wire-format name that
    // the server sends in bootstrap responses and sync deltas. The pool's
    // typeIndex, the ModelRegistry, and getModelName() all use this name.
    // Schema key (camelCase plural) is only for the consumer-facing proxy API.
    const modelName = modelDef.typename ?? schemaKey;

    // Collect JSON sub-property fields to generate ${field}Json getters
    const jsonSubFields: Array<{ fieldName: string; subSchema: z.ZodObject<z.ZodRawShape> }> = [];

    for (const [fieldName, zodType] of Object.entries(modelDef.shape)) {
      const inner = unwrapZodType(zodType);
      if (isZodObject(inner)) {
        jsonSubFields.push({ fieldName, subSchema: inner });
      }
    }

    // Create a dynamic Model subclass with JSON sub-property getters
    const isLazy = modelDef.lazyObservable === true;
    const fieldNames = Object.keys(modelDef.shape);
    const computed = (modelDef as { computed?: Record<string, (self: Record<string, unknown>) => unknown> }).computed;
    const DynamicModel = createDynamicModelClass(modelName, jsonSubFields, fieldNames, computed, isLazy);

    // Respect the schema's load strategy so lazy models skip IDB hydration + bootstrap
    const loadStrategy = modelDef.load === 'lazy' || modelDef.load === 'manual'
      ? LoadStrategy.lazy
      : LoadStrategy.instant;

    registry.registerModel(modelName, DynamicModel, {
      loadStrategy,
      fields: modelDef.fields,
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
    for (const [fieldName, zodType] of Object.entries(modelDef.shape)) {
      const isOptional = zodType.isOptional?.() ?? false;
      // A field is indexed if it's the FK of a `belongsTo({ index: true })`
      // relation. Legacy `description === 'indexed'` still works for
      // consumers using `field.*().indexed()`.
      const isIndexed =
        indexedFields.has(fieldName) || zodType.description === 'indexed';
      registry.registerProperty(modelName, fieldName, {
        type: PropertyType.property,
        indexed: isIndexed,
        optional: isOptional,
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
        const orderByField = (relDef as unknown as Record<string, unknown>)._orderBy as string | undefined;

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
                const va = (a as unknown as Record<string, unknown>)[orderByField];
                const vb = (b as unknown as Record<string, unknown>)[orderByField];
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
 * Unwrap a Zod schema through .describe(), .optional(), .nullable(),
 * .default() to find the innermost type. Needed to detect whether a
 * field.json() call wraps a ZodObject (has sub-properties) or a plain
 * type (ZodUnknown, ZodArray, etc.).
 */
function unwrapZodType(schema: z.ZodTypeAny): z.ZodTypeAny {
  let current = schema;
  for (let i = 0; i < 10; i++) {
    const def = (current as unknown as { _def: { typeName?: string; innerType?: z.ZodTypeAny } })._def;
    if (!def) break;
    const tn = def.typeName;
    if (tn === 'ZodOptional' || tn === 'ZodNullable' || tn === 'ZodDefault' || tn === 'ZodEffects') {
      if (def.innerType) { current = def.innerType; continue; }
    }
    break;
  }
  return current;
}

/** Type guard: is this a ZodObject with a .shape property? */
function isZodObject(schema: z.ZodTypeAny): schema is z.ZodObject<z.ZodRawShape> {
  return (schema as unknown as { _def: { typeName?: string } })._def?.typeName === 'ZodObject';
}

/** Create a Model subclass for a schema-defined model */
function createDynamicModelClass(
  modelName: string,
  jsonSubFields: Array<{ fieldName: string; subSchema: z.ZodObject<z.ZodRawShape> }>,
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

    getModelName(): string {
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

// ── Default console logger ────────────────────────────────────────────────

const consoleLogger: SyncLogger = {
  debug: (...args: unknown[]) => { if (typeof console !== 'undefined') console.debug('[sync]', ...args); },
  info: (...args: unknown[]) => { if (typeof console !== 'undefined') console.info('[sync]', ...args); },
  warn: (...args: unknown[]) => { if (typeof console !== 'undefined') console.warn('[sync]', ...args); },
  error: (...args: unknown[]) => { if (typeof console !== 'undefined') console.error('[sync]', ...args); },
};

// ── Default mutation executor (wire: batch_ack frame, method: commit) ────

/**
 * Derive a stable `Idempotency-Key` from the batch's operation set.
 *
 * Retries of the same batch compute the same key — a reconnecting
 * client that rebuilds the identical mutations from its offline queue
 * sends the identical key, so the server's `mutation_log` replay path
 * returns the cached response instead of re-executing the mutators.
 *
 * Content-addressed: sort operations by (model, id, type) then sha256
 * the serialized form. Separator-safe — adjacent fields are delimited
 * by a character (`\x1e`, the ASCII record separator) that cannot
 * appear in a JSON string literal. Output length is 70 chars — safely
 * under Stripe's documented 255-char cap.
 *
 * Uses the Web Crypto API (cross-runtime: Node 20+ and browsers), same
 * primitive as the offline queue's AES-GCM encryption.
 *
 * @internal — exported as unexported file-local; callers go through
 * the executor's own `Idempotency-Key` plumbing.
 */
async function deriveOperationsIdempotencyKey(
  operations: ReadonlyArray<{
    type: string;
    model: string;
    id: string;
    input?: Record<string, unknown>;
  }>,
): Promise<string> {
  const normalized = [...operations]
    .map((op) => ({
      type: op.type,
      model: op.model,
      id: op.id,
      input: op.input ?? null,
    }))
    .sort((a, b) => {
      if (a.model !== b.model) return a.model < b.model ? -1 : 1;
      if (a.id !== b.id) return a.id < b.id ? -1 : 1;
      return a.type < b.type ? -1 : a.type > b.type ? 1 : 0;
    });
  const encoded = new TextEncoder().encode(JSON.stringify(normalized));
  const digest = await crypto.subtle.digest('SHA-256', encoded);
  const bytes = new Uint8Array(digest);
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, '0');
  }
  return `batch-${hex}`;
}

function createDefaultMutationExecutor(baseUrl: string, apiKey?: string): MutationExecutor {
  const gqlUrl = `${baseUrl.replace(/^ws/, 'http')}/graphql`;

  const baseHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) baseHeaders['X-API-Key'] = apiKey;

  async function commit(
    operations: Array<{ type: string; model: string; id: string; input?: Record<string, unknown> }>,
    options?: MutationOptions,
  ) {
    // Per-call headers start from the base set so concurrent calls
    // with different idempotency keys don't clobber each other.
    const headers: Record<string, string> = { ...baseHeaders };
    // Derive a stable idempotency key from the operation set itself
    // so retries of the SAME batch hit the server's mutation_log
    // replay path. The derivation is content-addressed (sorted +
    // sha256), so a reconnecting client that rebuilds the same batch
    // from its offline queue computes the same key — no persistence
    // needed beyond the IndexedDB tx rows we already have.
    //
    // Caller-supplied `options.idempotencyKey` wins (explicit > auto);
    // passing `null` opts out entirely (rare — each retry mints fresh).
    const keyOption = options?.idempotencyKey;
    if (keyOption === null) {
      // Explicit opt-out: no header sent.
    } else if (typeof keyOption === 'string') {
      headers['Idempotency-Key'] = keyOption;
    } else if (operations.length > 0) {
      headers['Idempotency-Key'] = await deriveOperationsIdempotencyKey(
        operations,
      );
    }

    // Per-request timeout via AbortSignal. The caller's timeout MUST NOT
    // leak across retries — each attempt gets a fresh signal.
    const controller = options?.timeout !== undefined ? new AbortController() : undefined;
    const timer =
      controller && options?.timeout !== undefined
        ? setTimeout(() => controller.abort(), options.timeout)
        : undefined;

    try {
      const res = await fetch(gqlUrl, {
        method: 'POST',
        credentials: apiKey ? 'omit' : 'include',
        headers,
        signal: controller?.signal,
        body: JSON.stringify({
          query: `mutation BatchAck($operations: [MutationOperation!]!) { batchAck(operations: $operations) { lastSyncId } }`,
          variables: { operations },
        }),
      });
      if (!res.ok) {
        // Route through the typed-error translator so callers get
        // `AbloAuthenticationError`/`AbloRateLimitError`/etc. instead
        // of a generic `Error`. Body is parsed best-effort.
        const requestId = res.headers.get('x-request-id') ?? undefined;
        const body = await res.text().catch(() => '');
        let parsed: unknown = body;
        try {
          parsed = JSON.parse(body);
        } catch {
          /* keep as text */
        }
        throw translateHttpError(res.status, parsed, requestId);
      }
      const json = await res.json();
      return { lastSyncId: json.data?.batchAck?.lastSyncId ?? 0 };
    } catch (err) {
      // AbortError → AbloConnectionError (caller's timeout fired).
      // Native fetch network errors (DOMException, TypeError) → same.
      if (err instanceof AbloError) throw err;
      if (err instanceof Error) {
        if (err.name === 'AbortError' || err.name === 'TimeoutError') {
          throw new AbloConnectionError(err.message, { cause: err });
        }
        if (err.message && /fetch|network|ECONN/i.test(err.message)) {
          throw new AbloConnectionError(err.message, { cause: err });
        }
      }
      throw err;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  return {
    commit,
    executeCreate: (model, id, input, _txId, options) =>
      commit([{ type: 'CREATE', model: model.toLowerCase(), id, input }], options).then(() => {}),
    executeUpdate: (model, id, data, _txId, options) =>
      commit([{ type: 'UPDATE', model: model.toLowerCase(), id, input: data }], options),
    executeDelete: (model, id, _txId, options) =>
      commit([{ type: 'DELETE', model: model.toLowerCase(), id }], options).then(() => {}),
    executeArchive: (model, id, _txId, options) =>
      commit([{ type: 'ARCHIVE', model: model.toLowerCase(), id }], options).then(() => {}),
    executeUnarchive: (model, id, _txId, options) =>
      commit([{ type: 'UNARCHIVE', model: model.toLowerCase(), id }], options).then(() => {}),
  };
}

// ── Default mutation dispatcher (for offline flush) ───────────────────────

function createDefaultMutationDispatcher(executor: MutationExecutor): MutationDispatcher {
  return {
    async dispatch(opName: string, variables: Record<string, unknown>) {
      const prefixes = ['Create', 'Update', 'Delete', 'Archive', 'Unarchive'] as const;
      for (const prefix of prefixes) {
        if (opName.startsWith(prefix)) {
          const model = opName.slice(prefix.length);
          const v = variables;
          const input = (prefix === 'Create' || prefix === 'Update')
            ? v.input as Record<string, unknown>
            : undefined;
          await executor.commit([{
            type: prefix.toUpperCase(),
            model: model.toLowerCase(),
            id: (v.id as string) ?? '',
            input,
          }]);
          return;
        }
      }
    },
  };
}

// ── Model operations proxy ────────────────────────────────────────────────

function createModelProxy<T, C>(
  modelName: string,
  objectPool: ObjectPool,
  syncClient: SyncClient,
  registry: ModelRegistry,
): ModelOperations<T, C> {
  const ModelClass = registry.getModelByName(modelName)!;

  return {
    findById(id: string): T | undefined {
      return objectPool.get(id) as T | undefined;
    },

    findMany(options): T[] {
      const all = objectPool.getByType(ModelClass) as T[];
      let result = all;

      if (options?.where) {
        const where = options.where as Record<string, unknown>;
        result = result.filter(item => {
          for (const [key, value] of Object.entries(where)) {
            if ((item as Record<string, unknown>)[key] !== value) return false;
          }
          return true;
        });
      }

      if (options?.orderBy) {
        const [field, dir] = Object.entries(options.orderBy)[0];
        result = [...result].sort((a, b) => {
          const av = (a as Record<string, unknown>)[field];
          const bv = (b as Record<string, unknown>)[field];
          if (av == null || bv == null) return 0;
          const cmp = av < bv ? -1 : av > bv ? 1 : 0;
          return dir === 'desc' ? -cmp : cmp;
        });
      }

      if (options?.offset) result = result.slice(options.offset);
      if (options?.limit) result = result.slice(0, options.limit);

      return result;
    },

    findFirst(options): T | undefined {
      return this.findMany({ ...options, limit: 1 })[0];
    },

    count(options): number {
      return this.findMany(options).length;
    },

    /**
     * Create an entity with optimistic insertion.
     *
     * Returns immediately with the optimistic model. The mutation is queued
     * and confirmed asynchronously by the server — track confirmation via
     * `engine.syncStatus.pendingChanges` or call `engine.waitForFlush()` if
     * you need to wait for the server to acknowledge.
     *
     * This is the standard sync engine pattern (Linear, Replicache, Convex):
     * mutations apply optimistically so the UI stays instant. If the server
     * rejects the mutation, it rolls back automatically and emits an error
     * on `syncStatus.error`.
     *
     * Note: this returns `Promise<T>` for symmetry with REST/Prisma APIs,
     * but the Promise resolves *immediately* — there's no `await` cost.
     */
    async create(data: C, _options?: MutationOptions): Promise<T> {
      // TODO(options-persistence): stash `_options` alongside the
      // queued transaction so idempotencyKey survives offline flush.
      // For now the options flow as far as the optimistic layer; the
      // executor-level slice wires them to the wire separately.
      const model = new ModelClass({
        id: Model.generateId(),
        ...data as Record<string, unknown>,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      syncClient.add(model);
      return model as unknown as T;
    },

    /**
     * Update an entity with optimistic patch.
     *
     * Resolves immediately with the patched model. The diff is queued and
     * sent to the server. On rejection, the model rolls back to its previous
     * state automatically. Use `engine.waitForFlush()` to wait for confirmation.
     */
    async update(id: string, data: Partial<T>, _options?: MutationOptions): Promise<T> {
      const model = objectPool.get(id);
      if (!model)
        throw new AbloValidationError(`Entity not found: ${modelName}/${id}`, {
          code: 'entity_not_found',
        });
      model.updateFromData(data as Record<string, unknown>);
      syncClient.update(model);
      return model as unknown as T;
    },

    /**
     * Delete an entity with optimistic removal.
     *
     * Resolves immediately. The entity disappears from queries instantly.
     * If the server rejects the delete, the entity is restored. Use
     * `engine.waitForFlush()` to wait for server confirmation.
     */
    async delete(id: string, _options?: MutationOptions): Promise<void> {
      const model = objectPool.get(id);
      if (!model)
        throw new AbloValidationError(`Entity not found: ${modelName}/${id}`, {
          code: 'entity_not_found',
        });
      syncClient.delete(model);
    },

    subscribe(callback, options): () => void {
      // Simple polling-based subscription using MobX autorun
      const { autorun } = require('mobx');
      return autorun(() => {
        const entities = this.findMany(options ? { where: options.where } : undefined);
        callback(entities);
      });
    },
  };
}

// ── The factory ───────────────────────────────────────────────────────────

/**
 * Create a sync engine client in one call.
 *
 * ```ts
 * const sync = createSyncEngine({
 *   url: 'wss://api.example.com',
 *   schema,
 * });
 *
 * const tasks = sync.tasks.findMany({ where: { status: 'todo' } });
 * await sync.tasks.create({ title: 'New task' });
 * ```
 */
export function createSyncEngine<const S extends SchemaRecord>(
  options: SyncEngineOptions<S>
): SyncEngine<S> {
  const { url, schema, logger = consoleLogger } = options;

  // 1. Derive config from schema
  // 1. Derive config from schema, then layer caller-supplied overrides on top.
  //    `configOverrides` is a shallow merge: caller takes precedence per key.
  const config: SyncEngineConfig = {
    ...deriveConfigFromSchema(schema),
    ...options.configOverrides,
  };

  // 2. Create the mutation executor + dispatcher.
  //    If the caller supplied their own (e.g., Ablo's GraphQLClientWrapper-
  //    backed executor with cookie auth + observability), use it as-is.
  //    Otherwise fall back to the built-in fetch-based defaults.
  const executor: MutationExecutor =
    options.mutationExecutor ?? createDefaultMutationExecutor(url, options.apiKey);
  const dispatcher: MutationDispatcher =
    options.mutationDispatcher ?? createDefaultMutationDispatcher(executor);

  // 3. Initialize SDK context (one call — hides all DI wiring).
  //    Each provider can be overridden individually; the noop defaults
  //    are preserved for the zero-config consumer path.
  initSyncEngine({
    logger,
    observability: options.observability ?? noopObservability,
    analytics: options.analytics ?? noopAnalytics,
    sessionErrorDetector: options.sessionErrorDetector ?? defaultSessionErrorDetector,
    onlineStatus: options.onlineStatus ?? (options.inMemory ? alwaysOnline() : browserOnlineStatus),
    config,
    mutationExecutor: executor,
    mutationDispatcher: dispatcher,
  });

  // 4. Create internal components (user never sees these)
  const modelRegistry = new ModelRegistry({
    validateOnRegister: false,
    allowLateReferences: true,
  });
  registerModelsFromSchema(schema, modelRegistry);
  setActiveRegistry(modelRegistry);

  const objectPool = new ObjectPool(
    { maxSize: options.maxPoolSize ?? 10000 },
    modelRegistry,
  );

  // Derive instant-bootstrap model names from schema load strategies.
  // Models with load: 'lazy' or 'manual' are excluded from the initial
  // bootstrap request — they'll be fetched on demand by the ensure* loaders
  // or (Phase 6) by the ObjectPool auto-fetch mechanism.
  // Default load strategy is 'instant' for backward compatibility.
  const schemaModels = (schema as { models?: Record<string, unknown> }).models ?? schema;
  const instantModels = Object.entries(schemaModels).flatMap(([key, def]) => {
    if (!def || typeof def !== 'object' || !('load' in def)) return [key]; // no load → instant
    const load = (def as { load?: string }).load;
    if (!load || load === 'instant') return [(def as { typename?: string }).typename ?? key];
    return []; // lazy or manual → skip
  });

  // BootstrapHelper baseUrl: caller can override. Note that the helper
  // appends `/api` itself, so the default below produces `${url}/api/api`
  // — preserved for backward compatibility. Callers passing
  // `bootstrapBaseUrl` should provide the bare host without `/api`.
  const bootstrapHelper = new BootstrapHelper({
    baseUrl: options.bootstrapBaseUrl ?? `${url.replace(/^ws/, 'http')}/api`,
    organizationId: options.user?.organizationId ?? '',
    syncGroups: options.syncGroups,
    instantModels,
  });

  const database = new Database(modelRegistry, bootstrapHelper, {
    inMemory: options.inMemory ?? false,
  });
  const syncClient = new SyncClient(objectPool, database);

  // 5. BaseSyncedStore handles the initialization orchestration
  //    (open DB → hydrate IDB → connect WS → fetch bootstrap → hydrate again →
  //    ready) and exposes the observable `syncStatus` we expose on the engine.
  //
  //    Phase 2: pass the schema into the store so `deriveSyncPlanFromSchema`
  //    can auto-populate version vector keys, FK indexes, and enrichment
  //    rules from the declarative `belongsTo({ index, enrich })` annotations.
  //    Consumers using class-based subclasses with `new SyncedStore(...)`
  //    directly can pass explicit config arrays instead.
  const store = new BaseSyncedStore({
    syncClient,
    database,
    objectPool,
    modelRegistry,
    schema,
    url,
  });

  // 6. Validate options up front — fail loudly on obviously wrong inputs so
  //    strangers don't get silent empty results. Validation errors are written
  //    into `store.syncStatus` (the single source of truth) via helper below.
  let _validationError: Error | null = null;
  if (!url) {
    _validationError = new Error(
      'createSyncEngine: `url` is required. Pass the sync server URL, e.g. ' +
        `createSyncEngine({ url: 'wss://sync.ablo.dev', schema, user })`
    );
  } else if (!schema || !schema.models || Object.keys(schema.models).length === 0) {
    _validationError = new Error(
      'createSyncEngine: `schema` is required and must declare at least one model. ' +
        'Define a schema with defineSchema({ tasks: model({...}) }).'
    );
  } else if (!options.user || !options.user.id) {
    _validationError = new Error(
      'createSyncEngine: `user` is required with a stable `id`. This scopes the ' +
        'local IndexedDB and attributes mutations. For single-player apps, pass a ' +
        "stable device ID like `{ user: { id: 'local-device-1' } }`."
    );
  }
  if (_validationError) {
    logger.error(_validationError.message);
    store.syncStatus.state = 'error';
    store.syncStatus.error = _validationError;
  }

  // 7. Build the typed proxy — one property per model
  const modelProxies: Record<string, ModelOperations<unknown, unknown>> = {};
  for (const modelName of Object.keys(schema.models)) {
    modelProxies[modelName] = createModelProxy(
      modelName, objectPool, syncClient, modelRegistry,
    );
  }

  // 8. The ready() promise drives the BaseSyncedStore.initialize() generator
  //    to completion. First call kicks off the initialization; subsequent
  //    calls return the same promise (idempotent).
  //
  //    Status is tracked in store.syncStatus (MobX observable) — the single
  //    source of truth. No duplicate closure variables.
  let _readyPromise: Promise<void> | null = null;

  async function ready(): Promise<void> {
    if (_readyPromise) return _readyPromise;

    if (_validationError) {
      _readyPromise = Promise.reject(_validationError);
      return _readyPromise;
    }

    _readyPromise = (async () => {
      try {
        // User context from the required `user` option — no fabrication.
        const userId = options.user.id;
        const organizationId = options.user.organizationId ?? '';
        const teamIds = options.user.teamIds;

        // Drive the generator to completion. Each yielded promise is awaited
        // then fed back — this is standard generator consumption.
        //
        // The store.initialize() generator updates store.syncStatus as it
        // progresses (syncing → idle on success, error on failure), so the
        // consumer's `sync.syncStatus` observable reflects real-time state.
        const gen = store.initialize({ userId, organizationId, teamIds });
        let current = gen.next();
        while (!current.done) {
          const yielded = current.value;
          const resolved = yielded instanceof Promise ? await yielded : yielded;
          current = gen.next(resolved);
        }

        const result = current.value;
        if (!result.success) {
          throw result.error ?? new Error('Sync engine initialization failed');
        }

        logger.info('Sync engine ready', { models: Object.keys(schema.models).length });
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        // Make sure syncStatus reflects the failure for observer() components
        store.syncStatus.state = 'error';
        store.syncStatus.error = error;
        logger.error('Sync engine failed to initialize', { error: error.message });
        throw error;
      }
    })();

    return _readyPromise;
  }

  // 9. Optional auto-start for convenience. Opt-in because silent background
  //    init has historically been the #1 source of "why isn't my data loading"
  //    bug reports. Explicit `await sync.ready()` is the default — errors
  //    surface immediately instead of being swallowed.
  if (!_validationError && options.autoStart) {
    void ready().catch(() => {
      // Error is captured in store.syncStatus; consumers should check
      // `sync.syncStatus.state === 'error'` to detect failures.
    });
  }

  // 9b. waitForFlush — drains pending mutations using the store's
  //     pendingChanges counter (already maintained by BaseSyncedStore based
  //     on TransactionQueue events). Polls every 50ms; uses the existing
  //     observable rather than introducing a new event channel.
  async function waitForFlush(timeoutMs?: number): Promise<void> {
    const start = Date.now();
    while (store.syncStatus.pendingChanges > 0) {
      if (timeoutMs !== undefined && Date.now() - start > timeoutMs) {
        throw new AbloConnectionError(
          `Flush timeout: ${store.syncStatus.pendingChanges} pending mutations after ${timeoutMs}ms`,
          { code: 'flush_timeout' },
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  const engine = {
    ...modelProxies,

    ready,
    waitForFlush,

    async dispose() {
      try {
        await store.disconnect();
      } catch (err) {
        logger.warn('Error during sync engine disposal', { error: (err as Error).message });
      }
      syncClient.dispose();
    },

    /**
     * Destroy every IndexedDB database owned by this engine. Disconnects
     * the WebSocket, releases timers, and deletes all `ablo_*` / `ablo-*`
     * databases. Typically called on session expiry or explicit logout.
     * Best-effort — errors from individual deletions are swallowed.
     */
    async purge() {
      await store.purge();
      syncClient.dispose();
    },

    /**
     * Subscribe to session-error events. Fires when the server rejects
     * the session (WebSocket close code 1008/4001/4003 or a session_error
     * frame). Multiple subscribers supported; returns an unsubscribe
     * function. Consumers typically use this to trigger auth-failed UI
     * flows (e.g., redirect to sign-in). Does NOT automatically purge the
     * IndexedDB — call `engine.purge()` from the listener if you need
     * that behavior (the SDK's `<AbloProvider>` does this by default).
     */
    onSessionError(listener: (error: Error) => void) {
      return store.subscribeSessionError(listener);
    },

    // Expose the store's MobX observable directly — single source of truth.
    // React components using observer() will re-render automatically on
    // any state change (syncing, error, offline, pendingChanges, progress).
    get syncStatus() {
      return store.syncStatus;
    },

    schema,

    // ── Internal accessors for framework integration ─────────────────
    // These expose internal components for consumers that need direct
    // access (e.g., SyncEngineProvider wiring SyncContext, collaboration
    // events accessing the WebSocket handle, demand loaders accessing
    // the pool). Prefixed with _ to signal "internal but stable."

    /** The BaseSyncedStore — implements SyncStoreContract for SyncContext.Provider. */
    get _store() { return store; },

    /** The ObjectPool — for demand loaders that need pool.createFromData(). */
    get _pool() { return objectPool; },

    /** The SyncWebSocket — for collaboration events (slide selection, cursors). */
    get _ws() { return (store as unknown as { syncWebSocket: unknown }).syncWebSocket ?? null; },
  } as SyncEngine<S>;

  return engine;
}
