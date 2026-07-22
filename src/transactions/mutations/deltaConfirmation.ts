/**
 * Tracks whether the confirming delta for a write has arrived. It holds the
 * acknowledgement watermark (through the shared {@link LogPosition}), the
 * per-transaction confirmation timeouts, and the retry-with-backoff and
 * reconciliation policy for transactions in the `awaiting_delta` status. It
 * reaches back to {@link MutationQueue} only through the small
 * {@link DeltaConfirmationContext} interface, not the queue class itself, so it
 * has no cyclic dependency and can be tested on its own.
 */

import { getContext } from '../../context.js';
import type { LogPosition } from '../../transaction/logPosition.js';
import type { QueuedMutation } from './commitPayload.js';

/**
 * The subset of {@link MutationQueue} that the confirmation tracker needs:
 * store lookups and status changes, removing optimistic entries once a write
 * confirms, the queue's event emitter (`transaction:completed`,
 * `reconciliation:needed`, and so on), a connection check (so timeouts
 * re-schedule instead of escalating while offline), and the shared client
 * position (`noteAck` advances the acknowledgement cursor; diagnostics read the
 * applied cursor).
 */
export interface DeltaConfirmationContext {
  store: {
    get(id: string): QueuedMutation | undefined;
    getByStatus(status: QueuedMutation['status']): QueuedMutation[];
    updateStatus(id: string, status: QueuedMutation['status']): void;
  };
  optimisticUpdates: { delete(id: string): boolean };
  emit(event: string, payload?: unknown): void;
  isConnected(): boolean;
  position: LogPosition;
}

export class DeltaConfirmationTracker {
  // Retry configuration for delta confirmation, using exponential backoff.
  // Maximum retries before requesting a full reconciliation.
  private static readonly DELTA_MAX_RETRIES = 5;
  // Upper bound on the backoff timeout.
  private static readonly DELTA_MAX_TIMEOUT_MS = 120_000;

  // Pending confirmation timeouts for transactions awaiting their delta. On
  // timeout the tracker retries with backoff rather than rolling back.
  private deltaConfirmationTimeouts = new Map<string, ReturnType<typeof setTimeout>>();

  // Track retry attempts per transaction for exponential backoff
  private deltaConfirmationRetries = new Map<string, number>();

  constructor(private readonly ctx: DeltaConfirmationContext) {}

  /** Applied-cursor alias, kept so the read sites below stay legible. */
  private get lastSeenSyncId(): number {
    return this.ctx.position.applied;
  }

  private matchesSourceEcho(
    tx: QueuedMutation,
    correlationId: string | undefined,
  ): boolean {
    return (
      correlationId !== undefined &&
      tx.correlationId !== undefined &&
      correlationId === tx.correlationId
    );
  }

  noteAck(lastSyncId: number | undefined): void {
    this.ctx.position.noteAck(lastSyncId);
  }

