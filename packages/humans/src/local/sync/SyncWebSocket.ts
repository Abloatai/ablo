/**
 * The reactive engine's connection to the sync server: the settlement core's
 * duplex transport ({@link WsTransport}, ADR 0016) plus everything that turns
 * the stream into a local, watchable copy — wire-delta validation, the resume
 * cursor and its persistence-gated ack discipline, incremental sync and
 * bootstrap requests, the catch-up poll, and presence. The socket lifecycle,
 * reconnect backoff, heartbeat, and the commit/claim/release/subscription
 * frames all live in the transport; this subclass overrides its frame hooks
 * and open/close hooks with the materialisation the transport deliberately
 * does not do.
 */

import { getContext } from '../context.js';
import { clientSyncDeltaSchema, type ClientSyncDelta } from '@abloatai/transaction/wire/delta';
import {
  WsTransport,
  type WsTransportOptions,
  type EventMap,
  type DefaultCollaborationEvents,
} from '@abloatai/transaction/transport/wsTransport';
import { isRecord } from './wsFrameHandlers.js';
// Sync-position state (lastSyncId watermark, version vector, server cursor).
import { SyncCursor } from './syncCursor.js';
import { PROTOCOL_VERSION } from '@abloatai/transaction/wire/protocolVersion';
// Context-backed ports in the shape the core transport takes.
import {
  contextLogger,
  contextSocketObservability,
  contextOnlineStatus,
} from './contextPorts.js';

// Moved leaves — re-exported so every importer's path stays unchanged.
export type { CommitAck } from './commitFrames.js';
export type {
  SyncCapabilities,
  BootstrapHint,
  BootstrapDataEvent,
  PresenceUpdate,
  CoreSyncEventMap,
  DefaultCollaborationEvents,
  EventMap,
  SyncWebSocketEventMap,
} from '@abloatai/transaction/transport/wsTransport';

/**
 * How often, while connected, the client polls for any deltas whose best-effort
 * broadcast was lost in transit. This is a client-side eventual-consistency
 * setting, not part of the wire contract, so the server derives nothing from
 * it. That it currently equals the 30-second ping is a coincidence, not a
 * guarantee.
 */
const CATCHUP_POLL_INTERVAL_MS = 30_000;

/**
 * The wire delta the client receives. It is inferred from the canonical
 * `clientSyncDeltaSchema` so the client and server share one contract rather
 * than two hand-maintained definitions. The action vocabulary
 * (`I`/`U`/`D`/`A`/`V`/`C`/`G`/`S`) and the client-only extras (`metadata`,
 * `clientMutationId`, and the deprecated flat `createdBy`) live in that schema;
 * see its own documentation for the full field reference.
 */
export type SyncDelta = ClientSyncDelta;

/**
 * Payload for an older actionType `'G'` delta. It carries both the added and
 * removed sync groups in one delta and forces a full re-bootstrap.
 */
export interface SyncGroupChangePayload {
  removedGroups: string[];
  addedGroups: string[];
}

/**
 * Payload for an incremental actionType `'G'` delta. It signals that the
 * recipient has joined a single sync group; the following `'C'` (covering)
 * deltas deliver the newly visible entities. No re-bootstrap is required.
 */
export interface GroupAddedPayload {
  group: string;
  userId: string;
}

/**
 * Payload for an actionType `'S'` delta. It signals that the recipient has lost
 * access to a sync group; the client purges the affected local entities and
 * updates its subscription metadata.
 */
export interface GroupRemovedPayload {
  group: string;
  userId: string;
}

/**
 * The reactive engine's connection options — the transport's options under
 * the name consumers have always imported.
 */
export type SyncWebSocketOptions = WsTransportOptions;

// ---------------------------------------------------------------------------
// Consumers pass their own event types as the TCollaboration generic parameter.

export class SyncWebSocket<
  TCollaboration extends EventMap<TCollaboration> = DefaultCollaborationEvents
