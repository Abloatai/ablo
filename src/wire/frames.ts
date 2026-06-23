/**
 * `@abloatai/ablo/wire` — canonical COMMIT-PATH frame contract.
 *
 * These are the WebSocket (and HTTP-fallback) message shapes for the
 * write path: the client's `commit` / `mutation` frames and the server's
 * `mutation_result` ack. They live here — not in the server app and not
 * inlined in the SDK's `SyncWebSocket` — so the client, the server, and
 * any future `@abloatai/ablo/server` host all import ONE definition
 * and cannot drift.
 *
 * Scope note: the delta/sync frames (`sync_response`, `delta`) are NOT
 * here yet — they reference `SyncDelta`, which currently has two
 * definitions (server `db/deltas` vs package `core`) pending unification.
 * They stay server-local until that lands. Everything in this file
 * depends only on package-canonical types (`OnStaleMode`, `ErrorCode`,
 * `RequiredCapability`), so it is safe to share today.
 *
 * Changing any shape here is a wire-contract change — it requires
 * coordinated client + server updates.
 */
import type { OnStaleMode, StaleNotification, ReadDependency } from '../coordination/index.js';
import type { ErrorCode, RequiredCapability } from '../errors.js';

// ── Client → Server ────────────────────────────────────────────────────────

/**
 * A single operation within a {@link CommitMessage} batch. The atomic unit
 * the server's commit executor applies (and, once the mutator seam lands,
 * the raw-op fallback path when no named mutator is registered).
 */
export interface CommitOperation {
  type: 'CREATE' | 'UPDATE' | 'DELETE' | 'ARCHIVE' | 'UNARCHIVE';
  model: string;
  id?: string | null;
  input?: Record<string, unknown> | null;
  /**
   * Per-op client transaction id. Stamped onto `sync_deltas.transaction_id`
   * so the originating client can recognize the broadcast as an echo of its
   * own optimistic mutation. Distinct from the batch-level `clientTxId`
   * (which keys `mutation_log` for retry idempotency).
   */
  transactionId?: string | null;
  /**
   * Watermark from `context.capture`. The server checks whether the target
   * has received deltas since this id; if so the operation's `onStale` mode
   * applies.
   */
  readAt?: number | null;
  /**
   * Mode on stale detection (non-coercion). `'reject'` (default) throws
   * AbloStaleContextError; `'overwrite'` applies unconditionally (blind LWW);
   * `'notify'` holds the write and returns a `StaleNotification` for the actor
   * to resolve.
   */
  onStale?: OnStaleMode | null;
}

/**
 * Client → Server single named-mutation frame. The named-mutator write
 * primitive (claim + args), as opposed to the raw-op {@link CommitMessage}
 * batch. Server-side mutator dispatch resolves `mutatorName` against the
 * host-provided registry.
 */
export interface MutationMessage {
  type: 'mutation';
  payload: {
    mutatorName: string;
    input: unknown;
    clientTxId: string;
  };
}

/**
 * Client → Server "commit this batch of operations" frame. Formerly named
 * `batch_ack` / `BatchAckMessage` — renamed pre-stable to the customer-facing
 * verb (`commit`) consistently across the wire and the SDK method
 * (`MutationExecutor.commit`).
 */
export interface CommitMessage {
  type: 'commit';
  payload: {
    operations: CommitOperation[];
    clientTxId: string;
    /**
     * Dormant agent-task lineage field. The SDK no longer populates it —
     * turns/tasks were removed and write attribution now rides on the
     * claim (`claim`) id plus the server-stamped actor/capability. Kept
     * optional for wire-compat; when present the Hub still validates and
     * threads it onto `caused_by_task_id`, but client writes leave it
     * `null` (the audit pane treats null as "no prompt-side context").
     */
    causedByTaskId?: string | null;
    /**
     * Batch-level read dependencies (the STORM "did anything I looked at
     * change?" layer). Each entry is a row (`{model,id,readAt,fields?}`) or a
     * sync group (`{group,readAt}`) the batch's writes were premised on; the
     * server validates none moved since `readAt` and fires the entry's
     * `onStale` disposition over the batch. Omitted ⇒ only write-targets are
     * checked (legacy behavior).
     */
    reads?: ReadDependency[] | null;
  };
}

// ── Server → Client ──────────────────────────────────────────────────────

/**
 * Wire ack for a `commit` frame. Payload mirrors the canonical
 * `CommitReceipt` shape so WebSocket, HTTP `/v1/commits`, and persisted
 * `AgentJob.result.receipt` all carry identical fields.
 *
 * `object`, `status`, and `ops` are typed optional because pre-unification
 * WS clients didn't ship them; servers always populate them on the way out.
 * New clients can rely on them.
 */
export interface MutationResultMessage {
  type: 'mutation_result';
  payload: {
    object?: 'commit_receipt';
    clientTxId: string;
    serverTxId: string;
    success: boolean;
    status?: 'confirmed' | 'rejected';
    lastSyncId?: number;
    ops?: number;
    /**
     * Stale-context notifications for `onStale: 'notify' ops whose
     * premise moved concurrently. Present only on a successful ack that hit a
     * notify-resolved conflict; the client surfaces these via the
     * `conflict:notified` event and the commit receipt instead of rejecting.
     */
    notifications?: StaleNotification[];
    /**
     * Ids of UPDATE/DELETE targets that matched ZERO rows (don't exist or are
     * outside the org). Present (non-empty) only when a write missed. The
     * client turns this into a loud `AbloNotFoundError` for the affected
     * caller instead of treating the no-op as success.
     */
    missingIds?: string[];
    error?: {
      code: ErrorCode;
      message: string;
      field?: string;
      /** Structured rejection body (x402-style) emitted when the cap
       *  verifier denies the commit. */
      requiredCapability?: RequiredCapability;
    };
  };
}
