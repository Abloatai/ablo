/**
 * Builds the internal component graph the client runs on.
 *
 * From the caller's options and schema this wires together the model registry,
 * object pool, bootstrap helper, database, sync client, and hydration
 * coordinator. Each component depends on the one before it, so construction
 * order matters; keeping it here means the client constructor does not have to
 * know that order.
 */

import { Database } from '../Database.js';
import { ModelRegistry, setActiveRegistry } from '../ModelRegistry.js';
import { InstanceCache } from '../InstanceCache.js';
import { SyncClient } from '../SyncClient.js';
import { OnDemandLoader } from '../sync/OnDemandLoader.js';
import { BootstrapFetcher } from '../sync/BootstrapFetcher.js';
import type { AuthCredentialSource } from '../transaction/auth/credentialSource.js';
import type { Schema, SchemaRecord } from '../transaction/schema/schema.js';
import { loadsAtBootstrap, type LoadStrategy } from '../transaction/schema/loadStrategy.js';
import { resolveBootstrapBaseUrl } from '../transaction/auth/apiKey.js';
import { shouldUseInMemoryPersistence, type AbloPersistence } from '../transaction/persistence.js';
import type {
  DurableWriteStore,
  DurableWritesConfig,
} from '../transactions/mutations/durableWriteStore.js';
import { resolveDurableWrites } from '../transaction/durableWrites.js';

export interface InternalComponentsInput<S extends SchemaRecord> {
  readonly schema: Schema<S>;
  /** The WebSocket URL. Used to derive the bootstrap HTTP base URL when the
   * caller has not overridden `bootstrapBaseUrl`. */
  readonly url: string;
  readonly options: {
    readonly maxPoolSize?: number;
    readonly bootstrapBaseUrl?: string;
    readonly syncGroups?: string[];
    readonly persistence?: AbloPersistence;
    readonly offline?: boolean;
    readonly inMemory?: boolean;
    readonly durableWrites?: DurableWritesConfig;
    /** @deprecated Use `durableWrites`. */
    readonly commitOutbox?: DurableWriteStore;
  };
  readonly auth?: AuthCredentialSource;
}

export interface InternalComponents {
  readonly modelRegistry: ModelRegistry;
  readonly objectPool: InstanceCache;
  readonly bootstrapHelper: BootstrapFetcher;
  readonly database: Database;
  readonly syncClient: SyncClient;
  readonly hydration: OnDemandLoader;
}

export function createInternalComponents<S extends SchemaRecord>(
  input: InternalComponentsInput<S>,
): InternalComponents {
  const { schema, url, options, auth } = input;

  // The registry is created here, but model registration happens in the caller,
  // which owns the schema-to-class translation.
  const modelRegistry = new ModelRegistry({
    validateOnRegister: false,
    allowLateReferences: true,
  });
  setActiveRegistry(modelRegistry);

  const objectPool = new InstanceCache(
    { maxSize: options.maxPoolSize ?? 10000 },
    modelRegistry,
  );

  const bootstrapBaseUrl = resolveBootstrapBaseUrl({
    url,
    bootstrapBaseUrl: options.bootstrapBaseUrl,
  });
  const bootstrapHelper = new BootstrapFetcher({
    baseUrl: bootstrapBaseUrl,
    syncGroups: options.syncGroups,
    instantModels: deriveInstantModels(schema),
    getAuthToken: auth?.getAuthToken,
  });

  const database = new Database(modelRegistry, bootstrapHelper, {
    // By default there is no browser-local durable store unless the caller asks
    // for one. Node and edge runtimes always use the in-memory store because
    // IndexedDB is unavailable there.
    inMemory: shouldUseInMemoryPersistence(options),
  });
  const durableWrites = resolveDurableWrites(options);
  const syncClient = new SyncClient(
    objectPool,
    database,
    durableWrites.store,
    durableWrites.namespace ?? url,
  );

  // Lazy-load lane: hydrates the object pool and IndexedDB on demand for
  // entities not in scope at bootstrap (`load: 'lazy'` models, or an entity
  // reached by deep link before the pool warmed up). Single-flight, with
  // write-through to IndexedDB.
  const hydration = new OnDemandLoader({
    objectPool,
    database,
    registry: modelRegistry,
    schema,
    baseUrl: bootstrapBaseUrl,
    getAuthToken: auth?.getAuthToken,
  });

  // Drop the lazy-lane hydration ledger on reconnect. While connected, the
  // WebSocket delta stream keeps hydrated rows fresh so repeat reads serve
  // pure-local with no network; after a drop, deltas may have been missed, so
  // the next read of each query must re-confirm with the server once.
  syncClient.on('sync:reconnecting', () => { hydration.invalidate(); });

  return {
    modelRegistry,
    objectPool,
    bootstrapHelper,
    database,
    syncClient,
    hydration,
  };
}

/**
 * Derives the set of models to fetch in the initial bootstrap request from each
 * model's load strategy. Models declared `load: 'lazy'` are left out of the
 * bootstrap and fetched on demand instead. The default strategy is
 * `'instant'`, which includes the model.
 */
function deriveInstantModels<S extends SchemaRecord>(
  schema: Schema<S>,
): string[] {
  const schemaModels =
    (schema as { models?: Record<string, unknown> }).models ?? schema;
  return Object.entries(schemaModels).flatMap(([key, def]) => {
    if (!def || typeof def !== 'object' || !('load' in def)) {
      return [key]; // no load → the default strategy
    }
    const load = (def as { load?: LoadStrategy }).load;
    if (loadsAtBootstrap(load)) {
      return [(def as { typename?: string }).typename ?? key];
    }
    return [];
  });
}
