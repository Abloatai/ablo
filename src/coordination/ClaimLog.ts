/**
 * Sync-engine compatibility adapter for the transaction layer's narrow claim
 * log. The core log knows only claim/conflict events; this subclass supplies
 * inert implementations for the client lifecycle hooks required by
 * `ObservabilityProvider`, preserving `Ablo({ observability: new ClaimLog() })`
 * without leaking bootstrap, storage, or WebSocket vocabulary into the core.
 */

import { ClaimLog as CoordinationClaimLog } from '../transaction/coordination/trace.js';
import type { ObservabilityProvider } from '../interfaces/index.js';

export { formatClaim, formatConflict } from '../transaction/coordination/trace.js';
export type { ClaimLogEntry } from '../transaction/coordination/trace.js';

export class ClaimLog extends CoordinationClaimLog implements ObservabilityProvider {
  // Client-lifecycle hooks the claim log has no notion of. Every body below is
  // deliberately inert: the log records claims and conflicts, nothing else.
  setContext(): void { /* inert */ }
  setConnectionState(): void { /* inert */ }
  breadcrumb(): void { /* inert */ }
  captureRollback(): void { /* inert */ }
  captureMutationFailure(): void { /* inert */ }
  captureBootstrapFailure(): void { /* inert */ }
  captureReconciliation(): void { /* inert */ }
  captureDeltaRetryExhausted(): void { /* inert */ }
  captureWebSocketError(): void { /* inert */ }
  captureSelfHealing(): void { /* inert */ }
  captureCommitZeroSyncId(): void { /* inert */ }

  // Spans run their body untimed; the trailing `attributes` argument callers
  // pass has nowhere to go here, so it is left off the signature.
  startSpan<T>(_name: string, _op: string, fn: () => T): T {
    return fn();
  }

  startSpanAsync<T>(_name: string, _op: string, fn: () => Promise<T>): Promise<T> {
    return fn();
  }
}
