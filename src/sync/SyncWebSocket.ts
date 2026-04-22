/**
 * SyncWebSocket - Manages WebSocket connection to Go sync engine
 *
 * Handles:
 * - WebSocket lifecycle (connect, reconnect, disconnect)
 * - Delta reception and processing
 * - Multi-tab support
 * - Automatic reconnection with exponential backoff
 */

import { EventEmitter } from 'events';
import { getContext } from '../context';
import { flushOfflineQueueOnce } from './OfflineFlush';
import { SyncSessionError } from '../errors';
// SyncObservability replaced by getContext().observability

/** JSON model data from the sync engine — may arrive as a pre-parsed object or a JSON string. */
type SyncDeltaPayload = Record<string, unknown> | string | null;

export interface SyncDelta {
  id: number;
  /**
   * Delta action type — full Linear-compatible vocabulary.
   *
   * Core CRUD:
   *   I — Insert
   *   U — Update
   *   D — Delete (hard)
   *   A — Archive (soft delete)
   *   V — Unarchive (reVive)
   *
   * Permission / access control:
   *   C — Covering: client gained permission to see an existing entity
   *       (treated as insert by the client — see handleCovering path).
   *   G — GroupAdded: recipient was added to a sync group. Paired with
   *       subsequent 'C' deltas for each newly-visible entity.
   *   S — GroupRemoved: recipient lost access to a sync group. Client
   *       purges affected entities from its local store.
   */
  actionType: 'I' | 'U' | 'D' | 'A' | 'V' | 'C' | 'G' | 'S';
  modelName: string;
  modelId: string;
  data: SyncDeltaPayload;
  previousData?: SyncDeltaPayload;
  metadata?: SyncDeltaPayload;
  syncGroups: string[];
  createdBy?: string;
  transactionId?: string;
  clientMutationId?: string;
  createdAt: string;
}

/**
 * Payload for legacy actionType 'G' deltas emitted by EmitGroupChange.
 * Carries both added and removed groups in one delta, forces full re-bootstrap.
 */
export interface SyncGroupChangePayload {
  removedGroups: string[];
  addedGroups: string[];
}

/**
 * Payload for incremental actionType 'G' deltas emitted by EmitGroupAdded.
 * Signals that the recipient has joined a single sync group; subsequent
 * 'C' (Covering) deltas will deliver the newly-visible entities. No
 * re-bootstrap required.
 */
export interface GroupAddedPayload {
  group: string;
  userId: string;
}

/**
 * Payload for actionType 'S' deltas emitted by EmitGroupRemoved.
 * Signals that the recipient has lost access to a sync group. The client
 * purges affected local entities and updates its subscription metadata.
 */
export interface GroupRemovedPayload {
  group: string;
  userId: string;
}

export interface VersionVector {
  tasks: number;
  projects: number;
  users: number;
  events: number; // Renamed from activities - audit log entries
  inboxitems: number;
  teams: number;
  assignments: number;
  comments: number;
  threads: number;
  [entityType: string]: number;
}

export interface SyncCapabilities {
  partialBootstrap?: boolean;
  compressedDeltas?: boolean;
  streamingBootstrap?: boolean;
  batchedDeltas?: boolean;
}

export interface SyncWebSocketOptions {
  /** Base HTTP URL of the sync server */
  baseUrl?: string;
  url?: string;
  userId: string;
  organizationId: string;
  lastSyncId?: number;
  syncGroups?: string[];
  versions?: VersionVector;
  capabilities?: SyncCapabilities;
  reconnectDelay?: number;
  maxReconnectDelay?: number;
  /** @deprecated Heartbeats are no longer used - WebSocket ping/pong handles keepalive */
  heartbeatInterval?: number;
  /**
   * Collaboration event type keys to listen for (e.g., ['sheet:selection', 'slide:cursor']).
   * Wire messages with matching types (underscore format) will be emitted as events.
   */
  collaborationEvents?: string[];
}

/**
 * Bootstrap hint from server indicating full or partial bootstrap is needed.
 * Properties are optional since server payload structure may vary.
 */
export interface BootstrapHint {
  tables?: string[];
  reason?: 'too_far_behind' | 'too_many_deltas' | 'missing_entities';
  staleTables?: string[];
  totalDeltaCount?: number;
  /** @deprecated use tables instead */
  entities?: string[];
}

/** Bootstrap data event payload */
export interface BootstrapDataEvent {
  entityType: string;
  data: unknown;
  isComplete: boolean;
  cursor?: string;
}

