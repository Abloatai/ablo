/**
 * The store cluster — what `humans()` constructs at `init` now that the
 * plugin context carries the resolved url and the credential source
 * (ADR 0016; docs/plans/package-split.md, sequence step 2): this client's
 * runtime, the internal component graph, the registered model classes, and
 * the `BaseSyncedStore` that orchestrates them. The engine consumes the
 * cluster instead of constructing it; what remains in the composition root
 * (credential lifecycle, ready(), model proxies, resources) migrates in
 * later steps.
 *
 * The cluster rides the humans surface under {@link kStoreCluster}, a
 * symbol: `layerPluginSurface` merges only string-keyed members onto the
 * client, so the handoff never becomes public client API. When the plugin
 * contract adopts context patches (the decoration end-state), this channel
 * dissolves into them.
 */

import type { PluginContext } from '../../plugin.js';
import { shouldUseInMemoryPersistence } from '../persistence.js';
import type { MutationExecutor, RuntimeConfig } from '../interfaces/index.js';
import type { ModelRegistry } from '../ModelRegistry.js';
import {
  noopObservability,
  browserOnlineStatus,
  defaultSessionErrorDetector,
  noopAnalytics,
  type RuntimeContext,
} from '../RuntimeContext.js';
import { initRuntime } from '../context.js';
import { alwaysOnline } from '../adapters/alwaysOnline.js';
import { BaseSyncedStore } from '../BaseSyncedStore.js';
import { SyncWebSocket } from '../sync/SyncWebSocket.js';
import {
  createInternalComponents,
  type InternalComponents,
} from './createInternalComponents.js';
import { registerModelsFromSchema } from './modelRegistration.js';
import { deriveConfigFromSchema } from './schemaConfig.js';
import { createDefaultMutationExecutor } from './wsMutationExecutor.js';
import type { InternalAbloOptions } from './options.js';
import {
  createReadSetContext,
  type ReadSetContext,
} from '@abloatai/transaction/internal/read-set';
export type { InternalAbloOptions } from './options.js';

/**
 * The private handoff slot on the humans surface. Symbol-keyed on purpose:
 * surface members merge onto the client by string key, and the cluster is
 * construction machinery, not client API.
 */
export const kStoreCluster = Symbol.for('ablo.humans.store-cluster');

/** What `humans().init` constructs and the engine consumes. */
export interface StoreCluster {
  /** This client's runtime — every component below was constructed with it. */
  readonly runtime: RuntimeContext;
  /** The component graph: registry, pool, bootstrap, database, sync client, hydration. */
  readonly components: InternalComponents;
  /** The store orchestrating the graph, holding the host-built connection. */
  readonly store: BaseSyncedStore;
  /** Client-local opaque evidence registry; never an ambient execution scope. */
  readonly readSetContext: ReadSetContext;
}

/**
 * The contract types the connection as the core `WsTransport`; on the
 * reactive path the factory constructs the materialising subclass with the
 * default collaboration vocabulary, and this guard is where that knowledge
 * becomes a type. A connection that is not the subclass means the cluster
 * cannot be built here.
 */
function isReactiveSocket(transport: unknown): transport is SyncWebSocket {
  if (!transport || typeof transport !== 'object') return false;
  const candidate = transport as Record<string, unknown>;
  return [
    'subscribe',
    'sendCollaborationEvent',
    'disconnect',
    'isConnected',
    'getSyncGroups',
    'setSyncGroups',
    'setLastSyncId',
    'getLastSyncId',
    'acknowledge',
    'allowConnect',
    'connect',
  ].every((method) => typeof candidate[method] === 'function');
}

/**
 * Builds the cluster from what the context carries, or returns `null` when
 * it does not carry enough (no connection, no resolved url, no credential
 * source, or no schema on the options bag) — the same tolerance the
 * presence stream established: `init` constructs what the context can
 * support and no more. The reactive factory always supplies all four and
 * treats a missing cluster as a configuration fault.
 */
export function buildStoreCluster(
  context: PluginContext<InternalAbloOptions>,
): StoreCluster | null {
  const options = context.options;
  const { url, auth, transport, logger } = context;
  if (!options?.schema || !url || !auth || !isReactiveSocket(transport)) {
    return null;
  }
  const schema = options.schema;
  const readSetContext = createReadSetContext();

  // Config derives from the schema; caller-supplied overrides layer on top,
  // caller winning per key.
  const config: RuntimeConfig = {
    ...deriveConfigFromSchema(schema),
    ...options.configOverrides,
  };

  // The default executor sends `{ type: 'commit', ... }` over the context's
  // connection; before it opens, sends reject with the diagnosed not-ready
  // error and the MutationQueue owns the retry. A caller-supplied executor
  // still wins (test mocks, alternative transports).
  const executor: MutationExecutor =
    options.mutationExecutor ?? createDefaultMutationExecutor(
      () => transport,
      readSetContext,
    );

  // This client's runtime — the instance the whole graph is constructed
  // with, so two clients in one process never read each other's logger,
  // config, or executor. `getModelMetadata` closes over this client's own
  // registry (assigned once the graph exists below), never the
  // active-registry global.
  let registryForMetadata: ModelRegistry | undefined = undefined;
  const runtime: RuntimeContext = {
    logger,
    observability: options.observability ?? noopObservability,
    analytics: options.analytics ?? noopAnalytics,
    sessionErrorDetector: options.sessionErrorDetector ?? defaultSessionErrorDetector,
    onlineStatus:
      options.onlineStatus ??
      (shouldUseInMemoryPersistence(options) ? alwaysOnline() : browserOnlineStatus),
    config,
    mutationExecutor: executor,
    getModelMetadata: (name) => registryForMetadata?.getMetadata(name),
  };
  // The module-global bridge: code not yet constructed with an instance
  // (model instances, the react hooks, the socket's context ports) still
  // reads it. Last-writer-wins there, exactly as before the runtime became
  // per-client. Retired reference by reference (docs/plans/package-split.md).
  initRuntime(runtime);

  const components = createInternalComponents({
    schema,
    url,
    options,
    auth,
    runtime,
  });
  registryForMetadata = components.modelRegistry;
  registerModelsFromSchema(schema, components.modelRegistry);

  const store = new BaseSyncedStore(
    {
      syncClient: components.syncClient,
      database: components.database,
      objectPool: components.objectPool,
      modelRegistry: components.modelRegistry,
      syncWebSocket: transport,
      schema,
      url,
      auth,
      runtime,
      // The resolved list, so the store's delta pipeline dispatches the
      // declared stage handlers — including this plugin's own `apply`.
      stagePlugins: context.plugins ?? [],
    },
    // Collaboration vocabulary is the application's: the SDK subscribes to
    // the event types the caller declares and to nothing by default.
    { collaborationEvents: options.collaborationEvents ?? [] },
  );

  return { runtime, components, store, readSetContext };
}
