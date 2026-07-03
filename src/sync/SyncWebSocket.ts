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
import {
  AbloConnectionError,
  AbloError,
  SyncSessionError,
  toAbloError,
} from '../errors.js';
import type { MutationOperation } from '../interfaces/index.js';
import { clientSyncDeltaSchema, type ClientSyncDelta } from '../schema/sync-delta-wire.js';
import type {
  ClaimError,
  ClaimRejection,
  StaleNotification,
  ReadDependency,
} from '../coordination/schema.js';
// Commit-path frame builders (pure) — extracted leaf; the host re-exports
// `CommitAck` below so importers keep this module as their path.
import { buildCommitFrame, type CommitAck } from './commitFrames.js';
// Inbound frame dispatch table + the minimal session slice it operates on.
import {
  dispatchWsFrame,
  isRecord,
  isWsInboundFrame,
  type WsSession,
  type PendingCommit,
  type PendingClaim,
  type PendingSubscription,
} from './wsFrameHandlers.js';
// Sync-position state (lastSyncId watermark, version vector, server cursor).
import { SyncCursor } from './syncCursor.js';
// Application-level heartbeat timers (see heartbeat.ts for the rationale).
import { HeartbeatController } from './heartbeat.js';

// Moved leaves — re-exported so every importer's path stays unchanged.
export type { CommitAck } from './commitFrames.js';
import {
  WS_BEARER_SUBPROTOCOL_PREFIX,
  WS_SYNC_SUBPROTOCOL,
  type AuthTokenGetter,
} from '../auth/credentialSource.js';
// SyncObservability replaced by getContext().observability

/**
 * Periodic catch-up poll cadence — while connected, request any deltas
 * whose fire-and-forget pub/sub broadcast was lost in transit. Deliberately
 * LOCAL (not `wire/protocol.ts`): an SDK eventual-consistency knob, not a
 * cross-boundary contract the server derives anything from. That it equals
 * the 30s ping today is coincidence, not an invariant.
 */
const CATCHUP_POLL_INTERVAL_MS = 30_000;

/**
 * Ceiling for the exponential reconnect backoff (`reconnectDelay * 2^n`,
 * ±15% jitter). Local for the same reason as the catch-up poll.
 */
const MAX_RECONNECT_DELAY_MS = 30_000;

/**
 * The wire delta the client receives. Derived from the canonical
 * `clientSyncDeltaSchema` (`@abloatai/ablo/schema`) via `z.infer` so the
 * SDK and the sync-server share ONE contract instead of two hand-maintained
 * interfaces. The action vocabulary (`I`/`U`/`D`/`A`/`V`/`C`/`G`/`S`) and the
 * client-only extras (`metadata`, `clientMutationId`, deprecated flat
 * `createdBy`) live in that schema; see its doc for the full field reference.
 */
