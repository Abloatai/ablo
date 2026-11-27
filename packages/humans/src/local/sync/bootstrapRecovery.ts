import { AbloSessionError } from '@abloatai/transaction/errors';
import { LoadStrategy } from '@abloatai/transaction/types';
import type { RuntimeContext } from '../RuntimeContext.js';
import type { BootstrapRequirements, BootstrapResult, Database } from '../Database.js';
import type { SyncClient } from '../SyncClient.js';
import type { InstanceCache } from '../InstanceCache.js';
import type { ModelRegistry } from '../ModelRegistry.js';
import type { UserContext } from '../BaseSyncedStore.js';
import type { SyncStatus } from '../storeContract.js';
import type { RehydrationStats } from './bootstrapApply.js';
import type {
  BootstrapHint,
  DefaultCollaborationEvents,
  EventMap,
  SyncDelta,
  SyncWebSocket,
} from './SyncWebSocket.js';

export interface BackgroundBootstrapHost<
  TCollaboration extends EventMap<TCollaboration> = DefaultCollaborationEvents,
> {
  readonly database: Database;
  readonly syncClient: SyncClient;
  readonly objectPool: InstanceCache;
  readonly syncWebSocket: SyncWebSocket<TCollaboration>;
  readonly runtime: RuntimeContext;
  isDataReady(): boolean;
  getBootstrapDeltaQueue(): SyncDelta[] | null;
  setBootstrapDeltaQueue(queue: SyncDelta[] | null): void;
  withDeltaQueuing<T>(fn: () => Promise<T>): Promise<T>;
  resolveSyncGroups(context: UserContext): readonly string[];
  collectDeltaProtectedIds(preBootstrapIds: ReadonlySet<string>): Set<string>;
  applyBootstrapToPool(
    bootstrapResult: BootstrapResult,
    protectedIds?: ReadonlySet<string>,
  ): RehydrationStats;
  updateSyncStatus(updates: Partial<SyncStatus>): void;
}

export interface BootstrapRecoveryHost<
  TCollaboration extends EventMap<TCollaboration> = DefaultCollaborationEvents,
> {
  readonly modelRegistry: ModelRegistry;
  readonly syncWebSocket: SyncWebSocket<TCollaboration>;
  readonly runtime: RuntimeContext;
  getUserContext(): UserContext | null;
  getRecoveryInFlight(): Promise<void> | null;
  setRecoveryInFlight(value: Promise<void> | null): void;
  resolveSyncGroups(context: UserContext): readonly string[];
  updateSyncStatus(updates: Partial<SyncStatus>): void;
  performBackgroundBootstrap(
    requirements: BootstrapRequirements,
    context: UserContext,
    signal?: AbortSignal,
  ): Promise<void>;
}

/**
 * Non-blocking replacement bootstrap. Keeps the existing local replica intact
 * and readable while fetching, queues concurrent live deltas via
 * `withDeltaQueuing`, advances local/transport cursors together once committed,
 * and follows up with an incremental sync if connected.
 */
export async function performBackgroundBootstrap<
  TCollaboration extends EventMap<TCollaboration>,