/** Presence update event payload */
export interface PresenceUpdateEvent {
  userId: string;
  status: string;
  localTime?: string;
  timestamp?: number;
  type?: string;
  timezone?: string;
  socketId?: string;
}

/**
 * Core event map — transport-level events that every SyncWebSocket emits.
 * SDK consumers extend this with app-specific collaboration events.
 */
export interface CoreSyncEventMap {
  connected: [];
  disconnected: [CloseEvent];
  reconnecting: [{ attempt: number; delay: number }];
  delta: [SyncDelta];
  delta_batch: [SyncDelta[]];
  bootstrap_required: [BootstrapHint];
  bootstrap_data: [BootstrapDataEvent];
  presence_update: [PresenceUpdateEvent];
  error: [Error];
  session_error: [Error];
  /**
   * The WebSocket `onclose` fired before `onopen` — the handshake itself
   * failed. The browser cannot expose the HTTP status (it shows as code
   * 1006 with no reason), so the consumer should run an authenticated
   * HTTP probe to distinguish auth failure (session expired) from a
   * generic network issue.
   */
  handshake_failed: [CloseEvent];
  reconnect_failed: [{ attempts: number }];
}

/**
 * Collaboration event — app-specific real-time events (selection, cursors, etc.)
 * Each event is a [payload] tuple matching the EventEmitter convention.
 */
// Empty default — consumers extend with their own events
export type DefaultCollaborationEvents = Record<string, never>;

/**
 * Constraint for event maps: every value must be a tuple of handler args.
 *
 * Why a mapped type and not `Record<string, unknown[]>`?
 * `Record<string, ...>` requires an implicit string index signature, which
 * TypeScript interfaces don't have. So a closed interface like Ablo's
 * `AbloCollaborationEvents` would fail to satisfy `Record<string, unknown[]>`,
 * even though every one of its values IS a tuple. This mapped form iterates
 * over `keyof T` instead of demanding a string index, so it accepts both
 * closed interfaces and open Record types — while still enforcing
 * "every value is an array."
 */
export type EventMap<T> = { [K in keyof T]: unknown[] };

/**
 * Full event map = core + collaboration events.
 * Pass your own TCollaboration to add app-specific events.
 */
export type SyncWebSocketEventMap<
  TCollaboration extends EventMap<TCollaboration> = DefaultCollaborationEvents
> = CoreSyncEventMap & TCollaboration;

// ---------------------------------------------------------------------------
// Ablo-specific collaboration events moved to apps/web/src/lib/sync/collaboration-events.ts
// Consumers pass their own event types as TCollaboration generic parameter.

export class SyncWebSocket<
  TCollaboration extends EventMap<TCollaboration> = DefaultCollaborationEvents
