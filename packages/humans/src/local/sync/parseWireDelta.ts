/**
 * Zero-Zod structural validator and normalizer for inbound wire deltas.
 *
 * Contract-equivalent to {@link clientSyncDeltaSchema} from
 * `@abloatai/transaction/observation`, combined with the receive-boundary
 * server-compat normalization previously done inline in {@link SyncWebSocket}:
 *  - Coerces non-number `id` (e.g. Postgres BIGINT string) via `Number(id)`,
 *    falling back to `0` when non-finite, while still rejecting non-finite
 *    numbers (`NaN`, `Infinity`, `-Infinity`) that arrived as numbers.
 *  - Normalizes `transactionId: null` to absent (`undefined`).
 *  - Normalizes non-string `createdBy` (e.g. nested `ParticipantRef` or `null`)
 *    to absent (`undefined`).
 *  - Strips server-only fields (`projectId`, `actor`, `onBehalfOf`,
 *    `capabilityId`, `confirmationState`, etc.) just like Zod's default object
 *    stripping, without cloning the input object or walking payload keys via
 *    `Reflect.ownKeys`.
 *
 * Parity with `clientSyncDeltaSchema.safeParse` is pinned by
 * `parseWireDelta.test.ts`.
 */

import type {
  ClientSyncDelta,
  SyncDeltaAction,
  WireDeltaData,
} from '@abloatai/transaction/observation';
import { COMMIT_CORRELATION_ID_MAX_LENGTH } from '@abloatai/transaction/commit';
import type { AcceptedOperationReference } from '@abloatai/transaction/commit';

export type ParseWireDeltaResult =
  | { readonly ok: true; readonly data: ClientSyncDelta }
  | { readonly ok: false; readonly issue: string };

/** Plain-object predicate matching Zod v4's `z.record(z.string(), z.unknown())`. */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Matches `wireDeltaDataSchema = z.union([z.record(z.string(), z.unknown()), z.string()]).nullable()`. */
export function isWireDeltaData(value: unknown): value is WireDeltaData {
  return value === null || typeof value === 'string' || isPlainObject(value);
}

/** Matches `syncDeltaActionSchema = z.enum(['I', 'U', 'D', 'A', 'V', 'C', 'G', 'S'])`. */
export function isSyncDeltaAction(value: unknown): value is SyncDeltaAction {
  return (
    value === 'U' ||
    value === 'I' ||
    value === 'D' ||
    value === 'C' ||
    value === 'A' ||
    value === 'V' ||
    value === 'G' ||
    value === 'S'
  );
}

function parseOperation(value: unknown): AcceptedOperationReference | string {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return 'operation: expected object';
  }
  const op = value as Record<string, unknown>;
  const id = op.id;
  if (typeof id !== 'string' || id.length < 1 || id.length > 255) {
    return 'operation.id: expected non-empty string <= 255 chars';
  }
  const kind = op.kind;
  if (kind !== 'text' && kind !== 'counter') {
    return 'operation.kind: expected "text" or "counter"';
  }
  const field = op.field;
  if (typeof field !== 'string' || field.length < 1) {
    return 'operation.field: expected non-empty string';
  }
  const epoch = op.epoch;
  if (typeof epoch !== 'string' || epoch.length < 1 || epoch.length > 255) {
    return 'operation.epoch: expected non-empty string <= 255 chars';
  }
  const version = op.version;
  if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1) {
    return 'operation.version: expected positive safe integer';
  }
  // Enforce z.strictObject: reject any unrecognized own enumerable keys.
  for (const key in op) {
    if (!Object.prototype.hasOwnProperty.call(op, key)) continue;
    if (
      key !== 'id' &&
      key !== 'kind' &&
      key !== 'field' &&
      key !== 'epoch' &&
      key !== 'version'
    ) {
      return `operation: unrecognized key "${key}"`;
    }
  }
  return { id, kind, field, epoch, version };
}

/**
 * Allocation-minimal fast path returning the validated `ClientSyncDelta`
 * directly or `null` on failure (avoiding `{ ok: true, data }` wrapper objects
 * on the hot wire receive path). Call {@link parseWireDelta} on the rare `null`
 * failure path when an issue description is needed for diagnostics.
 */
