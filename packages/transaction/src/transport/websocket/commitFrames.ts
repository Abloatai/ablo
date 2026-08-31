/**
 * Builds the outgoing frames the sync WebSocket sends on the commit path, and
 * provides the single place claim events are traced. These are stateless
 * helpers that hold no socket state, so both the transport and its frame
 * dispatch can share them.
 */

// The wire types for the outgoing commit frame. Importing them lets the
// compiler enforce the frame shape, so the client and server can't drift apart.
import type { CommitMessage, WireCommitOperation } from '../../wire/index.js';
import type { CommitAck as CanonicalCommitAck } from '../../commit/contract.js';
import type { ReadDependency } from '../../coordination/schema.js';
import { claimEventReasonSchema } from '../../coordination/schema.js';
import type {
  ClaimAcquired,
  ClaimGranted,
  ClaimQueued,
  ClaimLost,
  ClaimRejection,
  ClaimExpired,
} from '../../coordination/schema.js';
import type { ClaimEvent, ClaimCounterparty } from '../../claims/events.js';
import type { AssertExact } from '../../types/assertExact.js';
import { formatClaim } from '../../claims/trace.js';
import { modelTarget } from '../../claims/locator.js';
import type { Logger } from '../../logger.js';
import type { SocketObservability } from '../../observability.js';

/** The value a commit acknowledgement resolves to. */
export type CommitAck = CanonicalCommitAck;

/**
 * The slice of a queued client mutation the commit frame reads — a structural
 * port, so the reactive engine's fatter `MutationOperation` satisfies it
 * without this module importing the consumer package.
 */
export interface CommitFrameOperation {
  readonly type: string;
  readonly model: string;
  readonly id: string | null;
  readonly input?: Record<string, unknown> | null;
  readonly where?: Record<string, unknown> | null;
  readonly transactionId?: string | null;
  readonly claimId?: string | null;
  readonly readAt?: number | null;
  readonly fenceToken?: number | null;
}

/**
 * Converts the client's list of {@link CommitFrameOperation} values into the wire
 * {@link CommitMessage} the server accepts. This is the one place the loosely
 * typed operation — its `type` is a string, and it carries client-only
 * `options` the server never reads — becomes the strict wire contract. Mapping
 * each field by hand means a change to {@link WireCommitOperation} fails to compile
 * here; the single `as` cast narrows the validated `type` to the wire union and
 * is the only place that loosening happens.
 */
export function buildCommitFrame(
  operations: readonly CommitFrameOperation[],
  clientTxId: string,
  reads?: readonly ReadDependency[] | null,
): CommitMessage {
  const payload: CommitMessage['payload'] = {
    operations: operations.map((op) => ({
      type: op.type as WireCommitOperation['type'],
      model: op.model,
      id: op.id,
      input: op.input,
      where: op.where,
      transactionId: op.transactionId,
      claimId: op.claimId,
      readAt: op.readAt,
      fenceToken: op.fenceToken,
    })),
    clientTxId,
  };
  // Preserve declaration at the wire boundary. `null`, an explicit empty list,
  // and omission are distinct inputs even when today's server treats each as
  // "none"; the WebSocket path must not silently erase a field the caller set.
  if (reads !== undefined) payload.reads = reads === null ? null : [...reads];
  return { type: 'commit', payload };
}

/** The reporting ports a claim trace writes through — supplied by the caller
 *  (the frame dispatch passes its session's own ports). */
export interface ClaimTracePorts {
  readonly logger: Logger;
  readonly observability: SocketObservability;
}

/**
 * Which frame reports each phase of a claim's life.
 *
 * The correspondence is real and was previously implicit: six dispatch handlers
 * each passed their own payload alongside a phase they picked by hand, and
 * nothing checked that the two matched. Stating it once means a caller cannot
 * label a rejection as an acquisition.
 *
 * Every value is the `z.infer` of the schema the dispatcher parsed with, so no
 * field is restated here — this maps existing types, it does not describe them.
 */
interface ClaimFrameByPhase {
  acquired: ClaimAcquired;
  granted: ClaimGranted;
  queued: ClaimQueued;
  lost: ClaimLost;
  rejected: ClaimRejection;
  expired: ClaimExpired;
}

