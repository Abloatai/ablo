import { AbloSessionError, isAccessCredentialExpiryCloseReason } from '@abloatai/transaction/errors';
import type { RuntimeContext } from '../RuntimeContext.js';
import type { SyncClient } from '../SyncClient.js';
import type { Database } from '../Database.js';
import type { InstanceCache } from '../InstanceCache.js';
import type { ConnectionManager } from './ConnectionManager.js';
import type { SubscriptionManager } from './SubscriptionManager.js';
import type { SyncStatus } from '../storeContract.js';
import type {
  BootstrapHint,
  BootstrapDataEvent,
  PresenceUpdate,
  SyncWebSocket,
  EventMap,
} from './SyncWebSocket.js';
import type { SyncDelta } from './SyncWebSocket.js';

export interface SocketEventHost<TCollaboration extends EventMap<TCollaboration>> {
  syncWebSocket: SyncWebSocket<TCollaboration>;
  syncClient: SyncClient;
  database: Database;
  objectPool: InstanceCache;
  areaOfInterest: SubscriptionManager;
  runtime: RuntimeContext;
  dataReady: boolean;
  connectionManager: ConnectionManager | null;
  disposers: (() => void)[];
  onConnectionEvent?: (event: string) => void;
  updateSyncStatus(updates: Partial<SyncStatus>): void;
  processDeltaWithBatching(delta: SyncDelta): void;
  applyDeltaFrame(deltas: SyncDelta[]): void;
  handleBootstrapRequired(hint: BootstrapHint): void;
  handleBootstrapData(data: BootstrapDataEvent): void;
  handlePresenceUpdate(data: PresenceUpdate): void;
  performCredentialRefresh(): Promise<'refreshed' | 'session_error' | 'network_error'>;
  handleTerminalSessionError(error: Error): void;
  nudgeReconnect(): void;
}

