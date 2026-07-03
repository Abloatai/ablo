/**
 * Delta-confirmation tracking — the queue's "did my write's echo arrive?"
 * machinery, lifted out of `TransactionQueue.ts` as a stateful leaf.
 *
 * Owns the ack watermark (via the shared `SyncPosition`), the per-transaction
 * confirmation timeout map, and the retry-with-backoff/reconciliation policy
 * for `awaiting_delta` transactions. Talks back to the queue through the
 * minimal `DeltaConfirmationContext` interface (never the host class type),
 * so the leaf stays cycle-free and testable in isolation.
 */

import { getContext } from '../context.js';
import type { SyncPosition } from '../sync/syncPosition.js';
import type { Transaction } from './commitPayload.js';

/**
 * The slice of the queue a confirmation tracker needs: store lookups +
 * status flips, dropping optimistic entries on confirm, the host's event
 * surface (`transaction:completed`, `reconciliation:needed`, …), the
 * connection check (timeouts re-schedule instead of escalating while
 * offline), and the shared client position (`noteAck` advances `acked`;
 * diagnostics read `applied`).
 */
export interface DeltaConfirmationContext {
  store: {
    get(id: string): Transaction | undefined;
    getByStatus(status: Transaction['status']): Transaction[];
    updateStatus(id: string, status: Transaction['status']): void;
  };
  optimisticUpdates: { delete(id: string): boolean };
  emit(event: string, payload?: unknown): void;
  isConnected(): boolean;
  position: SyncPosition;
}

export class DeltaConfirmationTracker {
  // Delta confirmation retry config (Replicache-style exponential backoff)
  // Max retries before requesting full reconciliation
  private static readonly DELTA_MAX_RETRIES = 5;
  // Initial timeout (first attempt)
  private static readonly DELTA_INITIAL_TIMEOUT_MS = 30_000;
  // Max timeout cap (like Replicache's maxDelayMs of 60s)
  private static readonly DELTA_MAX_TIMEOUT_MS = 120_000;

  // LINEAR PATTERN: Track delta confirmation timeouts for awaiting_delta transactions
  // Following Replicache/PowerSync pattern: retry with backoff instead of rolling back
  private deltaConfirmationTimeouts = new Map<string, ReturnType<typeof setTimeout>>();

  // Track retry attempts per transaction for exponential backoff
  private deltaConfirmationRetries = new Map<string, number>();

  constructor(private readonly ctx: DeltaConfirmationContext) {}

  /** Applied-cursor alias, kept so the read sites below stay legible. */
  private get lastSeenSyncId(): number {
    return this.ctx.position.applied;
  }

  noteAck(lastSyncId: number | undefined): void {
    this.ctx.position.noteAck(lastSyncId);
  }

