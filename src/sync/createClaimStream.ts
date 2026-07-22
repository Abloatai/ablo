/**
 * Moved to the settlement core (ADR 0016): claim push is coordination, and
 * coordination is the product — a contending agent wants `claim_granted`
 * pushed exactly as much as a person does. This path re-exports it so
 * existing importers stay unchanged.
 */

export {
  createClaimStream,
  type ClaimTransport,
  type ClaimStreamConfig,
  type AttachableClaimStream,
} from '../transaction/coordination/createClaimStream.js';