export function parseWireDeltaOrNull(raw: unknown): ClientSyncDelta | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return null;
  }

  const rec = raw as Record<string, unknown>;

  const rawId = rec.id;
  let id: number;
  if (typeof rawId === 'number') {
    if (!Number.isFinite(rawId)) return null;
    id = rawId;
  } else if (typeof rawId === 'symbol') {
    return null;
  } else {
    const coerced = Number(rawId);
    id = Number.isFinite(coerced) ? coerced : 0;
  }

  const actionType = rec.actionType;
  if (!isSyncDeltaAction(actionType)) return null;

  const modelName = rec.modelName;
  if (typeof modelName !== 'string' || modelName.length === 0) return null;

  const modelId = rec.modelId;
  if (typeof modelId !== 'string' || modelId.length === 0) return null;

  const data = rec.data;
  if (!isWireDeltaData(data)) return null;

  const rawSyncGroups = rec.syncGroups;
  if (!Array.isArray(rawSyncGroups)) return null;
  for (const group of rawSyncGroups) {
    if (typeof group !== 'string') return null;
  }

  const createdAt = rec.createdAt;
  if (typeof createdAt !== 'string') return null;

  const previousData = rec.previousData;
  if (previousData !== undefined && !isWireDeltaData(previousData)) return null;

  const rawOperation = rec.operation;
  let operation: AcceptedOperationReference | undefined;
  if (rawOperation !== undefined) {
    const parsedOp = parseOperation(rawOperation);
    if (typeof parsedOp === 'string') return null;
    operation = parsedOp;
  }

  const rawTransactionId = rec.transactionId;
  let transactionId: string | undefined;
  if (rawTransactionId !== undefined && rawTransactionId !== null) {
    if (typeof rawTransactionId !== 'string') return null;
    transactionId = rawTransactionId;
  }

  const correlationId = rec.correlationId;
  if (
    correlationId !== undefined &&
    (typeof correlationId !== 'string' ||
      correlationId.length < 1 ||
      correlationId.length > COMMIT_CORRELATION_ID_MAX_LENGTH)
  ) {
    return null;
  }

  const rawCreatedBy = rec.createdBy;
  const createdBy = typeof rawCreatedBy === 'string' ? rawCreatedBy : undefined;

  const metadata = rec.metadata;
  if (metadata !== undefined && !isWireDeltaData(metadata)) return null;

  const clientMutationId = rec.clientMutationId;
  if (clientMutationId !== undefined && typeof clientMutationId !== 'string') return null;

  const out: ClientSyncDelta = {
    id,
    actionType,
    modelName,
    modelId,
    data,
    syncGroups: rawSyncGroups as string[],
    createdAt,
  };
  if (previousData !== undefined) out.previousData = previousData;
  if (operation !== undefined) out.operation = operation;
  if (transactionId !== undefined) out.transactionId = transactionId;
  if (correlationId !== undefined) out.correlationId = correlationId;
  // eslint-disable-next-line @typescript-eslint/no-deprecated
  if (createdBy !== undefined) out.createdBy = createdBy;
  if (metadata !== undefined) out.metadata = metadata;
  if (clientMutationId !== undefined) out.clientMutationId = clientMutationId;

  return out;
}

/**
 * Validate and normalize an untrusted wire delta in a single allocation-light
 * pass. Returns `{ ok: true, data }` on success or `{ ok: false, issue }` on
 * schema violation.
 */
