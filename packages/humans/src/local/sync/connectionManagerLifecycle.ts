import { AbloSessionError } from '@ablo/transaction/errors';
import type { ParticipantKind } from '@ablo/transaction/types/participant';
import { ConnectionManager } from './ConnectionManager.js';
import type { DefaultCollaborationEvents, EventMap, SyncWebSocket } from './SyncWebSocket.js';
import type { SyncStatus } from '../storeContract.js';
import type { AuthCredentialSource } from '@ablo/transaction/auth/credentialSource';
import type { RuntimeContext } from '../RuntimeContext.js';
import { contextLogger, contextSocketObservability } from './contextPorts.js';

export interface ConnectionManagerHost<
  TCollaboration extends EventMap<TCollaboration> = DefaultCollaborationEvents,
> {
  connectionManager: ConnectionManager | null;
  onConnectionEvent?: (event: string) => void;
  syncWebSocket: SyncWebSocket<TCollaboration>;
  syncStatus: SyncStatus;
  createConnectionManager(kind?: ParticipantKind): ConnectionManager | null;
  performReconnect(): Promise<'success' | 'session_error' | 'network_error'>;
  performCredentialRefresh(): Promise<'refreshed' | 'session_error' | 'network_error'>;
  handleTerminalSessionError(error: Error): void;
  updateSyncStatus(updates: Partial<SyncStatus>): void;
  syncServerUrl?: string;
  auth?: AuthCredentialSource;
  runtime: RuntimeContext;
}

export function createConnectionManager<TCollaboration extends EventMap<TCollaboration>>(
  host: Pick<ConnectionManagerHost<TCollaboration>, 'syncServerUrl' | 'auth' | 'syncWebSocket'>,
  kind?: ParticipantKind,
): ConnectionManager | null {
  if (kind === 'agent') return null;
  return new ConnectionManager({
    baseUrl: host.syncServerUrl,
    getAuthToken: () => host.auth?.getAuthToken() ?? host.syncWebSocket.getAuthToken() ?? null,
    logger: contextLogger,
    observability: contextSocketObservability,
  });
}

export async function waitForWebSocketConnected<TCollaboration extends EventMap<TCollaboration>>(
  host: Pick<ConnectionManagerHost<TCollaboration>, 'syncWebSocket' | 'runtime'>,
  timeoutMs: number,
): Promise<boolean> {
  const ws = host.syncWebSocket;
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
      host.runtime.logger.debug(
        `[BaseSyncedStore] waitForWebSocketConnected timed out after ${timeoutMs}ms — initialize() will return but the next mutation may race the upgrade.`,
      );
      resolve(false);
    }, timeoutMs);
  });
}

export function startConnectionManager<TCollaboration extends EventMap<TCollaboration>>(
  host: ConnectionManagerHost<TCollaboration>,
  kind?: ParticipantKind,
): void {
    host.connectionManager = host.createConnectionManager(kind);
    if (host.connectionManager) {
      const manager = host.connectionManager;
      // Preserve any externally-set onConnectionEvent — chain rather
      // than overwrite, so subclasses that wire a secondary consumer
      // still receive events.
      const priorHook = host.onConnectionEvent;
      host.onConnectionEvent = (event: string) => {
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
        onReconnect: () => host.performReconnect(),
        onRefreshCredential: () => host.performCredentialRefresh(),
        onSessionExpired: () => {
          const err = new AbloSessionError('Session expired');
          host.handleTerminalSessionError(err);
        },
        onDisconnectWebSocket: () => {
          host.syncWebSocket.disconnect();
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
                host.syncStatus.state === 'offline' ||
                host.syncStatus.state === 'reconnecting' ||
                host.syncStatus.state === 'error'
              ) {
                host.updateSyncStatus({ state: 'idle', offlineSince: undefined });
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
              if (host.syncStatus.state !== 'reconnecting') {
                host.updateSyncStatus({ state: 'reconnecting' });
              }
              break;
            case 'waiting_for_network':
            case 'offline':
              if (host.syncStatus.state !== 'offline') {
                host.updateSyncStatus({
                  state: 'offline',
                  offlineSince: host.syncStatus.offlineSince ?? new Date(),
                });
              }
              break;
            // 'session_expired' / 'validating_session' are handled by
            // the existing session-error / WS subscription paths.
          }
        },
      });
    }
  }
