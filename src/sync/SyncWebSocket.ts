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
import { getContext } from '../context.js';
import { flushOfflineQueueOnce } from './OfflineFlush.js';
import {
  AbloClaimedError,
  CapabilityError,
  SyncSessionError,
  type RequiredCapability,
} from '../errors.js';
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
  /**
   * Collaboration event type keys to listen for (e.g., ['sheet:selection', 'slide:cursor']).
   * Wire messages with matching types (underscore format) will be emitted as events.
   */
  collaborationEvents?: string[];
  /**
   * Participant kind to declare on the WS upgrade. Defaults to `'user'`
   * (session-auth, web app). Agent runtimes (Node workers) pass
   * `'agent'` so the server's `agentTokenProvider`
   * routes them through capability-token verification instead of
   * session auth. The server reads this as the `kind` query param.
   */
  kind?: 'user' | 'agent' | 'system';
  /**
   * The agent's bearer credential — a restricted (`rk_`) API key. When
   * set, sent as `?authorization=Bearer+<token>` on the WS upgrade —
   * query-param form so it works in both Node (no header support) and
   * browsers. The server's auth path accepts either form. Required for
   * `kind: 'agent'`; ignored for `kind: 'user'`. (Field name predates
   * the Biscuit→opaque-key migration.)
   */
  capabilityToken?: string;
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
}

/** Bootstrap data event payload */
export interface BootstrapDataEvent {
  entityType: string;
  data: unknown;
  isComplete: boolean;
  cursor?: string;
}

/**
 * Presence update event payload — mirrors the wire frame's `payload`
 * field (apps/sync-server/src/hub/types.ts PresenceUpdateMessage).
 *
 * Every consumer (web entity-presence cache, PresenceStream,
 * agent-runtime presence reducer) reads its own subset; this type is
 * the union of what the server actually sends. Stripping fields at
 * this layer (the prior bug) silently broke rich-presence consumers
 * that needed `kind`, `activity`, `isAgent` to dispatch correctly.
 */
