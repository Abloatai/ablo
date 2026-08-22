import { AbloClaimedError, AbloConnectionError } from '../errors.js';
import { commitReceiptSchema, type CommitReceiptWire } from '../wire/commit.js';
import type { ClaimHeartbeatReply } from '../wire/claims.js';
import type { ModelClaim } from '../resources/httpResources.js';
import { subTarget, streamTarget } from '../coordination/locator.js';
import { declaredMeta } from '../coordination/claimMeta.js';
import type { Claim, ClaimHeartbeat } from '../types/streams.js';

/** Interpret a heartbeat reply for a lease this handle currently holds. */
export function heldHeartbeatReply(
  reply: ClaimHeartbeatReply,
  label: string,
): ClaimHeartbeat {
  if (reply.status === 'held' && typeof reply.expiresAt === 'number') {
    return {
      expiresAt: reply.expiresAt,
      ...(reply.queueDepth !== undefined ? { queueDepth: reply.queueDepth } : {}),
    };
  }
  throw new AbloClaimedError(
    `The lease behind ${label} is no longer held — it expired or was granted onward. Re-acquire the claim and retry; a write attempted under the old lease is rejected by its \`readAt\` guard.`,
    { code: 'claim_lost' },
  );
}

export function parseSuccessfulCommitResponse(
  value: unknown,
  idempotencyKey: string,
): CommitReceiptWire {
  const parsed = commitReceiptSchema.safeParse(value);
  if (!parsed.success || parsed.data.clientTxId !== idempotencyKey) {
    throw new AbloConnectionError(
      'The commit endpoint returned an invalid success receipt; its outcome remains pending and is safe to retry.',
      {
        code: 'commit_no_result',
        cause: parsed.success
          ? new Error('Commit receipt clientTxId did not match its idempotency key')
          : parsed.error,
      },
    );
  }
  return parsed.data;
}

/** Decode the HTTP claim DTO into the public Claim shape. */
export function claimFromModelClaim(claim: ModelClaim): Claim {
  const { meta, ...details } = subTarget(claim.target);
  return {
    object: 'claim',
    id: claim.id,
    ...(claim.status ? { status: claim.status } : {}),
    description: claim.description ?? 'editing',
    heldBy: claim.actor,
    participantKind: claim.participantKind,
    expiresAt: claim.expiresAt,
    ...(claim.position !== undefined ? { position: claim.position } : {}),
    target: {
      ...streamTarget(claim.target),
      ...details,
      ...(meta !== undefined ? { meta: declaredMeta(meta) } : {}),
    },
  };
}