  /**
   * LINEAR PATTERN: Confirm all awaiting transactions when delta with syncId >= threshold arrives.
   * This replaces clientMutationId echoing - transactions are confirmed by sync ID threshold.
   * @param syncId - The sync ID of the received delta
   */
  onDeltaReceived(syncId: number): void {
    // Cursor advancing happens where the delta is APPLIED (the store calls
    // position.advanceApplied / advancePersisted); this hook only resolves
    // confirmation thresholds against the incoming id.

    const awaitingTxs = this.ctx.store.getByStatus('awaiting_delta');
    const executingTxs = this.ctx.store.getByStatus('executing');

    // Debug: Show state when delta arrives
    if (awaitingTxs.length > 0 || executingTxs.length > 0) {
      getContext().logger.debug('tx:delta_received', {
        syncId,
        lastSeenSyncId: this.lastSeenSyncId,
        awaitingCount: awaitingTxs.length,
        executingCount: executingTxs.length,
        awaitingThresholds: awaitingTxs.map((tx) => ({
          txId: tx.id.slice(0, 8),
          model: tx.modelName,
          needed: tx.syncIdNeededForCompletion,
          willConfirm:
            tx.syncIdNeededForCompletion !== undefined && syncId >= tx.syncIdNeededForCompletion,
        })),
      });
    }

    // Fast path: no awaiting transactions
    if (awaitingTxs.length === 0) return;

    let confirmedCount = 0;

    for (const tx of awaitingTxs) {
      // Confirm if this delta's ID meets or exceeds the threshold
      if (tx.syncIdNeededForCompletion !== undefined && syncId >= tx.syncIdNeededForCompletion) {
        this.cancelDeltaConfirmationTimeout(tx.id);
        this.ctx.store.updateStatus(tx.id, 'completed');
        this.ctx.emit('transaction:completed', tx);
        this.ctx.emit(`transaction:completed:${tx.id}`, tx);
        this.ctx.optimisticUpdates.delete(tx.id);
        confirmedCount++;

        getContext().logger.debug('tx:confirm_via_delta', {
          txId: tx.id.slice(0, 8),
          model: tx.modelName,
          neededSyncId: tx.syncIdNeededForCompletion,
          receivedSyncId: syncId,
        });
      }
    }

    // Log batch summary only if we confirmed something
    if (confirmedCount > 0) {
      // Use warn for staging visibility when transactions confirm
      getContext().observability.breadcrumb('Transactions confirmed via delta', 'sync.transaction', 'info', {
        count: confirmedCount,
        syncId,
        remainingAwaiting: awaitingTxs.length - confirmedCount,
      });
    }
  }

