/**
 * Routes each inbound frame from the sync WebSocket to the handler for its
 * type. Handlers work against a minimal {@link WsSession} interface — only
 * the members they actually touch, rather than the transport object itself,
 * which keeps this module free of an import cycle. Reading a message off the
 * socket, parsing its JSON, and tracking heartbeats all happen before this
 * point; every parsed frame then passes through {@link dispatchWsFrame}.
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
 * An in-flight `update_subscription` request awaiting its
 * `subscription_ack`. The wire carries no correlation id, so requests are
 * matched to their acknowledgements in first-in, first-out order, the same
 * order the server applies them.
 */
export interface PendingSubscription {
  resolve: (value: { syncGroups: string[] }) => void;
  reject: (err: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

/**
 * A parsed inbound wire frame, straight from `JSON.parse`. The data is
 * untrusted: every payload is loosely typed, and each handler narrows it
 * defensively before use.
 */
export interface WsInboundFrame {
  type?: string;
  payload?: unknown;
  /** Some delta frames carry their delta fields at the top level rather than under `payload`. */
  actionType?: unknown;
  modelName?: unknown;
  [key: string]: unknown;
}

/** Narrow arbitrary wire data to a plain string-keyed record. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A type guard for the parsed result of an inbound message. A frame is any
 * plain object whose `type`, when present, is a string. Validating the
 * payload itself is left to each handler; delta payloads, for example, are
 * checked against the canonical delta schema before they are applied.
 */
export function isWsInboundFrame(value: unknown): value is WsInboundFrame {
  if (!isRecord(value)) return false;
  const type = value.type;
  return type === undefined || typeof type === 'string';
}

/**
 * The subset of the sync WebSocket that the frame handlers need. The
 * transport builds a single object exposing these members over its own
 * private state. Handlers read the fields live rather than capturing them,
 * so resetting a field elsewhere — such as clearing pending subscriptions
 * on close — never leaves a handler holding a stale value.
 */
export interface WsSession {
  /** EventEmitter surface — handlers emit the typed transport events. */
  emit(event: string, ...args: unknown[]): boolean;
  /** In-flight commit acks keyed by clientTxId. */
  pendingMutations: Map<string, PendingCommit>;
  /** In-flight claim acks keyed by claimId. */
  pendingClaims: Map<string, PendingClaim>;
  /** Removes and returns the oldest in-flight `update_subscription` request. */
  shiftPendingSubscription(): PendingSubscription | undefined;
  /** Connection options subset the handlers write back (acked sync groups). */
  options: { syncGroups: string[] };
  /** Registered collaboration event keys (colon format). */
  collaborationEventTypes: ReadonlySet<string>;
  /**
   * Processes one inbound delta. The argument is untrusted wire data; the
   * transport validates it against the canonical delta schema and drops
   * anything malformed, so handlers here never cast.
   */
  handleDelta(delta: unknown): void;
  handleSyncResponse(payload: unknown): void;
  handleBootstrapResponse(payload: unknown): void;
  handlePresenceUpdate(message: { payload?: unknown; [k: string]: unknown }): void;
}

export type WsFrameHandler = (session: WsSession, message: WsInboundFrame) => void;

/**
 * Handles the acknowledgement of a `commit` request. The canonical wire
 * shape is `MutationResultMessage`. The payload is parsed defensively
 * rather than cast, since it is untrusted and may be malformed or sent by
 * an older server.
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
    // The write succeeded, but a guarded premise shifted underneath it.
    // Emit the advisory signal so a caller can react, and still resolve
    // the receipt, since the commit itself went through.
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
    // Capture the full server error so the caller can see what actually
    // rejected the mutation, rather than a generic "mutation failed on
    // server". Object errors are stringified so structured server payloads,
    // such as validation issues, survive being wrapped in an Error.
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
    // A stale-context rejection (the write read state that has since
    // changed) or a foreign-claim conflict is a coordination collision.
    // The success-with-notifications path above records the conflict, and a
    // hard rejection must record it too, or the collision count would miss
    // every rejected write. The conflicting rows ride along on the typed
    // error's `conflicts` detail.
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
 * Handles the acknowledgement of a `claim` request. The frame has the shape
 * `{ type: 'claim_ack', payload: { claimId, success, syncGroups?,
 * ttlSeconds?, error? } }`.
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
 * Handles the acknowledgement of an `update_subscription` request. The wire
 * carries no correlation id, so the ack is matched to the oldest pending
 * request in first-in, first-out order, since the server applies and
 * acknowledges subscription updates in the order it receives them. The
 * payload is validated against its canonical schema before use.
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
 * Handles a `delta` frame, which carries either a single delta or a
 * `{ deltas: [...] }` batch. This only tells the two shapes apart; each
 * delta is validated once downstream, so batch elements are passed along
 * raw rather than parsed here.
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
    // `p.newVersions` from older servers is ignored; `sync_id` is the
    // causality token.
  }
};

/**
 * Maps each frame type to its handler. Every named server frame this
 * package understands is dispatched from this table; anything else falls
 * through to the collaboration-event and unknown-type path in
 * {@link dispatchWsFrame}.
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
    // The server denied a claim because the target is already held by
    // another participant. The payload is forwarded as-is for the claim
    // stream consumer to interpret (peerId, target, and so on).
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
  claim_heartbeat_ack: (session, message) => {
    // Reply to our `claim_heartbeat` — the claim stream correlates it back
    // to the awaiting caller by claimId. Not logged per-frame: heartbeats
    // are a cadence, and the interesting transitions (lost) surface through
    // the caller's error path.
    session.emit('claim_heartbeat_ack', message.payload ?? {});
  },
  delta: handleDeltaFrame,
};

/**
 * Routes one parsed inbound frame to its handler. Keepalive frames are
 * ignored, a missing `type` is treated as a bare delta, and any unknown
 * type falls through to the collaboration-event map, whose wire names use
 * underscores and whose event keys use colons.
 */
export function dispatchWsFrame(session: WsSession, message: WsInboundFrame): void {
  if (message.type === 'pong' || message.type === 'ping') {
    // Ignore keepalive messages
    getContext().logger.debug('Received keepalive', { type: message.type });
    return;
  }

  if (message.type === undefined) {
    // A bare delta, validated downstream like every other delta.
    if (message.actionType || message.modelName) {
      session.handleDelta(message);
    }
    return;
  }

  // Look up own properties only, so a wire type like 'toString' can't match
  // an inherited Object.prototype member; such types fall through to the
  // unknown-type path.
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
