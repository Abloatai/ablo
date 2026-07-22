/**
 * The vocabulary a local transaction uses on the wire. This module defines the
 * {@link QueuedMutation} record and the helpers that turn a transaction into a
 * wire-safe commit operation: schema-field projection
 * ({@link projectCommitPayload}), write-option projection
 * ({@link applyWriteOptions}), foreign-key-aware priority scoring
 * ({@link computePriorityScore}), and the structural checks used to classify
 * transport errors. Nothing here holds queue state or timers, so the batched
 * queue path and the HTTP commit path share the same projection.
 */

import { getContext } from '../../context.js';
import { MutationOperationType } from '../../transaction/types/index.js';
import { snapshotJsonValue } from '../../transaction/utils/json.js';
import type { OnStaleMode } from '../../transaction/coordination/schema.js';
import type { MutationOptions, WriteOptions } from '../../interfaces/index.js';
import type { CommitEnvelopeMember } from '../../transaction/transactions/settlement/commitEnvelope.js';

export interface UserContext {
  userId: string;
  organizationId: string;
  role?: string;
  teamIds?: string[];
}

/** Wire-format mutation payload (post-projection). */
export type MutationInput = Record<string, unknown>;

/**
 * Framework-internal keys added by `Model.toJSON()` that must never
 * reach the wire. The server treats each top-level key as a target
 * column, so shipping these would blow up the INSERT/UPDATE.
 */
const FRAMEWORK_KEYS = new Set(['__class', '__typename', 'clientId', 'syncStatus']);

/**
 * Projects a model's serialized data onto the fields declared in its schema and
 * returns a wire-safe commit payload. It does two things:
 *
 *   1. Drops framework-internal keys (`__class`, `__typename`, `clientId`,
 *      `syncStatus`) and anything not declared on the model's schema.
 *   2. Takes a fresh plain JSON snapshot of the projected values. JSON-typed
 *      fields stay objects rather than pre-serialized strings, while reactive
 *      proxies cannot leak into persistence or the wire payload.
 *
 * For updates (`dropUndefined: true`), `undefined` values are also removed so
 * they are not written as `SET column = NULL` on the server.
 *
 * Field metadata comes from the model registry, populated when the schema is
 * registered at initialization. If a model has no registered field metadata —
 * for example a manually registered model — projection snapshots all serialized
 * data apart from the framework keys.
 */
export function projectCommitPayload(
  modelName: string,
  source: Record<string, unknown>,
  opts: { dropUndefined: boolean },
): MutationInput {
  const metadata = getContext().getModelMetadata(modelName);
  const fields = metadata?.fields;
  const out: MutationInput = {};

  if (!fields) {
    // Unknown registration — strip framework keys and ship the rest.
    for (const [k, v] of Object.entries(source)) {
      if (FRAMEWORK_KEYS.has(k)) continue;
      if (opts.dropUndefined && v === undefined) continue;
      out[k] = v;
    }
    return snapshotJsonValue(out, '$.input') as MutationInput;
  }

  for (const key of Object.keys(fields)) {
    if (!(key in source)) continue;
    const value = source[key];
    if (opts.dropUndefined && value === undefined) continue;
    // JSON-typed fields (stored as jsonb on the server) are sent as objects,
    // not pre-serialized strings. Pre-stringifying here corrupts a round trip:
    //
    //   1. The client stringifies `position: {x, y}` to `'{"x":...}'`.
    //   2. The server writes it to the jsonb column, parsing the string, fine.
    //   3. The server's delta echoes the input, where `position` is still the
    //      string from step 1.
    //   4. The client merges the delta and sets `model.position` to that string.
    //   5. The next edit spreads the string character by character, producing a
    //      corrupted, index-keyed object.
    //   6. That corrupt object lands in the next commit and is stored in jsonb.
    //
    // Sending objects avoids the mismatch: the value travels through the delta
    // and the commit unchanged, and the Postgres driver serializes a JS object
    // to jsonb correctly once the column is identified as jsonb.
    out[key] = value;
  }
  return snapshotJsonValue(out, '$.input') as MutationInput;
}

export interface QueuedMutation {
  id: string;
  type: 'create' | 'update' | 'delete' | 'archive' | 'unarchive';
  modelName: string;
  modelId: string;
  modelKey: string;
  data?: MutationInput;
  previousData?: MutationInput | null;
  context: UserContext;
  status: 'pending' | 'executing' | 'awaiting_delta' | 'completed' | 'failed' | 'rolled_back';
  createdAt: number;
  attempts: number;
  priority: 'normal' | 'high';
  priorityScore: number; // foreign-key-aware priority, derived, used for sorting
  writeOptions?: WriteOptions;
  batchId?: string;
  /**
   * Stable identity of the wire commit that currently owns this operation.
   *
   * A transport failure is ambiguous: the server may have committed the
   * batch even though the acknowledgement never reached this client. Keeping
   * this envelope on every member lets the queue replay the exact same ordered
   * batch with the exact same idempotency key instead of accidentally
   * re-batching its operations under a fresh key.
   */
  commitEnvelope?: CommitEnvelopeMember;
  /** Pending-mutation journal entries atomically consumed by this envelope. */
  sourceMutationIds?: string[];
  /** Completed locally without a server operation; no sync echo will arrive. */
  localOnly?: boolean;
  /** Sync-id threshold: the transaction confirms once a delta with an id at least this value arrives. */
  syncIdNeededForCompletion?: number;
  /**
   * Opaque customer-side batch identity returned with a queued source receipt.
   * It is retained durably and is the only identity a live WAL delta may use
   * to settle this pending commit. Server-side replay additionally proves the
   * complete stored operation-id set before returning `confirmed`.
   */
  correlationId?: string;
  /**
   * A queued forward has no authoritative sync-id watermark yet. It may only
   * confirm when a WAL delta carries its opaque server-derived correlation;
   * unrelated deltas must never satisfy it by advancing the global watermark.
   */
  requiresCorrelatedDelta?: boolean;
  /**
   * Resolves once the server has confirmed this transaction, whether by a delta
   * or an HTTP acknowledgement. It rejects with the originating error if the
   * transaction is permanently rolled back; for a source-forwarded write it
   * also rejects with `replication_lag_timeout` when the accepted write's WAL
   * echo misses the confirmation deadline. That timeout does not roll back or
   * fail the transaction: it remains pending and may confirm when replication
   * recovers. This gives a caller one place to await the answer to "did my write
   * land?", matching the
   * `commits.create({ wait: 'confirmed' })` and
   * {@link MutationQueue.waitForConfirmation} vocabulary, so a failure
   * surfaces at the call site instead of only as a silent local rollback. The
   * permanent-rejection value is the same {@link AbloError} carried on the
   * queue's `transaction:failed` event.
   */
  confirmation?: Promise<void>;
}

