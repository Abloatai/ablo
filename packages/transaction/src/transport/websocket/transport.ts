/**
 * The duplex transport: a WebSocket connection to the sync server, extracted
 * out of the reactive engine's `SyncWebSocket` (ADR 0016). It owns the socket
 * lifecycle (connect, reconnect with exponential backoff, disconnect, the
 * application-level heartbeat), sends commits, claims, releases, and
 * subscription updates over the one connection, correlates their
 * acknowledgement frames back to awaiting callers, and dispatches every other
 * inbound frame through {@link dispatchWsFrame}.
 *
 * What it deliberately does not do is materialise: deltas, sync responses,
 * and bootstrap payloads are surfaced through protected frame hooks
 * ({@link handleDelta} and its siblings) whose defaults just emit, so a
 * server-side caller gets the push feed — claim grants, losses, deltas —
 * with no store, no cursor, and no renderer. The reactive engine subclasses
 * this and overrides the hooks with validation, cursor advancement, and
 * bootstrap handling. The membership test (ADR 0016): a caller with no socket
 * loses only push — it polls instead; a caller with no reactive layer loses
 * the local copy it never wanted.
 */

import { EventEmitter } from 'events';
import type { ParticipantKind } from '../../types/participant.js';
import {
  AbloConnectionError,
  AbloError,
  AbloSessionError,
  AbloValidationError,
  toAbloError,
} from '../../errors.js';
import {
  participantClaimPayloadSchema,
  updateSubscriptionPayloadSchema,
} from '../../coordination/schema.js';
import type { BootstrapReason } from '../../wire/bootstrapReason.js';
import type { ClientSyncDelta } from '../../observation/contract.js';
import type {
  ClaimAcquired,
  PresenceUpdate,
  ClaimExpired,
  ClaimGranted,
  ClaimHeartbeatAckPayload,
  ClaimLost,
  ClaimQueue,
  ClaimQueued,
  ClaimRejection,
  ParticipantClaimPayload,
  ReadDependency,
  WireClaim,
} from '../../coordination/schema.js';
import { PROTOCOL_VERSION, WS_CLOSE_PROTOCOL_VERSION } from '../../wire/protocolVersion.js';
import {
  WS_BEARER_SUBPROTOCOL_PREFIX,
  WS_SYNC_SUBPROTOCOL,
  type AuthTokenGetter,
} from '../../auth/credentialSource.js';
import { buildCommitFrame, type CommitAck, type CommitFrameOperation } from './commitFrames.js';
import type { CommitReceiptWire } from '../../commit/contract.js';
import {
  dispatchWsFrame,
  readWsInboundFrame,
  type WsSession,
  type PendingCommit,
  type PendingClaim,
  type PendingSubscription,
} from './frameHandlers.js';
import { HeartbeatController } from './heartbeat.js';
import { noopLogger, type Logger } from '../../logger.js';
import {
  noopSocketObservability,
  type SocketObservability,
} from '../../observability.js';
import type { DeliveryPartitionRoute } from '../../auth/deliveryPartition.js';

/**
 * Ceiling for the exponential reconnect backoff (`reconnectDelay * 2^n`,
 * ±15% jitter). A client-side setting, not part of the wire contract.
 */
const MAX_RECONNECT_DELAY_MS = 30_000;

export interface SyncCapabilities {
  partialBootstrap?: boolean;
  compressedDeltas?: boolean;
  streamingBootstrap?: boolean;
  batchedDeltas?: boolean;
}

