/**
 * Builds the outgoing frames the sync WebSocket sends on the commit path, and
 * provides the single place claim events are traced. These are stateless
 * helpers that hold no socket state, so both the transport and its frame
 * dispatch can share them.
 */

import { getContext } from '../context.js';
// The wire types for the outgoing commit frame. Importing them lets the
// compiler enforce the frame shape, so the client and server can't drift apart.
import type { CommitMessage, CommitOperation } from '../wire/index.js';
import type { CommitAck as CanonicalCommitAck } from '../wire/commit.js';
import type { MutationOperation, ClaimEvent } from '../interfaces/index.js';
import type {
  StaleNotification,
  ReadDependency,
  TrackDependency,
} from '../coordination/schema.js';
import {
  staleNotificationSchema,
  wireParticipantKindSchema,
} from '../coordination/schema.js';
import { formatClaim } from '../coordination/trace.js';

/**
 * The value a commit acknowledgement resolves to. `notifications` is present
 * only when a guarded write (`onStale: 'notify'`) met a concurrent change; it
 * carries the advisory signal that lets the writer self-heal, and the same
 * signal also arrives on the `conflict:notified` event.
 */
export type CommitAck = CanonicalCommitAck;

/**
 * Converts the client's list of {@link MutationOperation} values into the wire
 * {@link CommitMessage} the server accepts. This is the one place the loosely
 * typed operation — its `type` is a string, and it carries client-only
 * `options` the server never reads — becomes the strict wire contract. Mapping
 * each field by hand means a change to {@link CommitOperation} fails to compile
 * here; the single `as` cast narrows the validated `type` to the wire union and
 * is the only place that loosening happens.
 */
export function buildCommitFrame(
  operations: readonly MutationOperation[],
  clientTxId: string,
  causedByTaskId?: string | null,
  reads?: readonly ReadDependency[] | null,
  track?: readonly TrackDependency[] | null,
): CommitMessage {
  const payload: CommitMessage['payload'] = {
    operations: operations.map((op) => ({
      type: op.type as CommitOperation['type'],
      model: op.model,
      id: op.id,
      input: op.input,
      transactionId: op.transactionId,
      readAt: op.readAt,
      onStale: op.onStale,
      fenceToken: op.fenceToken,
    })),
    clientTxId,
  };
  if (causedByTaskId) payload.causedByTaskId = causedByTaskId;
  // The read set the batch was premised on: the rows or groups the writer read before committing.
  if (reads && reads.length > 0) payload.reads = [...reads];
  // Durable read-dependencies the writer is registering: the rows or groups it
  // wants to keep hearing about after this commit, delivered on a future receipt.
  if (track && track.length > 0) payload.track = [...track];
  return { type: 'commit', payload };
}

/**
 * Defensively validate the optional `notifications` array off a commit ack.
 * Untrusted wire data — a malformed entry is dropped rather than throwing,
 * so a bad notification never sinks an otherwise-successful commit.
 */
export function parseNotifications(raw: unknown): StaleNotification[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const out: StaleNotification[] = [];
  for (const entry of raw) {
    const parsed = staleNotificationSchema.safeParse(entry);
    if (parsed.success) out.push(parsed.data);
  }
  return out.length > 0 ? out : undefined;
}

/**
 * The single place claim events are traced. Every `claim_*` frame passes
 * through here, so a developer debugging a collision gets one consistent record
 * — a console line and a structured capture — without each frame case
 * re-deriving the row and holder shape. The wire payload is loosely typed
 * (`Record<string, unknown>`), so this is the one place that narrows it into a
 * {@link ClaimEvent}.
 */
export function recordClaim(
  phase: ClaimEvent['phase'],
  payload: Record<string, unknown>,
): void {
  const str = (v: unknown): string | undefined =>
    typeof v === 'string' ? v : undefined;
  // Targets arrive flat ({ entityType, entityId }) or nested under `target`.
  const target =
    payload.target && typeof payload.target === 'object'
      ? (payload.target as Record<string, unknown>)
      : payload;
  const kind = wireParticipantKindSchema.safeParse(payload.participantKind);
  const event: ClaimEvent = {
    phase,
    claimId: str(payload.claimId),
    model: str(target.entityType) ?? str(target.model),
    id: str(target.entityId) ?? str(target.id),
    field: str(target.field),
    actor: str(payload.actor) ?? str(payload.heldBy),
    participantKind: kind.success ? kind.data : undefined,
    position: typeof payload.position === 'number' ? payload.position : undefined,
    reason: str(payload.policyReason) ?? str(payload.reason),
  };
  const message = formatClaim(event);
  // A rejection or lost lease is the collision a developer is actively
  // debugging → warn (shows at the default log level). The routine events
  // (acquired/queued/granted/expired) are debug-only so they never drown the
  // console until you opt in with `new Ablo({ debug: true })`.
  const isCollision = phase === 'rejected' || phase === 'lost';
  const ctx = getContext();
  if (isCollision) ctx.logger.warn(message);
  else ctx.logger.debug(message);
  ctx.observability.breadcrumb(message, 'sync.coordination', isCollision ? 'warning' : 'info');
  ctx.observability.captureClaim(event);
}