> extends WsTransport<TCollaboration> {
  /** Periodic catchup interval — polls for missed deltas every 30s while connected */
  private catchupInterval: ReturnType<typeof setInterval> | null = null;
  /**
   * Sync-position state: the lastSyncId watermark, version vector, and server
   * cursor. The advance discipline is documented at `sendAck` and `handleDelta`;
   * the state itself lives in {@link SyncCursor}.
   */
  private readonly cursor: SyncCursor;

  constructor(options: SyncWebSocketOptions) {
    super({
      ...options,
      logger: contextLogger,
      observability: contextSocketObservability,
      onlineStatus: contextOnlineStatus,
    });
    this.cursor = new SyncCursor(options.lastSyncId ?? 0);
  }

  /** The persisted resume position, sent on the upgrade URL. */
  protected override resumeCursor(): string {
    return this.cursor.syncCursor || '';
  }

  /**
   * The open ritual, run by the transport between its `connected` emit and the
   * heartbeat start: announce presence, tell the server where we left off,
   * request the deltas we missed, and start the catch-up poll.
   */
  protected override onOpened(): void {
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
    // CATCHUP_POLL_INTERVAL_MS while connected. Real-time WebSocket delivery
    // is best-effort, so this interval guarantees eventual consistency by
    // fetching any deltas that were committed but whose broadcast was lost in
    // transit.
    this.stopCatchupInterval();
    this.catchupInterval = setInterval(() => {
      if (this.isConnected()) {
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
  }

  /** The transport clears its socket reference before this runs. */
  protected override onClosed(): void {
    this.stopCatchupInterval();
  }

  /**
   * Validates and normalizes a wire delta at the receive boundary — the single
   * seam every inbound delta (a `delta` frame, a batch element, a `sync_response`
   * replay, or the older bare frame) passes through before it is emitted,
   * persisted, or allowed to advance any watermark.
   *
   * Normalization keeps already-deployed servers compatible:
   *  - `id`: the contract says `number`, but some servers have sent the raw
   *    Postgres BIGINT serialization — a string — and every downstream watermark
   *    gate treats a string as invalid, so acks are withheld, the resume cursor
   *    never advances, and every reconnect replays from zero. Coerce it once here.
   *  - `transactionId` / `createdBy`: the server projection sends these as
   *    nullable (and `createdBy` as a nested reference); the client contract
   *    types them as optional strings and never reads them, so normalize them to
   *    absent rather than reject every real server delta.
   *
   * Validation runs `clientSyncDeltaSchema.safeParse`, the canonical wire
   * contract. A frame that fails is dropped (returns `null`) with a debug log
   * and an observability breadcrumb; it is never applied. There is one parse per
   * delta — callers must not re-parse.
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
  protected override handleDelta(rawDelta: unknown): void {
    const delta = this.normalizeWireDelta(rawDelta);
    if (!delta) return;
    getContext().logger.debug('Received delta', {
      action: delta.actionType,
      model: delta.modelName,
      id: delta.modelId,
      syncId: delta.id,
    });

    // Do not advance `this.cursor.lastSyncId` on receipt. The runtime cursor
    // must stay consistent with what has been persisted locally; otherwise the
    // next `requestIncrementalSync()` (and the connect-time handshake) would
    // send an optimistic cursor and the server would skip deltas that never
    // landed in local storage. `this.cursor.lastSyncId` advances only in
    // `sendAck()`, which the store gates on its persisted-syncId watermark, so
    // the cursor is never read ahead of the persisted client view.
    //
    // The version vector is intentionally not updated here for the same reason;
    // it is left to the persistence-gated path.

    // Emit delta for processing. Ack will be sent by SyncedStore after persistence.
    this.emit('delta', delta);
  }

  /**
   * Acknowledges received deltas up to the given syncId. This is the only place
   * `this.cursor.lastSyncId` moves forward for live deltas. The store calls it
   * with its persisted-syncId watermark — that is, only after the deltas have
   * committed to local storage. Advancing the cursor here, rather than at
   * receipt in `handleDelta` or `handleSyncResponse`, keeps the cursor from
   * getting ahead of the persisted view, so reconnect and catch-up requests
   * cannot skip un-persisted deltas.
   */
  private sendAck(syncId: number): void {
    // Advance the local cursor *and* the version vector for this ack —
    // these are what `requestIncrementalSync` and the connect handshake
    // will send next, and what `getLastSyncId()` reports for clean-
    // shutdown persistence.
    this.cursor.ackAdvance(syncId);

    if (!this.isConnected()) return;

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
    if (!this.isConnected()) return;

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
  override disconnect(): void {
    this.stopCatchupInterval();
    super.disconnect();
  }

  // Cursor accessors — thin delegates; the state and semantics live in
  // SyncCursor.

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
   * Requests an incremental sync from the server, starting at the current cursor.
   */
  async requestIncrementalSync(): Promise<void> {
    if (!this.isConnected()) {
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
        // Protocol handshake: the server rejects an out-of-range version with
        // WebSocket close code 4010 before serving any deltas.
        protocolVersion: PROTOCOL_VERSION,
      },
    });
  }

  /**
   * Request bootstrap for specific entities
   */
  async requestBootstrap(entities?: string[]): Promise<void> {
    if (!this.isConnected()) {
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
  protected override handleSyncResponse(rawPayload: unknown): void {
    const payload: Record<string, unknown> = isRecord(rawPayload) ? rawPayload : {};
    const rawDeltas: unknown[] | null = Array.isArray(payload.deltas)
      ? payload.deltas
      : null;
    // Cursor reconciliation. The server stamps its authoritative `currentSyncId`
    // on every sync_response. If our local cursor is ahead of the server, our
    // local view has somehow diverged (corrupted metadata, a regression that
    // reintroduced an eager advance, or local storage lying about a successful
    // commit). Trust the server, reset the cursor, and request another sync so
    // any deltas we should have applied get re-delivered. When the field is
    // absent (an older server build) we simply skip this step.
    //
    // We only reconcile when the response carries no deltas. If deltas are
    // present they advance our cursor through the normal persistence-gated path
    // anyway — and the in-flight round-trip means the snapshot's `currentSyncId`
    // is naturally a few syncIds behind our locally-advanced cursor at receive
    // time (live deltas may have landed in the meantime). Restricting to
    // empty-delta responses eliminates that benign false positive while still
    // catching the real corruption case (server head < local, and the server
    // has nothing new to send).
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
  protected override handleBootstrapResponse(payload: unknown): void {
    // Emit the bootstrap data for processing. (A `version` field from older
    // servers is ignored; the version vector is no longer used.) The typeof
    // guards mirror the cursor handling above: the frame is server-produced, so
    // coercion only bites on a malformed frame.
    const p = (payload && typeof payload === 'object' ? payload : {}) as {
      entityType?: unknown;
      data?: unknown;
      isComplete?: unknown;
      cursor?: unknown;
    };
    this.emit('bootstrap_data', {
      entityType: typeof p.entityType === 'string' ? p.entityType : '',
      data: p.data,
      isComplete: p.isComplete === true,
      cursor: typeof p.cursor === 'string' ? p.cursor : undefined,
    });
  }
}