export interface WsTransportOptions {
  /** Base HTTP URL of the sync server */
  baseUrl?: string;
  url?: string;
  /**
   * Engine bookkeeping only. The server is bearer-only — it resolves identity
   * from the verified credential and never reads these — and the transport
   * itself never reads them either. A bare connection omits them.
   */
  userId?: string;
  organizationId?: string;
  /**
   * Opaque server-resolved delivery route. The transport echoes it on every
   * WebSocket upgrade; the receiving gateway authenticates and verifies it.
   */
  deliveryPartition?: DeliveryPartitionRoute | null;
  lastSyncId?: number;
  syncGroups?: string[];
  capabilities?: SyncCapabilities;
  reconnectDelay?: number;
  maxReconnectDelay?: number;
  /**
   * Collaboration event type keys to listen for (e.g., ['document:selection',
   * 'document:cursor']). Wire messages with matching types (underscore format)
   * are emitted as events.
   *
   * Defaults to none. The vocabulary is the application's, not the SDK's, so
   * an application names the events it broadcasts rather than inheriting a
   * built-in list that would only ever fit one consumer.
   */
  collaborationEvents?: string[];
  /**
   * The participant kind declared on the WebSocket upgrade. Defaults to
   * `'user'` (session auth, the web app). Agent runtimes pass `'agent'` so the
   * server verifies them by capability token instead of session auth. The
   * server reads this as the `kind` query parameter.
   */
  kind?: ParticipantKind;
  /**
   * The agent's bearer credential — a restricted (`rk_`) API key. When set, it
   * is sent in the `ablo.bearer.<token>` WebSocket subprotocol so the credential
   * stays out of URLs and proxy logs. Required for `kind: 'agent'` and ignored
   * for `kind: 'user'`.
   */
  capabilityToken?: string;
  /**
   * Getter for the current credential. When provided, the WebSocket upgrade
   * reads it instead of a copied `capabilityToken`, so reconnects always use
   * the freshest token from the SDK's single credential source. Preferred over
   * `getCapabilityToken`.
   */
  getAuthToken?: AuthTokenGetter;
  /** @deprecated Use `getAuthToken`. Kept for direct low-level callers. */
  getCapabilityToken?: AuthTokenGetter;
  /**
   * Hold the first connection until the owner releases it. While held,
   * `connect()` is ignored (debug-logged). A host that builds the socket
   * before identity is resolved sets this, seeds the late values (`setKind`,
   * `setSyncGroups`, the resume cursor), and calls {@link WsTransport.allowConnect}
   * followed by `connect()` — so no caller can open an unscoped connection in
   * the window between construction and identity resolution.
   */
  deferConnect?: boolean;
  /** Where the transport logs. Defaults to silent. */
  logger?: Logger;
  /** Where lifecycle breadcrumbs, socket errors, and coordination outcomes
   *  are reported. Defaults to silent. */
  observability?: SocketObservability;
  /** The connectivity signal consulted before connecting, sending, and
   *  scheduling reconnects. Defaults to always-online, which is correct for a
   *  server-side host; the browser engine passes its `navigator.onLine`-backed
   *  provider. */
  onlineStatus?: { isOnline(): boolean };
}

/**
 * Bootstrap hint from server indicating full or partial bootstrap is needed.
 * Properties are optional since server payload structure may vary.
 */
