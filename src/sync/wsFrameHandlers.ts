/**
 * Inbound frame dispatch for the sync WebSocket.
 *
 * Replaces the monolithic frame `switch` that used to live inside
 * `SyncWebSocket.setupEventHandlers` with a frame-type → handler table of
 * functions over a minimal {@link WsSession} interface — only the members
 * the handlers actually touch, never the transport class itself (no
 * import cycle). The host's `onmessage` stays responsible for JSON
 * parsing, heartbeat proof-of-life, and the outer try/catch; everything
 * after that funnels through {@link dispatchWsFrame}.
 */

import { getContext } from '../context.js';
import {
  CapabilityError,
  errorFromWire,
  type RequiredCapability,
} from '../errors.js';
import { subscriptionAckPayloadSchema } from '../coordination/schema.js';
import { formatConflict } from '../coordination/trace.js';
import { parseNotifications, recordClaim, type CommitAck } from './commitFrames.js';

/**
 * In-flight `commit` request record, keyed by clientTxId in the session.
 * Resolved when a matching `mutation_result` frame arrives from the
 * server, or rejected on timeout / disconnect.
 */
export interface PendingCommit {
  resolve: (value: CommitAck) => void;
  reject: (err: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

/**
 * In-flight `claim` request record, keyed by claimId. Resolved when the
 * matching `claim_ack` arrives, or rejected on timeout/disconnect.
 */
export interface PendingClaim {
  resolve: (value: { syncGroups: string[]; ttlSeconds?: number }) => void;
  reject: (err: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

/**
 * In-flight `update_subscription` record awaiting `subscription_ack`.
 * FIFO-matched (no correlation id on the wire) — see the session field
 * doc on SyncWebSocket.pendingSubscriptions.
 */
export interface PendingSubscription {
  resolve: (value: { syncGroups: string[] }) => void;
  reject: (err: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

/**
 * Parsed inbound wire frame (the raw `JSON.parse` result). Untrusted
 * data — every payload is loose and each handler narrows defensively,
 * the same posture the inline switch had.
 */
export interface WsInboundFrame {
  type?: string;
  payload?: unknown;
  /** Legacy bare-delta frames carry delta fields at the top level. */
  actionType?: unknown;
  modelName?: unknown;
  [key: string]: unknown;
}

/** Narrow arbitrary wire data to a plain string-keyed record. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Envelope guard for the raw `JSON.parse` result of an inbound WS message.
 * A frame is any plain object whose `type`, when present, is a string —
 * payload-level validation stays with each handler (deltas go through the
 * canonical `clientSyncDeltaSchema` at the `normalizeWireDelta` seam).
 */
export function isWsInboundFrame(value: unknown): value is WsInboundFrame {
  if (!isRecord(value)) return false;
  const type = value.type;
  return type === undefined || typeof type === 'string';
}

/**
 * The slice of SyncWebSocket the frame handlers operate on. The host
 * builds one adapter object over its private state; closures read live
 * fields so host-side reassignment (e.g. the pendingSubscriptions reset
 * on close) can't strand the handlers on stale references.
 */
export interface WsSession {
  /** EventEmitter surface — handlers emit the typed transport events. */
  emit(event: string, ...args: unknown[]): boolean;
  /** In-flight commit acks keyed by clientTxId. */
  pendingMutations: Map<string, PendingCommit>;
  /** In-flight claim acks keyed by claimId. */
  pendingClaims: Map<string, PendingClaim>;
  /** FIFO pop of the oldest in-flight `update_subscription` request. */
  shiftPendingSubscription(): PendingSubscription | undefined;
  /** Connection options subset the handlers write back (acked sync groups). */
  options: { syncGroups: string[] };
  /** Registered collaboration event keys (colon format). */
  collaborationEventTypes: ReadonlySet<string>;
  /**
   * Receive-boundary delta processing. Takes UNTRUSTED wire data — the
   * host validates against the canonical `clientSyncDeltaSchema` (and
   * drops malformed deltas) at its `normalizeWireDelta` seam, so the
   * handlers here never need to cast.
   */
  handleDelta(delta: unknown): void;
  handleSyncResponse(payload: unknown): void;
  handleBootstrapResponse(payload: unknown): void;
  handlePresenceUpdate(message: { payload?: unknown; [k: string]: unknown }): void;
}

export type WsFrameHandler = (session: WsSession, message: WsInboundFrame) => void;

/**
 * Ack for a prior `commit` we sent. Canonical shape is
 * `MutationResultMessage` in `@abloatai/ablo/wire`. This stays a
 * DEFENSIVE parse (not a typed cast) because the payload is
 * untrusted wire data that may be malformed or from an older server.
 */
const handleMutationResult: WsFrameHandler = (session, message) => {
  const p = (message.payload ?? message) as Record<string, unknown>;
  const { clientTxId, success, lastSyncId, error } = p ?? {};
  // Defensive: validate notifications against the canonical schema —
  // untrusted wire data from a possibly-older/newer server.
  const notifications = parseNotifications(
    (p as { notifications?: unknown } | undefined)?.notifications,
  );
  const pending =
    typeof clientTxId === 'string'
      ? session.pendingMutations.get(clientTxId)
      : undefined;
  if (!pending) return;
  clearTimeout(pending.timeout);
  // `pending` exists ⇒ clientTxId was a string key (the guard above).
  session.pendingMutations.delete(clientTxId as string);
  if (success) {
    // Coerce defensively — bigint columns serialize as strings
    // from older servers (see normalizeWireDelta).
    const ackedSyncId = Number(lastSyncId);
    // Notify-instead-of-abort: a guarded write's premise moved. Emit
    // the advisory signal so an agent loop can self-heal, AND resolve
    // the receipt with it (the commit still succeeded).
    if (notifications && notifications.length > 0) {
      const txId = typeof clientTxId === 'string' ? clientTxId : '';
      const event = {
        clientTxId: txId,
        rows: notifications.map((n) => ({
          model: n.model,
          id: n.id,
          fields: n.conflictingFields,
          writtenBy: n.writtenBy?.kind,
        })),
      };
      const message = formatConflict(event);
      const ctx = getContext();
      ctx.logger.warn(message);
      ctx.observability.breadcrumb(message, 'sync.coordination', 'warning');
      ctx.observability.captureConflict(event);
      session.emit('conflict:notified', {
        clientTxId: txId,
        notifications,
      });
    }
    pending.resolve({
      lastSyncId: Number.isFinite(ackedSyncId) ? ackedSyncId : 0,
      ...(notifications && notifications.length > 0
        ? { notifications }
        : {}),
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
    // Coordination collision: a stale-context rejection (the write's
    // readAt premise moved underneath) or a foreign-claim conflict is
    // exactly the collision ClaimLog exists to surface. The notify
    // path (success + notifications) emits captureConflict above; a
    // HARD rejection must too — otherwise observability.collisions()
    // silently misses every rejected write. The conflicted rows ride
    // along on the typed error's `conflicts` detail (see
    // AbloStaleContextError.toJSON / errorEnvelope).
    if (
      errorCode === 'stale_context' ||
      errorCode === 'claim_conflict' ||
      errorCode === 'entity_claimed' ||
      errorCode?.startsWith('policy:') === true
    ) {
      const rawConflicts =
        error != null &&
        typeof error === 'object' &&
        Array.isArray((error as { conflicts?: unknown }).conflicts)
          ? (error as { conflicts: readonly { model?: unknown; id?: unknown }[] })
              .conflicts
          : [];
      const conflictEvent = {
        clientTxId: typeof clientTxId === 'string' ? clientTxId : '',
        rows: rawConflicts.map((r) => ({
          model: typeof r.model === 'string' ? r.model : 'unknown',
          id: typeof r.id === 'string' ? r.id : 'unknown',
          fields: [] as string[],
        })),
      };
      const ctx = getContext();
      ctx.observability.breadcrumb(
        formatConflict(conflictEvent),
        'sync.coordination',
        'warning',
      );
      ctx.observability.captureConflict(conflictEvent);
    }
    // Build the proper typed AbloError from the wire code via the
    // shared factory — the same code→class mapping the HTTP commit
    // path uses (`translateHttpError`). This keeps rejected commits
    // inside the typed hierarchy (capability denials →
    // CapabilityError with `.requiredCapability`; foreign-claim
    // conflicts → AbloClaimedError; everything else → the subclass
    // its registry `httpStatus` implies) instead of a hand-rolled
    // `new Error`, so callers can `instanceof`/`e.type` it and
    // downstream retry logic can read the contract's retryability.
    pending.reject(
      errorFromWire(errorMessage, {
        code: errorCode,
        requiredCapability,
      }),
    );
  }
};

/**
 * Ack for a prior `claim` we sent. Wire format mirrors
 * apps/sync-server/src/hub/types.ts ClaimAckMessage:
 *   { type: 'claim_ack',
 *     payload: { claimId, success, syncGroups?,
 *                ttlSeconds?, error? } }
 */
const handleClaimAck: WsFrameHandler = (session, message) => {
  const p = (message.payload ?? {}) as Record<string, unknown>;
  const { claimId, success, syncGroups, ttlSeconds, error } = p;
  const pending =
    typeof claimId === 'string'
      ? session.pendingClaims.get(claimId)
      : undefined;
  if (!pending) return;
  clearTimeout(pending.timeout);
  // `pending` exists ⇒ claimId was a string key (the guard above).
  session.pendingClaims.delete(claimId as string);
  if (success) {
    pending.resolve({
      syncGroups: Array.isArray(syncGroups) ? syncGroups : [],
      ttlSeconds: typeof ttlSeconds === 'number' ? ttlSeconds : undefined,
    });
  } else {
    const err = error as
      | { code?: unknown; message?: unknown }
      | undefined;
    const code =
      err?.code && typeof err.code === 'string'
        ? err.code
        : 'claim_rejected';
    const msg =
      err?.message && typeof err.message === 'string'
        ? err.message
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
      // Route through the shared factory so a failed claim_ack is a
      // typed AbloError (registry code → right subclass), symmetric
      // with the commit `mutation_result` path — never a bare Error.
      pending.reject(errorFromWire(msg, { code }));
    }
  }
};

/**
 * Ack for a prior `update_subscription`. The wire carries no
 * correlation id, so FIFO-match against the oldest pending
 * request — the server applies and acks subscription updates
 * in receive order. Validated through the canonical zod schema
 * (mirrors how the Hub validates inbound frames).
 */
const handleSubscriptionAck: WsFrameHandler = (session, message) => {
  const pending = session.shiftPendingSubscription();
  if (!pending) return;
  clearTimeout(pending.timeout);
  const parsed = subscriptionAckPayloadSchema.safeParse(message.payload);
  if (!parsed.success) {
    // Unreadable ack — resolve the pending request as a failure
    // rather than hang it until timeout.
    pending.reject(
      errorFromWire('malformed subscription_ack from server', {
        code: 'malformed_subscription',
      }),
    );
    return;
  }
  const ack = parsed.data;
  if (ack.success) {
    // Keep the reconnect URL aligned with current interest: a
    // reconnect re-subscribes from `this.options.syncGroups`.
    session.options.syncGroups = ack.syncGroups;
    pending.resolve({ syncGroups: ack.syncGroups });
  } else {
    pending.reject(
      errorFromWire(
        ack.error?.message ?? 'update_subscription rejected by server',
        { code: ack.error?.code ?? 'malformed_subscription' },
      ),
    );
  }
};

/**
 * `delta` frames carry either a single delta or a `{ deltas: [...] }` batch.
 * Only DISCRIMINATES the two shapes here — each delta is validated exactly
 * once downstream (the host's `normalizeWireDelta` seam), so batch elements
 * are handed over raw rather than pre-parsed.
 */
const handleDeltaFrame: WsFrameHandler = (session, message) => {
  const p = message.payload;
  if (!isRecord(p)) return;
  if (p.actionType || p.modelName) {
    session.handleDelta(p);
  } else if (Array.isArray(p.deltas)) {
    for (const d of p.deltas) {
      session.handleDelta(d);
    }
    // `p.newVersions` from pre-cutover servers is ignored — the version
    // vector was removed in W4a (sync_id is the causality token).
  }
};

/**
 * Frame-type → handler table. Every named server frame the SDK
 * understands dispatches through here; anything else falls to the
 * collaboration-event / unknown-type path in {@link dispatchWsFrame}.
 */
export const wsFrameHandlers: Record<string, WsFrameHandler> = {
  sync_response: (session, message) => { session.handleSyncResponse(message.payload); },
  bootstrap_response: (session, message) => { session.handleBootstrapResponse(message.payload); },
  presence_update: (session, message) => { session.handlePresenceUpdate(message); },
  mutation_result: handleMutationResult,
  claim_ack: handleClaimAck,
  subscription_ack: handleSubscriptionAck,
  claim_expired: (session, message) => {
    // Server-initiated expiry notification. Emit as a typed
    // event so consumers can react (re-claim with a fresh
    // capability, or accept the drop). The claim is already
    // inactive server-side by the time this arrives.
    const p = (message.payload ?? {}) as Record<string, unknown>;
    if (typeof p.claimId === 'string') {
      recordClaim('expired', p);
      session.emit('claim_expired', { claimId: p.claimId });
    }
  },
  claim_rejected: (session, message) => {
    // Server denied an `claim_begin` because the target is
    // already claimed by another participant. Forward the
    // payload as-is — the ClaimStream consumer interprets
    // the conflict shape (peerId, target, etc.).
    recordClaim('rejected', (message.payload ?? {}) as Record<string, unknown>);
    session.emit('claim_rejected', message.payload ?? {});
  },
  claim_acquired: (session, message) => {
    // Opt-in fair queue: the target was free, so the lease is ours
    // immediately (no waiting). Payload carries { claimId, target }.
    recordClaim('acquired', (message.payload ?? {}) as Record<string, unknown>);
    session.emit('claim_acquired', message.payload ?? {});
  },
  claim_queue: (session, message) => {
    // Per-entity wait-queue snapshot for reactive `queue(id)`. Not a
    // single claim's state change, so it isn't logged — the per-claim
    // `queued`/`granted` events already tell that story.
    session.emit('claim_queue', message.payload ?? {});
  },
  claim_queued: (session, message) => {
    // Opt-in fair queue: our claim is waiting in line. Payload
    // carries { claimId, target, position }.
    recordClaim('queued', (message.payload ?? {}) as Record<string, unknown>);
    session.emit('claim_queued', message.payload ?? {});
  },
  claim_granted: (session, message) => {
    // Our queued claim reached the head — the lease is now ours.
    recordClaim('granted', (message.payload ?? {}) as Record<string, unknown>);
    session.emit('claim_granted', message.payload ?? {});
  },
  claim_lost: (session, message) => {
    // A held/granted claim was taken from us (TTL lapse, revoke).
    recordClaim('lost', (message.payload ?? {}) as Record<string, unknown>);
    session.emit('claim_lost', message.payload ?? {});
  },
  delta: handleDeltaFrame,
};

/**
 * Route one parsed inbound frame to its handler. Mirrors the original
 * inline switch exactly: keepalives are ignored, a missing `type` is
 * the legacy bare-delta form, unknown types fall through to the
 * collaboration-event map (underscore wire format → colon event key).
 */
export function dispatchWsFrame(session: WsSession, message: WsInboundFrame): void {
  if (message.type === 'pong' || message.type === 'ping') {
    // Ignore keepalive messages
    getContext().logger.debug('Received keepalive', { type: message.type });
    return;
  }

  if (message.type === undefined) {
    // Legacy support: bare delta (validated at the host's
    // normalizeWireDelta seam like every other delta).
    if (message.actionType || message.modelName) {
      session.handleDelta(message);
    }
    return;
  }

  // Own-property lookup so wire types like 'toString' can never hit
  // Object.prototype members — those fall through to the unknown-type
  // path exactly as the switch's `default` did.
  const handler = Object.prototype.hasOwnProperty.call(wsFrameHandlers, message.type)
    ? wsFrameHandlers[message.type]
    : undefined;
  if (handler) {
    handler(session, message);
    return;
  }

  // Collaboration events use underscore wire format (e.g., 'sheet_selection')
  // Convert to colon format for the event map (e.g., 'sheet:selection')
  const eventKey = message.type?.replace(/_/g, ':');
  if (eventKey && session.collaborationEventTypes.has(eventKey)) {
    session.emit(eventKey, message.payload);
  } else {
    getContext().logger.debug('Received unknown message type', { message });
  }
}