export function parseWireDelta(raw: unknown): ParseWireDeltaResult {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, issue: 'not an object' };
  }

  const rec = raw as Record<string, unknown>;

  // 1. id: coerce non-number (e.g. Postgres BIGINT string) via Number(),
  //    falling back to 0 when non-finite; reject non-finite numbers directly.
  const rawId = rec.id;
  let id: number;
  if (typeof rawId === 'number') {
    if (!Number.isFinite(rawId)) {
      return { ok: false, issue: 'id: expected finite number' };
    }
    id = rawId;
  } else if (typeof rawId === 'symbol') {
    return { ok: false, issue: 'id: expected number' };
  } else {
    const coerced = Number(rawId);
    id = Number.isFinite(coerced) ? coerced : 0;
  }

  // 2. actionType: 'U' | 'I' | 'D' | 'C' | 'A' | 'V' | 'G' | 'S'
  const actionType = rec.actionType;
  if (!isSyncDeltaAction(actionType)) {
    return { ok: false, issue: 'actionType: invalid action code' };
  }

  // 3. modelName: non-empty string
  const modelName = rec.modelName;
  if (typeof modelName !== 'string' || modelName.length === 0) {
    return { ok: false, issue: 'modelName: expected non-empty string' };
  }

  // 4. modelId: non-empty string
  const modelId = rec.modelId;
  if (typeof modelId !== 'string' || modelId.length === 0) {
    return { ok: false, issue: 'modelId: expected non-empty string' };
  }

  // 5. data: plain object | string | null
  const data = rec.data;
  if (!isWireDeltaData(data)) {
    return { ok: false, issue: 'data: expected plain object, string, or null' };
  }

  // 6. syncGroups: string[]
  const rawSyncGroups = rec.syncGroups;
  if (!Array.isArray(rawSyncGroups)) {
    return { ok: false, issue: 'syncGroups: expected array of strings' };
  }
  for (let i = 0; i < rawSyncGroups.length; i++) {
    if (typeof rawSyncGroups[i] !== 'string') {
      return { ok: false, issue: `syncGroups.${i}: expected string` };
    }
  }
  const syncGroups = rawSyncGroups as string[];

  // 7. createdAt: string
  const createdAt = rec.createdAt;
  if (typeof createdAt !== 'string') {
    return { ok: false, issue: 'createdAt: expected string' };
  }

  // 8. previousData (optional): plain object | string | null
  const previousData = rec.previousData;
  if (previousData !== undefined && !isWireDeltaData(previousData)) {
    return { ok: false, issue: 'previousData: expected plain object, string, or null' };
  }

  // 9. operation (optional): strict AcceptedOperationReference
  const rawOperation = rec.operation;
  let operation: AcceptedOperationReference | undefined;
  if (rawOperation !== undefined) {
    const parsedOp = parseOperation(rawOperation);
    if (typeof parsedOp === 'string') {
      return { ok: false, issue: parsedOp };
    }
    operation = parsedOp;
  }

  // 10. transactionId (optional; server `null` normalizes to absent)
  const rawTransactionId = rec.transactionId;
  let transactionId: string | undefined;
  if (rawTransactionId !== undefined && rawTransactionId !== null) {
    if (typeof rawTransactionId !== 'string') {
      return { ok: false, issue: 'transactionId: expected string' };
    }
    transactionId = rawTransactionId;
  }

  // 11. correlationId (optional): string of length 1..255
  const correlationId = rec.correlationId;
  if (
    correlationId !== undefined &&
    (typeof correlationId !== 'string' ||
      correlationId.length < 1 ||
      correlationId.length > COMMIT_CORRELATION_ID_MAX_LENGTH)
  ) {
    return { ok: false, issue: 'correlationId: expected non-empty string <= 255 chars' };
  }

  // 12. createdBy (optional; non-string server ParticipantRef / null normalizes to absent)
  const rawCreatedBy = rec.createdBy;
  const createdBy = typeof rawCreatedBy === 'string' ? rawCreatedBy : undefined;

  // 13. metadata (optional): plain object | string | null
  const metadata = rec.metadata;
  if (metadata !== undefined && !isWireDeltaData(metadata)) {
    return { ok: false, issue: 'metadata: expected plain object, string, or null' };
  }

  // 14. clientMutationId (optional): string
  const clientMutationId = rec.clientMutationId;
  if (clientMutationId !== undefined && typeof clientMutationId !== 'string') {
    return { ok: false, issue: 'clientMutationId: expected string' };
  }

  // Build stripped ClientSyncDelta (matching Zod's default object strip).
  const out: ClientSyncDelta = {
    id,
    actionType,
    modelName,
    modelId,
    data,
    syncGroups,
    createdAt,
  };
  if (previousData !== undefined) out.previousData = previousData;
  if (operation !== undefined) out.operation = operation;
  if (transactionId !== undefined) out.transactionId = transactionId;
  if (correlationId !== undefined) out.correlationId = correlationId;
  // eslint-disable-next-line @typescript-eslint/no-deprecated
  if (createdBy !== undefined) out.createdBy = createdBy;
  if (metadata !== undefined) out.metadata = metadata;
  if (clientMutationId !== undefined) out.clientMutationId = clientMutationId;

  return { ok: true, data: out };
}
