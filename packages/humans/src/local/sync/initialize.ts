import { AbloSessionError } from '@abloatai/transaction/errors';
import type { RuntimeContext } from '../RuntimeContext.js';
import type { BootstrapRequirements, Database } from '../Database.js';
import type { SyncClient } from '../SyncClient.js';
import type { UserContext } from '../BaseSyncedStore.js';
import type { InstanceCache } from '../InstanceCache.js';
import type { DefaultCollaborationEvents, EventMap, SyncWebSocket } from './SyncWebSocket.js';
import type { SyncStatus } from '../storeContract.js';

export interface InitializeHost<
  TCollaboration extends EventMap<TCollaboration> = DefaultCollaborationEvents,
> {
  initialized: boolean;
  userContext: UserContext;
  dataReady: boolean;
  runtime: RuntimeContext;
  database: Database;
  syncClient: SyncClient;
  objectPool: InstanceCache;
  syncWebSocket: SyncWebSocket<TCollaboration>;
  updateSyncStatus(updates: Partial<SyncStatus>): void;
  setupWebSocketSync(context: UserContext, lastSyncId: number): void;
  waitForWebSocketConnected(timeoutMs: number): Promise<boolean>;
  performBackgroundBootstrap(
    requirements: Awaited<ReturnType<Database['requiredBootstrap']>>,
    context: UserContext,
    signal?: AbortSignal,
  ): Promise<void>;
  executeBootstrapWithTimeout(
    fn: () => Promise<void>,
    context: UserContext,
    signal?: AbortSignal,
  ): Promise<void>;
  resolveSyncGroups(context: UserContext): readonly string[];
}

export function* initialize<TCollaboration extends EventMap<TCollaboration>>(
  host: InitializeHost<TCollaboration>,
  context: UserContext,
  signal?: AbortSignal,
): Generator<Promise<void | number | boolean | BootstrapRequirements>, { success: boolean; error?: Error }, void | number | boolean | BootstrapRequirements> {
    if (host.initialized) return { success: true };

    host.userContext = context;

    try {
      host.updateSyncStatus({ state: 'syncing', progress: 0 });

      // The commit outbox and offline mutation journal live in IndexedDB.
      // Open it before SyncClient restores either one; reading first used to
      // make persistence silently look empty on every cold start.
      yield host.database.open({
        participantId: context.userId,
        organizationId: context.organizationId,
        participantKind: context.kind ?? 'user',
        projectId: context.projectId ?? context.organizationId,
        environment: context.environment ?? null,
        sandboxId: context.sandboxId ?? null,
      });

      // Propagate identity only after storage is ready, then restore sealed
      // requests before accepting fresh mutations.
      yield host.syncClient.initialize(
        context.userId,
        context.organizationId,
      );

      // Hydrate from IndexedDB (fast, cached data)
      let hasLocalData = false;
      try {
        yield host.syncClient.hydrateFromDatabase();
        hasLocalData = host.objectPool.size > 0;
      } catch (hydrateError) {
        host.runtime.logger.debug('[sync-engine] IDB hydration failed', { error: hydrateError });
        host.runtime.observability.captureBootstrapFailure(hydrateError, { type: 'hydration-from-idb' });
      }

      // Get sync baseline for WebSocket
      const lastSyncId = (yield host.database.getLastSyncId()) as number;
      host.syncClient.position.advancePersisted(lastSyncId || 0);

      // If local data available, show UI immediately
      if (hasLocalData) {
        host.dataReady = true;
        host.initialized = true;
        host.updateSyncStatus({ state: 'syncing', progress: 50 });
      }

      // Setup WebSocket
      host.setupWebSocketSync(context, lastSyncId);

      // Bootstrap from server if needed.
      //
      // `bootstrapMode: 'none'` participants (agent-worker, headless
      // task runners) skip baseline replication — they read via
      // `model.get()` round-trips and rely on covering deltas
      // from filtered subscriptions to populate the pool lazily. The
      // WS is already open by `setupWebSocketSync` above, so live
      // delta flow works regardless of this branch.
      const requirements = (yield host.database.requiredBootstrap()) as Awaited<
        ReturnType<typeof host.database.requiredBootstrap>
      >;

      if (context.bootstrapMode === 'none') {
        host.runtime.logger.info(
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
        yield host.waitForWebSocketConnected(5000);
      } else if (requirements.type !== 'local') {
        if (hasLocalData) {
          // Background bootstrap — don't block UI. The method captures its own
          // operational failures; this backstop covers escapes from the
          // delta-queue replay in withDeltaQueuing's finally (and the error
          // handler itself), which would otherwise vanish unhandled.
          void host.performBackgroundBootstrap(requirements, context, signal).catch(
            (error) => {
              host.runtime.observability.captureBootstrapFailure(error, {
                type: 'background-orchestration',
              });
            }
          );
        } else {
          // First load — must wait for server data
          yield host.executeBootstrapWithTimeout(
            async () => {
              await host.database.bootstrapFromServer(
                requirements,
                host.resolveSyncGroups(context),
              );
            },
            context,
            signal
          );
          yield host.syncClient.hydrateFromDatabase();
          host.dataReady = true;
          host.initialized = true;
        }
      }

      if (!host.initialized) host.initialized = true;
      if (!host.dataReady) {
        host.dataReady = true;
      }

      host.updateSyncStatus({ state: 'idle', progress: 100 });
      return { success: true };
    } catch (error) {
      const isAbort = error instanceof DOMException && error.name === 'AbortError';
      if (isAbort) {
        host.dataReady = false;
        host.initialized = false;
        host.updateSyncStatus({ state: 'idle', progress: 0 });
        return { success: false, error: error };
      }

      const isSession = AbloSessionError.isSessionError(error);
      host.runtime.observability.captureBootstrapFailure(error, { type: 'initialize' });

      if (isSession) {
        host.syncWebSocket.setSessionErrorDetected();
        host.syncWebSocket.disconnect();
        host.updateSyncStatus({ state: 'error', error: error });
        return { success: false, error: error };
      }

      // Fallback: show local data if available
      if (host.objectPool.size === 0) {
        try {
          yield host.syncClient.hydrateFromDatabase();
        } catch {}
      }

      if (host.objectPool.size > 0) {
        host.dataReady = true;
        host.initialized = true;
        host.updateSyncStatus(
          host.syncWebSocket.isConnected()
            ? { state: 'idle', progress: 100 }
            : { state: 'offline', offlineSince: new Date() }
        );
        return { success: true };
      }

      host.updateSyncStatus({ state: 'error', error: error as Error });
      return { success: false, error: error as Error };
    }
  }