export type SyncDelta = ClientSyncDelta;

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
   * set, sent in the `ablo.bearer.<token>` WebSocket subprotocol so the
   * credential stays out of URLs and proxy logs. Required for `kind: 'agent'`;
   * ignored for `kind: 'user'`. (Field name predates the Biscuit→opaque-key
   * migration.)
   */
  capabilityToken?: string;
  /**
   * Shared credential getter. When provided, WebSocket URL auth reads this
   * instead of a copied `capabilityToken`, so reconnects use refreshed tokens
   * from the SDK's single auth source.
   */
  /** Shared SDK auth getter. Preferred internal name. */
  getAuthToken?: AuthTokenGetter;
  /** @deprecated Use `getAuthToken`. Kept for direct low-level callers. */
  getCapabilityToken?: AuthTokenGetter;
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
  /**
   * Server-stamped canonical kind (`'user' | 'agent' | 'system'`). Additive:
   * older servers omit it and readers fall back to the lossy `isAgent`
   * boolean (which cannot express `'system'`). Typed `string` because it is
   * raw wire input — normalize via `participantKindFromWire`.
   */
  participantKind?: string;
  timestamp?: number;
  /** Server stamps every presence frame with this participant's open
   *  claims so peers see them without a separate channel. Wire
   *  shape mirrors `apps/sync-server/src/hub/types.ts Claim`. */
  activeClaims?: {
    claimId: string;
    entityType: string;
    entityId: string;
    path?: string;
    range?: {
      startLine: number;
      endLine: number;
      startColumn?: number;
      endColumn?: number;
    };
    reason: string;
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
    error?: ClaimError;
  }[];
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
   * Server rejected an `claim_begin` because another participant
   * already holds an open claim on the same target (cooperative
   * mutex enforced server-side). Surfaces to the participant-level
   * ClaimStream so the caller knows their announce was denied.
   * Payload mirrors the wire frame's `payload`.
   */
  claim_rejected: [ClaimRejection];
  /**
   * Fair-queue frames (opt-in `queue: true` on `claim_begin`). `claim_acquired`
   * means the target was free and the lease is ours immediately; `claim_queued`
   * means the claim is waiting in line (carries `position`); `claim_granted`
   * means it reached the head and the lease is now ours; `claim_lost` means a
   * held/granted claim was taken away (TTL lapse on disconnect, revoke).
   */
  /**
   * Per-entity wait-queue snapshot: `{ target, queue: Claim[] }` with each
   * entry `status: 'queued'` + `position`. Broadcast to entity peers on every
   * queue mutation — powers the reactive `ablo.<model>.claim.queue({ id })` read.
   */
  claim_queue: [Record<string, unknown>];
  claim_acquired: [Record<string, unknown>];
  claim_queued: [Record<string, unknown>];
  claim_granted: [Record<string, unknown>];
  claim_lost: [Record<string, unknown>];
  /**
   * Notify-instead-of-abort (non-coercion). A committed write guarded with
   * `onStale: 'notify' collided with a concurrent change; rather than
   * forcing an outcome, the engine returned the conflicting field's current
   * value so the actor can solve it. The resolver is the intelligent actor —
   * an agent reasoning over the change, or a human watching the row. The commit
   * SUCCEEDED; held ops ('notify') weren't written and the actor re-issues once
   * it has reconciled. (The claim is the prospective form of the same
   * non-coercion; this is the in-flight form.)
   */
  'conflict:notified': [{ clientTxId: string; notifications: StaleNotification[] }];
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
    Omit<
      SyncWebSocketOptions,
      'baseUrl' | 'kind' | 'capabilityToken' | 'getAuthToken' | 'getCapabilityToken'
    >
  > & {
    baseUrl?: string;
    // `kind`, `capabilityToken`, `getAuthToken`, and `getCapabilityToken` are genuinely
    // optional: web sessions don't pass either token field, agents pass one.
    // Excluded from the Required<>
    // wrap so consumers don't have to supply placeholders.
    kind?: SyncWebSocketOptions['kind'];
    capabilityToken?: SyncWebSocketOptions['capabilityToken'];
    getAuthToken?: SyncWebSocketOptions['getAuthToken'];
    getCapabilityToken?: SyncWebSocketOptions['getCapabilityToken'];
  };
  private reconnectAttempts = 0;
  /** Stop retrying after this many consecutive failures (backoff caps at 30s, so ~7.5 min total) */
  private static readonly MAX_RECONNECT_ATTEMPTS = 15;
  private reconnectTimer: NodeJS.Timeout | null = null;
  /** Periodic catchup interval — polls for missed deltas every 30s while connected */
  private catchupInterval: NodeJS.Timeout | null = null;
  /**
   * Application-level heartbeat — ping every 30s, force-close on a 10s
   * silent watchdog. The full zombie-socket rationale lives with the
   * timers in `sync/heartbeat.ts`; the transport closures below are the
   * only socket access the controller gets.
   */
  private readonly heartbeat = new HeartbeatController({
    isSocketOpen: () => this.ws?.readyState === WebSocket.OPEN,
    // Optional-chained rather than asserted: the controller only calls
    // this synchronously after `isSocketOpen()`, so `ws` is present.
    sendPing: () => {
      this.ws?.send(JSON.stringify({ type: 'ping' }));
    },
    forceClose: (reason) => { this.forceClose(reason); },
  });
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
  /**
   * Sync-position state (lastSyncId watermark, version vector, server
   * cursor). The advance discipline stays documented at `sendAck` /
   * `handleDelta`; the state itself lives in `sync/syncCursor.ts`.
   */
  private readonly cursor: SyncCursor;
  /** Registered collaboration event keys (colon format) for dispatch in onmessage */
  private collaborationEventTypes: Set<string>;
  /**
   * Minimal session adapter handed to the frame dispatch table
   * (`sync/wsFrameHandlers.ts`). Exposes ONLY the members the handlers
   * touch; the closure members read live state so host-side reassignment
   * (e.g. the `pendingSubscriptions` reset on close) can't strand the
   * handlers on a stale reference. Built in the constructor, after the
   * state it captures exists.
   */
  private readonly frameSession: WsSession;

  /**
   * In-flight `commit` mutation requests keyed by clientTxId. Resolved when
   * a matching `mutation_result` frame arrives from the server, or rejected on
   * timeout / disconnect. Lets consumers await a server ack for mutations
   * sent over the same socket that streams deltas.
   */
  private pendingMutations = new Map<string, PendingCommit>();

  /**
   * In-flight `claim` requests keyed by claimId. Resolved when the
   * matching `claim_ack` arrives, or rejected on timeout/disconnect.
   * Same shape as pendingMutations — Phoenix-style request/response
   * over a multiplexed connection.
   */
  private pendingClaims = new Map<string, PendingClaim>();

  /**
   * In-flight `update_subscription` frames awaiting `subscription_ack`.
   * A FIFO queue rather than a keyed Map because the wire ack carries no
   * correlation id — the server applies subscription updates in receive
   * order and acks in the same order, so `shift()` on ack matches the
   * oldest pending request. (Read-interest changes are infrequent and
   * usually settle before the next one, so depth is ~1 in practice.)
   */
  private pendingSubscriptions: PendingSubscription[] = [];

  constructor(options: SyncWebSocketOptions) {
    super();

    // Construct WebSocket URL from base Go server URL
    const baseUrl = options.baseUrl || options.url || "http://localhost:8080";
    const wsProtocol = baseUrl.startsWith('https') ? 'wss' : 'ws';
    const wsUrl = baseUrl.replace(/^https?/, wsProtocol) + '/api/sync/ws';

    this.options = {
      url: wsUrl,
      reconnectDelay: 1000,
      maxReconnectDelay: MAX_RECONNECT_DELAY_MS,
      collaborationEvents: ['sheet:selection', 'slide:selection', 'slide:cursor'],
      syncGroups: [],
      lastSyncId: 0,
      capabilities: {
        partialBootstrap: true,
        compressedDeltas: true,
        streamingBootstrap: true,
        batchedDeltas: true,
      },
      ...options,
    };

    this.cursor = new SyncCursor(this.options.lastSyncId);
    this.collaborationEventTypes = new Set(
      options.collaborationEvents ?? ['sheet:selection', 'slide:selection', 'slide:cursor']
    );

    // Session slice for the inbound frame dispatch table — see the field
    // doc on `frameSession` for why members that the host reassigns are
    // exposed through closures instead of captured references.
    this.frameSession = {
      emit: (event, ...args) => this.emit(event, ...args),
      pendingMutations: this.pendingMutations,
      pendingClaims: this.pendingClaims,
      shiftPendingSubscription: () => this.pendingSubscriptions.shift(),
      options: this.options,
      collaborationEventTypes: this.collaborationEventTypes,
      handleDelta: (delta) => { this.handleDelta(delta); },
      handleSyncResponse: (payload) => { this.handleSyncResponse(payload); },
      handleBootstrapResponse: (payload) => { this.handleBootstrapResponse(payload); },
      handlePresenceUpdate: (message) =>
        { this.handlePresenceUpdate(
          message as { payload?: PresenceUpdateEvent; [k: string]: unknown },
        ); },
    };
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
   * Clear the session-error latch so `connect()` / `scheduleReconnect()`
   * work again. Called by the store's access-credential recovery path when
   * the close was a re-mintable `ek_`/`rk_` expiry (`4001 credential_expired`),
   * not a login loss — see `isAccessCredentialExpiryCloseReason`. Genuine
   * session losses never clear the latch; re-auth builds a fresh client.
   */
  clearSessionError(): void {
    this._sessionErrorDetected = false;
    this.sessionErrorAt = null;
  }

  /**
   * Connect to the sync engine WebSocket
   */
  connect(): void {
    if (this._sessionErrorDetected) {
      getContext().logger.debug('WebSocket connect suppressed — session error detected');
      return;
    }

    // CLOSING counts as busy: the socket's close teardown is still in
    // flight and its `onclose` (which runs `scheduleReconnect`) hasn't
    // fired yet. Overwriting `this.ws` mid-teardown is what produced the
    // orphaned-socket race — see the stale-socket guards in
    // `setupEventHandlers`.
    if (
      this.ws?.readyState === WebSocket.OPEN ||
      this.ws?.readyState === WebSocket.CLOSING ||
      this.isConnecting
    ) {
      getContext().logger.debug('WebSocket already connected, connecting, or closing');
      return;
    }

    // Note: onlineStatus is advisory — we'll try to connect and let the WebSocket
    // handle failures. The default browser implementation reads navigator.onLine,
    // which is unreliable but the only signal available; in Node it returns true
    // (assume online) so the sidecar/agent path doesn't short-circuit here.
    if (!getContext().onlineStatus.isOnline()) {
      getContext().logger.debug('onlineStatus reports offline, but attempting connection anyway');
    }

    this.isConnecting = true;
    this.isManualClose = false;

    // Pattern: one credential, server-resolved identity. The bearer travels
    // in a `Sec-WebSocket-Protocol` value (built below), NOT the URL. The
    // server is bearer-only (`apiKeyProvider`) and resolves identity from the
    // verified token — userId/organizationId are NEVER read from URL params.
    const params = new URLSearchParams({
      // Intentionally omit lastSyncId, capabilities from URL; these are sent in sync_request
      // and ack messages to avoid stale baselines on reconnect.
      cursor: this.cursor.syncCursor || '',
    });

    // Participant kind — defaults to `user` for backward compatibility
    // with web sessions. Agent runtimes pass `'agent'` so the server's
    // capability-token path activates instead of session auth.
    if (this.options.kind && this.options.kind !== 'user') {
      params.set('kind', this.options.kind);
    }

    // Add sync groups if provided
    this.options.syncGroups.forEach((group) => {
      params.append('syncGroups', group);
    });

    const wsUrl = `${this.options.url}?${params.toString()}`;

    // Carry the bearer in a `Sec-WebSocket-Protocol` value, NOT the URL. A
    // browser can't set an Authorization header on a WS, but it CAN offer
    // subprotocols — and unlike the query string, those don't land in ALB
    // access logs, proxies, or browser history. The server reads
    // `ablo.bearer.<token>` and selects the real `ablo.sync.v1` protocol,
    // never echoing the token-bearing value back. (Token is the raw ek_/rk_,
    // which is subprotocol-token-safe — alphanumerics + `_`.)
    const authToken = this.resolveAuthToken();
    const protocols = authToken
      ? [`${WS_BEARER_SUBPROTOCOL_PREFIX}${authToken}`, WS_SYNC_SUBPROTOCOL]
      : [WS_SYNC_SUBPROTOCOL];

    try {
      // Reset the handshake flag before wiring the new socket. Each connect()
      // gets its own lifecycle — a prior successful open on a previous socket
      // must not mask a handshake failure on the new one.
      this._everOpened = false;
      this.ws = new WebSocket(wsUrl, protocols);
      this.setupEventHandlers();
    } catch (error) {
      // WebSocket constructor can throw if URL is invalid
      const errorMessage = error instanceof Error ? error.message : 'Failed to create WebSocket';
      getContext().observability.captureWebSocketError({ context: 'create-websocket', error: errorMessage });
      this.isConnecting = false;
      this.emit('error', new AbloConnectionError(errorMessage, { cause: error }));
      this.scheduleReconnect();
    }
  }

  /**
   * Setup WebSocket event handlers
   */
  private setupEventHandlers(): void {
    // Capture the socket THIS call wires. Every handler below guards on
    // `this.ws === socket` (onclose additionally tolerates a nulled host —
    // see there) so a handler firing late, after `connect()` replaced the
    // socket, can never clobber the NEW connection's shared state. Without
    // this, an old socket's `onclose` ran `this.ws = null;
    // stopCatchupInterval(); stopHeartbeat()` unconditionally — a reconnect
    // during close teardown orphaned the fresh socket (zombie receiving
    // deltas with no timers and broken send paths).
    const socket = this.ws;
    if (!socket) return;

    socket.onopen = () => {
      if (this.ws !== socket) return; // stale socket — a newer connect() owns the state
      getContext().observability.breadcrumb('WebSocket connected', 'sync.websocket', 'info', {
        lastSyncId: this.cursor.lastSyncId,
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

      // Immediately request incremental sync based on our stored cursor.
      // `requestIncrementalSync` is async — a bare call inside try/catch is a
      // rejection hole (the catch never sees it); route failures through
      // `.catch` so they land in the same breadcrumb instead of an
      // unhandled rejection.
      const reportSyncRequestFailure = (e: unknown): void => {
        getContext().observability.breadcrumb(
          'Failed to request incremental sync on open',
          'sync.websocket',
          'warning',
          {
            error: e instanceof Error ? e.message : String(e),
          }
        );
      };
      try {
        if (this.cursor.lastSyncId && this.cursor.lastSyncId > 0) {
          // Let server know where we left off before requesting deltas
          this.sendAck(this.cursor.lastSyncId);
        }
      } catch (e) {
        reportSyncRequestFailure(e);
      }
      this.requestIncrementalSync().catch(reportSyncRequestFailure);

      // Start periodic catchup — polls for missed deltas every
      // CATCHUP_POLL_INTERVAL_MS while connected. Real-time WebSocket
      // delivery is best-effort (fire-and-forget Redis pub/sub). This
      // interval guarantees eventual consistency by fetching any deltas
      // that were committed to the DB but whose broadcast was lost in
      // transit.
      this.stopCatchupInterval();
      this.catchupInterval = setInterval(() => {
        if (this.ws?.readyState === WebSocket.OPEN) {
          // A rejected sync request must never surface as an unhandled
          // rejection from a background interval — log and let the next
          // poll retry.
          this.requestIncrementalSync().catch((e: unknown) => {
            getContext().observability.breadcrumb(
              'Periodic catchup sync request failed',
              'sync.websocket',
              'warning',
              {
                error: e instanceof Error ? e.message : String(e),
              }
            );
          });
        }
      }, CATCHUP_POLL_INTERVAL_MS);

      // Start application-level heartbeat — see sync/heartbeat.ts for rationale.
      this.heartbeat.start();
    };

    socket.onmessage = (event) => {
      if (this.ws !== socket) return; // stale socket — drop, don't feed shared state
      try {
        // Untrusted wire input: parse to `unknown`, then narrow through
        // the frame-envelope guard before dispatch. Payload-level
        // validation (deltas etc.) happens per-frame downstream.
        const message: unknown = JSON.parse(event.data);

        // ANY inbound frame proves the socket is alive — clear the
        // heartbeat-timeout timer so we don't false-trip force-close
        // during normal traffic.
        this.heartbeat.clearHeartbeatTimeout();

        if (!isWsInboundFrame(message)) {
          getContext().logger.debug('[SyncWebSocket] dropped malformed wire frame', {
            received: Array.isArray(message) ? 'array' : typeof message,
          });
          return;
        }

        // Frame-type → handler dispatch (sync/wsFrameHandlers.ts). The
        // session adapter exposes only the members the handlers touch;
        // keepalives, the legacy bare-delta form, and collaboration
        // events are all routed there too.
        dispatchWsFrame(this.frameSession, message);
      } catch (error) {
        getContext().observability.captureWebSocketError({
          context: 'parse-message',
          error: error instanceof Error ? error.message : String(error),
        });
      }
    };

    socket.onerror = (_event) => {
      if (this.ws !== socket) return; // stale socket — its errors are no longer ours
      // WebSocket errors are DOM Events, not Error objects
      // Check if we're offline first
      if (!getContext().onlineStatus.isOnline()) {
        getContext().observability.breadcrumb(
          'WebSocket error: Network is offline',
          'sync.websocket',
          'warning'
        );
        this.emit('error', new AbloConnectionError('Network is offline', { code: 'bootstrap_offline' }));
        return;
      }

      // After session error, suppress Sentry capture — the root cause is already reported.
      // Still emit so SyncedStore can update UI state.
      const error = new AbloConnectionError(`WebSocket connection failed`);
      if (!this._sessionErrorDetected) {
        getContext().observability.captureWebSocketError({
          context: 'connection-error',
          error: error.message,
        });
      }
      this.emit('error', error);
    };

    socket.onclose = (event) => {
      // Stale-socket close: a NEWER socket already owns the connection
      // state — don't null it, stop its timers, or schedule a duplicate
      // reconnect (the orphaning race this guard exists for). The one
      // deliberate asymmetry vs the other handlers: `this.ws === null`
      // (manual `disconnect()` nulls the field before the close event
      // lands) still runs the full body, so in-flight work is rejected
      // promptly and 'disconnected' reaches consumers — the pre-guard
      // behavior manual close always had.
      if (this.ws !== null && this.ws !== socket) return;
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
      this.heartbeat.stop();

      // Cancel in-flight mutations — the socket that was carrying them is
      // gone, and the server-side state may or may not have accepted each
      // one. Rejecting promptly is better than hanging the caller forever;
      // higher-level retry belongs to TransactionQueue, not here.
      if (this.pendingMutations.size > 0) {
        for (const pending of this.pendingMutations.values()) {
          clearTimeout(pending.timeout);
          // AbloConnectionError → `isPermanentError` treats it as transient,
          // so TransactionQueue retries the commit on reconnect rather than
          // rolling it back. `diagnostics` is preserved as a property (the
          // queue's failure log walks the cause chain for it).
          pending.reject(
            Object.assign(
              new AbloConnectionError(
                `WebSocket closed while commit was in flight (code=${event.code}` +
                  (event.reason ? ` reason=${event.reason}` : '') +
                  (this.lastForceCloseReason
                    ? ` forceCloseReason=${this.lastForceCloseReason}`
                    : '') +
                  ')',
                { code: 'commit_no_result' },
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
            new AbloConnectionError(
              `WebSocket closed while claim was in flight (code=${event.code})`,
            ),
          );
        }
        this.pendingClaims.clear();
      }

      // Cancel in-flight subscription updates — the reconnect handshake
      // re-sends `options.syncGroups` (the last acked interest) in the
      // upgrade URL, so a pending change that never acked is simply
      // retried by the caller against the fresh connection.
      if (this.pendingSubscriptions.length > 0) {
        for (const pending of this.pendingSubscriptions) {
          clearTimeout(pending.timeout);
          pending.reject(
            new AbloConnectionError(
              `WebSocket closed while update_subscription was in flight (code=${event.code})`,
            ),
          );
        }
        this.pendingSubscriptions = [];
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
        // Don't reconnect from HERE. For a genuine session loss the user
        // must re-authenticate; for an expired ACCESS credential
        // (`credential_expired`) the store's session_error handler re-mints,
        // clears the latch, and drives the reconnect — see
        // BaseSyncedStore.setupWebSocketSync.
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
   * Validate + normalize a wire delta at the receive boundary — the ONE
   * seam every inbound delta (`delta` frame, batch element, `sync_response`
   * replay, legacy bare frame) passes through before it is emitted,
   * persisted to IDB, or allowed to advance any watermark.
   *
   * Normalization (older/deployed servers stay compatible):
   *  - `id`: the contract says `number`, but deployed servers have sent the
   *    raw Postgres BIGINT serialization — a STRING — and every downstream
   *    watermark gate (`typeof syncId === 'number'` in
   *    `Database.processDeltaBatch`, the metadata-cursor update, numeric
   *    `>=` thresholds in TransactionQueue) silently breaks on strings:
   *    acks are withheld, the resume cursor never advances, and every
   *    reconnect replays from 0. Coerce ONCE here.
   *  - `transactionId` / `createdBy`: the SERVER projection sends these as
   *    nullable (and `createdBy` as a nested ParticipantRef); the client
   *    contract types them as optional strings and never reads them.
   *    Normalize to absent instead of rejecting every real server delta.
   *
   * Validation: `clientSyncDeltaSchema.safeParse` — the canonical Zod wire
   * contract. A frame that fails is DROPPED (returns `null`) with a
   * debug-level log + observability breadcrumb; it is never applied. One
   * parse per delta — callers must not re-parse.
   */
  private normalizeWireDelta(raw: unknown): SyncDelta | null {
    let candidate: unknown = raw;
    if (isRecord(raw)) {
      const normalized: Record<string, unknown> = { ...raw };
      if (typeof normalized.id !== 'number') {
        const coerced = Number(normalized.id);
        normalized.id = Number.isFinite(coerced) ? coerced : 0;
      }
      if (normalized.transactionId === null) delete normalized.transactionId;
      if (normalized.createdBy !== undefined && typeof normalized.createdBy !== 'string') {
        delete normalized.createdBy;
      }
      candidate = normalized;
    }
    const parsed = clientSyncDeltaSchema.safeParse(candidate);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const detail = {
        issue: issue ? `${issue.path.join('.')}: ${issue.message}` : 'not an object',
        modelName:
          isRecord(raw) && typeof raw.modelName === 'string' ? raw.modelName : undefined,
        actionType:
          isRecord(raw) && typeof raw.actionType === 'string' ? raw.actionType : undefined,
      };
      getContext().logger.debug('[SyncWebSocket] dropped malformed wire delta', detail);
      getContext().observability.breadcrumb(
        'Dropped malformed wire delta',
        'sync.websocket',
        'warning',
        detail,
      );
      return null;
    }
    return parsed.data;
  }

  /**
   * Handle incoming sync delta (untrusted wire input — validated and
   * normalized by {@link normalizeWireDelta}; malformed deltas are dropped).
   */
  private handleDelta(rawDelta: unknown): void {
    const delta = this.normalizeWireDelta(rawDelta);
    if (!delta) return;
    getContext().logger.debug('Received delta', {
      action: delta.actionType,
      model: delta.modelName,
      id: delta.modelId,
      syncId: delta.id,
    });

    // DO NOT advance `this.cursor.lastSyncId` on receipt. The runtime cursor
    // must stay consistent with what's persisted in IDB — otherwise the
    // next `requestIncrementalSync()` (and the connect-time handshake)
    // sends an optimistic cursor and the server skips deltas that never
    // landed in IDB. `this.cursor.lastSyncId` is advanced only in `sendAck()`,
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
   * This is the SOLE forward-mover of `this.cursor.lastSyncId` for live
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
    this.cursor.ackAdvance(syncId);

    if (this.ws?.readyState !== WebSocket.OPEN) return;

    this.send({
      type: 'ack',
      payload: {
        lastSyncId: syncId,      },
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
    operations: readonly MutationOperation[],
    clientTxId: string,
    timeoutMs = 15_000,
    causedByTaskId?: string | null,
    reads?: readonly ReadDependency[] | null,
  ): Promise<CommitAck> {
    if (this.ws?.readyState !== WebSocket.OPEN) {
      return Promise.reject(this.notConnectedError('commit'));
    }

    return new Promise<CommitAck>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingMutations.delete(clientTxId);
        reject(
          new AbloConnectionError(
            `commit timed out after ${timeoutMs}ms (clientTxId=${clientTxId})`,
            { code: 'commit_no_result' },
          ),
        );
      }, timeoutMs);
      this.pendingMutations.set(clientTxId, { resolve, reject, timeout });
      try {
        // `causedByTaskId` is included only when the agent SDK has
        // an open turn — keeps the wire shape stable for sessions
        // that don't use turns. Servers that don't know the field
        // ignore it; newer servers stamp it onto every delta.
        const frame = buildCommitFrame(operations, clientTxId, causedByTaskId, reads);
        this.ws!.send(JSON.stringify(frame));
      } catch (error) {
        clearTimeout(timeout);
        this.pendingMutations.delete(clientTxId);
        reject(toAbloError(error));
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
    operations: readonly MutationOperation[],
    clientTxId: string,
    causedByTaskId?: string | null,
    reads?: readonly ReadDependency[] | null,
  ): void {
    if (this.ws?.readyState !== WebSocket.OPEN) {
      throw this.notConnectedError('commit');
    }
    const frame = buildCommitFrame(operations, clientTxId, causedByTaskId, reads);
    this.ws.send(JSON.stringify(frame));
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
    syncGroups: readonly string[],
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
          new AbloConnectionError(`claim timed out after ${timeoutMs}ms (claimId=${claimId})`, {
            code: 'wait_for_timeout',
          }),
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
        reject(toAbloError(error));
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
    // reject; doing it now matches the user's claim immediately.
    const pending = this.pendingClaims.get(claimId);
    if (pending) {
      clearTimeout(pending.timeout);
      this.pendingClaims.delete(claimId);
      pending.reject(
        new AbloError(`claim ${claimId} released before ack`, {
          code: 'claim_wait_aborted',
          httpStatus: 409,
        }),
      );
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
   * Move this connection's READ interest — replace the connection-level
   * sync groups mid-session as the user opens/closes entities. This is the
   * area-of-interest (AOI) navigation primitive: the server fans out
   * deltas only for groups currently in view, instead of the frozen set
   * chosen at connect.
   *
   * Full-set replace semantics — pass the complete new group list, not a
   * delta. Resolves with the server's effective set once `subscription_ack`
   * arrives; rejects (typed) on a scope denial (a restricted `rk_` key
   * requesting a group outside its allowlist), timeout, or disconnect. On
   * success the new set is recorded as `options.syncGroups` so a later
   * reconnect re-subscribes to current interest, not the connect-time set.
   *
   * Distinct from {@link sendClaim} (write-claim, per-op, TTL'd) — this is
   * the read side and carries no capability token of its own; it's bounded
   * by the connection credential's grant.
   */
  updateSubscription(
    syncGroups: readonly string[],
    options?: { timeoutMs?: number },
  ): Promise<{ syncGroups: string[] }> {
    if (this.ws?.readyState !== WebSocket.OPEN) {
      return Promise.reject(this.notConnectedError('update_subscription'));
    }
    const timeoutMs = options?.timeoutMs ?? 15_000;
    return new Promise<{ syncGroups: string[] }>((resolve, reject) => {
      const entry: PendingSubscription = {
        resolve,
        reject,
        timeout: setTimeout(() => {
          const idx = this.pendingSubscriptions.indexOf(entry);
          if (idx !== -1) this.pendingSubscriptions.splice(idx, 1);
          reject(
            new AbloConnectionError(
              `update_subscription timed out after ${timeoutMs}ms`,
              { code: 'wait_for_timeout' },
            ),
          );
        }, timeoutMs),
      };
      this.pendingSubscriptions.push(entry);
      try {
        this.ws!.send(
          JSON.stringify({
            type: 'update_subscription',
            payload: { syncGroups: [...syncGroups] },
          }),
        );
      } catch (error) {
        clearTimeout(entry.timeout);
        const idx = this.pendingSubscriptions.indexOf(entry);
        if (idx !== -1) this.pendingSubscriptions.splice(idx, 1);
        reject(toAbloError(error));
      }
    });
  }

  /**
   * Compatibility setter for direct SyncWebSocket users. The SDK-owned
   * `Ablo()` path passes `getAuthToken`, so reconnect URL auth reads the
   * shared credential source instead of this copied value.
   */
  setCapabilityToken(token: string): void {
    this.options.capabilityToken = token;
  }

  getAuthToken(): string | undefined {
    return this.resolveAuthToken();
  }

  /**
   * Return the credential that will be used by the next WebSocket upgrade.
   * ConnectionManager reads this for HTTP auth probes so visibility/network
   * checks authenticate the same way reconnects do.
   */
  getCapabilityToken(): string | undefined {
    return this.resolveAuthToken();
  }

  private resolveAuthToken = (): string | undefined => {
    return this.options.getAuthToken?.()
      ?? this.options.getCapabilityToken?.()
      ?? this.options.capabilityToken;
  };

  /**
   * Send spreadsheet selection presence
   */
  sendSheetSelection(sheetId: string, selectedCells: { ref: string }[]): void {
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
    selectedLayers: { layerId: string }[]
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
    this.heartbeat.stop();

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
   * Force-close the socket from the client side using a private 4xxx
   * code. Callers expect `onclose` to fire; that handler runs the
   * existing reconnect / handshake-failed dispatch. Wrapped in
   * try/catch because `close()` on a CLOSING/CLOSED socket throws on
   * some browsers.
   */
  private forceClose(reason: string): void {
    if (!this.ws) return;
    this.lastForceCloseReason = reason;
    getContext().logger.debug('[SyncWebSocket] forceClose', {
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

    // Session-latched is NOT a transient transport hiccup: reconnection is
    // suppressed until re-auth (or the store's credential re-mint clears the
    // latch), so retrying can never succeed. Reject with the PERMANENT
    // session type — `isPermanentError` surfaces it to the caller as
    // "re-authenticate" instead of parking the write for a reconnect that
    // will never happen (the old `ws_not_ready` retry-forever hazard).
    if (d.sessionErrorDetected) {
      return Object.assign(
        new SyncSessionError(
          `SyncWebSocket not connected — cannot send ${action}: session expired` +
            (d.lastCloseReason ? ` (${d.lastCloseReason})` : '') +
            '; re-authenticate',
        ),
        { diagnostics: d },
      );
    }

    let detail: string;
    if (d.isManualClose) {
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
    // Typed so it lands in the AbloError hierarchy AND `isPermanentError`
    // sees a transient transport failure (retry on reconnect, don't roll
    // back). `diagnostics` stays a property — the queue's failure log walks
    // the cause chain for it.
    const err = Object.assign(
      new AbloConnectionError(
        `SyncWebSocket not connected — cannot send ${action} (${detail})`,
        { code: 'ws_not_ready' },
      ),
      { diagnostics: d },
    );
    return err;
  }

  /** Returns the sync groups this connection is subscribed to. */
  getSyncGroups(): string[] {
    return this.options.syncGroups;
  }

  // Cursor accessors — thin delegates; the state + semantics live in
  // sync/syncCursor.ts (SyncCursor).

  /**
   * Update last sync ID (for persistence)
   */
  setLastSyncId(syncId: number): void {
    this.cursor.setLastSyncId(syncId);
  }

  /**
   * Update sync cursor (for incremental sync)
   */
  setSyncCursor(cursor: string | null): void {
    this.cursor.setSyncCursor(cursor);
  }

  /**
   * Get current sync cursor
   */
  getSyncCursor(): string | null {
    return this.cursor.getSyncCursor();
  }

  /**
   * Get the highest syncId seen this session (for persistence on clean shutdown)
   */
  getLastSyncId(): number {
    return this.cursor.getLastSyncId();
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
        cursor: this.cursor.syncCursor,        // Always send lastSyncId to ensure server uses client's current position
        lastSyncId: this.cursor.lastSyncId,
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
        entities: entities || [],        capabilities: this.options.capabilities,
      },
    });
  }

  /**
   * Handle sync response from server. Untrusted wire input — the envelope
   * fields are narrowed defensively and every delta is validated through
   * {@link normalizeWireDelta} (exactly once each; malformed ones drop out
   * of the batch).
   */
  private handleSyncResponse(rawPayload: unknown): void {
    const payload: Record<string, unknown> = isRecord(rawPayload) ? rawPayload : {};
    const rawDeltas: unknown[] | null = Array.isArray(payload.deltas)
      ? payload.deltas
      : null;
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
    const hasDeltas = rawDeltas !== null && rawDeltas.length > 0;
    if (!hasDeltas && typeof payload.currentSyncId === 'number') {
      const serverHead: number = payload.currentSyncId;
      if (serverHead < this.cursor.lastSyncId) {
        getContext().logger.debug(
          '[SyncWebSocket] local cursor ahead of server head — resetting and resyncing',
          {
            local: this.cursor.lastSyncId,
            server: serverHead,
            drift: this.cursor.lastSyncId - serverHead,
          },
        );
        getContext().observability.breadcrumb(
          'Local sync cursor diverged from server — reset',
          'sync.websocket',
          'warning',
          { local: this.cursor.lastSyncId, server: serverHead },
        );
        this.cursor.lastSyncId = serverHead;
        // Fire a follow-up incremental sync to re-deliver anything we
        // were missing. Fire-and-forget — the next response will go
        // through this same path. The infinite-loop concern is bounded
        // by the `serverHead < this.cursor.lastSyncId` strict-less check: once
        // we've reset to `serverHead`, the next response with the same
        // (or higher) `currentSyncId` won't re-enter this branch. A `.catch`
        // (not `void`) so a failed send logs instead of surfacing as an
        // unhandled rejection.
        this.requestIncrementalSync().catch((e: unknown) => {
          getContext().observability.breadcrumb(
            'Post-cursor-reset sync request failed',
            'sync.websocket',
            'warning',
            {
              error: e instanceof Error ? e.message : String(e),
            }
          );
        });
      }
    }

    if (payload.requiresBootstrap) {
      this.emit('bootstrap_required', payload.bootstrapHint);
      return;
    }

    // Process incremental deltas
    if (rawDeltas) {
      // Process all deltas from sync response - store handles idempotency.
      // Same receive-boundary validation + normalization as handleDelta —
      // catch-up replays from older servers carry string ids too, and
      // malformed deltas drop out of the batch instead of being applied.
      const newDeltas: SyncDelta[] = [];
      for (const d of rawDeltas) {
        const delta = this.normalizeWireDelta(d);
        if (delta) newDeltas.push(delta);
      }

      if (newDeltas.length > 0) {
        // DO NOT pre-advance `this.cursor.lastSyncId` here. Same reasoning as
        // `handleDelta`: the runtime cursor must stay consistent with
        // IDB. The delta_batch event routes through
        // `BaseSyncedStore.processDeltaWithBatching` →
        // `flushPendingDeltas`, which calls `acknowledge()` with the
        // honest `persistedSyncId` once IDB commits. That ack is what
        // moves `this.cursor.lastSyncId` forward.

        // Emit ALL deltas as a single batch event
        this.emit('delta_batch', newDeltas);
      }
    }

    // Update cursor. (`newVersions` from pre-cutover servers is ignored —
    // the version vector was removed in W4a; `sync_id` is the causality token.)
    if (typeof payload.newCursor === 'string' && payload.newCursor) {
      this.cursor.syncCursor = payload.newCursor;
    } else if (typeof payload.cursor === 'string' && payload.cursor) {
      this.cursor.syncCursor = payload.cursor;
    }
  }

  /**
   * Handle bootstrap response from server
   */
  private handleBootstrapResponse(payload: any): void {
    // Emit bootstrap data for processing. (A `version` field from
    // pre-cutover servers is ignored — version vector removed in W4a.)
    this.emit('bootstrap_data', {
      entityType: payload.entityType,
      data: payload.data,
      isComplete: payload.isComplete,
      cursor: payload.cursor,
    });
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
   *     syncGroups, activity, isAgent, timestamp, activeClaims } }
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
