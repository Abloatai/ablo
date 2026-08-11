/**
 * Package-private ReadSet integration seam used by the reactive materialiser.
 * Application code declares dependencies through `reads: [returnedRow]`.
 */
export {
  abortReadSetCommit,
  capturePointRead,
  createReadSetContext,
  commitRecordIdentity,
  consumeReadSet,
  evidenceForRow,
  kReadEvidence,
  prepareReadSet,
  publishCommitRecord,
  readEvidenceBinding,
} from '../readSetContext.js';
export { recordWebSocketCommitReceipt } from '../commitRecordRuntime.js';
export type {
  CapturedReadEvidence,
  PreparedReadSet,
  ReadEvidenceBinding,
  ReadSetContext,
} from '../readSetContext.js';
