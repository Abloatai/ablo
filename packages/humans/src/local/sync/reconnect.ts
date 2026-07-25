import { AbloSessionError } from '@ablo/transaction/errors';
import type { RuntimeContext } from '../RuntimeContext.js';
import type { SyncClient } from '../SyncClient.js';
import type { Database } from '../Database.js';
import type { InstanceCache } from '../InstanceCache.js';
import type { SyncWebSocket } from './SyncWebSocket.js';
import type { DefaultCollaborationEvents, EventMap } from './SyncWebSocket.js';
import type { SyncStatus } from '../storeContract.js';
import type { UserContext } from '../BaseSyncedStore.js';
import type { BootstrapResult } from '../Database.js';

export interface ReconnectHost<
  TCollaboration extends EventMap<TCollaboration> = DefaultCollaborationEvents,
> {
  userContext: UserContext | null;
  database: Database;
  syncClient: SyncClient;
  objectPool: InstanceCache;
  syncWebSocket: SyncWebSocket<TCollaboration>;
  runtime: RuntimeContext;
  dataReady: boolean;
  checkSyncGroupShrinkage(): Promise<void>;
  resolveSyncGroups(context: UserContext): readonly string[];
  applyBootstrapToPool(result: BootstrapResult): void;
  updateSyncStatus(updates: Partial<SyncStatus>): void;
}

export async function performReconnect<
  TCollaboration extends EventMap<TCollaboration>,
>(
  host: ReconnectHost<TCollaboration>,
): Promise<'success' | 'session_error' | 'network_error'> {
  if (!host.userContext) return 'network_error';

  try {
    await host.checkSyncGroupShrinkage();
    const requirements = await host.database.requiredBootstrap();
    if (requirements.type === 'full' || requirements.lastSyncId === 0) {
      host.updateSyncStatus({ state: 'syncing', progress: 0 });
      const result = await host.database.bootstrapFromServer(
        requirements,
        host.resolveSyncGroups(host.userContext),
      );
      host.applyBootstrapToPool(result);
      host.dataReady = true;
    } else if (!host.dataReady) {
      await host.syncClient.hydrateFromDatabase();
      host.dataReady = true;
    }

    if (!host.syncWebSocket.isConnected()) {
      host.syncWebSocket.resetReconnectAttempts();
      host.syncWebSocket.connect();
    }
    host.updateSyncStatus({ state: 'idle', progress: 100 });
    return 'success';
  } catch (error) {
    host.runtime.observability.captureBootstrapFailure(error, {
      type: 'connection-store-reconnect',
    });

    if (AbloSessionError.isSessionError(error)) {
      host.syncWebSocket.setSessionErrorDetected();
      host.syncWebSocket.disconnect();
      host.updateSyncStatus({ state: 'error', error });
      host.database.clear({ includeWriteJournal: true }).catch(() => undefined);
      host.objectPool.clear();
      return 'session_error';
    }

    if (!host.dataReady && host.objectPool.size === 0) {
      try {
        await host.syncClient.hydrateFromDatabase();
        if (host.objectPool.size > 0) {
          host.dataReady = true;
          host.runtime.logger.info('[BaseSyncedStore] Hydrated from local fallback', {
            objectPoolSize: host.objectPool.size,
          });
        }
      } catch (fallbackError) {
        host.runtime.logger.debug('[BaseSyncedStore] Local fallback failed', {
          error: fallbackError instanceof Error ? fallbackError.message : String(fallbackError),
        });
      }
    }
    return 'network_error';
  }
}