export interface PresenceUpdateEvent {
  /** Server-stamped transition: 'enter' on join + roster snapshot,
   *  'update' on activity change, 'leave' on disconnect. */
  kind?: 'enter' | 'update' | 'leave';
  userId: string;
  status: string;
  syncGroups?: string[];
  activity?: {
    entityType: string;
    entityId: string;
    path?: string;
    range?: {
      startLine: number;
      endLine: number;
      startColumn?: number;
      endColumn?: number;
    };
    field?: string;
    meta?: Record<string, unknown>;
    action: string;
    detail?: string;
  };
  /** Server-derived from the connection's userId prefix. Clients must
   *  not self-declare — server is the source of truth. */
  isAgent?: boolean;
  timestamp?: number;
  /** Server stamps every presence frame with this participant's open
   *  intent claims so peers see them without a separate channel. Wire
   *  shape mirrors `apps/sync-server/src/hub/types.ts IntentClaim`. */
  activeIntents?: Array<{
    intentId: string;
    entityType: string;
    entityId: string;
    path?: string;
    range?: {
      startLine: number;
      endLine: number;
      startColumn?: number;
      endColumn?: number;
    };
    action: string;
    field?: string;
    meta?: Record<string, unknown>;
    declaredAt: number;
    expiresAt: number;
    /**
     * Lifecycle state. Additive — older servers omit it and the reader
     * treats absence as `'active'`. Terminal states (`committed` /
     * `expired` / `canceled`) ride one frame as the claim ends so peers
     * learn *how* it resolved before it drops from the active set.
     */
    status?: 'active' | 'committed' | 'expired' | 'canceled';
    error?: {
      code: string;
      message?: string;
      heldBy?: string;
      heldByIntentId?: string;
      heldByExpiresAt?: number;
    };
  }>;
  // Legacy/optional fields kept for back-compat with the web's
  // simpler online/offline cache.
  localTime?: string;
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
  /**
   * Server-initiated notification that a previously-active claim's
   * TTL has expired. Consumers (e.g., the participant SDK) re-mint
   * a fresh capability and re-claim, OR accept the drop. The claim
   * is already inactive on the server side by the time this fires —
   * no client-side action needed unless re-claiming.
   */
  claim_expired: [{ claimId: string }];
  /**
   * Server rejected an `intent_begin` because another participant
   * already holds an open claim on the same target (cooperative
   * mutex enforced server-side). Surfaces to the participant-level
   * IntentStream so the caller knows their announce was denied.
   * Payload mirrors the wire frame's `payload`.
   */
  intent_rejected: [Record<string, unknown>];
  /**
   * Fair-queue frames (opt-in `queue: true` on `intent_begin`). `intent_acquired`
   * means the target was free and the lease is ours immediately; `intent_queued`
   * means the claim is waiting in line (carries `position`); `intent_granted`
   * means it reached the head and the lease is now ours; `intent_lost` means a
   * held/granted claim was taken away (TTL lapse on disconnect, revoke).
   */
  /**
   * Per-entity wait-queue snapshot: `{ target, queue: Intent[] }` with each
   * entry `status: 'queued'` + `position`. Broadcast to entity peers on every
   * queue mutation — powers the reactive `ablo.<model>.queue(id)` read.
   */
  intent_queue: [Record<string, unknown>];
  intent_acquired: [Record<string, unknown>];
  intent_queued: [Record<string, unknown>];
  intent_granted: [Record<string, unknown>];
  intent_lost: [Record<string, unknown>];
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
  private options: Required<
    Omit<SyncWebSocketOptions, 'baseUrl' | 'kind' | 'capabilityToken'>
  > & {
    baseUrl?: string;
    // `kind` and `capabilityToken` are genuinely optional: web sessions
    // don't pass either, agents pass both. Excluded from the Required<>
    // wrap so consumers don't have to supply placeholders.
    kind?: SyncWebSocketOptions['kind'];
    capabilityToken?: SyncWebSocketOptions['capabilityToken'];
  };
  private reconnectAttempts = 0;
  /** Stop retrying after this many consecutive failures (backoff caps at 30s, so ~7.5 min total) */
  private static readonly MAX_RECONNECT_ATTEMPTS = 15;
  private reconnectTimer: NodeJS.Timeout | null = null;
  /** Periodic catchup interval — polls for missed deltas every 30s while connected */
  private catchupInterval: NodeJS.Timeout | null = null;
  /**
   * Application-level heartbeat. The browser WebSocket API hides RFC 6455
   * protocol-level ping/pong from JavaScript, so the server's `ws.ping()`
   * keepalive can't be observed by client code — meaning the client cannot
   * tell a healthy idle connection apart from a "zombie" socket where TCP
   * silently broke (laptop sleep, NAT timeout, mobile handoff). We send an
   * application-level `{ type: 'ping' }` every 30s and force-close the
   * socket if no inbound traffic arrives within 10s. ANY inbound message
   * counts as proof-of-life — the explicit `pong` is just a guarantee that
   * something will arrive even on an idle stream.
   */
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatTimeoutTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly HEARTBEAT_INTERVAL_MS = 30_000;
  private static readonly HEARTBEAT_TIMEOUT_MS = 10_000;
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
  /**
   * Diagnostic snapshot of the last connection lifecycle. Persisted across
   * the lifetime of the SyncWebSocket so that any subsequent "not connected"
   * rejection can quote the actual root cause (close code + reason + when)
   * instead of bottoming out at a generic error string. Browser WS code 1006
   * hides the real reason, so we layer on our own signals: `forceCloseReason`
   * captures heartbeat trips / send failures, `everOpened` distinguishes
   * handshake reject from mid-session drop, and `sessionErrorAt` tells us
   * whether reconnect is suppressed.
   */
  private lastOpenAt: number | null = null;
  private lastCloseAt: number | null = null;
  private lastCloseCode: number | null = null;
  private lastCloseReason: string | null = null;
  private lastForceCloseReason: string | null = null;
  private sessionErrorAt: number | null = null;
  private lastSyncId: number;
  private versionVector: VersionVector;
  private syncCursor: string | null = null;
  /** Registered collaboration event keys (colon format) for dispatch in onmessage */
  private collaborationEventTypes: Set<string>;

  /**
   * In-flight `commit` mutation requests keyed by clientTxId. Resolved when
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

  /**
   * In-flight `claim` requests keyed by claimId. Resolved when the
   * matching `claim_ack` arrives, or rejected on timeout/disconnect.
   * Same shape as pendingMutations — Phoenix-style request/response
   * over a multiplexed connection.
   */
  private pendingClaims = new Map<
    string,
    {
      resolve: (value: { syncGroups: string[]; ttlSeconds?: number }) => void;
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
    this.sessionErrorAt = Date.now();
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

    // Pattern: one credential, server-resolved identity. The WS URL
    // carries the credential (cap-token bearer in `?authorization=`
    // for the cap path; session cookie in headers for the cookie
    // path). The server's AuthProvider chain (`apiKeyProvider →
    // agentTokenProvider → betterAuthProvider`) resolves identity
    // from the verified credential — userId/organizationId are
    // NEVER read from URL params in production. See
    // `apps/sync-server/src/auth/provider.ts:148` (betterAuthProvider
    // calls `auth.api.getSession({headers})`) and `agentTokenProvider`
    // for the cap-token path.
    const params = new URLSearchParams({
      // Intentionally omit lastSyncId, versions, capabilities from URL; these are sent in sync_request
      // and ack messages to avoid stale baselines on reconnect.
      cursor: this.syncCursor || '',
    });

    // Participant kind — defaults to `user` for backward compatibility
    // with web sessions. Agent runtimes pass `'agent'` so the server's
    // capability-token path activates instead of session auth.
    if (this.options.kind && this.options.kind !== 'user') {
      params.set('kind', this.options.kind);
    }

    // Capability bearer (query-param form so it works in both Node's
    // global WebSocket — which can't set headers — and browsers).
    if (this.options.capabilityToken) {
      params.set(
        'authorization',
        `Bearer ${this.options.capabilityToken}`,
      );
    }

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
      this.lastOpenAt = Date.now();
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

      // Start application-level heartbeat — see field declaration for rationale.
      this.startHeartbeat();
    };

