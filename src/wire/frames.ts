/**
 * The write-path message shapes for the sync protocol. These cover the frames
 * a client sends to commit work — {@link CommitMessage} (a batch of raw
 * operations) and {@link MutationMessage} (a single named mutation) — and the
 * server's {@link MutationResultMessage} acknowledgement. The same frames flow
 * over a WebSocket connection and over the HTTP commit endpoint.
 *
 * Both the client and the server import these definitions from here, so the two
 * sides cannot drift. Each interface is paired with a Zod validator
 * ({@link commitOperationSchema}, {@link commitPayloadSchema}) pinned to it at
 * compile time, so the runtime check and the type stay in lockstep. Changing
 * any shape in this file changes the wire contract and requires the client and
 * server to update together.
 */
import { z } from 'zod';
// The runtime schema primitives are imported straight from the coordination
// schema module to keep this file's runtime dependencies limited to Zod.
import {
  commitOperationSchema as coordinationCommitOperationSchema,
  readDependencySchema,
} from '../coordination/schema.js';
import type { OnStaleMode, StaleNotification, ReadDependency } from '../coordination/index.js';
import type { ErrorCode, RequiredCapability } from '../errors.js';

/** Asserts two types are exactly equal in both directions. Used to pin each
 *  Zod schema to its interface: the assignment fails to compile the moment
 *  either side drifts from the other. */
type _AssertExact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;

// ── Client → Server ────────────────────────────────────────────────────────

/**
 * A single operation within a {@link CommitMessage} batch. Each operation is
 * the smallest unit the server applies atomically — one create, update,
 * delete, archive, or unarchive against one model row.
 */
export interface CommitOperation {
  type: 'CREATE' | 'UPDATE' | 'DELETE' | 'ARCHIVE' | 'UNARCHIVE';
  model: string;
  id?: string | null;
  input?: Record<string, unknown> | null;
  /**
   * A client-generated transaction id for this one operation. The server
   * stamps it onto the `sync_deltas.transaction_id` column so the originating
   * client can recognize the resulting broadcast as an echo of its own
   * optimistic write. This is distinct from the batch-level `clientTxId` on
   * {@link CommitMessage}, which the server uses to deduplicate retried batches.
   */
  transactionId?: string | null;
  /**
   * A read watermark captured when the client last read this row. The server
   * checks whether the target has changed since this point; if it has, the
   * operation's {@link CommitOperation.onStale} mode decides what happens.
   */
  readAt?: number | null;
  /**
   * What to do when the server detects the row changed since
   * {@link CommitOperation.readAt}. `'reject'` (the default) fails the
   * operation with a stale-context error; `'overwrite'` applies the write
   * regardless; `'notify'` holds the write and returns a
   * {@link StaleNotification} for the caller to resolve.
   */
  onStale?: OnStaleMode | null;
  /**
   * Write even when another participant holds a claim on this row. The default
   * (`false`) rejects the operation with a claimed-entity error while a claim
   * is held. Setting `bypass` overrides that, and the override is recorded. It
   * is honored only for participants the claim guard trusts, such as human and
   * framework identities; a bypass requested by an agent is ignored.
   */
  bypass?: boolean | null;
}

/**
 * Runtime validator for {@link CommitOperation}. Both commit transports — the
 * WebSocket `commit` frame and the HTTP `/v1/commits` endpoint — run this check
 * on every operation before it is applied, so a malformed operation is rejected
 * at the edge. It builds on the shared coordination schema, widening `bypass`
 * to also accept `null` so the validator and the interface match exactly. Note
 * that `readAt` must be a number: it feeds the server's stale-check comparison,
 * so a non-numeric watermark is refused here.
 */
export const commitOperationSchema = coordinationCommitOperationSchema.extend({
  bypass: z.boolean().nullish(),
});
// Pins the schema to the interface: this fails to compile if either side drifts.
const _commitOperationContract: _AssertExact<
  z.infer<typeof commitOperationSchema>,
  CommitOperation
> = true;
void _commitOperationContract;

/**
 * A client-to-server frame that invokes a single named mutation by name and
 * arguments, as opposed to the raw operation batch in {@link CommitMessage}.
 * The server resolves `mutatorName` against the set of mutations registered on
 * it and runs the matching one.
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
 * A client-to-server frame that asks the server to commit a batch of operations
 * atomically. This is the raw-operation counterpart to {@link MutationMessage};
 * it carries a list of {@link CommitOperation} entries plus the batch metadata
 * below.
 */
export interface CommitMessage {
  type: 'commit';
  payload: {
    operations: CommitOperation[];
    clientTxId: string;
    /**
     * Optional lineage id linking this batch to the task that caused it. When
     * present, the server validates it and records it on the delta's
     * `caused_by_task_id` column for audit trails; when omitted or `null`, the
     * batch simply carries no task attribution.
     */
    causedByTaskId?: string | null;
    /**
     * The reads this batch's writes were premised on. Each entry names either a
     * specific row (`{ model, id, readAt, fields? }`) or a sync group
     * (`{ group, readAt }`) that must not have changed since its `readAt`
     * watermark. The server checks every entry and applies its `onStale`
     * disposition to the whole batch if one moved. When omitted, only the rows
     * being written are checked for staleness.
     */
    reads?: ReadDependency[] | null;
  };
}

/**
 * Runtime validator for the payload of {@link CommitMessage}. It checks every
 * field the server acts on — `operations`, `clientTxId`, `causedByTaskId`, and
 * `reads` — validating each operation with {@link commitOperationSchema} and
 * each read dependency with the shared read-dependency schema.
 */
export const commitPayloadSchema = z.object({
  operations: z.array(commitOperationSchema),
  clientTxId: z.string(),
  causedByTaskId: z.string().nullish(),
  reads: z.array(readDependencySchema).nullish(),
});
// Pins the schema to the payload type: fails to compile if either side drifts.
const _commitPayloadContract: _AssertExact<
  z.infer<typeof commitPayloadSchema>,
  CommitMessage['payload']
> = true;
void _commitPayloadContract;

// ── Server → Client ──────────────────────────────────────────────────────

/**
 * The server's acknowledgement of a {@link CommitMessage}. Its payload mirrors
 * the commit-receipt shape, so a commit acknowledged over a WebSocket, over the
 * HTTP `/v1/commits` endpoint, or read back from a persisted job result all
 * carry the same fields.
 *
 * `object`, `status`, and `ops` are optional in the type but the server always
 * populates them, so a current client can rely on them being present.
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
     * Notifications for operations that used `onStale: 'notify'` and whose
     * premise changed while the batch was being applied. Present only on a
     * successful acknowledgement that resolved such a conflict; the client
     * surfaces each one through its `conflict:notified` event and the commit
     * receipt rather than failing the write.
     */
    notifications?: StaleNotification[];
    /**
     * Ids of update or delete targets that matched no rows — because they do
     * not exist or fall outside the caller's organization. Present and
     * non-empty only when a write missed. The client raises a not-found error
     * for the affected caller rather than treating the no-op as a success.
     */
    missingIds?: string[];
    error?: {
      code: ErrorCode;
      message: string;
      field?: string;
      /** The capability the commit required but the caller lacked. Present when
       *  the commit was denied for want of a capability, so the client can tell
       *  the caller exactly what to obtain. */
      requiredCapability?: RequiredCapability;
    };
  };
}
