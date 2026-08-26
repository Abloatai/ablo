/**
 * Package-private ReadSet integration seam used by the reactive materialiser.
 * Application code declares dependencies through `reads: [returnedRow]`.
 */
export {
  capturePointRead,
  createReadSetContext,
  evidenceForRow,
  kReadEvidence,
  prepareReadSet,
  publishCommitRecord,
  readEvidenceBinding,
} from '../commit/readSetContext.js';
export { recordWebSocketCommitReceipt } from '../commit/recordRuntime.js';
export type {
  CapturedReadEvidence,
  PreparedReadSet,
  ReadEvidenceBinding,
  ReadSetContext,
} from '../commit/readSetContext.js';
