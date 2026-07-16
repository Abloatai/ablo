/**
 * The write-path message shapes for the sync protocol. These cover the frames
 * a client sends to commit work — {@link CommitMessage}, a batch of raw
 * operations — and the server's {@link MutationResultMessage}
 * acknowledgement. The same frames flow over a WebSocket connection and over
 * the HTTP commit endpoint.
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
  trackDependencySchema,
} from '../coordination/schema.js';
import type { OnStaleMode, ReadDependency, TrackDependency } from '../coordination/index.js';
import type { MutationResultMessageWire } from './commit.js';

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
  /**
   * The monotonic fencing token of the held claim this write was issued under
   * ({@link https://martin.kleppmann.com/2016/02/08/how-to-do-distributed-locking.html Kleppmann fencing}).
   * The server rejects the write if a later holder already advanced this
   * entity's persisted high-water past the token — closing the "lapsed holder
   * resumes after its successor came and went" residual that the live-lease
   * claim guard cannot see. Absent on every unclaimed write.
   */
  fenceToken?: number | null;
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
 * A client-to-server frame that asks the server to commit a batch of operations
 * atomically. It carries a list of {@link CommitOperation} entries plus the
 * batch metadata below.
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
    /**
     * Durable read-dependencies to register for this batch's participant. Each
     * entry — a row (`{ model, id }`) or a sync group (`{ group }`) — is persisted
     * and re-checked against every future delta; a later match surfaces a
     * `StaleNotification` on the participant's next commit. Distinct from `reads`,
     * which is checked once here and discarded.
     */
    track?: TrackDependency[] | null;
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
  track: z.array(trackDependencySchema).nullish(),
});
// Pins the schema to the payload type: fails to compile if either side drifts.
const _commitPayloadContract: _AssertExact<
  z.infer<typeof commitPayloadSchema>,
  CommitMessage['payload']
> = true;
void _commitPayloadContract;

// ── Server → Client ──────────────────────────────────────────────────────

/**
 * The server's acknowledgement of a {@link CommitMessage}. Runtime shape and
 * TypeScript type are both owned by `wire/commit.ts`; HTTP, WebSocket, and
 * cached replay no longer maintain parallel receipt declarations.
 */
export type MutationResultMessage = MutationResultMessageWire;