export function wireSocketEvents<TCollaboration extends EventMap<TCollaboration>>(
  deps: SocketEventHost<TCollaboration>,
): void {

    // Connection events → forward to connection lifecycle callback
    const onConnected = deps.syncWebSocket.subscribe('connected', () => {
      deps.syncClient.markConnected();
      deps.onConnectionEvent?.('WS_CONNECTED');
      if (deps.dataReady) {
        deps.updateSyncStatus({ state: 'idle', offlineSince: undefined });
      } else {
        deps.updateSyncStatus({ offlineSince: undefined });
      }
      // Re-assert read interest on every (re)connect. After a transient
      // reconnect the socket re-sends its URL groups, but interest may have
      // changed while offline; after a full reconnect the new socket's URL
      // carries only base groups. `resync` re-pushes the current desired set
      // so the server-side index matches what the user is actually viewing.
      void deps.areaOfInterest.resync();
    });

    const onDisconnected = deps.syncWebSocket.subscribe('disconnected', () => {
      deps.syncClient.disconnect();
      deps.onConnectionEvent?.('WS_DISCONNECTED');
      deps.updateSyncStatus({ state: 'offline', offlineSince: new Date() });
    });

    const onReconnecting = deps.syncWebSocket.subscribe('reconnecting', (...args) => {
      const [{ attempt, delay }] = args;
      deps.runtime.logger.info('[BaseSyncedStore] WebSocket reconnecting', { attempt, delay });
      deps.updateSyncStatus({ state: 'reconnecting' });
    });

    // Delta events → feed into processing pipeline
    const onDelta = deps.syncWebSocket.subscribe('delta', (delta: SyncDelta) => {
      deps.processDeltaWithBatching(delta);
    });

    const onDeltaBatch = deps.syncWebSocket.subscribe('delta_batch', (deltas: SyncDelta[]) => {
      // A catch-up/reconnect frame is already complete — apply it as ONE
      // atomic flush so the gallery re-renders once, not once per 50-delta
      // chunk. See `applyDeltaFrame`.
      deps.applyDeltaFrame(deltas);
    });

    // Bootstrap events
    const onBootstrapRequired = deps.syncWebSocket.subscribe(
      'bootstrap_required',
      (hint: BootstrapHint) => { deps.handleBootstrapRequired(hint); }
    );

    const onBootstrapData = deps.syncWebSocket.subscribe('bootstrap_data', (...args) => {
      const data = args[0];
      deps.handleBootstrapData(data);
    });

    const onPresenceUpdate = deps.syncWebSocket.subscribe('presence_update', (...args) => {
      const data = args[0];
      deps.handlePresenceUpdate(data);
    });

    // Error events
    const onError = deps.syncWebSocket.subscribe('error', (error: Error) => {
      if (error.message === 'Network is offline' || error.message === 'WebSocket connection failed') {
        deps.updateSyncStatus({ state: 'offline', offlineSince: new Date() });
      } else {
        deps.updateSyncStatus({ state: 'error', error });
      }
    });

    // Terminal session loss (revocation / the login itself is gone): notify,
    // route the FSM to its terminal state, and clear local data.
    const handleTerminalSessionError = (error: Error): void => {
      deps.onConnectionEvent?.('WS_SESSION_ERROR');
      deps.handleTerminalSessionError(error);
    };

    const onSessionError = deps.syncWebSocket.subscribe('session_error', (error: Error) => {
      // WS analog of HTTP's `apikey_expired` (see AbloSessionError.
      // isSessionErrorResponse): the hub's keepalive reaper closes sockets
      // whose SHORT-LIVED access credential (`ek_`/`rk_`) passed its expiry
      // with `4001 credential_expired`. That is re-mintable from the
      // still-valid login — recover silently (un-latch, single-flight
      // re-mint, reconnect) instead of signing out and clearing local data.
      // Only a mint that answers `null` (the login itself is gone) falls
      // through to the terminal path. Without this branch, every credential
      // TTL elapse wedged the socket behind the write-once session latch.
      if (AbloSessionError.isSessionError(error) && isAccessCredentialExpiryCloseReason(error.message)) {
        deps.runtime.observability.breadcrumb(
          'WebSocket closed for expired access credential — re-minting',
          'sync.websocket',
          'warning',
        );
        // Un-latch BEFORE the async mint so the FSM's own recovery
        // (probe → refreshing_credential → reconnect) is never blocked on
        // our .then() ordering.
        deps.syncWebSocket.clearSessionError();
        void deps.performCredentialRefresh().then((outcome) => {
          if (outcome === 'refreshed') {
            if (deps.connectionManager) {
              // Kick a parked FSM; a concurrent probe joins the same
              // single-flight mint, so this never double-mints.
              deps.nudgeReconnect();
            } else {
              // Agent/system clients have no connection FSM
              // (createConnectionManager returns null for kind 'agent') —
              // reconnect the socket directly; connect() reads the
              // freshly-minted credential from the credential source.
              deps.syncWebSocket.resetReconnectAttempts();
              deps.syncWebSocket.connect();
            }
            return;
          }
          if (outcome === 'session_error') {
            // The mint endpoint rejected: the long-lived login is gone.
            // Re-latch so writes reject with the permanent session type
            // (see SyncWebSocket.notConnectedError) instead of parking.
            deps.syncWebSocket.setSessionErrorDetected();
            handleTerminalSessionError(error);
          }
          // 'network_error' → transient mint failure. The WS_DISCONNECTED
          // that follows this event already put the FSM on its probe/backoff
          // loop, which retries through the same single-flight refresh.
        });
        return;
      }
      handleTerminalSessionError(error);
    });

    // Handshake failed: WS close before open. The HTTP status is hidden
    // behind close code 1006, so we can't tell whether the server rejected
    // auth (401/403) or the connection never reached the server (DNS/TLS/LB).
    // Forward a dedicated event so the connection-lifecycle owner can run
    // an authenticated HTTP probe to disambiguate.
    const onHandshakeFailed = deps.syncWebSocket.subscribe('handshake_failed', () => {
      deps.onConnectionEvent?.('WS_HANDSHAKE_FAILED');
      deps.updateSyncStatus({ state: 'offline', offlineSince: new Date() });
    });

    const onReconnectFailed = deps.syncWebSocket.subscribe('reconnect_failed', (...args) => {
      const [{ attempts }] = args;
      // consumer register: reconnection exhausted — the app is now offline
      deps.runtime.logger.warn(
        'Lost connection to the sync service and could not reconnect. Your app is now offline; changes will sync once the connection is restored.',
      );
      deps.runtime.logger.debug('[BaseSyncedStore] WebSocket reconnection gave up', { attempts });
      deps.updateSyncStatus({ state: 'reconnecting' });
    });

    deps.disposers.push(
      onConnected, onDisconnected, onReconnecting,
      onDelta, onDeltaBatch, onBootstrapRequired,
      onBootstrapData, onPresenceUpdate,
      onError, onSessionError, onHandshakeFailed, onReconnectFailed,
      () => { deps.areaOfInterest.dispose(); },
    );
  }
