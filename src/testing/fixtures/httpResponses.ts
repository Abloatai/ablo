/**
 * Response bodies for a fake HTTP server, built in the shapes the real one
 * answers with.
 *
 * A test that hand-rolls `{ data, stamp }` is asserting against a server it
 * invented. That is how a client and its server drift apart while every test
 * stays green: the fixture and the client agree, and neither has met the
 * route. Each builder here is `satisfies`-pinned to the wire schema the server
 * answers with and the client parses — so a change to the contract breaks these
 * fixtures at compile time, and the tests that use them describe a server that
 * exists.
 *
 * Only the fields a test actually varies are parameters; everything else is a
 * plausible default, because a fixture that makes you fill in `object: 'model'`
 * teaches nothing and gets copy-pasted wrong.
 */

import { listEnvelope } from '../../transaction/wire/index.js';
import type {
  ModelReadResponse,
  ModelListResponse,
  ClaimAcquiredResponse,
  ClaimQueuedResponse,
  ClaimListResponse,
  ClaimHeartbeatReply,
} from '../../transaction/wire/index.js';
import type { ModelClaim } from '../../transaction/coordination/index.js';

/** `GET /v1/models/{model}/{id}`. Pass `data: null` for a miss. */
export function modelReadResponse(args: {
  model: string;
  id: string;
  data: unknown;
  stamp?: number;
  claims?: readonly ModelClaim[];
}): ModelReadResponse {
  return {
    object: 'model',
    model: args.model,
    id: args.id,
    data: args.data,
    stamp: args.stamp ?? 0,
    claims: args.claims ?? [],
  } satisfies ModelReadResponse;
}

/** `GET /v1/models/{model}`. */
export function modelListResponse(args: {
  model: string;
  data: readonly unknown[];
  hasMore?: boolean;
  nextCursor?: string | null;
  stamp?: number;
}): ModelListResponse {
  return {
    object: 'list',
    model: args.model,
    data: [...args.data],
    has_more: args.hasMore ?? false,
    next_cursor: args.nextCursor ?? null,
    stamp: args.stamp ?? 0,
  } satisfies ModelListResponse;
}

/** One claim in the shape the HTTP claim routes return it. */
export function modelClaim(args: {
  id: string;
  model: string;
  entityId: string;
  actor?: string;
  participantKind?: ModelClaim['participantKind'];
  description?: string;
  status?: 'active' | 'queued';
  position?: number;
  expiresAt?: number;
  fenceToken?: number;
  field?: string;
}): ModelClaim {
  return {
    id: args.id,
    actor: args.actor ?? 'user_fixture',
    participantKind: args.participantKind ?? 'user',
    description: args.description ?? 'editing',
    ...(args.field !== undefined ? { field: args.field } : {}),
    ...(args.status !== undefined ? { status: args.status } : {}),
    ...(args.position !== undefined ? { position: args.position } : {}),
    expiresAt: args.expiresAt ?? Date.now() + 60_000,
    ...(args.fenceToken !== undefined ? { fenceToken: args.fenceToken } : {}),
    target: { model: args.model, id: args.entityId },
  } satisfies ModelClaim;
}

/** `POST /v1/models/{model}/{id}/claim` — 201, the lease is yours. */
export function claimAcquiredResponse(claim: ModelClaim): ClaimAcquiredResponse {
  return {
    id: claim.id,
    object: 'claim',
    status: 'active',
    ...(claim.fenceToken !== undefined ? { fenceToken: claim.fenceToken } : {}),
    expiresAt: claim.expiresAt,
    claim,
  } satisfies ClaimAcquiredResponse;
}

/** `POST /v1/models/{model}/{id}/claim` — 202, you are in the wait line. */
export function claimQueuedResponse(args: {
  id: string;
  position: number;
  heldBy?: string;
  expiresAt?: number;
}): ClaimQueuedResponse {
  return {
    id: args.id,
    object: 'claim',
    status: 'queued',
    position: args.position,
    ...(args.heldBy !== undefined ? { heldBy: args.heldBy } : {}),
    ...(args.expiresAt !== undefined ? { expiresAt: args.expiresAt } : {}),
  } satisfies ClaimQueuedResponse;
}

/**
 * `GET /v1/claims` — holders and waiters in one list, each carrying its
 * `status`, which is how a reader tells them apart.
 */
export function claimListResponse(
  args: { claims?: readonly ModelClaim[]; queue?: readonly ModelClaim[] } = {},
): ClaimListResponse {
  return listEnvelope([
    ...(args.claims ?? []),
    ...(args.queue ?? []).map((claim) => ({ ...claim, status: 'queued' as const })),
  ]) satisfies ClaimListResponse;
}

/** `POST /v1/models/{model}/{id}/claim/heartbeat`. */
export function claimHeartbeatReply(args: {
  claimId: string;
  status?: 'held' | 'queued';
  expiresAt?: number;
  queueDepth?: number;
  position?: number;
}): ClaimHeartbeatReply {
  const status = args.status ?? 'held';
  return {
    object: 'claim_heartbeat',
    claimId: args.claimId,
    status,
    ...(status === 'held'
      ? {
          expiresAt: args.expiresAt ?? Date.now() + 60_000,
          ...(args.queueDepth !== undefined ? { queueDepth: args.queueDepth } : {}),
        }
      : { position: args.position ?? 0 }),
  } satisfies ClaimHeartbeatReply;
}
