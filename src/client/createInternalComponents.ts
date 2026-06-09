/**
 * Internal component construction for `Ablo()`.
 *
 * Builds the full sync-engine component graph from options + schema:
 * `ModelRegistry`, `ObjectPool`, `BootstrapHelper`, `Database`,
 * `SyncClient`, `HydrationCoordinator`. Each component depends on
 * the previous one, so the construction order matters; isolating it
 * here means `Ablo.ts` doesn't need to know the dependency order.
 *
 * Mirrors the pattern Anthropic uses: their client constructor wires
 * endpoint modules. Ours wires the sync-engine components instead.
 */

import { Database } from '../Database.js';
import { ModelRegistry, setActiveRegistry } from '../ModelRegistry.js';
import { ObjectPool } from '../ObjectPool.js';
import { SyncClient } from '../SyncClient.js';
import { HydrationCoordinator } from '../sync/HydrationCoordinator.js';
import { BootstrapHelper } from '../sync/BootstrapHelper.js';
import type { AuthCredentialSource } from '../auth/credentialSource.js';
import type { Schema, SchemaRecord } from '../schema/schema.js';
import { resolveBootstrapBaseUrl } from './auth.js';
import { shouldUseInMemoryPersistence, type AbloPersistence } from './persistence.js';

export interface InternalComponentsInput<S extends SchemaRecord> {
  readonly schema: Schema<S>;
  /** WebSocket URL — used to derive bootstrap HTTP base when the
   * caller didn't override `bootstrapBaseUrl`. */
  readonly url: string;
  readonly options: {
    readonly maxPoolSize?: number;
    readonly bootstrapBaseUrl?: string;
    readonly syncGroups?: string[];
    readonly persistence?: AbloPersistence;
    readonly offline?: boolean;
    readonly inMemory?: boolean;
  };
  readonly auth?: AuthCredentialSource;
}

export interface InternalComponents {
  readonly modelRegistry: ModelRegistry;
  readonly objectPool: ObjectPool;
  readonly bootstrapHelper: BootstrapHelper;
  readonly database: Database;
  readonly syncClient: SyncClient;
  readonly hydration: HydrationCoordinator;
}

export function createInternalComponents<S extends SchemaRecord>(
  input: InternalComponentsInput<S>,
): InternalComponents {
  const { schema, url, options, auth } = input;

  // The registry is created here but model registration happens in
  // the caller (Ablo.ts owns `registerModelsFromSchema` since the
  // schema-to-class translation depends on private helpers there).
  const modelRegistry = new ModelRegistry({
    validateOnRegister: false,
    allowLateReferences: true,
  });
  setActiveRegistry(modelRegistry);

  const objectPool = new ObjectPool(
    { maxSize: options.maxPoolSize ?? 10000 },
    modelRegistry,
  );

  const bootstrapBaseUrl = resolveBootstrapBaseUrl({
    url,
    bootstrapBaseUrl: options.bootstrapBaseUrl,
  });
  const bootstrapHelper = new BootstrapHelper({
    baseUrl: bootstrapBaseUrl,
    syncGroups: options.syncGroups,
    instantModels: deriveInstantModels(schema),
    getAuthToken: auth?.getAuthToken,
  });

  const database = new Database(modelRegistry, bootstrapHelper, {
    // Point-solution default: no browser-local durable store unless the
    // caller explicitly asks for it. Node/edge runtimes always use the
    // in-memory store because IndexedDB is unavailable there.
    inMemory: shouldUseInMemoryPersistence(options),
  });
  const syncClient = new SyncClient(objectPool, database);

  // Lazy-load lane: hydrates pool/IDB on `ablo.<model>.load(...)` for
  // entities not in scope at bootstrap (`load: 'lazy'` models, or
  // entities accessed via deep-link before the pool warmed up).
  // Single-flight + IDB write-through.
  const hydration = new HydrationCoordinator({
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
  syncClient.on('sync:reconnecting', () => hydration.invalidate());

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
 * Derive instant-bootstrap model names from schema load strategies.
 * Models with `load: 'lazy'` or `'manual'` are excluded from the
 * initial bootstrap request — they're fetched on demand by the
 * `ensure*` loaders or (Phase 6) by the `ObjectPool` auto-fetch
 * mechanism. Default load strategy is `'instant'`.
 */
function deriveInstantModels<S extends SchemaRecord>(
  schema: Schema<S>,
): string[] {
  const schemaModels =
    (schema as { models?: Record<string, unknown> }).models ?? schema;
  return Object.entries(schemaModels).flatMap(([key, def]) => {
    if (!def || typeof def !== 'object' || !('load' in def)) {
      return [key]; // no load → instant
    }
    const load = (def as { load?: string }).load;
    if (!load || load === 'instant') {
      return [(def as { typename?: string }).typename ?? key];
    }
    return []; // lazy or manual → skip
  });
}
