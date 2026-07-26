/**
 * The Ablo settlement core (ADR 0013).
 *
 * The transaction layer that the reactive client is a consumer of, not the
 * other way round. The root barrel is deliberate: it exports the seam —
 * {@link TransactionLayer} — plus exactly the vocabulary its signatures
 * reference and the error hierarchy callers catch. Everything else stays on
 * subpaths; every addition here is a decision
 * (docs/plans/transaction-layer-barrel-design.md).
 */

// The seam.
export type {
  TransactionLayer,
  ListQuery,
  CommitReceipt,
  ObserveOptions,
  ObserveCursorStore,
  ObservedDelta,
} from './transactionLayer.js';
export { createTransactionClient } from './headlessClient.js';
export type {
  TransactionClient,
  TransactionClientOptions,
} from './headlessClient.js';

// The client entry point (ADR 0016). The bare import constructs the
// coordination layer over request/response transport; the reactive
// materialiser is the consumer package's entry point, layered above it.
export { Ablo } from './ablo.js';
export type {
  AbloHttpClient,
  AbloHttpClientOptions,
  HttpModelClient,
} from './transport/httpClient.js';

// The types the seam's signatures reference.
export type {
  Delta,
  HeldClaim,
  HeldLease,
  ClaimTarget,
  ClaimLeaseOptions,
} from './types/streams.js';
export type { ModelData } from './types/modelData.js';

// The error hierarchy and its wire/recovery helpers.
export * from './errors.js';

// Pre-seam leaf surfaces, kept for compatibility with the first extraction.
export * from './errorCodes.js';
export * from './environment.js';
export * from './branches.js';
