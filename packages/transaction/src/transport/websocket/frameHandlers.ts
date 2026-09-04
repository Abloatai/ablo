/**
 * Routes each inbound frame from the sync WebSocket to the handler for its
 * type. Handlers work against a minimal {@link WsSession} interface — only
 * the members they actually touch, rather than the transport object itself,
 * which keeps this module free of an import cycle. Reading a message off the
 * socket, parsing its JSON, and tracking heartbeats all happen before this
 * point; every parsed frame then passes through {@link dispatchWsFrame}.
 */

import { z } from 'zod';
import {
  AbloConnectionError,
  CapabilityError,
  errorFromWire,
  type RequiredCapability,
} from '../../errors.js';
import {
  commitAckSchema,
  commitReceiptSchema,
  type CommitReceiptWire,
} from '../../commit/contract.js';
import { subscriptionAckPayloadSchema } from '../../coordination/schema.js';
import {
  WS_INBOUND_FRAMES,
  isKnownInboundFrame,
  isSchemaValidatedFrame,
  wsInboundEnvelopeSchema,
  type SchemaValidatedFrameType,
  type WsInboundEnvelope,
} from '../../wire/inboundFrames.js';
import { formatConflict } from '../../claims/trace.js';
import { recordClaim, type CommitAck } from './commitFrames.js';
import type { Logger } from '../../logger.js';
import type { SocketObservability } from '../../observability.js';
import type { PresenceSessionEstablished } from '../../presence/session.js';

/**
 * In-flight `commit` request record, keyed by clientTxId in the session.
 * Resolved when a matching `mutation_result` frame arrives from the
 * server, or rejected on timeout / disconnect.
 */
