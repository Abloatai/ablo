/**
 * Moved to the confirmation core with the duplex transport (ADR 0016): the
 * commit-path frame builders are stateless wire helpers. This path re-exports
 * them so existing importers stay unchanged. The core's `buildCommitFrame`
 * takes the structural `CommitFrameOperation` slice, which this package's
 * `MutationOperation` satisfies.
 */

export {
  buildCommitFrame,
  recordClaim,
  type CommitAck,
  type CommitFrameOperation,
  type ClaimTracePorts,
} from '@abloatai/transaction/transport/websocket';