export const normalizeModelKey = (modelName: string): string =>
  modelName.replace('Model', '').toLowerCase();
export const stripModelSuffix = (modelName: string): string => modelName.replace('Model', '');

/**
 * Returns the priority score used to order create operations by foreign-key
 * depth, so a parent row commits before its children.
 *
 * The score comes from a priority map on the runtime configuration, built once
 * at initialization by walking the schema's `belongsTo` graph. No model names
 * are hard-coded here, and an application can override specific priorities
 * through `configOverrides.modelCreatePriority`.
 *
 * Non-create operations (update, delete, archive, unarchive) need no
 * foreign-key ordering because the row already exists, so they all share the
 * configured default non-create priority.
 */
export const computePriorityScore = (type: QueuedMutation['type'], modelName: string): number => {
  const { modelCreatePriority, defaultCreatePriority, defaultNonCreatePriority } =
    getContext().config;
  if (type !== 'create') return defaultNonCreatePriority;
  return modelCreatePriority.get(modelName) ?? defaultCreatePriority;
};

export const TX_TYPE_TO_MUTATION_OP: Record<QueuedMutation['type'], MutationOperationType> = {
  create: MutationOperationType.CREATE,
  update: MutationOperationType.UPDATE,
  delete: MutationOperationType.DELETE,
  archive: MutationOperationType.ARCHIVE,
  unarchive: MutationOperationType.UNARCHIVE,
};

export function hasStaleWriteOptions(options?: WriteOptions): boolean {
  return (
    options?.readAt !== undefined ||
    options?.onStale !== undefined
  );
}

/** Options whose identity/audit semantics forbid merging two caller writes. */
export function hasCommitCoalescingBarrier(options?: WriteOptions): boolean {
  return (
    hasStaleWriteOptions(options) ||
    typeof options?.idempotencyKey === 'string' ||
    typeof options?.label === 'string'
  );
}

export interface WriteOperationFields {
  readAt?: number | null;
  onStale?: OnStaleMode | null;
  fenceToken?: number | null;
  options?: Pick<MutationOptions, 'idempotencyKey' | 'label'>;
}

/**
 * Copies a transaction's `writeOptions` onto the wire operation. The
 * stale-context guards (`readAt` and `onStale`) sit at the operation's root,
 * while `idempotencyKey` and `label` go in its `options` slot — the
 * `mutation_log` cache key and audit tag. This is the one place caller-supplied
 * write options cross onto the wire.
 */
export function applyWriteOptions<T extends object>(
  op: T,
  transaction: QueuedMutation,
): T & WriteOperationFields {
  const operation = op as T & WriteOperationFields;
  const writeOptions = transaction.writeOptions;
  if (!writeOptions) return operation;
  if (writeOptions.readAt !== undefined) {
    operation.readAt = writeOptions.readAt;
  }
  if (writeOptions.onStale !== undefined) {
    operation.onStale = writeOptions.onStale;
  }
  if (writeOptions.fenceToken !== undefined) {
    operation.fenceToken = writeOptions.fenceToken;
  }
  if (writeOptions.idempotencyKey != null || writeOptions.label !== undefined) {
    operation.options = {
      ...(writeOptions.idempotencyKey != null
        ? { idempotencyKey: writeOptions.idempotencyKey }
        : {}),
      ...(writeOptions.label !== undefined ? { label: writeOptions.label } : {}),
    };
  }
  return operation;
}

/**
 * The structural shape used to inspect transport-layer errors. It covers the
 * GraphQL-style and HTTP-style error shapes the mutation executor can surface,
 * and is kept intentionally narrow so it does not claim fields the runtime may
 * not supply.
 */
export interface TransportError {
  message?: string;
  code?: string | number;
  extensions?: Record<string, unknown>;
  locations?: readonly unknown[];
  path?: readonly (string | number)[];
  response?: {
    status?: number;
    errors?: readonly { extensions?: { code?: string }; message?: string }[];
  };
  // Some executors stash a wrapped server message under `error`.
  error?: string;
}

export function asTransportError(value: unknown): TransportError {
  return (value && typeof value === 'object' ? value : {});
}

export function extractStatusCode(error: unknown): number | undefined {
  return asTransportError(error).response?.status;
}