> extends EventEmitter {
  /**
   * Subscribe to events with automatic cleanup.
   * Returns unsubscribe function for clean disposal.
   */
  subscribe<K extends keyof SyncWebSocketEventMap<TCollaboration>>(
    event: K,
    handler: (...args: SyncWebSocketEventMap<TCollaboration>[K]) => void
  ): () => void {
    this.on(event as string, handler as (...args: unknown[]) => void);
    return () => this.off(event as string, handler as (...args: unknown[]) => void);
  }

  /**
   * Send a collaboration event (app-specific real-time message).
   * The wire format is `{ type: messageType, payload: { ...payload, timestamp } }`.
   */
  sendCollaborationEvent<K extends string & keyof TCollaboration>(
    messageType: K,
    payload: TCollaboration[K] extends [infer P] ? Omit<P & Record<string, unknown>, 'timestamp'> : never
  ): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.send({
      type: messageType.replace(/:/g, '_'), // 'sheet:selection' → 'sheet_selection' wire format
      payload: { ...payload, timestamp: Date.now() },
    });
  }
  private ws: WebSocket | null = null;
  private options: Required<Omit<SyncWebSocketOptions, 'baseUrl'>> & { baseUrl?: string };
  private reconnectAttempts = 0;
  /** Stop retrying after this many consecutive failures (backoff caps at 30s, so ~7.5 min total) */
  private static readonly MAX_RECONNECT_ATTEMPTS = 15;
  private reconnectTimer: NodeJS.Timeout | null = null;
  /** Periodic catchup interval — polls for missed deltas every 30s while connected */
  private catchupInterval: NodeJS.Timeout | null = null;
  private isConnecting = false;
  private isManualClose = false;
  /** When true, a session error has been detected (from any path — WS close or HTTP bootstrap).
   *  Suppresses reconnection and Sentry error capture to avoid cascading noise. */
  private _sessionErrorDetected = false;
  /** True once `onopen` has fired at least once on the current socket. Reset each
   *  time a new socket is created in `connect()`. Used by `onclose` to detect
   *  handshake failures (close before open) — the one signal we have for "the
   *  server rejected the upgrade" since browsers hide the HTTP status (e.g.
   *  401) behind the opaque 1006 close code. */
  private _everOpened = false;
  private lastSyncId: number;
  private versionVector: VersionVector;
  private syncCursor: string | null = null;
  /** Registered collaboration event keys (colon format) for dispatch in onmessage */
  private collaborationEventTypes: Set<string>;

  /**
   * In-flight `batch_ack` mutation requests keyed by clientTxId. Resolved when
   * a matching `mutation_result` frame arrives from the server, or rejected on
   * timeout / disconnect. Lets consumers await a server ack for mutations
   * sent over the same socket that streams deltas.
   */
  private pendingMutations = new Map<
    string,
    {
      resolve: (value: { lastSyncId: number }) => void;
      reject: (err: Error) => void;
      timeout: ReturnType<typeof setTimeout>;
    }
  >();

  constructor(options: SyncWebSocketOptions) {
    super();

    // Construct WebSocket URL from base Go server URL
    const baseUrl = options.baseUrl || options.url || "http://localhost:8080";
    const wsProtocol = baseUrl.startsWith('https') ? 'wss' : 'ws';
    const wsUrl = baseUrl.replace(/^https?/, wsProtocol) + '/api/sync/ws';

    this.options = {
      url: wsUrl,
      reconnectDelay: 1000,
      maxReconnectDelay: 30000,
      heartbeatInterval: 0, // Deprecated - WebSocket ping/pong handles keepalive
      collaborationEvents: ['sheet:selection', 'slide:selection', 'slide:cursor'],
      syncGroups: [],
      lastSyncId: 0,
      versions: {
        tasks: 0,
        projects: 0,
        users: 0,
        events: 0,
        inboxitems: 0,
        teams: 0,
        assignments: 0,
        comments: 0,
        threads: 0,
      },
      capabilities: {
        partialBootstrap: true,
        compressedDeltas: true,
        streamingBootstrap: true,
        batchedDeltas: true,
      },
      ...options,
    };

    this.lastSyncId = this.options.lastSyncId;
    this.versionVector = { ...this.options.versions };
    this.syncCursor = null;
    this.collaborationEventTypes = new Set(
      options.collaborationEvents ?? ['sheet:selection', 'slide:selection', 'slide:cursor']
    );
  }

  /**
   * Mark that a session error has been detected (e.g. 401 from HTTP bootstrap).
   * Suppresses further reconnection attempts and Sentry error capture.
   */
  setSessionErrorDetected(): void {
    this._sessionErrorDetected = true;
  }

  /**
   * Connect to the sync engine WebSocket
   */
  connect(): void {
    if (this._sessionErrorDetected) {
      getContext().logger.debug('WebSocket connect suppressed — session error detected');
      return;
    }

    if (this.ws?.readyState === WebSocket.OPEN || this.isConnecting) {
      getContext().logger.debug('WebSocket already connected or connecting');
      return;
    }

    // Note: onlineStatus is advisory — we'll try to connect and let the WebSocket
    // handle failures. The default browser implementation reads navigator.onLine,
    // which is unreliable but the only signal available; in Node it returns true
    // (assume online) so the sidecar/agent path doesn't short-circuit here.
    if (!getContext().onlineStatus.isOnline()) {
      getContext().logger.warn('onlineStatus reports offline, but attempting connection anyway');
    }

    this.isConnecting = true;
    this.isManualClose = false;

    const params = new URLSearchParams({
      userId: this.options.userId,
      organizationId: this.options.organizationId,
      // Intentionally omit lastSyncId, versions, capabilities from URL; these are sent in sync_request
      // and ack messages to avoid stale baselines on reconnect.
      cursor: this.syncCursor || '',
    });

    // Add sync groups if provided
    this.options.syncGroups.forEach((group) => {
      params.append('syncGroups', group);
    });

    const wsUrl = `${this.options.url}?${params.toString()}`;

    try {
      // Reset the handshake flag before wiring the new socket. Each connect()
      // gets its own lifecycle — a prior successful open on a previous socket
      // must not mask a handshake failure on the new one.
      this._everOpened = false;
      this.ws = new WebSocket(wsUrl);
      this.setupEventHandlers();
    } catch (error) {
      // WebSocket constructor can throw if URL is invalid
      const errorMessage = error instanceof Error ? error.message : 'Failed to create WebSocket';
      getContext().observability.captureWebSocketError({ context: 'create-websocket', error: errorMessage });
      this.isConnecting = false;
      this.emit('error', new Error(errorMessage));
      this.scheduleReconnect();
    }
  }

  /**
   * Setup WebSocket event handlers
   */
  private setupEventHandlers(): void {
    if (!this.ws) return;

    this.ws.onopen = () => {
      getContext().observability.breadcrumb('WebSocket connected', 'sync.websocket', 'info', {
        lastSyncId: this.lastSyncId,
        reconnectAttempts: this.reconnectAttempts,
      });
      this.isConnecting = false;
      this.reconnectAttempts = 0;
      this._everOpened = true;
      this.emit('connected');

      // Send presence update with timezone (server sets presence to "online" on connect,
      // this improves localTime accuracy by providing the user's actual timezone)
      this.sendPresenceUpdate('online');

      // Flush any queued offline mutations now that we're online
      // Fire-and-forget; emit events for UI if desired in the future
      (async () => {
        try {
          const res = await flushOfflineQueueOnce();
          if (res.processed > 0) {
            getContext().logger.info('Flushed offline mutations', res);
          }
        } catch (e) {
          getContext().observability.captureOfflineFlushFailure({
            error: e instanceof Error ? e.message : String(e),
          });
        }
      })();

      // Immediately request incremental sync based on our stored cursor/versions
      try {
        if (this.lastSyncId && this.lastSyncId > 0) {
          // Let server know where we left off before requesting deltas
          this.sendAck(this.lastSyncId);
        }
        this.requestIncrementalSync();
      } catch (e) {
        getContext().observability.breadcrumb(
          'Failed to request incremental sync on open',
          'sync.websocket',
          'warning',
          {
            error: e instanceof Error ? e.message : String(e),
          }
        );
      }

      // Start periodic catchup — polls for missed deltas every 30s.
      // Real-time WebSocket delivery is best-effort (fire-and-forget Redis pub/sub).
      // This interval guarantees eventual consistency by fetching any deltas that
      // were committed to the DB but whose broadcast was lost in transit.
      this.stopCatchupInterval();
      this.catchupInterval = setInterval(() => {
        if (this.ws?.readyState === WebSocket.OPEN) {
          this.requestIncrementalSync();
        }
      }, 30_000);
    };

    this.ws.onmessage = (event) => {
      try {
        const message: any = JSON.parse(event.data);

        // 🐛 DEBUG: Log delta messages only
        if (message.type === 'delta') {
          console.log('[SyncWebSocket] Delta received:', {
            type: message.type,
            payload: message.payload,
          });
        }

        // Handle different message types
        if (message.type === 'pong' || message.type === 'ping') {
          // Ignore keepalive messages
          getContext().logger.debug('Received keepalive', { type: message.type });
          return;
        }

        // Handle different message types
        switch (message.type) {
          case 'sync_response':
            this.handleSyncResponse(message.payload);
            break;
          case 'bootstrap_response':
            this.handleBootstrapResponse(message.payload);
            break;
          case 'presence_update':
            this.handlePresenceUpdate(message);
            break;
          case 'mutation_result': {
            // Ack for a prior `batch_ack` we sent. Wire format (mirrors
            // apps/sync-server/src/hub/types.ts MutationResultMessage):
            //   { type: 'mutation_result',
            //     payload: { clientTxId, serverTxId, success,
            //                lastSyncId?, error? } }
            const p = message.payload ?? message;
            const { clientTxId, success, lastSyncId, error } = p ?? {};
            const pending =
              typeof clientTxId === 'string'
                ? this.pendingMutations.get(clientTxId)
                : undefined;
            if (!pending) break;
            clearTimeout(pending.timeout);
            this.pendingMutations.delete(clientTxId);
            if (success) {
              pending.resolve({
                lastSyncId:
                  typeof lastSyncId === 'number' ? lastSyncId : 0,
              });
            } else {
              pending.reject(
                new Error(
                  typeof error === 'string'
                    ? error
                    : 'mutation failed on server',
                ),
              );
            }
            break;
          }
          case 'delta': {
            const p = message.payload;
            if (p?.actionType || p?.modelName) {
              this.handleDelta(p as SyncDelta);
            } else if (Array.isArray(p?.deltas)) {
              for (const d of p.deltas) {
                if (d?.actionType || d?.modelName) this.handleDelta(d as SyncDelta);
              }
              if (p?.newVersions) {
                Object.assign(this.versionVector, p.newVersions);
              }
            }
            break;
          }
          case undefined: // Legacy support: bare delta
            if (message.actionType || message.modelName) {
              this.handleDelta(message as SyncDelta);
            }
            break;
          default: {
            // Collaboration events use underscore wire format (e.g., 'sheet_selection')
            // Convert to colon format for the event map (e.g., 'sheet:selection')
            const eventKey = message.type?.replace(/_/g, ':');
            if (eventKey && this.collaborationEventTypes.has(eventKey)) {
              this.emit(eventKey, message.payload);
            } else {
              getContext().logger.debug('Received unknown message type', { message });
            }
          }
        }
      } catch (error) {
        getContext().observability.captureWebSocketError({
          context: 'parse-message',
          error: error instanceof Error ? error.message : String(error),
        });
      }
    };

    this.ws.onerror = (_event) => {
      // WebSocket errors are DOM Events, not Error objects
      // Check if we're offline first
      if (!getContext().onlineStatus.isOnline()) {
        getContext().observability.breadcrumb(
          'WebSocket error: Network is offline',
          'sync.websocket',
          'warning'
        );
        this.emit('error', new Error('Network is offline'));
        return;
      }

      // After session error, suppress Sentry capture — the root cause is already reported.
      // Still emit so SyncedStore can update UI state.
      const error = new Error(`WebSocket connection failed`);
      if (!this._sessionErrorDetected) {
        getContext().observability.captureWebSocketError({
          context: 'connection-error',
          error: error.message,
        });
      }
      this.emit('error', error);
    };

    this.ws.onclose = (event) => {
      getContext().logger.info('WebSocket closed', { code: event.code, reason: event.reason });
      this.isConnecting = false;
      this.ws = null;
      this.stopCatchupInterval();
      const everOpened = this._everOpened;

      // Cancel in-flight mutations — the socket that was carrying them is
      // gone, and the server-side state may or may not have accepted each
      // one. Rejecting promptly is better than hanging the caller forever;
      // higher-level retry belongs to TransactionQueue, not here.
      if (this.pendingMutations.size > 0) {
        for (const pending of this.pendingMutations.values()) {
          clearTimeout(pending.timeout);
          pending.reject(
            new Error(
              `WebSocket closed while batch_ack was in flight (code=${event.code})`,
            ),
          );
        }
        this.pendingMutations.clear();
      }

      // Check for session-related close codes
      // 1008 = Policy Violation (often auth)
      // 4001 = Unauthorized (custom)
      // 4003 = Forbidden (custom)
      const isSessionClose =
        event.code === 1008 ||
        event.code === 4001 ||
        event.code === 4003 ||
        SyncSessionError.isSessionError(event.reason || '');

      if (isSessionClose) {
        this._sessionErrorDetected = true;
        getContext().observability.captureWebSocketError({
          context: 'session-error-close',
          code: event.code,
          reason: event.reason,
        });
        this.emit('session_error', new SyncSessionError(event.reason || 'Session expired', event.code));
        // Don't reconnect for session errors - user needs to re-authenticate
        this.emit('disconnected', event);
        return;
      }

      // Handshake failure: `onclose` fired before `onopen` ever did, so the
      // server rejected the upgrade (typically 401/403 on a bad cookie, but
      // could also be a CORS/origin reject or an LB 5xx). The browser hides
      // the HTTP status behind code 1006, so we can't tell which from here.
      //
      // Emit a dedicated event and SKIP the internal reconnect — the owner
      // (SyncedStore / ConnectionStore) should run an auth-validating HTTP
      // probe to distinguish session expiry from a transient network issue
      // and transition the UI accordingly. Reconnecting blindly is what
      // produced the infinite "offline → reconnecting → offline" loop on
      // stale cookies.
      if (!everOpened && !this.isManualClose) {
        getContext().observability.captureWebSocketError({
          context: 'handshake-failed-close',
          code: event.code,
          reason: event.reason,
        });
        this.emit('handshake_failed', event);
        this.emit('disconnected', event);
        return;
      }

      this.emit('disconnected', event);

      // Reconnect if not manually closed
      if (!this.isManualClose) {
        this.scheduleReconnect();
      }
    };
  }

  /**
   * Handle incoming sync delta
   */
  private handleDelta(delta: SyncDelta): void {
    getContext().logger.debug('Received delta', {
      action: delta.actionType,
      model: delta.modelName,
      id: delta.modelId,
      syncId: delta.id,
    });

    // Update last sync ID to newest
    if (delta.id > this.lastSyncId) {
      this.lastSyncId = delta.id;
    }

    // Update version vector for this entity type
    const entityType = delta.modelName.toLowerCase();
    if (this.versionVector[entityType] !== undefined) {
      this.versionVector[entityType] = Math.max(this.versionVector[entityType], delta.id);
    }

    // Emit delta for processing. Ack will be sent by SyncedStore after persistence.
    this.emit('delta', delta);
  }

  /**
   * Send acknowledgment for received delta with version vector
   */
  private sendAck(syncId: number): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;

    this.send({
      type: 'ack',
      payload: {
        lastSyncId: syncId,
        versions: this.versionVector,
      },
    });
  }

  /**
   * Public wrapper for sending ack from outside the class
   */
  acknowledge(syncId: number): void {
    this.sendAck(syncId);
  }

  /**
   * Send message to server
   */
  send(message: any): void {
    if (this.ws?.readyState !== WebSocket.OPEN) {
      // Only log at debug level when offline - this is expected behavior, not an error
      if (getContext().onlineStatus.isOnline()) {
        getContext().observability.breadcrumb(
          'WebSocket not connected, cannot send message',
          'sync.websocket',
          'warning'
        );
      } else {
        getContext().logger.debug('WebSocket send skipped - offline');
      }
      return;
    }

    try {
      this.ws.send(JSON.stringify(message));
    } catch (error) {
      // Only log as error if we're online - offline send failures are expected
      if (getContext().onlineStatus.isOnline()) {
        getContext().observability.captureWebSocketError({
          context: 'send-message',
          error: error instanceof Error ? error.message : String(error),
        });
      } else {
        getContext().logger.debug('WebSocket send failed - offline');
      }
    }
  }

  /**
   * Send a `batch_ack` mutation request over the existing WebSocket and
   * resolve when the server's `mutation_result` frame comes back with the
   * same `clientTxId`. Mirrors the Hub protocol used by SyncAgent — the
   * human-client equivalent of `SyncAgent.batchAck()`.
   *
   * The transport path matters: before this existed, the main web client
   * routed mutations through the REST/GraphQL adapter (which targeted
   * the Go sync-engine). When the Go server was retired in favor of the
   * TS sync-server, that adapter posted into the void. This method gives
   * the mutation executor a transport that's already connected, already
   * authenticated, and already multiplexed with the delta stream.
   *
   * Times out after 15s of silence from the server. The socket may close
   * during an in-flight mutation (network flap, server restart); we do
   * NOT auto-retry here — the caller's TransactionQueue owns retry +
   * offline replay semantics and the SDK shouldn't duplicate that logic.
   */
  sendBatchAck(
    operations: ReadonlyArray<{
      type: string;
      model: string;
      id: string;
      input?: Record<string, unknown>;
    }>,
    clientTxId: string,
    timeoutMs = 15_000,
  ): Promise<{ lastSyncId: number }> {
    if (this.ws?.readyState !== WebSocket.OPEN) {
      return Promise.reject(
        new Error(
          'SyncWebSocket not connected — cannot send commit',
        ),
      );
    }

    return new Promise<{ lastSyncId: number }>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingMutations.delete(clientTxId);
        reject(
          new Error(
            `commit timed out after ${timeoutMs}ms (clientTxId=${clientTxId})`,
          ),
        );
      }, timeoutMs);
      this.pendingMutations.set(clientTxId, { resolve, reject, timeout });
      try {
        this.ws!.send(
          JSON.stringify({
            type: 'commit',
            payload: { operations, clientTxId },
          }),
        );
      } catch (error) {
        clearTimeout(timeout);
        this.pendingMutations.delete(clientTxId);
        reject(
          error instanceof Error
            ? error
            : new Error(String(error)),
        );
      }
    });
  }

  /**
   * Send spreadsheet selection presence
   */
  sendSheetSelection(sheetId: string, selectedCells: Array<{ ref: string }>): void {
    this.sendCollaborationEvent('sheet:selection' as string & keyof TCollaboration, {
      sheetId,
      selectedCells,
    } as never);
  }

  /**
   * Send slide layer selection presence
   */
  sendSlideSelection(
    deckId: string,
    slideId: string,
    selectedLayers: Array<{ layerId: string }>
  ): void {
    this.sendCollaborationEvent('slide:selection' as string & keyof TCollaboration, {
      deckId,
      slideId,
      selectedLayers,
    } as never);
  }

  /**
   * Send slide cursor position for real-time collaboration
   * Note: Throttling should be handled by the caller (e.g., useSlideCursorBroadcast hook)
   */
  sendSlideCursor(deckId: string, slideId: string, x: number, y: number): void {
    this.sendCollaborationEvent('slide:cursor' as string & keyof TCollaboration, {
      deckId,
      slideId,
      x,
      y,
    } as never);
  }

  /**
   * Send presence update to server.
   * Use this for:
   * - Updating timezone (improves localTime accuracy shown to other users)
   * - Manual status changes (away, custom status)
   *
   * Note: "online" status is automatically set by server on WebSocket connect,
   * and "offline" is set on disconnect. You don't need to call this for basic online/offline.
   *
   * @param status - "online", "away", or custom status string
   * @param customStatus - Optional custom status message
   */
  sendPresenceUpdate(
    status: 'online' | 'away' | 'offline' = 'online',
    customStatus?: string
  ): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;

    const timezone = (() => {
      try {
        return Intl.DateTimeFormat().resolvedOptions().timeZone;
      } catch {
        return 'UTC';
      }
    })();

    this.send({
      type: 'presence_update',
      payload: {
        status,
        timezone,
        ...(customStatus ? { customStatus } : {}),
      },
    });
  }

  /**
   * Schedule reconnection with exponential backoff
   */
  private scheduleReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }

    // Session error means the user needs to re-authenticate — don't reconnect.
    if (this._sessionErrorDetected) {
      return;
    }

    // Don't attempt reconnection while offline.
    // SyncedStore.handleNetworkOnline() owns the offline→online transition:
    // it bootstraps first, then calls syncWebSocket.connect() explicitly.
    // Self-reconnecting here would bypass the bootstrap gate and cause stale data.
    if (!getContext().onlineStatus.isOnline()) {
      this.emit('reconnecting', { attempt: this.reconnectAttempts + 1, delay: 0 });
      return;
    }

    // Give up after MAX_RECONNECT_ATTEMPTS consecutive failures.
    // The user can recover by refreshing or when network comes back online
    // (handleNetworkOnline resets attempts and reconnects).
    if (this.reconnectAttempts >= SyncWebSocket.MAX_RECONNECT_ATTEMPTS) {
      this.emit('reconnect_failed', { attempts: this.reconnectAttempts });
      return;
    }

    // Exponential backoff with ±15% jitter to prevent thundering herd
    const baseDelay = Math.min(
      this.options.reconnectDelay * Math.pow(2, this.reconnectAttempts),
      this.options.maxReconnectDelay
    );
    const jitter = baseDelay * (0.85 + Math.random() * 0.3);
    const delay = Math.round(jitter);

    // Emit reconnecting event so UI can show reconnection status
    this.emit('reconnecting', { attempt: this.reconnectAttempts + 1, delay });

    this.reconnectTimer = setTimeout(() => {
      this.reconnectAttempts++;
      this.connect();
    }, delay);
  }

  /**
   * Reset reconnect attempt counter. Called when network comes back online
   * to allow a fresh reconnect cycle after the max was previously reached.
   */
  resetReconnectAttempts(): void {
    this.reconnectAttempts = 0;
  }

  /**
   * Stop the periodic catchup interval
   */
  private stopCatchupInterval(): void {
    if (this.catchupInterval) {
      clearInterval(this.catchupInterval);
      this.catchupInterval = null;
    }
  }

  /**
   * Disconnect from WebSocket
   */
  disconnect(): void {
    this.isManualClose = true;
    this.stopCatchupInterval();

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.ws) {
      this.ws.close(1000, 'Manual disconnect');
      this.ws = null;
    }
  }

  /**
   * Get connection state
   */
  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  /** Returns the sync groups this connection is subscribed to. */
  getSyncGroups(): string[] {
    return this.options.syncGroups;
  }

  /**
   * Update last sync ID (for persistence)
   */
  setLastSyncId(syncId: number): void {
    this.lastSyncId = syncId;
  }

  /**
   * Get current version vector
   */
  getVersionVector(): VersionVector {
    return { ...this.versionVector };
  }

  /**
   * Update version vector for specific entity type
   */
  updateVersionVector(entityType: string, version: number): void {
    this.versionVector[entityType] = Math.max(this.versionVector[entityType] || 0, version);
  }

  /**
   * Set version vector (for initialization)
   */
  setVersionVector(versions: VersionVector): void {
    this.versionVector = { ...versions };
  }

  /**
   * Update sync cursor (for incremental sync)
   */
  setSyncCursor(cursor: string | null): void {
    this.syncCursor = cursor;
  }

  /**
   * Get current sync cursor
   */
  getSyncCursor(): string | null {
    return this.syncCursor;
  }

  /**
   * Get the highest syncId seen this session (for persistence on clean shutdown)
   */
  getLastSyncId(): number {
    return this.lastSyncId || 0;
  }

  /**
   * Linear-style incremental sync request
   */
  async requestIncrementalSync(): Promise<void> {
    if (this.ws?.readyState !== WebSocket.OPEN) {
      // Silent when offline - not an error condition
      if (getContext().onlineStatus.isOnline()) {
        getContext().observability.breadcrumb(
          'WebSocket not connected, cannot request sync',
          'sync.websocket',
          'warning'
        );
      }
      return;
    }

    // Normalize capabilities to an array of strings for server compatibility
    const capsObj = this.options.capabilities || {};
    const capsArr = Object.entries(capsObj)
      .filter(([, v]) => !!v)
      .map(([k]) => k);

    this.send({
      type: 'sync_request',
      payload: {
        cursor: this.syncCursor,
        versions: this.versionVector,
        // Always send lastSyncId to ensure server uses client's current position
        lastSyncId: this.lastSyncId,
        capabilities: capsArr,
      },
    });
  }

  /**
   * Request bootstrap for specific entities
   */
  async requestBootstrap(entities?: string[]): Promise<void> {
    if (this.ws?.readyState !== WebSocket.OPEN) {
      // Silent when offline - not an error condition
      if (getContext().onlineStatus.isOnline()) {
        getContext().observability.breadcrumb(
          'WebSocket not connected, cannot request bootstrap',
          'sync.websocket',
          'warning'
        );
      }
      return;
    }

    this.send({
      type: 'bootstrap_request',
      payload: {
        entities: entities || [],
        versions: this.versionVector,
        capabilities: this.options.capabilities,
      },
    });
  }

  /**
   * Handle sync response from server
   */
  private handleSyncResponse(payload: any): void {
    if (payload.requiresBootstrap) {
      this.emit('bootstrap_required', payload.bootstrapHint);
      return;
    }

    // Process incremental deltas
    if (payload.deltas && Array.isArray(payload.deltas)) {
      // Process all deltas from sync response - store handles idempotency
      const newDeltas = payload.deltas;

      if (newDeltas.length > 0) {
        // Update lastSyncId to the highest delta ID in batch
        const maxDeltaId = Math.max(...newDeltas.map((d: SyncDelta) => d.id));
        this.lastSyncId = maxDeltaId;

        // Update version vector
        newDeltas.forEach((delta: SyncDelta) => {
          const entityType = delta.modelName.toLowerCase();
          if (this.versionVector[entityType] !== undefined) {
            this.versionVector[entityType] = Math.max(this.versionVector[entityType], delta.id);
          }
        });

        // Emit ALL deltas as a single batch event
        this.emit('delta_batch', newDeltas);
      }
    }

    // Update cursors and versions
    if (payload.newCursor) {
      this.syncCursor = payload.newCursor;
    } else if (payload.cursor) {
      this.syncCursor = payload.cursor;
    }

    if (payload.newVersions) {
      Object.assign(this.versionVector, payload.newVersions);
    }
  }

  /**
   * Handle bootstrap response from server
   */
  private handleBootstrapResponse(payload: any): void {
    // Emit bootstrap data for processing
    this.emit('bootstrap_data', {
      entityType: payload.entityType,
      data: payload.data,
      isComplete: payload.isComplete,
      cursor: payload.cursor,
    });

    // Update version vector if provided
    if (payload.version && payload.entityType) {
      this.updateVersionVector(payload.entityType.toLowerCase(), payload.version);
    }
  }

  /**
   * Handle presence update from server
   */
  private handlePresenceUpdate(message: any): void {
    // Emit presence update for the store to handle
    this.emit('presence_update', {
      userId: message.userId,
      status: message.status,
      localTime: message.localTime,
      timestamp: message.timestamp,
      type: message.type,
    });
    // Increment metric counter
    try {
      // Dynamic import to avoid bundling issues
    } catch {}
  }
}
