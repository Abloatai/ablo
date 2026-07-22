/**
 * Moved to the settlement core (ADR 0016): claim push is coordination, and
 * coordination is the product. This path re-exports it so existing importers
 * stay unchanged.
 */

export {
  awaitClaimGrant,
  type GrantTransport,
  type ClaimGrantInfo,
} from '../transaction/coordination/awaitClaimGrant.js';