// The phases this map covers and the phases a ClaimEvent can report are the
// same set. Adding one to either without the other stops compiling here.
const _phaseCoverage: AssertExact<
  keyof ClaimFrameByPhase,
  ClaimEvent['phase']
> = true;
void _phaseCoverage;

/** Any of the six payloads, once the phase that selected it is no longer known. */
type ClaimFramePayload = ClaimFrameByPhase[keyof ClaimFrameByPhase];

/**
 * The single place claim events are traced. Every `claim_*` frame passes
 * through here, so a developer debugging a collision gets one consistent record
 * — a console line and a structured capture — without each frame case
 * re-deriving the row and holder shape.
 *
 * The payload arrives already validated against its frame's schema, so this
 * reads it as the shape it is rather than re-narrowing an untyped record. That
 * distinction is not cosmetic: while this took `Record<string, unknown>` it
 * read `actor`, `participantKind`, and `description` off frames that carry none
 * of them, and every one of those reads silently produced `undefined` because a
 * string key never has to exist.
 */
export function recordClaim<P extends keyof ClaimFrameByPhase>(
  ports: ClaimTracePorts,
  phase: P,
  payload: ClaimFrameByPhase[P],
): void {
  // Widened so the members can be told apart with `in`. The parameter above
  // stays correlated to `phase`, which is what the widening cannot undo.
  const frame: ClaimFramePayload = payload;
  const target = 'target' in frame ? frame.target : undefined;
  // The holder rides on the rejection and queued frames, with a summary of
  // their claim beside it. Collecting it is the whole of "name the
  // counterparty" — the wire has carried it all along and this projection used
  // to flatten it into one string alongside the cause.
  const counterparty: ClaimCounterparty = {
    ...('heldBy' in frame && frame.heldBy !== undefined
      ? { actor: frame.heldBy }
      : {}),
    ...('heldByKind' in frame && frame.heldByKind !== undefined
      ? { participantKind: frame.heldByKind }
      : {}),
    ...('heldByClaimId' in frame && frame.heldByClaimId !== undefined
      ? { claimId: frame.heldByClaimId }
      : {}),
    ...('heldByExpiresAt' in frame && frame.heldByExpiresAt !== undefined
      ? { expiresAt: frame.heldByExpiresAt }
      : {}),
    ...('heldByClaim' in frame && frame.heldByClaim?.description !== undefined
      ? { description: frame.heldByClaim.description }
      : {}),
  };
  // `reason` is a plain string on the wire, which is frozen, so an older server
  // may send a word the closed set does not list. One that parses becomes the
  // typed reason; one that does not is absent rather than passed off as prose.
  const parsedReason =
    'reason' in frame ? claimEventReasonSchema.safeParse(frame.reason) : undefined;
  const event: ClaimEvent = {
    phase,
    claimId: frame.claimId,
    ...(target ? modelTarget(target) : {}),
    ...(target?.field !== undefined ? { field: target.field } : {}),
    // No claim frame names an actor of its own; the only participant one
    // carries is the holder that blocked it.
    ...('heldBy' in frame && frame.heldBy !== undefined
      ? { actor: frame.heldBy }
      : {}),
    ...('position' in frame ? { position: frame.position } : {}),
    ...(parsedReason?.success ? { reason: parsedReason.data } : {}),
    ...('message' in frame && frame.message !== undefined
      ? { message: frame.message }
      : {}),
    ...(Object.keys(counterparty).length > 0 ? { heldBy: counterparty } : {}),
  };
  const message = formatClaim(event);
  // A rejection or lost lease is the collision a developer is actively
  // debugging → warn (shows at the default log level). The routine events
  // (acquired/queued/granted/expired) are debug-only so they never drown the
  // console until you opt in with `new Ablo({ debug: true })`.
  const isCollision = phase === 'rejected' || phase === 'lost';
  if (isCollision) ports.logger.warn(message);
  else ports.logger.debug(message);
  ports.observability.breadcrumb(message, 'sync.coordination', isCollision ? 'warning' : 'info');
  ports.observability.captureClaim(event);
}