>(
  host: BackgroundBootstrapHost<TCollaboration>,
  requirements: BootstrapRequirements,
  context: UserContext,
): Promise<void> {
  const succeeded = await host.withDeltaQueuing(async (): Promise<boolean> => {
    try {
      const preBootstrapIds = new Set(host.objectPool.getAllIds());
      const bootstrapResult = await host.database.bootstrapFromServer(
        requirements,
        host.resolveSyncGroups(context),
      );
      const deltaProtectedIds = host.collectDeltaProtectedIds(preBootstrapIds);
      host.applyBootstrapToPool(bootstrapResult, deltaProtectedIds);
      const postBootstrapSyncId = await host.database.getLastSyncId();
      if (postBootstrapSyncId > 0) {
        host.syncClient.position.advanceApplied(postBootstrapSyncId);
        host.syncClient.position.advancePersisted(postBootstrapSyncId);
        // Drop queued deltas already covered by the committed snapshot so
        // replaying the queue cannot overwrite newer snapshot rows in IDB.
        const queued = host.getBootstrapDeltaQueue();
        if (queued) {
          host.setBootstrapDeltaQueue(
            queued.filter((delta) => delta.id <= 0 || delta.id > postBootstrapSyncId),
          );
        }
      }
      if (postBootstrapSyncId > host.syncWebSocket.getLastSyncId()) {
        host.syncWebSocket.setLastSyncId(postBootstrapSyncId);
      }
      host.updateSyncStatus({ state: 'idle', progress: 100 });
      return true;
    } catch (error) {
      host.runtime.logger.debug('[sync-engine] Background bootstrap failed', {
        error: error instanceof Error ? error.message : String(error),
        cause: error,
      });
      host.runtime.observability.captureBootstrapFailure(error, { type: 'background' });
      if (AbloSessionError.isSessionError(error)) {
        host.syncWebSocket.setSessionErrorDetected();
        host.syncWebSocket.disconnect();
        host.updateSyncStatus({ state: 'error', error });
      } else if (!host.syncWebSocket.isConnected()) {
        host.updateSyncStatus({ state: 'offline', offlineSince: new Date() });
      } else if (host.isDataReady()) {
        host.updateSyncStatus({ state: 'idle' });
      }
      return false;
    }
  });

  if (succeeded && host.syncWebSocket.isConnected()) {
    host.syncWebSocket.requestIncrementalSync().catch((error: unknown) => {
      host.runtime.observability.breadcrumb(
        'Post-bootstrap incremental sync request failed',
        'sync.bootstrap',
        'warning',
        { error: error instanceof Error ? error.message : String(error) },
      );
    });
  }
}

/**
 * Trigger a single-flight replacement bootstrap when the server signals
 * `requiresBootstrap: true` (e.g., replay row/byte cap overflow). Preserves
 * the current local replica and cursor until the replacement commits.
 */
export function triggerBootstrapRecovery<
  TCollaboration extends EventMap<TCollaboration>,
>(
  host: BootstrapRecoveryHost<TCollaboration>,
  hint: BootstrapHint,
): void {
  const context = host.getUserContext();
  if (!context || context.bootstrapMode === 'none') {
    host.runtime.logger.debug('[BaseSyncedStore] Skipping bootstrap_required recovery', {
      reason: hint.reason,
      hasContext: !!context,
      bootstrapMode: context?.bootstrapMode,
    });
    return;
  }

  if (host.getRecoveryInFlight()) {
    host.runtime.logger.debug('[BaseSyncedStore] Coalescing concurrent bootstrap_required hint', {
      reason: hint.reason,
    });
    return;
  }

  const fullRequirements: BootstrapRequirements = {
    type: 'full',
    modelsToLoad: [
      ...host.modelRegistry.getModelsByLoadStrategy(LoadStrategy.instant),
      ...host.modelRegistry.getModelsByLoadStrategy(LoadStrategy.lazy),
    ],
    lastSyncId: 0,
    syncGroups: [...host.resolveSyncGroups(context)],
  };

  host.runtime.logger.info('[BaseSyncedStore] Starting replacement bootstrap after replay overflow', {
    reason: hint.reason,
    lastSyncId: host.syncWebSocket.getLastSyncId(),
  });
  host.updateSyncStatus({ state: 'syncing' });

  const recovery = host.performBackgroundBootstrap(fullRequirements, context)
    .catch((error: unknown) => {
      host.runtime.observability.captureBootstrapFailure(error, {
        type: 'bootstrap-required-recovery',
      });
    })
    .finally(() => {
      if (host.getRecoveryInFlight() === recovery) {
        host.setRecoveryInFlight(null);
      }
    });
  host.setRecoveryInFlight(recovery);
}