  /**
   * Confirms every awaiting transaction whose sync-id threshold this delta
   * meets or exceeds.
   * @param syncId - The sync id of the received delta.
   */
  onDeltaReceived(syncId: number, correlationId?: string): void {
    // The cursor advances where the delta is applied (the store calls
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
          requiresCorrelatedDelta: tx.requiresCorrelatedDelta === true,
          willConfirm:
            tx.requiresCorrelatedDelta === true
              ? this.matchesSourceEcho(tx, correlationId)
              : tx.syncIdNeededForCompletion !== undefined &&
                syncId >= tx.syncIdNeededForCompletion,
        })),
      });
    }

    // Fast path: no awaiting transactions
    if (awaitingTxs.length === 0) return;

    let confirmedCount = 0;

    for (const tx of awaitingTxs) {
      // Queued forward receipts deliberately have no watermark. They confirm
      // only when the authoritative source echoes the receipt's opaque,
      // authenticated-scope batch identity; the legacy anomaly path continues
      // to use its sync-id threshold.
      const confirmedByCorrelation =
        tx.requiresCorrelatedDelta === true &&
        this.matchesSourceEcho(tx, correlationId);
      const confirmedByThreshold =
        tx.requiresCorrelatedDelta !== true &&
        tx.syncIdNeededForCompletion !== undefined &&
        syncId >= tx.syncIdNeededForCompletion;
      if (confirmedByCorrelation || confirmedByThreshold) {
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
          confirmation: confirmedByCorrelation ? 'source_correlation' : 'sync_id',
        });
      }
    }

    // Log batch summary only if we confirmed something
    if (confirmedCount > 0) {
      // Leave a breadcrumb when transactions confirm.
      getContext().observability.breadcrumb('Transactions confirmed via delta', 'sync.transaction', 'info', {
        count: confirmedCount,
        syncId,
        remainingAwaiting: awaitingTxs.length - confirmedCount,
      });
    }
  }

  // Schedule the confirmation wait for a transaction. On timeout the tracker
  // retries with exponential backoff and requests reconciliation to catch up on
  // missed deltas, rather than rolling back, which would discard state the
  // server has already confirmed. A rollback happens only on an explicit server
  // rejection, never on a timeout.
  scheduleDeltaConfirmationTimeout(tx: QueuedMutation, timeoutMs: number): void {
    // Cancel any existing timeout for this transaction
    this.cancelDeltaConfirmationTimeout(tx.id);

    // Deliberately not an async callback: the body is fully synchronous, and
    // `setTimeout(async …)` would turn any throw into an unhandled promise
    // rejection instead of a catchable synchronous error.
    const timeoutHandle = setTimeout(() => {
      const currentTx = this.ctx.store.get(tx.id);
      if (currentTx?.status !== 'awaiting_delta') {
        this.deltaConfirmationRetries.delete(tx.id);
        return; // Already confirmed or failed
      }

      // If disconnected, re-schedule with same timeout (no backoff while offline)
      if (!this.ctx.isConnected()) {
        // Self-healing: re-schedule the confirmation wait while offline, no
        // consumer action needed → debug.
        getContext().logger.debug('[MutationQueue] Timeout fired while disconnected - re-scheduling', {
          txId: tx.id.slice(0, 8),
          model: tx.modelName,
        });
        this.deltaConfirmationTimeouts.delete(tx.id);
        this.scheduleDeltaConfirmationTimeout(tx, timeoutMs);
        return;
      }

      const retryCount = this.deltaConfirmationRetries.get(tx.id) ?? 0;

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
        // Retry: request reconciliation and re-schedule with exponential
        // backoff. The server has already committed the mutation; only the
        // delta is outstanding.
        this.deltaConfirmationRetries.set(tx.id, retryCount + 1);
        this.deltaConfirmationTimeouts.delete(tx.id);

        // Exponential backoff: 30s → 60s → 120s → 120s → 120s (capped)
        const nextTimeout = Math.min(timeoutMs * 2, DeltaConfirmationTracker.DELTA_MAX_TIMEOUT_MS);

        // Request reconciliation so the client can cycle the connection and
        // catch up on missed deltas from the server.
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
        getContext().logger.debug('[MutationQueue] Re-scheduling with backoff', {
          txId: tx.id.slice(0, 8),
          model: tx.modelName,
          nextTimeoutMs: nextTimeout,
          retry: retryCount + 1,
        });

        this.scheduleDeltaConfirmationTimeout(tx, nextTimeout);
      } else {
        // Retries exhausted: persist the awaiting state instead of rolling back.
        // The commit succeeded on the server, so the data exists there. Saving
        // the awaiting state lets it survive the page closing; on the next
        // session, reconnecting and catching up on deltas will confirm it.
        this.deltaConfirmationRetries.delete(tx.id);
        this.deltaConfirmationTimeouts.delete(tx.id);

        getContext().observability.captureDeltaRetryExhausted({
          txId: tx.id,
          model: tx.modelName,
          modelId: tx.modelId,
          retryCount: DeltaConfirmationTracker.DELTA_MAX_RETRIES,
          syncIdNeeded: currentTx.syncIdNeededForCompletion,
        });

        // Emit the persist event; the client performs the write to local storage.
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
   * Clears every armed confirmation timer, one per in-flight transaction.
   * {@link MutationQueue.dispose} calls this; without it a disposed queue
   * would keep the process alive and fire callbacks against a cleared store.
   */
  dispose(): void {
    for (const timeoutHandle of this.deltaConfirmationTimeouts.values()) {
      clearTimeout(timeoutHandle);
    }
    this.deltaConfirmationTimeouts.clear();
    this.deltaConfirmationRetries.clear();
  }
}
