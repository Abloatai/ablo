/**
 * Commit-path frame builders and claim instrumentation for the sync
 * WebSocket — pure functions with no socket state, extracted from
 * SyncWebSocket so the wire codec is a leaf the transport (and the frame
 * dispatch table) can share.
 */

import { getContext } from '../context.js';
// Canonical commit-path frame contract. The SDK previously DESCRIBED these
// shapes in comments ("mirrors hub/types.ts …"); importing the wire types makes
// the compiler enforce the outgoing frame so client and server cannot drift.
import type { CommitMessage, CommitOperation } from '../wire/index.js';
import type { MutationOperation, ClaimEvent } from '../interfaces/index.js';
import type { StaleNotification, ReadDependency } from '../coordination/schema.js';
import {
  staleNotificationSchema,
  wireParticipantKindSchema,
} from '../coordination/schema.js';
import { formatClaim } from '../coordination/trace.js';

/**
 * Resolution value of a commit ack. `notifications` is present only when a
 * guarded write (`onStale: 'notify') hit a concurrent change — the
 * advisory self-heal signal, surfaced both here and via `conflict:notified`.
 */
export interface CommitAck {
  lastSyncId: number;
  notifications?: StaleNotification[];
}

/**
 * Project the SDK's `MutationOperation[]` onto the canonical wire
 * `CommitMessage`. This is the single serialize boundary between the SDK op
 * type (loose `type: string`, plus an SDK-internal `options` the server never
 * reads) and the strict wire contract. The per-field map gives compile-time
 * drift detection (a `CommitOperation` shape change breaks here) and the lone
 * `as` narrows the validated op `type` to the wire union — the only
 * loosening, localized to this boundary.
 */
export function buildCommitFrame(
  operations: readonly MutationOperation[],
  clientTxId: string,
  causedByTaskId?: string | null,
  reads?: readonly ReadDependency[] | null,
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
    })),
    clientTxId,
  };
  if (causedByTaskId) payload.causedByTaskId = causedByTaskId;
  // Batch-level read-set (STORM layer): rows/groups the batch was premised on.
  if (reads && reads.length > 0) payload.reads = [...reads];
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
 * Single instrumentation point for claim events. Every `claim_*` frame routes
 * through here so a developer debugging a collision gets one consistent trace
 * — a console line AND a structured capture — without each dispatch case
 * re-deriving the row/holder shape. The wire payload is loosely typed
 * (`Record<string, unknown>`), so this is the one place that narrows it into
 * a {@link ClaimEvent}.
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