    this.ws.onmessage = (event) => {
      try {
        const message: any = JSON.parse(event.data);

        // ANY inbound frame proves the socket is alive — clear the
        // heartbeat-timeout timer so we don't false-trip force-close
        // during normal traffic.
        this.clearHeartbeatTimeout();

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
            // Ack for a prior `commit` we sent. Wire format (mirrors
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
              // Capture the FULL server error so the user can see what
              // actually rejected the mutation. Without this, every
              // rejection becomes the generic "mutation failed on
              // server" — useless when debugging chart batches that
              // tank 40+ ops at once. We stringify object errors so
              // structured server payloads (e.g., Zod issues, schema
              // violations) survive the trip through `new Error(...)`.
              let errorMessage: string;
              let errorCode: string | undefined;
              let requiredCapability: RequiredCapability | undefined;
              if (typeof error === 'string') {
                errorMessage = error;
              } else if (error != null && typeof error === 'object') {
                const obj = error as {
                  code?: unknown;
                  message?: unknown;
                  requiredCapability?: unknown;
                };
                if (typeof obj.code === 'string') errorCode = obj.code;
                if (typeof obj.message === 'string') {
                  errorMessage = obj.message;
                } else {
                  try {
                    errorMessage = JSON.stringify(error);
                  } catch {
                    errorMessage = String(error);
                  }
                }
                if (
                  obj.requiredCapability != null &&
                  typeof obj.requiredCapability === 'object' &&
                  typeof (obj.requiredCapability as { scope?: unknown }).scope === 'string'
                ) {
                  requiredCapability = obj.requiredCapability as RequiredCapability;
                }
              } else {
                errorMessage = 'mutation failed on server';
              }
              // Capability denials route through the typed CapabilityError
              // so callers can `instanceof CapabilityError` and read
              // `.requiredCapability` to attenuate-and-retry without
              // string-matching the error code.
              if (
                errorCode === 'capability_scope_denied' ||
                errorCode === 'capability_invalid'
              ) {
                pending.reject(
                  new CapabilityError(errorCode, errorMessage, requiredCapability),
                );
              } else if (
                errorCode === 'intent_conflict' ||
                errorCode === 'claim_conflict' ||
                errorCode === 'entity_claimed'
              ) {
                // Claim enforcement: another participant holds a live claim on
                // a targeted entity. Two server layers reject this — the Hub's
                // pre-commit lease check (`intent_conflict`, the code that
                // reaches clients in practice) and `executeCommit`'s deeper
                // guard (`entity_claimed`). Both mean "claimed", so both route
                // through the typed AbloClaimedError, letting callers
                // `instanceof AbloClaimedError` (or read `e.type` across worker
                // boundaries) and wait/bypass — symmetric with the
                // CapabilityError branch above, and with the HTTP commit path
                // (`translateHttpError`).
                pending.reject(
                  new AbloClaimedError(errorMessage, {
                    code: errorCode === 'intent_conflict' ? 'claim_conflict' : errorCode,
                    httpStatus: 409,
                  }),
                );
              } else {
                const rejection = new Error(errorMessage) as Error & {
                  code?: string;
                };
                if (errorCode) rejection.code = errorCode;
                pending.reject(rejection);
              }
            }
            break;
          }
          case 'claim_ack': {
            // Ack for a prior `claim` we sent. Wire format mirrors
            // apps/sync-server/src/hub/types.ts ClaimAckMessage:
            //   { type: 'claim_ack',
            //     payload: { claimId, success, syncGroups?,
            //                ttlSeconds?, error? } }
            const p = message.payload ?? {};
            const { claimId, success, syncGroups, ttlSeconds, error } = p;
            const pending =
              typeof claimId === 'string'
                ? this.pendingClaims.get(claimId)
                : undefined;
            if (!pending) break;
            clearTimeout(pending.timeout);
            this.pendingClaims.delete(claimId);
            if (success) {
              pending.resolve({
                syncGroups: Array.isArray(syncGroups) ? syncGroups : [],
                ttlSeconds: typeof ttlSeconds === 'number' ? ttlSeconds : undefined,
              });
            } else {
              const code =
                error?.code && typeof error.code === 'string'
                  ? error.code
                  : 'claim_rejected';
              const msg =
                error?.message && typeof error.message === 'string'
                  ? error.message
                  : 'claim rejected by server';
              // Capability denials get the typed CapabilityError so
              // callers can read `.requiredCapability` and attenuate-
              // and-retry the claim with a narrower token.
              if (
                code === 'capability_scope_denied' ||
                code === 'capability_invalid'
              ) {
                const rc = (error as { requiredCapability?: unknown } | undefined)
                  ?.requiredCapability;
                const requiredCapability =
                  rc != null &&
                  typeof rc === 'object' &&
                  typeof (rc as { scope?: unknown }).scope === 'string'
                    ? (rc as RequiredCapability)
                    : undefined;
                pending.reject(new CapabilityError(code, msg, requiredCapability));
              } else {
                // Attach `code` as a property on the rejection so callers
                // can discriminate (`scope_conflict`, `malformed_claim`,
                // ...) without parsing the message.
                const rejection: Error & { code: string } = Object.assign(
                  new Error(`${code}: ${msg}`),
                  { code },
                );
                pending.reject(rejection);
              }
            }
            break;
          }
          case 'claim_expired': {
            // Server-initiated expiry notification. Emit as a typed
            // event so consumers can react (re-claim with a fresh
            // capability, or accept the drop). The claim is already
            // inactive server-side by the time this arrives.
            const p = message.payload ?? {};
            if (typeof p.claimId === 'string') {
              this.emit('claim_expired', { claimId: p.claimId });
            }
            break;
          }
          case 'intent_rejected': {
            // Server denied an `intent_begin` because the target is
            // already claimed by another participant. Forward the
            // payload as-is — the IntentStream consumer interprets
            // the conflict shape (peerId, target, etc.).
            this.emit('intent_rejected', message.payload ?? {});
            break;
          }
          case 'intent_acquired': {
            // Opt-in fair queue: the target was free, so the lease is ours
            // immediately (no waiting). Payload carries { intentId, target }.
            this.emit('intent_acquired', message.payload ?? {});
            break;
          }
          case 'intent_queue': {
            // Per-entity wait-queue snapshot for reactive `queue(id)`.
            this.emit('intent_queue', message.payload ?? {});
            break;
          }
          case 'intent_queued': {
            // Opt-in fair queue: our claim is waiting in line. Payload
            // carries { intentId, target, position }.
            this.emit('intent_queued', message.payload ?? {});
            break;
          }
          case 'intent_granted': {
            // Our queued claim reached the head — the lease is now ours.
            this.emit('intent_granted', message.payload ?? {});
            break;
          }
          case 'intent_lost': {
            // A held/granted claim was taken from us (TTL lapse, revoke).
            this.emit('intent_lost', message.payload ?? {});
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
      const everOpened = this._everOpened;
      this.lastCloseAt = Date.now();
      this.lastCloseCode = event.code;
      this.lastCloseReason = event.reason || null;
      getContext().logger.info('WebSocket closed', {
        code: event.code,
        reason: event.reason,
        everOpened,
        reconnectAttempts: this.reconnectAttempts,
        forceCloseReason: this.lastForceCloseReason,
        msSinceOpen:
          this.lastOpenAt != null ? Date.now() - this.lastOpenAt : null,
        isManualClose: this.isManualClose,
      });
      this.isConnecting = false;
      this.ws = null;
      this.stopCatchupInterval();
      this.stopHeartbeat();

      // Cancel in-flight mutations — the socket that was carrying them is
      // gone, and the server-side state may or may not have accepted each
      // one. Rejecting promptly is better than hanging the caller forever;
      // higher-level retry belongs to TransactionQueue, not here.
      if (this.pendingMutations.size > 0) {
        for (const pending of this.pendingMutations.values()) {
          clearTimeout(pending.timeout);
          pending.reject(
            Object.assign(
              new Error(
                `WebSocket closed while commit was in flight (code=${event.code}` +
                  (event.reason ? ` reason=${event.reason}` : '') +
                  (this.lastForceCloseReason
                    ? ` forceCloseReason=${this.lastForceCloseReason}`
                    : '') +
                  ')',
              ),
              { diagnostics: this.getConnectionDiagnostics() },
            ),
          );
        }
        this.pendingMutations.clear();
      }

      // Cancel in-flight claims — same rationale. Server-side
      // claims are bound to the connection; a reconnect will need
      // to re-claim. Higher-level retry belongs to whoever holds
      // the participant handle (typically the SDK's claim manager).
      if (this.pendingClaims.size > 0) {
        for (const pending of this.pendingClaims.values()) {
          clearTimeout(pending.timeout);
          pending.reject(
            new Error(
              `WebSocket closed while claim was in flight (code=${event.code})`,
            ),
          );
        }
        this.pendingClaims.clear();
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
        this.sessionErrorAt = Date.now();
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

    // DO NOT advance `this.lastSyncId` on receipt. The runtime cursor
    // must stay consistent with what's persisted in IDB — otherwise the
    // next `requestIncrementalSync()` (and the connect-time handshake)
    // sends an optimistic cursor and the server skips deltas that never
    // landed in IDB. `this.lastSyncId` is advanced only in `sendAck()`,
    // which is gated on `BaseSyncedStore.flushPendingDeltas`'s
    // `persistedSyncId` watermark. See Replicache's "lastMutationID
    // read in the same transaction as the client view" rule.
    //
    // Version vector is also intentionally NOT updated here for the
    // same reason — left to the persistence-gated path.

    // Emit delta for processing. Ack will be sent by SyncedStore after persistence.
    this.emit('delta', delta);
  }

  /**
   * Send acknowledgment for received delta with version vector.
   *
   * This is the SOLE forward-mover of `this.lastSyncId` for live
   * deltas. Called by `BaseSyncedStore.flushPendingDeltas` with the
   * `persistedSyncId` watermark — i.e. only after the deltas have
   * actually committed to IDB. Keeping the cursor advance here (rather
   * than at receipt in `handleDelta`/`handleSyncResponse`) means the
   * cursor never gets ahead of the persisted view, so reconnect/
   * catch-up requests can't accidentally skip un-persisted deltas.
   */
  private sendAck(syncId: number): void {
    // Advance the local cursor *and* the version vector for this ack —
    // these are what `requestIncrementalSync` and the connect handshake
    // will send next, and what `getLastSyncId()` reports for clean-
    // shutdown persistence.
    if (syncId > this.lastSyncId) {
      this.lastSyncId = syncId;
    }

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
   * Send a `commit` mutation request over the existing WebSocket and
   * resolve when the server's `mutation_result` frame comes back with
   * the same `clientTxId`. The wire-level frame is `{ type: 'commit',
   * payload: { operations, clientTxId } }` — matching the
   * `handleCommit` path on `apps/sync-server/src/hub/Hub.ts` (see the
   * dispatch at Hub.ts:737).
   *
   * Historical naming note: this was originally `sendBatchAck` back when
   * the Go sync-engine used a GraphQL `batchAck` mutation. The TS
   * sync-server uses `type: 'commit'` over WebSocket exclusively. The
   * method name now matches the wire protocol so the ack/commit naming
   * confusion stops here.
   *
   * Times out after 15s of silence from the server. The socket may close
   * during an in-flight mutation (network flap, server restart); we do
   * NOT auto-retry here — the caller's TransactionQueue owns retry +
   * offline replay semantics and the SDK shouldn't duplicate that logic.
   */
  sendCommit(
    operations: ReadonlyArray<{
      type: string;
      model: string;
      id: string;
      input?: Record<string, unknown>;
      /**
       * Per-op client transaction id. The server stamps this onto
       * `sync_deltas.transaction_id` so the originating client
       * recognizes the broadcast as an echo of its own optimistic
       * mutation (echo detection in `SyncClient.applyDeltaBatchToPool`).
       * Distinct from the batch-level `clientTxId` argument below
       * (which keys `mutation_log` for retry idempotency). See
       * `apps/sync-server/docs/OPTIMISTIC_RECONCILIATION.md`.
       */
      transactionId?: string;
      readAt?: number | null;
      onStale?: 'reject' | 'force' | 'flag' | 'merge' | null;
    }>,
    clientTxId: string,
    timeoutMs = 15_000,
    causedByTaskId?: string | null,
  ): Promise<{ lastSyncId: number }> {
    if (this.ws?.readyState !== WebSocket.OPEN) {
      return Promise.reject(this.notConnectedError('commit'));
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
        // `causedByTaskId` is included only when the agent SDK has
        // an open turn — keeps the wire shape stable for sessions
        // that don't use turns. Servers that don't know the field
        // ignore it; newer servers stamp it onto every delta.
        const payload: {
          operations: typeof operations;
          clientTxId: string;
          causedByTaskId?: string;
        } = { operations, clientTxId };
        if (causedByTaskId) payload.causedByTaskId = causedByTaskId;
        this.ws!.send(
          JSON.stringify({ type: 'commit', payload }),
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
   * Send a commit frame without waiting for `mutation_result`.
   *
   * This backs the public `wait: 'queued'` API: the socket accepted the
   * frame for delivery, but the server has not confirmed it yet. The
   * eventual `mutation_result` frame is intentionally ignored by this
   * instance because no pending resolver is registered.
   */
  sendCommitQueued(
    operations: ReadonlyArray<{
      type: string;
      model: string;
      id: string;
      input?: Record<string, unknown>;
      transactionId?: string;
      readAt?: number | null;
      onStale?: 'reject' | 'force' | 'flag' | 'merge' | null;
    }>,
    clientTxId: string,
    causedByTaskId?: string | null,
  ): void {
    if (this.ws?.readyState !== WebSocket.OPEN) {
      throw this.notConnectedError('commit');
    }
    const payload: {
      operations: typeof operations;
      clientTxId: string;
      causedByTaskId?: string;
    } = { operations, clientTxId };
    if (causedByTaskId) payload.causedByTaskId = causedByTaskId;
    this.ws.send(JSON.stringify({ type: 'commit', payload }));
  }

  /**
   * Activate a participant claim on this connection. Multiplexed
   * subscription pattern (Phoenix Channels / Pusher) — the same
   * connection can hold N concurrent claims, each scoped to a
   * different set of sync groups.
   *
   * Returns a promise that resolves with the server-canonicalized
   * `syncGroups` and effective `ttlSeconds` once `claim_ack` arrives,
   * or rejects with a typed error on `success: false` ack /
   * timeout / disconnect.
   *
   * Why this exists: the old scoped-participant path opened a separate
   * WS per scope. With claims, the SDK reuses the existing session/agent
   * connection — one TCP, N logical participants. See
   * `apps/sync-server/docs/PARTICIPANT_CLAIMS.md` for the migration
   * framing (Phase A.1).
   */
  sendClaim(
    claimId: string,
    syncGroups: ReadonlyArray<string>,
    options?: {
      capabilityToken?: string;
      ttlSeconds?: number;
      timeoutMs?: number;
    },
  ): Promise<{ syncGroups: string[]; ttlSeconds?: number }> {
    if (this.ws?.readyState !== WebSocket.OPEN) {
      return Promise.reject(this.notConnectedError('claim'));
    }
    const timeoutMs = options?.timeoutMs ?? 15_000;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingClaims.delete(claimId);
        reject(
          new Error(`claim timed out after ${timeoutMs}ms (claimId=${claimId})`),
        );
      }, timeoutMs);
      this.pendingClaims.set(claimId, { resolve, reject, timeout });
      try {
        this.ws!.send(
          JSON.stringify({
            type: 'claim',
            payload: {
              claimId,
              syncGroups: [...syncGroups],
              capabilityToken: options?.capabilityToken,
              ttlSeconds: options?.ttlSeconds,
            },
          }),
        );
      } catch (error) {
        clearTimeout(timeout);
        this.pendingClaims.delete(claimId);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  /**
   * Drop a previously-active claim. Idempotent — `release` is
   * fire-and-forget per the wire contract; the server accepts
   * unknown claimIds silently so disconnect-time release storms
   * never error. No ack is expected.
   *
   * If a claim's send promise is still pending (no claim_ack yet),
   * we reject it locally — the user explicitly chose to release.
   */
  sendRelease(claimId: string): void {
    // Cancel any in-flight claim that hadn't acked yet — the user
    // changed their mind. Without this the timer would eventually
    // reject; doing it now matches the user's intent immediately.
    const pending = this.pendingClaims.get(claimId);
    if (pending) {
      clearTimeout(pending.timeout);
      this.pendingClaims.delete(claimId);
      pending.reject(new Error(`claim ${claimId} released before ack`));
    }
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    try {
      this.ws.send(
        JSON.stringify({ type: 'release', payload: { claimId } }),
      );
    } catch {
      // Idempotent contract — silent failure is acceptable here.
    }
  }

  /**
   * Replace the capability token used for authentication. The new
   * value is read by the next URL-build (i.e., next connect / reconnect
   * cycle). The currently-open WS is NOT torn down — servers keep
   * connections alive past cap expiry until they decide to close, and
   * a forced reconnect would interrupt in-flight deltas. The cap-mint
   * scheduler in `Ablo.ts` calls this on each successful refresh so
   * reconnects after server-initiated close pick up the fresh token.
   */
  setCapabilityToken(token: string): void {
    this.options.capabilityToken = token;
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
    this.stopHeartbeat();

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
   * Application-level heartbeat. Every `HEARTBEAT_INTERVAL_MS` while
   * `OPEN`, send `{ type: 'ping' }` and arm a `HEARTBEAT_TIMEOUT_MS`
   * watchdog. Any inbound frame (handled in `onmessage`) clears the
   * watchdog. If the watchdog fires, we treat the connection as
   * zombie and force-close it — `onclose` then triggers the existing
   * reconnect path.
   *
   * Why both sides need this:
   *  - The server sends RFC 6455 protocol pings via `ws.ping()` every
   *    30s. Browsers auto-respond with a pong but DO NOT expose either
   *    frame to JavaScript, so the client is blind to its own keepalive.
   *  - On a half-open TCP (laptop wake, NAT timeout, mobile handoff)
   *    the browser may keep `readyState === OPEN` for minutes before
   *    the OS surfaces the broken connection. App-level traffic is
   *    the only signal we can observe.
   */
  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.ws?.readyState !== WebSocket.OPEN) return;

      // Send the ping. If `send` throws, the socket is already dead —
      // force-close so onclose triggers the reconnect cycle.
      try {
        this.ws.send(JSON.stringify({ type: 'ping' }));
      } catch (err) {
        getContext().observability.captureWebSocketError({
          context: 'heartbeat-send-failed',
          error: err instanceof Error ? err.message : String(err),
        });
        this.forceClose('heartbeat-send-failed');
        return;
      }

      // Arm the timeout. ANY inbound message clears it (see onmessage).
      // We don't require an explicit `pong` — a delta or any other frame
      // is equally good proof-of-life.
      if (this.heartbeatTimeoutTimer) clearTimeout(this.heartbeatTimeoutTimer);
      this.heartbeatTimeoutTimer = setTimeout(() => {
        getContext().observability.captureWebSocketError({
          context: 'heartbeat-timeout',
        });
        this.forceClose('heartbeat-timeout');
      }, SyncWebSocket.HEARTBEAT_TIMEOUT_MS);
    }, SyncWebSocket.HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.clearHeartbeatTimeout();
  }

  private clearHeartbeatTimeout(): void {
    if (this.heartbeatTimeoutTimer) {
      clearTimeout(this.heartbeatTimeoutTimer);
      this.heartbeatTimeoutTimer = null;
    }
  }

  /**
   * Force-close the socket from the client side using a private 4xxx
   * code. Callers expect `onclose` to fire; that handler runs the
   * existing reconnect / handshake-failed dispatch. Wrapped in
   * try/catch because `close()` on a CLOSING/CLOSED socket throws on
   * some browsers.
   */
  private forceClose(reason: string): void {
    if (!this.ws) return;
    this.lastForceCloseReason = reason;
    getContext().logger.warn('[SyncWebSocket] forceClose', {
      reason,
      readyState: this.ws.readyState,
      msSinceOpen:
        this.lastOpenAt != null ? Date.now() - this.lastOpenAt : null,
    });
    try {
      this.ws.close(4000, reason);
    } catch {
      // Already closing / closed — onclose will still fire.
    }
  }

  /**
   * Get connection state
   */
  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  /**
   * Snapshot of recent connection lifecycle state, for diagnostic logs
   * and error messages. Cheap to call (no I/O); safe to log every time
   * a send is rejected so we can attribute "not connected" rejections
   * to the actual root cause (handshake reject vs heartbeat zombie vs
   * session expiry vs explicit close).
   */
  getConnectionDiagnostics(): {
    readyState: number | null;
    isConnecting: boolean;
    isManualClose: boolean;
    sessionErrorDetected: boolean;
    everOpened: boolean;
    reconnectAttempts: number;
    maxReconnectAttempts: number;
    lastOpenAt: number | null;
    lastCloseAt: number | null;
    lastCloseCode: number | null;
    lastCloseReason: string | null;
    lastForceCloseReason: string | null;
    sessionErrorAt: number | null;
    msSinceLastOpen: number | null;
    msSinceLastClose: number | null;
  } {
    const now = Date.now();
    return {
      readyState: this.ws?.readyState ?? null,
      isConnecting: this.isConnecting,
      isManualClose: this.isManualClose,
      sessionErrorDetected: this._sessionErrorDetected,
      everOpened: this._everOpened,
      reconnectAttempts: this.reconnectAttempts,
      maxReconnectAttempts: SyncWebSocket.MAX_RECONNECT_ATTEMPTS,
      lastOpenAt: this.lastOpenAt,
      lastCloseAt: this.lastCloseAt,
      lastCloseCode: this.lastCloseCode,
      lastCloseReason: this.lastCloseReason,
      lastForceCloseReason: this.lastForceCloseReason,
      sessionErrorAt: this.sessionErrorAt,
      msSinceLastOpen: this.lastOpenAt != null ? now - this.lastOpenAt : null,
      msSinceLastClose:
        this.lastCloseAt != null ? now - this.lastCloseAt : null,
    };
  }

  /**
   * Build a richly-diagnosed "not connected" error so callers (and the
   * logs they emit) can attribute the rejection. The message embeds the
   * dominant signal in human-readable form; the structured detail is
   * also attached as `error.diagnostics` for log scrapers.
   */
  private notConnectedError(action: string): Error & {
    diagnostics: ReturnType<SyncWebSocket['getConnectionDiagnostics']>;
  } {
    const d = this.getConnectionDiagnostics();
    let detail: string;
    if (d.sessionErrorDetected) {
      detail = 'session_error_suppressed_reconnect';
    } else if (d.isManualClose) {
      detail = 'manual_close';
    } else if (d.isConnecting) {
      detail = 'still_connecting';
    } else if (!d.everOpened && d.lastCloseAt != null) {
      detail = `handshake_failed code=${d.lastCloseCode}`;
    } else if (d.lastForceCloseReason) {
      detail = `force_closed reason=${d.lastForceCloseReason}`;
    } else if (d.lastCloseAt != null) {
      detail =
        `closed code=${d.lastCloseCode}` +
        (d.lastCloseReason ? ` reason=${d.lastCloseReason}` : '') +
        (d.msSinceLastClose != null ? ` ${d.msSinceLastClose}ms ago` : '') +
        (d.reconnectAttempts > 0
          ? ` reconnectAttempts=${d.reconnectAttempts}/${d.maxReconnectAttempts}`
          : '');
    } else {
      detail = 'never_connected';
    }
    const err = new Error(
      `SyncWebSocket not connected — cannot send ${action} (${detail})`,
    ) as Error & {
      diagnostics: ReturnType<SyncWebSocket['getConnectionDiagnostics']>;
    };
    err.diagnostics = d;
    return err;
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
    // Cursor reconciliation — Linear-style handshake. The server stamps
    // its authoritative `currentSyncId` on every sync_response. If our
    // local cursor is AHEAD of the server, our local view has somehow
    // diverged (corrupted metadata, future regression reintroducing an
    // eager-advance, IDB lying about a successful commit). Trust the
    // server, reset the cursor, and request another sync so any deltas
    // we *should* have applied get re-delivered. Backward-compatible
    // when the field is absent (older server build) — we just skip the
    // reconciliation step.
    //
    // We only reconcile when the response carries NO deltas. If deltas
    // are present, they'll advance our cursor through the normal
    // persistence-gated path anyway — and the in-flight request/response
    // round-trip means the snapshot's `currentSyncId` is naturally a
    // few syncIds behind our locally-advanced cursor at receive time
    // (live deltas may have landed in the meantime). Restricting to
    // empty-delta responses eliminates this benign false positive while
    // still catching the real corruption case (server head < local AND
    // server has nothing new to send).
    const hasDeltas = Array.isArray(payload.deltas) && payload.deltas.length > 0;
    if (!hasDeltas && typeof payload.currentSyncId === 'number') {
      const serverHead: number = payload.currentSyncId;
      if (serverHead < this.lastSyncId) {
        getContext().logger.warn(
          '[SyncWebSocket] local cursor ahead of server head — resetting and resyncing',
          {
            local: this.lastSyncId,
            server: serverHead,
            drift: this.lastSyncId - serverHead,
          },
        );
        getContext().observability.breadcrumb(
          'Local sync cursor diverged from server — reset',
          'sync.websocket',
          'warning',
          { local: this.lastSyncId, server: serverHead },
        );
        this.lastSyncId = serverHead;
        // Fire a follow-up incremental sync to re-deliver anything we
        // were missing. Fire-and-forget — the next response will go
        // through this same path. The infinite-loop concern is bounded
        // by the `serverHead < this.lastSyncId` strict-less check: once
        // we've reset to `serverHead`, the next response with the same
        // (or higher) `currentSyncId` won't re-enter this branch.
        void this.requestIncrementalSync();
      }
    }

    if (payload.requiresBootstrap) {
      this.emit('bootstrap_required', payload.bootstrapHint);
      return;
    }

    // Process incremental deltas
    if (payload.deltas && Array.isArray(payload.deltas)) {
      // Process all deltas from sync response - store handles idempotency
      const newDeltas = payload.deltas;

      if (newDeltas.length > 0) {
        // DO NOT pre-advance `this.lastSyncId` here. Same reasoning as
        // `handleDelta`: the runtime cursor must stay consistent with
        // IDB. The delta_batch event routes through
        // `BaseSyncedStore.processDeltaWithBatching` →
        // `flushPendingDeltas`, which calls `acknowledge()` with the
        // honest `persistedSyncId` once IDB commits. That ack is what
        // moves `this.lastSyncId` forward.

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
   * Handle presence update from server. The wire frame's payload is
   * forwarded as-is so every consumer (web entity cache,
   * PresenceStream, agent runtime) reads from the same shape.
   * Stripping fields here was a prior bug — it silently dropped
   * `kind`, `activity`, `syncGroups`, `isAgent` for rich consumers.
   *
   * Wire frame (apps/sync-server/src/hub/types.ts PresenceUpdateMessage):
   *   { type: 'presence_update', payload: { kind, userId, status,
   *     syncGroups, activity, isAgent, timestamp, activeIntents } }
   */
  private handlePresenceUpdate(message: {
    payload?: PresenceUpdateEvent;
    [k: string]: unknown;
  }): void {
    const event: PresenceUpdateEvent =
      // Server canonical path: `{ payload: {...} }`. Some legacy
      // pathways emit fields at the top level (test fixtures) — fall
      // back to reading from the message itself.
      message.payload ?? (message as unknown as PresenceUpdateEvent);
    this.emit('presence_update', event);
  }
}