  // REPLICACHE/POWERSYNC PATTERN: Schedule delta confirmation with retry + reconciliation
  // Instead of rolling back on timeout (which destroys confirmed server state),
  // retry with exponential backoff and request reconciliation to catch up on missed deltas.
  // Only rollback on explicit server rejection, never on timeout.
  scheduleDeltaConfirmationTimeout(tx: Transaction, timeoutMs: number): void {
    // Cancel any existing timeout for this transaction
    this.cancelDeltaConfirmationTimeout(tx.id);

    // NB: deliberately NOT an async callback — the body is fully synchronous,
    // and `setTimeout(async …)` turns any throw into an unhandled promise
    // rejection instead of a catchable synchronous error.
    const timeoutHandle = setTimeout(() => {
      const currentTx = this.ctx.store.get(tx.id);
      if (!currentTx || currentTx.status !== 'awaiting_delta') {
        this.deltaConfirmationRetries.delete(tx.id);
        return; // Already confirmed or failed
      }

      // If disconnected, re-schedule with same timeout (no backoff while offline)
      if (!this.ctx.isConnected()) {
        // Self-healing: re-schedule the confirmation wait while offline, no
        // consumer action needed → debug.
        getContext().logger.debug('[TransactionQueue] Timeout fired while disconnected - re-scheduling', {
          txId: tx.id.slice(0, 8),
          model: tx.modelName,
        });
        this.deltaConfirmationTimeouts.delete(tx.id);
        this.scheduleDeltaConfirmationTimeout(tx, timeoutMs);
        return;
      }

      const retryCount = this.deltaConfirmationRetries.get(tx.id) ?? 0;
      const diagnosis =
        this.lastSeenSyncId === 0
          ? 'No deltas received - delta pipeline may be broken'
          : currentTx.syncIdNeededForCompletion &&
              this.lastSeenSyncId < currentTx.syncIdNeededForCompletion
            ? 'Delta not yet received - may be lost or delayed'
            : 'Delta should have confirmed - possible race condition';

      getContext().observability.captureReconciliation({
        reason: 'delta_timeout',
        model: tx.modelName,
        modelId: tx.modelId,
        syncIdNeeded: currentTx.syncIdNeededForCompletion,
        lastSeenSyncId: this.lastSeenSyncId,
        retryCount,
        connectionState: this.ctx.isConnected() ? 'connected' : 'disconnected',
      });

      if (retryCount < DeltaConfirmationTracker.DELTA_MAX_RETRIES) {
        // RETRY: Request reconciliation and re-schedule with exponential backoff
        // The server already committed this mutation — we just need the delta to arrive
        this.deltaConfirmationRetries.set(tx.id, retryCount + 1);
        this.deltaConfirmationTimeouts.delete(tx.id);

        // Exponential backoff: 30s → 60s → 120s → 120s → 120s (capped)
        const nextTimeout = Math.min(timeoutMs * 2, DeltaConfirmationTracker.DELTA_MAX_TIMEOUT_MS);

        // Emit reconciliation request so SyncedStore can cycle the WebSocket
        // to trigger delta catch-up from the server
        this.ctx.emit('reconciliation:needed', {
          reason: 'delta_confirmation_timeout',
          txId: tx.id,
          model: tx.modelName,
          modelId: tx.modelId,
          syncIdNeeded: currentTx.syncIdNeededForCompletion,
          lastSeenSyncId: this.lastSeenSyncId,
          retryCount: retryCount + 1,
        });

        // Self-healing retry with backoff — the server already committed; we're
        // just waiting on the delta. No consumer action → debug.
        getContext().logger.debug('[TransactionQueue] Re-scheduling with backoff', {
          txId: tx.id.slice(0, 8),
          model: tx.modelName,
          nextTimeoutMs: nextTimeout,
          retry: retryCount + 1,
        });

        this.scheduleDeltaConfirmationTimeout(tx, nextTimeout);
      } else {
        // LINEAR PATTERN: Retries exhausted — persist to IndexedDB instead of rolling back.
        // The transaction succeeded on the server (HTTP 200), so the data exists server-side.
        // Persist the awaiting state so it survives tab close. On next session, the WebSocket
        // reconnect + delta catch-up will naturally confirm it (like Linear's IndexedDB caching).
        this.deltaConfirmationRetries.delete(tx.id);
        this.deltaConfirmationTimeouts.delete(tx.id);

        getContext().observability.captureDeltaRetryExhausted({
          txId: tx.id,
          model: tx.modelName,
          modelId: tx.modelId,
          retryCount: DeltaConfirmationTracker.DELTA_MAX_RETRIES,
          syncIdNeeded: currentTx.syncIdNeededForCompletion,
        });

        // Emit persist event — SyncClient handles the IDB write
        this.ctx.emit('transaction:persist_awaiting', {
          txId: tx.id,
          model: tx.modelName,
          modelId: tx.modelId,
          operationType: tx.type,
          syncIdNeeded: currentTx.syncIdNeededForCompletion,
        });

        // Also request one final reconciliation cycle
        this.ctx.emit('reconciliation:needed', {
          reason: 'delta_retries_exhausted',
          txId: tx.id,
          model: tx.modelName,
          modelId: tx.modelId,
          syncIdNeeded: currentTx.syncIdNeededForCompletion,
          lastSeenSyncId: this.lastSeenSyncId,
          retryCount: DeltaConfirmationTracker.DELTA_MAX_RETRIES,
        });
      }
    }, timeoutMs);

    this.deltaConfirmationTimeouts.set(tx.id, timeoutHandle);
  }

  // Cancel a pending delta confirmation timeout and clean up retry tracking
  private cancelDeltaConfirmationTimeout(id: string): void {
    const timeoutHandle = this.deltaConfirmationTimeouts.get(id);
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
      this.deltaConfirmationTimeouts.delete(id);
    }
    this.deltaConfirmationRetries.delete(id);
  }

  /**
   * Tear down every armed confirmation timer (30–120s each, one per
   * in-flight transaction). Called from `TransactionQueue.dispose()` —
   * without it a disposed queue kept the Node process alive and fired
   * callbacks against an already-cleared store (T1.19).
   */
  dispose(): void {
    for (const timeoutHandle of this.deltaConfirmationTimeouts.values()) {
      clearTimeout(timeoutHandle);
    }
    this.deltaConfirmationTimeouts.clear();
    this.deltaConfirmationRetries.clear();
  }
}
