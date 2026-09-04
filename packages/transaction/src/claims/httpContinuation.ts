/**
 * Marks a model mutation as continuation of an already-admitted fenced claim.
 *
 * Admission uses this transport hint only to preserve the lifecycle under
 * pressure. The model route remains responsible for authoritatively checking
 * the claim id and fence token before applying the write.
 */
export const CLAIM_CONTINUATION_HEADER = 'Ablo-Claim-Continuation';
