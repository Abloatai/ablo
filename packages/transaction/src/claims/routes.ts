/**
 * Where the claim routes live, named once.
 *
 * A path is a contract between two programs, and it was being stated twice: the
 * server registered `/v1/models/:model/:id/claim` and every client wrote the
 * same string out again with its parameters interpolated. Nothing held the two
 * spellings together, so a rename would have compiled on both sides and failed
 * at the first request — the one class of drift that survives a green build.
 *
 * The two ends need the path differently. A router wants the `:param` pattern;
 * a caller wants the filled URL. Both come from the same literal here: the
 * pattern is the definition, and every builder below is a substitution into it,
 * so a path can be corrected in exactly one place.
 *
 * Percent-encoding belongs here too. A model or row id is caller-supplied, and
 * an id containing `/` silently addressed a different route when each call site
 * remembered to encode on its own.
 */

/**
 * Claim route patterns, in the `:param` spelling a router registers.
 *
 * `as const` is load-bearing: it keeps each value a literal type, which is what
 * lets a typed router infer a route's parameter names from the pattern it is
 * handed. Widening these to `string` would compile and quietly cost the server
 * its `c.req.param()` typing.
 */
export const CLAIM_ROUTES = {
  /** List claims, and take one. */
  collection: '/v1/claims',
  /** Beat every lease this caller holds, in one call. */
  collectionHeartbeat: '/v1/claims/heartbeat',
  /** Poll one claim, or release it. */
  byId: '/v1/claims/:claimId',
  /** Beat one named lease. */
  byIdHeartbeat: '/v1/claims/:claimId/heartbeat',
  /** The model-scoped surface, mirroring `ablo.<model>.claim({ id })`. */
  onModel: '/v1/models/:model/:id/claim',
  onModelHeartbeat: '/v1/models/:model/:id/claim/heartbeat',
  onModelReorder: '/v1/models/:model/:id/claim/reorder',
  /** The pre-`/v1` spelling, still mounted for clients that predate it. */
  legacyCollection: '/sync/claims',
  legacyById: '/sync/claims/:claimId',
} as const;

/** The row a model-scoped claim route addresses. */
export interface ClaimRouteTarget {
  readonly model: string;
  readonly id: string;
}

function forTarget(pattern: string, target: ClaimRouteTarget): string {
  return pattern
    .replace(':model', encodeURIComponent(target.model))
    .replace(':id', encodeURIComponent(target.id));
}

/** `POST` to take the lease on a row, `DELETE` to give it back. */
export function claimOnModelPath(target: ClaimRouteTarget): string {
  return forTarget(CLAIM_ROUTES.onModel, target);
}

/** `POST` to say the holder is still working. */
export function claimHeartbeatOnModelPath(target: ClaimRouteTarget): string {
  return forTarget(CLAIM_ROUTES.onModelHeartbeat, target);
}

/** `POST` to move a waiter within the line. */
export function claimReorderOnModelPath(target: ClaimRouteTarget): string {
  return forTarget(CLAIM_ROUTES.onModelReorder, target);
}

/** `GET` to poll one claim's state, `DELETE` to release it by its own id. */
export function claimByIdPath(claimId: string): string {
  return CLAIM_ROUTES.byId.replace(':claimId', encodeURIComponent(claimId));
}

/** `POST` to beat one named lease. */
export function claimHeartbeatByIdPath(claimId: string): string {
  return CLAIM_ROUTES.byIdHeartbeat.replace(':claimId', encodeURIComponent(claimId));
}