export interface BootstrapHint {
  tables?: string[];
  reason?: BootstrapReason;
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
 * The presence frame, re-exported at the path consumers already reach it
 * through. The declaration lives with the rest of the coordination vocabulary;
 * this keeps `import { PresenceUpdate } from '…/wsTransport'` working for
 * everything that used to import the hand-written type from here. The local
 * `import type` above is what makes this a re-export of a bound name rather
 * than a pass-through that leaves the name unusable in this file.
 */
export type { PresenceUpdate };

/**
 * Core event map — transport-level events that every connection emits.
 * SDK consumers extend this with app-specific collaboration events.
 */
export interface CoreSyncEventMap {
  connected: [];
  disconnected: [CloseEvent];
  reconnecting: [{ attempt: number; delay: number }];
  delta: [ClientSyncDelta];
  delta_batch: [ClientSyncDelta[]];
  bootstrap_required: [BootstrapHint];
  bootstrap_data: [BootstrapDataEvent];
  presence_update: [PresenceUpdate];
  error: [Error];
  session_error: [Error];
  protocol_mismatch: [CloseEvent];
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
  claim_expired: [ClaimExpired];
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
  claim_queue: [ClaimQueue];
  claim_acquired: [ClaimAcquired];
  claim_queued: [ClaimQueued];
  claim_granted: [ClaimGranted];
  claim_lost: [ClaimLost];
  /**
   * Reply to an outbound `claim_heartbeat` — the lease's fate: `held` with
   * the extended `expiresAt`, `queued` with the current `position`, or
   * `lost`. Correlated back to the awaiting caller by `claimId` in the
   * claim stream.
   */
  claim_heartbeat_ack: [ClaimHeartbeatAckPayload];
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
 * even though every one of its values is a tuple. This mapped form iterates
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
// Consumers pass their own event types as the TCollaboration generic parameter.

export class WsTransport<
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
      type: messageType.replace(/:/g, '_'), // 'document:selection' → 'document_selection' wire format
      payload: { ...payload, timestamp: Date.now() },
    });
  }
  private ws: WebSocket | null = null;
  protected options: Required<
    Omit<
      WsTransportOptions,
      | 'baseUrl'
      | 'kind'
      | 'capabilityToken'
      | 'getAuthToken'
      | 'getCapabilityToken'
      | 'deferConnect'
      | 'logger'
      | 'observability'
      | 'onlineStatus'
    >
  > & {
    baseUrl?: string;
    // `kind`, `capabilityToken`, `getAuthToken`, and `getCapabilityToken` are
    // genuinely optional: session connections pass no token field and agents
    // pass one. They are excluded from the Required<> wrap so callers do not
    // have to supply placeholders.
    kind?: WsTransportOptions['kind'];
    capabilityToken?: WsTransportOptions['capabilityToken'];
    getAuthToken?: WsTransportOptions['getAuthToken'];
    getCapabilityToken?: WsTransportOptions['getCapabilityToken'];
  };
  /** The transport's reporting ports, shared with the subclassing engine. */
  protected readonly logger: Logger;
  protected readonly observability: SocketObservability;
  protected readonly onlineStatus: { isOnline(): boolean };
  private reconnectAttempts = 0;
  /** Stop retrying after this many consecutive failures (backoff caps at 30s, so ~7.5 min total) */
  private static readonly MAX_RECONNECT_ATTEMPTS = 15;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Application-level heartbeat: ping every 30 seconds and force-close after a
   * 10-second silence. The {@link HeartbeatController} holds the timing and the
   * zombie-socket rationale; the closures below are the only socket access it
   * gets.
   */
  private readonly heartbeat: HeartbeatController;
  private isConnecting = false;
  private isManualClose = false;
  /** True while the owner still holds the first connection (`deferConnect`).
   *  `connect()` is ignored until {@link allowConnect} lifts the hold. */
  private connectHeld: boolean;
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
   * the lifetime of the transport so that any subsequent "not connected"
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
  /** Registered collaboration event keys (colon format) for dispatch in onmessage */
  private collaborationEventTypes: Set<string>;
  /**
   * A minimal session adapter handed to the inbound frame dispatch table
   * ({@link dispatchWsFrame}). It exposes only the members the handlers touch;
   * the closure members read live state so a reassignment here (for example the
   * `pendingSubscriptions` reset on close) cannot strand a handler on a stale
   * reference. Built in the constructor, after the state it captures exists.
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
   * In-flight `claim` requests keyed by claimId. Resolved when the matching
   * `claim_ack` arrives, or rejected on timeout or disconnect — the same
   * request/response pattern as `pendingMutations`, multiplexed over the one
   * connection.
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

  constructor(options: WsTransportOptions) {
    super();

    // Construct the WebSocket URL from the base server URL.
    const baseUrl = options.baseUrl || options.url || "http://localhost:8080";
    const wsProtocol = baseUrl.startsWith('https') ? 'wss' : 'ws';
    const wsUrl = baseUrl.replace(/^https?/, wsProtocol) + '/api/sync/ws';

    const { logger, observability, onlineStatus, deferConnect, ...connectionOptions } =
      options;
    this.logger = logger ?? noopLogger;
    this.observability = observability ?? noopSocketObservability;
    this.onlineStatus = onlineStatus ?? { isOnline: () => true };
    this.connectHeld = deferConnect === true;

    this.options = {
      url: wsUrl,
      reconnectDelay: 1000,
      maxReconnectDelay: MAX_RECONNECT_DELAY_MS,
      collaborationEvents: [],
      syncGroups: [],
      lastSyncId: 0,
      userId: '',
      organizationId: '',
      deliveryPartition: null,
      capabilities: {
        partialBootstrap: true,
        compressedDeltas: true,
        streamingBootstrap: true,
        batchedDeltas: true,
      },
      ...connectionOptions,
    };

    this.heartbeat = new HeartbeatController(
      {
        isSocketOpen: () => this.ws?.readyState === WebSocket.OPEN,
        // Optional-chained rather than asserted: the controller only calls
        // this synchronously after `isSocketOpen()`, so `ws` is present.
        sendPing: () => {
          this.ws?.send(JSON.stringify({ type: 'ping' }));
        },
        forceClose: (reason) => { this.forceClose(reason); },
      },
      this.observability,
    );

    this.collaborationEventTypes = new Set(
      options.collaborationEvents ?? []
    );

    // Session slice for the inbound frame dispatch table — see the field doc on
    // `frameSession` for why reassigned members are exposed through closures
    // instead of captured references. The four materialisation handlers route
    // through the protected hooks, so a subclass's overrides win.
    this.frameSession = {
      emit: (event, ...args) => this.emit(event, ...args),
      logger: this.logger,
      observability: this.observability,
      pendingMutations: this.pendingMutations,
      pendingClaims: this.pendingClaims,
      shiftPendingSubscription: () => this.pendingSubscriptions.shift(),
      options: this.options,
      collaborationEventTypes: this.collaborationEventTypes,
      handleDelta: (delta) => { this.handleDelta(delta); },
      handleSyncResponse: (payload) => { this.handleSyncResponse(payload); },
      handleBootstrapResponse: (payload) => { this.handleBootstrapResponse(payload); },
      handlePresenceUpdate: (message) => {
        this.handlePresenceUpdate(
          message as { payload?: PresenceUpdate; [k: string]: unknown },
        );
      },
    };
  }

  // ── Materialisation hooks ─────────────────────────────────────────────
  //
  // The frame dispatch routes deltas, sync responses, bootstrap payloads, and
  // presence frames through these protected hooks. The defaults surface the
  // raw push feed as events — enough for a socketed agent that wants claim
  // push and change notifications without a local copy. The reactive engine
  // overrides them with wire validation, cursor advancement, and bootstrap
  // handling; anything it does not override keeps the transport default.

  /**
   * One inbound delta, straight off the wire and unvalidated. The default
   * emits it as-is; the reactive engine's override validates against the
   * canonical delta schema and drops anything malformed before emitting.
   */
  protected handleDelta(rawDelta: unknown): void {
    this.emit('delta', rawDelta);
  }

  /** A `sync_response` frame. Meaningless without a resume cursor to advance,
   *  so the transport default does nothing. */
  protected handleSyncResponse(_payload: unknown): void {}

  /** A `bootstrap_response` frame. Bootstrap is materialisation, so the
   *  transport default does nothing. */
  protected handleBootstrapResponse(_payload: unknown): void {}

  /**
   * Handles a presence update from the server. The wire frame's payload is
   * forwarded as-is, so every consumer reads the same shape; stripping fields
   * here would drop `kind`, `activity`, `syncGroups`, and `isAgent` for
   * consumers that need them.
   *
   * The wire frame is:
   *   { type: 'presence_update', payload: { kind, userId, status,
   *     syncGroups, activity, isAgent, timestamp, activeClaims } }
   */
  protected handlePresenceUpdate(
    // Typed as a partial presence event as well as an envelope, because both
    // shapes genuinely arrive: the server's canonical `{ payload: {...} }`,
    // and legacy pathways (test fixtures) that put the fields at the top
    // level. Declaring the union up front is what lets the fallback below
    // stay a plain read instead of a checked-off cast.
    message: Partial<PresenceUpdate> & {
      payload?: PresenceUpdate;
      [k: string]: unknown;
    },
  ): void {
    const event: PresenceUpdate =
      // Server canonical path: `{ payload: {...} }`. Some legacy
      // pathways emit fields at the top level (test fixtures) — fall
      // back to reading from the message itself.
      message.payload ?? (message as PresenceUpdate);
    this.emit('presence_update', event);
  }

  /**
   * Runs after the socket opens and `connected` is emitted, before the
   * heartbeat starts. The default does nothing; the reactive engine's
   * override runs its open ritual — presence, ack, incremental sync, and the
   * catch-up poll.
   */
  protected onOpened(): void {}

  /**
   * Runs inside the close handler, after the socket reference is cleared and
   * before in-flight requests are rejected. The default does nothing; the
   * reactive engine's override stops its catch-up poll.
   */
  protected onClosed(): void {}

  /**
   * The resume position sent as the `cursor` query parameter on the upgrade.
   * The transport itself holds no cursor — a bare connection resumes from
   * nothing — so the default is empty; the reactive engine's override supplies
   * its persisted sync cursor.
   */
  protected resumeCursor(): string {
    return '';
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
   * Lift the `deferConnect` hold. The owner calls this once the connection's
   * identity and read scope are seeded; from then on `connect()` works
   * normally, including every reconnect path.
   */
  allowConnect(): void {
    this.connectHeld = false;
  }

  /**
   * Connect to the sync engine WebSocket
   */
  connect(): void {
    if (this.connectHeld) {
      // Deliberately ignored, not queued: the decided answer to "connect()
      // before the host has seeded identity" is a no-op, so an early caller
      // can never open an unscoped connection (see deferConnect).
      this.logger.debug('WebSocket connect ignored — the connection is still held by its host');
      return;
    }
    if (this._sessionErrorDetected) {
      this.logger.debug('WebSocket connect suppressed — session error detected');
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
      this.logger.debug('WebSocket already connected, connecting, or closing');
      return;
    }

    // Note: onlineStatus is advisory — we'll try to connect and let the WebSocket
    // handle failures. The default browser implementation reads navigator.onLine,
    // which is unreliable but the only signal available; in Node it returns true
    // (assume online) so the sidecar/agent path doesn't short-circuit here.
    if (!this.onlineStatus.isOnline()) {
      this.logger.debug('onlineStatus reports offline, but attempting connection anyway');
    }

    this.isConnecting = true;
    this.isManualClose = false;

    // One credential, server-resolved identity. The bearer travels in a
    // `Sec-WebSocket-Protocol` value (built below), not the URL. The server is
    // bearer-only and resolves identity from the verified token; userId and
    // organizationId are never read from URL parameters.
    const params = new URLSearchParams({
      // Intentionally omit lastSyncId, capabilities from URL; these are sent in sync_request
      // and ack messages to avoid stale baselines on reconnect.
      cursor: this.resumeCursor(),
    });

    // Participant kind — defaults to `user` for session connections. Agent
    // runtimes pass `'agent'` so the server's capability-token path activates
    // instead of session auth.
    if (this.options.kind && this.options.kind !== 'user') {
      params.set('kind', this.options.kind);
    }

    // Add sync groups if provided
    this.options.syncGroups.forEach((group) => {
      params.append('syncGroups', group);
    });
    if (this.options.deliveryPartition) {
      params.set(
        'deliveryPartition',
        `${this.options.deliveryPartition.index}-${this.options.deliveryPartition.count}`,
      );
    }

    const wsUrl = `${this.options.url}?${params.toString()}`;

    // Carry the bearer in a `Sec-WebSocket-Protocol` value, not the URL. A
    // browser cannot set an Authorization header on a WebSocket, but it can
    // offer subprotocols — and unlike the query string, those do not land in
    // load-balancer access logs, proxies, or browser history. The server reads
    // `ablo.bearer.<token>` and selects the real `ablo.sync.v1` protocol, never
    // echoing the token-bearing value back. The token is the raw `ek_`/`rk_`,
    // which is safe as a subprotocol value (alphanumerics and `_`).
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
      this.observability.captureWebSocketError({ context: 'create-websocket', error: errorMessage });
      this.isConnecting = false;
      this.emit('error', new AbloConnectionError(errorMessage, { cause: error }));
      this.scheduleReconnect();
    }
  }

  /**
   * Setup WebSocket event handlers
   */
  private setupEventHandlers(): void {
    // Capture the socket this call wires. Every handler below guards on
    // `this.ws === socket` (onclose additionally tolerates a nulled field —
    // see there), so a handler firing late, after `connect()` has replaced the
    // socket, can never clobber the new connection's shared state. Without this
    // guard, an old socket's `onclose` would unconditionally run `this.ws =
    // null; onClosed(); stopHeartbeat()` — a reconnect during close
    // teardown then orphaned the fresh socket (a zombie receiving deltas with
    // no timers and broken send paths).
    const socket = this.ws;
    if (!socket) return;

    socket.onopen = () => {
      if (this.ws !== socket) return; // stale socket — a newer connect() owns the state
      this.observability.breadcrumb('WebSocket connected', 'sync.websocket', 'info', {
        reconnectAttempts: this.reconnectAttempts,
      });
      this.isConnecting = false;
      this.reconnectAttempts = 0;
      this._everOpened = true;
      this.lastOpenAt = Date.now();
      this.emit('connected');

      // The subclass's open ritual (presence, ack, incremental sync,
      // catch-up poll) runs here, between the `connected` emit and the
      // heartbeat start — the exact position the inline code held before
      // the split.
      this.onOpened();

      // Start the application-level heartbeat (see HeartbeatController).
      this.heartbeat.start();
    };

    socket.onmessage = (event) => {
      if (this.ws !== socket) return; // stale socket — drop, don't feed shared state
      try {
        // Untrusted wire input: parse to `unknown`, then narrow through
        // the frame-envelope guard before dispatch. Payload-level
        // validation (deltas etc.) happens per-frame downstream.
        const message: unknown = JSON.parse(event.data);

        // Any inbound frame proves the socket is alive — clear the
        // heartbeat-timeout timer so we don't false-trip force-close
        // during normal traffic.
        this.heartbeat.clearHeartbeatTimeout();

        const frame = readWsInboundFrame(message);
        if (!frame) {
          this.logger.debug('[WsTransport] dropped malformed wire frame', {
            received: Array.isArray(message) ? 'array' : typeof message,
          });
          return;
        }

        // Dispatch by frame type (see dispatchWsFrame). The session adapter
        // exposes only the members the handlers touch; keepalives, the older
        // bare-delta form, and collaboration events are all routed there too.
        dispatchWsFrame(this.frameSession, frame);
      } catch (error) {
        this.observability.captureWebSocketError({
          context: 'parse-message',
          error: error instanceof Error ? error.message : String(error),
        });
      }
    };

    socket.onerror = (_event) => {
      if (this.ws !== socket) return; // stale socket — its errors are no longer ours
      // WebSocket errors are DOM Events, not Error objects
      // Check if we're offline first
      if (!this.onlineStatus.isOnline()) {
        this.observability.breadcrumb(
          'WebSocket error: Network is offline',
          'sync.websocket',
          'warning'
        );
        this.emit('error', new AbloConnectionError('Network is offline', { code: 'bootstrap_offline' }));
        return;
      }

      // After a session error, suppress error capture — the root cause is
      // already reported. Still emit so the store can update UI state.
      const error = new AbloConnectionError(`WebSocket connection failed`);
      if (!this._sessionErrorDetected) {
        this.observability.captureWebSocketError({
          context: 'connection-error',
          error: error.message,
        });
      }
      this.emit('error', error);
    };

    socket.onclose = (event) => {
      // Stale-socket close: a newer socket already owns the connection
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
      this.logger.info('WebSocket closed', {
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
      this.onClosed();
      this.heartbeat.stop();

      // Cancel in-flight mutations — the socket that was carrying them is
      // gone, and the server-side state may or may not have accepted each
      // one. Rejecting promptly is better than hanging the caller forever;
      // higher-level retry belongs to MutationQueue, not here.
      if (this.pendingMutations.size > 0) {
        for (const pending of this.pendingMutations.values()) {
          clearTimeout(pending.timeout);
          // AbloConnectionError → `isPermanentError` treats it as transient,
          // so MutationQueue retries the commit on reconnect rather than
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

      // Protocol-version rejection (4010): terminal. Reconnecting cannot heal a
      // version mismatch — only upgrading the SDK, or rolling the server
      // forward, can — so a blind retry here would loop forever against the
      // same typed close. Surface it and stop.
      if (event.code === WS_CLOSE_PROTOCOL_VERSION) {
        this.observability.captureWebSocketError({
          context: 'protocol-version-close',
          code: event.code,
          reason: event.reason,
        });
        this.emit('protocol_mismatch', event);
        this.emit('disconnected', event);
        return;
      }

      // Check for session-related close codes
      // 1008 = Policy Violation (often auth)
      // 4001 = Unauthorized (custom)
      // 4003 = Forbidden (custom)
      const isSessionClose =
        event.code === 1008 ||
        event.code === 4001 ||
        event.code === 4003 ||
        AbloSessionError.isSessionError(event.reason || '');

      if (isSessionClose) {
        this._sessionErrorDetected = true;
        this.sessionErrorAt = Date.now();
        this.observability.captureWebSocketError({
          context: 'session-error-close',
          code: event.code,
          reason: event.reason,
        });
        this.emit('session_error', new AbloSessionError(event.reason || 'Session expired', event.code));
        // Don't reconnect from here. For a genuine session loss the user must
        // re-authenticate; for an expired access credential (`credential_expired`)
        // the store's session-error handler re-mints, clears the latch, and
        // drives the reconnect itself.
        this.emit('disconnected', event);
        return;
      }

      // Handshake failure: `onclose` fired before `onopen` ever did, so the
      // server rejected the upgrade (typically 401/403 on a bad cookie, but it
      // could also be a CORS/origin reject or a load-balancer 5xx). The browser
      // hides the HTTP status behind code 1006, so we cannot tell which from
      // here.
      //
      // Emit a dedicated event and skip the internal reconnect — the owner
      // should run an auth-validating HTTP probe to distinguish session expiry
      // from a transient network issue and transition the UI accordingly.
      // Reconnecting blindly is what produced the infinite
      // "offline → reconnecting → offline" loop on stale cookies.
      if (!everOpened && !this.isManualClose) {
        this.observability.captureWebSocketError({
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
   * Send message to server
   */
  send(message: any): void {
    if (this.ws?.readyState !== WebSocket.OPEN) {
      // Only log at debug level when offline - this is expected behavior, not an error
      if (this.onlineStatus.isOnline()) {
        this.observability.breadcrumb(
          'WebSocket not connected, cannot send message',
          'sync.websocket',
          'warning'
        );
      } else {
        this.logger.debug('WebSocket send skipped - offline');
      }
      return;
    }

    try {
      this.ws.send(JSON.stringify(message));
    } catch (error) {
      // Only log as error if we're online - offline send failures are expected
      if (this.onlineStatus.isOnline()) {
        this.observability.captureWebSocketError({
          context: 'send-message',
          error: error instanceof Error ? error.message : String(error),
        });
      } else {
        this.logger.debug('WebSocket send failed - offline');
      }
    }
  }

  /**
   * Ask the server for every durable delta after the supplied position.
   *
   * This is deliberately part of the carrier rather than the reactive
   * materialiser: browser stores and headless WebSocket clients resume the same
   * ordered protocol. The owner decides when a received position is durable
   * enough to acknowledge.
   */
  requestSync(position: {
    readonly cursor?: string | null;
    readonly lastSyncId: number;
  }): void {
    if (this.ws?.readyState !== WebSocket.OPEN) {
      throw this.notConnectedError('sync_request');
    }
    const capabilities = Object.entries(this.options.capabilities)
      .filter(([, enabled]) => enabled)
      .map(([name]) => name);
    this.send({
      type: 'sync_request',
      payload: {
        cursor: position.cursor ?? null,
        lastSyncId: position.lastSyncId,
        capabilities,
        protocolVersion: PROTOCOL_VERSION,
      },
    });
  }

  /** Persist the server-side resume position after the caller durably applied it. */
  acknowledge(lastSyncId: number): void {
    if (!Number.isSafeInteger(lastSyncId) || lastSyncId < 0) {
      throw new AbloValidationError('acknowledge requires a non-negative safe integer.', {
        code: 'invalid_request',
      });
    }
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.send({ type: 'ack', payload: { lastSyncId } });
  }

  /** Announce this participant's current presence on the shared connection. */
  updatePresence(input: {
    readonly status?: 'online' | 'away' | 'offline';
    readonly customStatus?: string;
    readonly timezone?: string;
    readonly activity?: Record<string, unknown>;
  } = {}): void {
    if (this.ws?.readyState !== WebSocket.OPEN) {
      throw this.notConnectedError('presence_update');
    }
    let timezone = input.timezone;
    if (!timezone) {
      try {
        timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      } catch {
        timezone = 'UTC';
      }
    }
    this.send({
      type: 'presence_update',
      payload: {
        status: input.status ?? 'online',
        timezone,
        ...(input.customStatus !== undefined
          ? { customStatus: input.customStatus }
          : {}),
        ...(input.activity !== undefined ? { activity: input.activity } : {}),
      },
    });
  }

  /**
   * Sends a `commit` mutation request over the existing WebSocket and resolves
   * when the server's `mutation_result` frame comes back with the same
   * `clientTxId`. The wire frame is `{ type: 'commit', payload: { operations,
   * clientTxId } }`.
   *
   * Times out after 15 seconds of silence from the server. The socket may close
   * during an in-flight mutation (a network flap, a server restart); this does
   * not auto-retry — the caller's transaction queue owns retry and offline
   * replay, and the SDK does not duplicate that logic.
   */
  sendCommit(
    operations: readonly CommitFrameOperation[],
    clientTxId: string,
    timeoutMs = 15_000,
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
      this.pendingMutations.set(clientTxId, {
        resolve: (value) => resolve(value as CommitAck),
        reject,
        timeout,
      });
      try {
        const frame = buildCommitFrame(operations, clientTxId, reads);
        this.ws!.send(JSON.stringify(frame));
      } catch (error) {
        clearTimeout(timeout);
        this.pendingMutations.delete(clientTxId);
        reject(toAbloError(error));
      }
    });
  }

  /** @internal Exact wire receipt used to correlate a logical commit record. */
  sendCommitReceipt(
    operations: readonly CommitFrameOperation[],
    clientTxId: string,
    timeoutMs = 15_000,
    reads?: readonly ReadDependency[] | null,
  ): Promise<CommitReceiptWire> {
    if (this.ws?.readyState !== WebSocket.OPEN) {
      return Promise.reject(this.notConnectedError('commit'));
    }
    return new Promise<CommitReceiptWire>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingMutations.delete(clientTxId);
        reject(new AbloConnectionError(
          `commit timed out after ${timeoutMs}ms (clientTxId=${clientTxId})`,
          { code: 'commit_no_result' },
        ));
      }, timeoutMs);
      this.pendingMutations.set(clientTxId, {
        resolve: (value) => resolve(value as CommitReceiptWire),
        reject,
        timeout,
        returnReceipt: true,
      });
      try {
        const frame = buildCommitFrame(operations, clientTxId, reads);
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
    operations: readonly CommitFrameOperation[],
    clientTxId: string,
    reads?: readonly ReadDependency[] | null,
  ): void {
    if (this.ws?.readyState !== WebSocket.OPEN) {
      throw this.notConnectedError('commit');
    }
    const frame = buildCommitFrame(operations, clientTxId, reads);
    this.ws.send(JSON.stringify(frame));
  }

  /**
   * Activates a participant claim on this connection. One connection can hold
   * several concurrent claims at once, each scoped to a different set of sync
   * groups, so the SDK reuses the existing connection instead of opening a
   * separate socket per scope.
   *
   * Returns a promise that resolves with the server-canonicalized `syncGroups`
   * and effective `ttlSeconds` once `claim_ack` arrives, or rejects with a typed
   * error on a failed ack, a timeout, or a disconnect.
   */
  sendClaim(
    claimId: string,
    syncGroups: readonly string[],
    options?: Pick<ParticipantClaimPayload, 'capabilityToken' | 'ttlSeconds'> & {
      timeoutMs?: number;
    },
  ): Promise<{ syncGroups: string[]; ttlSeconds?: number }> {
    if (this.ws?.readyState !== WebSocket.OPEN) {
      return Promise.reject(this.notConnectedError('claim'));
    }
    // Checked against the schema the server ingests it with, for the same
    // reason `updateSubscription` below is: the two frames name their scopes
    // identically, so a group that would be refused there is refused here, at
    // the call that asked for it, rather than coming back as a failed ack a
    // round trip later with nothing to point at.
    const payload = participantClaimPayloadSchema.safeParse({
      claimId,
      syncGroups: [...syncGroups],
      capabilityToken: options?.capabilityToken,
      ttlSeconds: options?.ttlSeconds,
    });
    if (!payload.success) {
      return Promise.reject(
        new AbloValidationError(
          `join was given a sync group the protocol does not accept: ${payload.error.issues[0]?.message ?? 'unreadable'}. A group is 'default' or 'kind:id'.`,
          { code: 'malformed_claim' },
        ),
      );
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
        this.ws!.send(JSON.stringify({ type: 'claim', payload: payload.data }));
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
   * Moves this connection's read interest — replaces the connection-level sync
   * groups mid-session as the user opens and closes entities. This is the
   * area-of-interest navigation primitive: the server fans out deltas only for
   * the groups currently in view, rather than the fixed set chosen at connect.
   *
   * This is a full-set replace: pass the complete new group list, not a delta.
   * Resolves with the server's effective set once `subscription_ack` arrives;
   * rejects (with a typed error) on a scope denial (a restricted `rk_` key
   * requesting a group outside its allowlist), a timeout, or a disconnect. On
   * success the new set is recorded as `options.syncGroups`, so a later reconnect
   * re-subscribes to the current interest rather than the connect-time set.
   *
   * Distinct from {@link sendClaim} (a write claim, per operation, with a TTL):
   * this is the read side, carries no capability token of its own, and is
   * bounded by the connection credential's grant.
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
      // Check the payload against the schema the server ingests it with, so a
      // malformed sync group fails here — naming the group and the call that
      // asked for it — instead of coming back as a rejection ack a round trip
      // later, detached from the code that caused it.
      const payload = updateSubscriptionPayloadSchema.safeParse({
        syncGroups: [...syncGroups],
      });
      if (!payload.success) {
        clearTimeout(entry.timeout);
        reject(
          new AbloValidationError(
            `update_subscription was given a sync group the protocol does not accept: ${payload.error.issues[0]?.message ?? 'unreadable'}. A group is 'default' or 'kind:id'.`,
            { code: 'malformed_subscription' },
          ),
        );
        return;
      }
      this.pendingSubscriptions.push(entry);
      try {
        this.ws!.send(
          JSON.stringify({ type: 'update_subscription', payload: payload.data }),
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
   * Sets a fixed credential for callers that construct the socket directly. The
   * SDK instead supplies `getAuthToken`, so reconnects read the shared
   * credential source rather than this copied value.
   */
  setCapabilityToken(token: string): void {
    this.options.capabilityToken = token;
  }

  /**
   * Seeds the participant kind after identity resolution. The kind rides the
   * upgrade URL and selects the server's auth path, and on the hosted path it
   * is derived from the credential's scope — known only once identity
   * resolves, after the socket is built. Call before `connect()`.
   */
  setKind(kind: ParticipantKind): void {
    this.options.kind = kind;
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

    // Don't attempt reconnection while offline. The owning store manages the
    // offline→online transition: it bootstraps first, then calls `connect()`
    // explicitly. Self-reconnecting here would bypass that bootstrap gate and
    // surface stale data.
    if (!this.onlineStatus.isOnline()) {
      this.emit('reconnecting', { attempt: this.reconnectAttempts + 1, delay: 0 });
      return;
    }

    // Give up after MAX_RECONNECT_ATTEMPTS consecutive failures. The user can
    // recover by refreshing, or the store resets the attempt count and
    // reconnects when the network returns.
    if (this.reconnectAttempts >= WsTransport.MAX_RECONNECT_ATTEMPTS) {
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
   * Disconnect from WebSocket
   */
  disconnect(): void {
    this.isManualClose = true;
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
  protected forceClose(reason: string): void {
    if (!this.ws) return;
    this.lastForceCloseReason = reason;
    this.logger.debug('[WsTransport] forceClose', {
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
      maxReconnectAttempts: WsTransport.MAX_RECONNECT_ATTEMPTS,
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
  protected notConnectedError(action: string): Error & {
    diagnostics: ReturnType<WsTransport['getConnectionDiagnostics']>;
  } {
    const d = this.getConnectionDiagnostics();

    // A session-latched socket is not a transient transport hiccup: reconnection
    // is suppressed until re-auth (or the store's credential re-mint clears the
    // latch), so retrying can never succeed. Reject with the permanent session
    // error type — `isPermanentError` surfaces it to the caller as
    // "re-authenticate" instead of parking the write for a reconnect that will
    // never happen.
    if (d.sessionErrorDetected) {
      return Object.assign(
        new AbloSessionError(
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
    // Typed so it lands in the AbloError hierarchy and `isPermanentError` sees a
    // transient transport failure (retry on reconnect, don't roll back).
    // `diagnostics` stays a property — the queue's failure log walks the cause
    // chain for it.
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

  /**
   * Seeds the connection's read interest — the sync groups the next upgrade
   * URL carries. The set is already mutable state (`subscription_ack` writes
   * the acked set back so a reconnect resubscribes to current interest);
   * this setter is the host's way to seed it once identity resolves, before
   * the first `connect()`.
   */
  setSyncGroups(syncGroups: readonly string[]): void {
    this.options.syncGroups = [...syncGroups];
  }

  /** Seeds the server-resolved route before the held first connection opens. */
  setDeliveryPartition(deliveryPartition: DeliveryPartitionRoute | null): void {
    this.options.deliveryPartition = deliveryPartition;
  }
}
