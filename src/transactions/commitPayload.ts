/**
 * Commit-payload projection — the queue's wire vocabulary, lifted out of
 * `TransactionQueue.ts` as a pure leaf (no queue state, no timers).
 *
 * Owns the `Transaction` record shape plus every helper that turns a local
 * transaction into a wire-safe commit operation: schema-field projection
 * (`projectCommitPayload`), write-option projection (`applyWriteOptions`),
 * FK-aware priority scoring, and the transport-error duck-typing used to
 * classify server rejections. Because nothing here touches the queue's
 * runtime, the HTTP commit path can share this projection too.
 */

import { getContext } from '../context.js';
import { getActiveRegistry } from '../ModelRegistry.js';
import { MutationOperationType } from '../types/index.js';
import type { MutationOptions, WriteOptions } from '../interfaces/index.js';

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
 * Project a Model's serialized data onto its schema-declared fields
 * and return a wire-safe commit payload. Two jobs:
 *
 *   1. Drop framework internals (`__class`, `__typename`, `clientId`,
 *      `syncStatus`) and anything not declared on the model's schema.
 *   2. JSON.stringify values typed as `field.json()` — TEXT columns
 *      storing JSON need explicit stringification; postgres.js won't
 *      auto-serialize for non-JSONB columns.
 *
 * For updates (`dropUndefined: true`), `undefined` values are also
 * stripped so they don't translate to `SET column = NULL` on the
 * server side.
 *
 * Fields are read from `ModelRegistry`, populated by
 * `registerModelsFromSchema` at SDK initialization. If the model
 * isn't registered with field metadata (edge case — e.g., tests or
 * manually registered models), projection falls back to identity and
 * the caller gets whatever the Model serialized.
 */
export function projectCommitPayload(
  modelName: string,
  source: Record<string, unknown>,
  opts: { dropUndefined: boolean },
): MutationInput {
  const metadata = getActiveRegistry().getMetadata(modelName);
  const fields = metadata?.fields;
  const out: MutationInput = {};

  if (!fields) {
    // Unknown registration — strip framework keys and ship the rest.
    for (const [k, v] of Object.entries(source)) {
      if (FRAMEWORK_KEYS.has(k)) continue;
      if (opts.dropUndefined && v === undefined) continue;
      out[k] = v;
    }
    return out;
  }

  for (const [key, meta] of Object.entries(fields)) {
    if (!(key in source)) continue;
    const value = source[key];
    if (opts.dropUndefined && value === undefined) continue;
    // JSON-typed fields (`jsonb` on the server): ship as OBJECTS over
    // the wire, not pre-stringified strings. Previously we stringified
    // here, which round-tripped incorrectly:
    //
    //   1. Client stringifies `position: {x, y}` → `'{"x":...}'`
    //   2. Server writes to jsonb column (parses string → jsonb object, fine)
    //   3. Server's delta echoes `data: JSON.stringify(op.input)` where
    //      `op.input.position` is still the STRING from step 1
    //   4. Client merges delta → `model.position = "{...}"` (STRING)
    //   5. Next drag: `{ ...layer.position, x, y }` spreads the STRING
    //      char-by-char, producing corrupted char-indexed objects like
    //      `{"0":"{","1":"\"","2":"x",...,"x":null,"y":null,...}`
    //   6. That corrupt object lands in the next commit, stored in jsonb.
    //
    // Sending objects avoids the round-trip mismatch: the wire carries
    // the object through delta + commit unchanged, and `postgres-js`
    // serializes JS objects to jsonb correctly via its own
    // `json.serialize` (triggered by Postgres's ParameterDescription
    // response identifying the column as type 3802 / jsonb).
    out[key] = value;
  }
  return out;
}

export interface Transaction {
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
  priorityScore: number; // derived FK-aware priority used for sorting
  writeOptions?: WriteOptions;
  batchId?: string;
  /** Completed locally without a server operation; no sync echo will arrive. */
  localOnly?: boolean;
  /** LINEAR PATTERN: syncId threshold - transaction confirms when delta.id >= this value */
  syncIdNeededForCompletion?: number;
  /**
   * Resolves when the server has confirmed this transaction (delta arrived
   * or HTTP ack). Rejects with the originating error if the transaction is
   * permanently rolled back. Name matches the queue's existing `'confirmed'`
   * status vocabulary (`commits.create({wait:'confirmed'})`,
   * `waitForConfirmation`) — gives call sites a single `await` point for
   * "did my write land?", so failures surface at the source instead of
   * leaking via silent pool rollback. The rejection error is the same
   * `AbloError` recorded on the queue's `transaction:failed` event.
   */
  confirmation?: Promise<void>;
}

export const normalizeModelKey = (modelName: string): string =>
  modelName.replace('Model', '').toLowerCase();
export const stripModelSuffix = (modelName: string): string => modelName.replace('Model', '');

/**
 * FK-ordered create priority.
 *
 * Reads `config.modelCreatePriority` out of the runtime SyncEngineContext —
 * this map is populated once at `createSyncEngine(...)` time by walking the
 * schema's `belongsTo` graph (see `computeFKDepthPriority` in
 * `client/createSyncEngine.ts`). The queue stays schema-agnostic: no model
 * names appear here, and consumer applications can override specific
 * priorities via `configOverrides.modelCreatePriority` without touching the
 * SDK.
 *
 * Non-create ops (update/delete/archive/unarchive) don't need FK ordering
 * because the row already exists, so they all share
 * `config.defaultNonCreatePriority`.
 */
export const computePriorityScore = (type: Transaction['type'], modelName: string): number => {
  const { modelCreatePriority, defaultCreatePriority, defaultNonCreatePriority } =
    getContext().config;
  if (type !== 'create') return defaultNonCreatePriority;
  return modelCreatePriority.get(modelName) ?? defaultCreatePriority;
};

export const TX_TYPE_TO_MUTATION_OP: Record<Transaction['type'], MutationOperationType> = {
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

export interface WriteOperationFields {
  readAt?: number | null;
  onStale?: 'reject' | 'overwrite' | 'notify' | null;
  options?: Pick<MutationOptions, 'idempotencyKey' | 'label'>;
}

/**
 * Project a transaction's `writeOptions` onto the wire operation. Stale
 * guards (`readAt`/`onStale`) ride at the op root; `idempotencyKey`/`label`
 * ride in the op's `options` slot (`MutationOperation.options` — the
 * mutation_log cache key + audit tag). This is the single place the
 * caller-supplied write vocabulary crosses onto the wire.
 */
export function applyWriteOptions<T extends object>(
  op: T,
  transaction: Transaction,
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
 * Structural shape we duck-type against for transport-layer errors.
 * Captures the union of GraphQL-style and HTTP-style error shapes the
 * mutation executor surfaces — kept narrow on purpose so we don't
 * pretend to know fields the runtime won't always supply.
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