export interface PendingCommit {
  resolve: (value: CommitAck | CommitReceiptWire) => void;
  reject: (err: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
  readonly returnReceipt?: boolean;
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
 * A parsed inbound wire frame — the envelope only, with its payload still
 * untrusted. Inferred from {@link wsInboundEnvelopeSchema} rather than written
 * out, so the type a handler sees and the check the socket runs are the same
 * statement. The open key set is what carries the oldest delta form, which puts
 * a delta's own fields (`actionType`, `modelName`) at the top level instead of
 * under `payload`.
 */
export type WsInboundFrame = WsInboundEnvelope;

/** Narrow arbitrary wire data to a plain string-keyed record. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Read the envelope off an inbound message, or `null` when it is not one —
 * anything that is not an object, or whose `type` is not a string. The payload
 * is not checked here; that belongs to the frame's own schema, applied at
 * dispatch.
 */
export function readWsInboundFrame(value: unknown): WsInboundFrame | null {
  const parsed = wsInboundEnvelopeSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
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
  /** Where the handlers log. The transport passes its own port. */
  logger: Logger;
  /** Where coordination outcomes and lifecycle breadcrumbs are reported. */
  observability: SocketObservability;
  /** In-flight commit acks keyed by clientTxId. */
  pendingMutations: Map<string, PendingCommit>;
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
  establishPresenceSession(value: PresenceSessionEstablished): void;
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
  const { clientTxId, success, error } = p;
  const missingIds = Array.isArray(p.missingIds)
    ? [
        ...new Set(
          p.missingIds.filter(
            (id): id is string => typeof id === 'string' && id.length > 0,
          ),
        ),
      ]
    : undefined;
  const pending =
    typeof clientTxId === 'string'
      ? session.pendingMutations.get(clientTxId)
      : undefined;
  if (!pending) return;
  clearTimeout(pending.timeout);
  // `pending` exists ⇒ clientTxId was a string key (the guard above).
  session.pendingMutations.delete(clientTxId as string);
  if (success) {
    const parsedReceipt = commitReceiptSchema.safeParse({
      ...p,
      missingIds,
    });
    if (!parsedReceipt.success) {
      pending.reject(
        new AbloConnectionError(
          'The sync server returned an invalid commit receipt; its outcome remains pending and is safe to retry.',
          { code: 'commit_no_result', cause: parsedReceipt.error },
        ),
      );
      return;
    }
    const receipt = parsedReceipt.data;
    pending.resolve(
      pending.returnReceipt
        ? receipt
        : commitAckSchema.parse({
        status: receipt.status,
        ...(receipt.correlationId
          ? { correlationId: receipt.correlationId }
          : {}),
        statusAt: receipt.statusAt,
        lastSyncId: receipt.lastSyncId,
        ...(receipt.missingIds && receipt.missingIds.length > 0
          ? { missingIds: receipt.missingIds }
          : {}),
        ...(receipt.operationResults && receipt.operationResults.length > 0
          ? { operationResults: receipt.operationResults }
          : {}),
          }),
    );
  } else {
    // Capture the full server error so the caller can see what actually
    // rejected the mutation, rather than a generic "mutation failed on
    // server". Object errors are stringified so structured server payloads,
    // such as validation issues, survive being wrapped in an Error.
    let errorMessage: string;
    let errorCode: string | undefined;
    let requestId: string | undefined;
    let requiredCapability: RequiredCapability | undefined;
    let details: Readonly<Record<string, unknown>> | undefined;
    if (typeof error === 'string') {
      errorMessage = error;
    } else if (error != null && typeof error === 'object') {
      const obj = error as {
        code?: unknown;
        message?: unknown;
        request_id?: unknown;
        event_id?: unknown;
        requiredCapability?: unknown;
        details?: unknown;
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
      requestId =
        typeof obj.request_id === 'string' ? obj.request_id : undefined;
      details =
        obj.details != null &&
        typeof obj.details === 'object' &&
        !Array.isArray(obj.details)
          ? (obj.details as Readonly<Record<string, unknown>>)
          : undefined;
      if (typeof obj.event_id === 'string') {
        details = { ...(details ?? {}), event_id: obj.event_id };
      }
    } else {
      errorMessage = 'mutation failed on server';
    }
    // Stale-context and foreign-claim rejections are coordination collisions.
    // The conflicting rows ride on the typed error's `conflicts` detail.
    if (
      errorCode === 'stale_context' ||
      errorCode === 'claim_conflict' ||
      errorCode === 'entity_claimed'
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
      session.observability.breadcrumb(
        formatConflict(conflictEvent),
        'sync.coordination',
        'warning',
      );
      session.observability.captureConflict(conflictEvent);
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
        requestId,
        requiredCapability,
        details,
      }),
    );
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
    const eventId = ack.error?.event_id;
    pending.reject(
      errorFromWire(
        ack.error?.message ?? 'update_subscription rejected by server',
        {
          code: ack.error?.code ?? 'malformed_subscription',
          requestId: ack.error?.request_id,
          ...(eventId !== undefined ? { details: { event_id: eventId } } : {}),
        },
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

/** The reporting ports of one session, in the shape {@link recordClaim} takes. */
function tracePorts(session: WsSession): { logger: Logger; observability: SocketObservability } {
  return { logger: session.logger, observability: session.observability };
}

/**
 * Maps each frame type to its handler. Every named server frame this
 * package understands is dispatched from this table; anything else falls
 * through to the collaboration-event and unknown-type path in
 * {@link dispatchWsFrame}.
 */
export const wsFrameHandlers: Record<string, WsFrameHandler> = {
  sync_response: (session, message) => { session.handleSyncResponse(message.payload); },
  bootstrap_response: (session, message) => { session.handleBootstrapResponse(message.payload); },
  mutation_result: handleMutationResult,
  subscription_ack: handleSubscriptionAck,
  delta: handleDeltaFrame,
};

/**
 * Binds a handler to the schema that validates its input.
 *
 * The two are paired here, at the declaration, so the payload type is inferred
 * from the schema rather than restated — and the frame's validation cannot be
 * changed without the handler's parameter type following it. The bound function
 * accepts `unknown`, which is what lets the dispatcher call any of them from a
 * lookup without an assertion.
 */
function validating<T>(
  schema: z.ZodType<T>,
  frameType: string,
  run: (session: WsSession, payload: T) => void,
): (session: WsSession, payload: unknown) => void {
  return (session, payload) => {
    const parsed = schema.safeParse(payload ?? {});
    if (!parsed.success) {
      throw new AbloConnectionError(
        `The sync server sent a ${frameType} frame that does not match the protocol; it was not applied.`,
        { code: 'malformed_response', cause: parsed.error },
      );
    }
    run(session, parsed.data);
  };
}

/**
 * Handlers for the frames the protocol validates before dispatch. Each takes
 * the parsed payload, typed by the registry's own schema — which is why none of
 * them narrows, defaults, or casts. The record's key type makes the table
 * exhaustive: adding a `validation: 'schema'` frame to the registry without
 * adding it here is a compile error.
 */
const validatedFrameHandlers: Record<
  SchemaValidatedFrameType,
  (session: WsSession, payload: unknown) => void
> = {
  presence_session: validating(
    WS_INBOUND_FRAMES.presence_session.payload,
    'presence_session',
    (session, payload) => {
      session.establishPresenceSession(payload);
    },
  ),
  presence_snapshot: validating(
    WS_INBOUND_FRAMES.presence_snapshot.payload,
    'presence_snapshot',
    (session, payload) => {
      session.emit('presence_snapshot', payload);
    },
  ),
  presence_patch: validating(
    WS_INBOUND_FRAMES.presence_patch.payload,
    'presence_patch',
    (session, payload) => {
      session.emit('presence_patch', payload);
    },
  ),
  claim_rejected: validating(
    WS_INBOUND_FRAMES.claim_rejected.payload,
    'claim_rejected',
    (session, payload) => {
      // The target is held by another participant and this claim did not opt
      // into the wait line.
      recordClaim(tracePorts(session), 'rejected', payload);
      session.emit('claim_rejected', payload);
    },
  ),
  claim_acquired: validating(
    WS_INBOUND_FRAMES.claim_acquired.payload,
    'claim_acquired',
    (session, payload) => {
      // The target was free: the lease is ours without waiting.
      recordClaim(tracePorts(session), 'acquired', payload);
      session.emit('claim_acquired', payload);
    },
  ),
  claim_abandon_ack: validating(
    WS_INBOUND_FRAMES.claim_abandon_ack.payload,
    'claim_abandon_ack',
    (session, payload) => {
      session.emit('claim_abandon_ack', payload);
    },
  ),
  claim_queued: validating(
    WS_INBOUND_FRAMES.claim_queued.payload,
    'claim_queued',
    (session, payload) => {
      // Opt-in fair queue: our claim waits in line, carrying its position.
      recordClaim(tracePorts(session), 'queued', payload);
      session.emit('claim_queued', payload);
    },
  ),
  claim_granted: validating(
    WS_INBOUND_FRAMES.claim_granted.payload,
    'claim_granted',
    (session, payload) => {
      // Our queued claim reached the head — the lease is now ours.
      recordClaim(tracePorts(session), 'granted', payload);
      session.emit('claim_granted', payload);
    },
  ),
  claim_lost: validating(
    WS_INBOUND_FRAMES.claim_lost.payload,
    'claim_lost',
    (session, payload) => {
      // A held or granted lease was taken from us (TTL lapse, preemption).
      recordClaim(tracePorts(session), 'lost', payload);
      session.emit('claim_lost', payload);
    },
  ),
  claim_queue: validating(
    WS_INBOUND_FRAMES.claim_queue.payload,
    'claim_queue',
    (session, payload) => {
      // Per-entity wait-line snapshot backing the reactive `queue(id)` read.
      // Not logged: the per-claim queued/granted events tell that story.
      session.emit('claim_queue', payload);
    },
  ),
  claim_heartbeat_ack: validating(
    WS_INBOUND_FRAMES.claim_heartbeat_ack.payload,
    'claim_heartbeat_ack',
    (session, payload) => {
      // Reply to our `claim_heartbeat`; the claim stream correlates it back to
      // the awaiting caller by claimId. Not logged per-frame — a heartbeat is
      // a cadence, and the transition that matters (lost) surfaces as an error.
      session.emit('claim_heartbeat_ack', payload);
    },
  ),
};

/**
 * Routes one inbound frame to its handler, validating the payload first.
 *
 * A frame the protocol declares with a payload schema is parsed here, so its
 * handler works on a proven shape. A frame the protocol does not declare is
 * rejected: the server and this package ship together, so an unrecognised type
 * means the two have drifted, and a change nobody validated should not reach a
 * local store. The one exception is an application's own collaboration events,
 * which the consumer registers at construction and the protocol knows nothing
 * about.
 *
 * Throwing is the reporting channel. The transport's message loop catches and
 * reports through `captureWebSocketError`, so a bad frame surfaces as a
 * captured error and the connection survives.
 */
export function dispatchWsFrame(session: WsSession, message: WsInboundFrame): void {
  if (message.type === 'pong' || message.type === 'ping') {
    // Ignore keepalive messages
    session.logger.debug('Received keepalive', { type: message.type });
    return;
  }

  if (message.type === undefined) {
    // A bare delta, validated downstream like every other delta.
    if (message.actionType || message.modelName) {
      session.handleDelta(message);
    }
    return;
  }

  const frameType = message.type;

  if (isKnownInboundFrame(frameType)) {
    if (isSchemaValidatedFrame(frameType)) {
      // Validated on the way in — see `validating`, which pairs each handler
      // with the registry schema its parameter type is inferred from.
      validatedFrameHandlers[frameType](session, message.payload);
      return;
    }
    // `validation: 'handler'` — the check lives inside, cited by the registry.
    const handler = wsFrameHandlers[frameType];
    if (handler) {
      handler(session, message);
      return;
    }
  }

  // Collaboration events use underscore wire format (e.g., 'section_selection')
  // Convert to colon format for the event map (e.g., 'section:selection')
  const eventKey = frameType.replace(/_/g, ':');
  if (session.collaborationEventTypes.has(eventKey)) {
    session.emit(eventKey, message.payload);
    return;
  }

  throw new AbloConnectionError(
    `The sync server sent an unrecognised frame type "${frameType}". This client and the server have drifted; the frame was not applied.`,
    { code: 'malformed_response' },
  );
}
