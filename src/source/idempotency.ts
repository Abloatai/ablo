/**
 * Customer-side source idempotency helpers.
 *
 * Connected writes use a permanent, server-derived correlation key at the
 * customer boundary. The matching intent hash must therefore also be
 * permanent: replaying the key with a different request is a conflict, never a
 * fresh execution. Ablo supplies the hash for signed source requests because
 * it covers context/read guards that an adapter cannot reconstruct from the
 * effective operation list alone. Direct adapter users get a canonical
 * operations-only fallback.
 */

import { createHash } from 'node:crypto';
import { z } from 'zod';
import { AbloValidationError } from '../errors.js';
import {
  COMMIT_CORRELATION_ID_MAX_LENGTH,
  correlationIdSchema,
} from '../wire/commit.js';
import type { ChangeSet, Operation } from './contract.js';

const SOURCE_ECHO_TRANSACTION_ID_PREFIX = 'ablo_echo_tx_v1:';

const sourceOperationTransactionIdSchema = z
  .string()
  .min(1)
  .max(COMMIT_CORRELATION_ID_MAX_LENGTH);

/** Runtime shape recovered from the internal storage envelope. */
export const sourceEchoTransactionIdSchema = z.strictObject({
  correlationId: correlationIdSchema,
  transactionId: sourceOperationTransactionIdSchema,
});
export type SourceEchoTransactionId = z.infer<typeof sourceEchoTransactionIdSchema>;

const sourceEchoTransactionIdTupleSchema = z.tuple([
  correlationIdSchema,
  sourceOperationTransactionIdSchema,
]);

/**
 * Store both source-batch identity and the originating optimistic-write id in
 * the existing `sync_deltas.transaction_id` column. The database value is an
 * internal envelope: the server unwraps it before broadcasting, so clients
 * still receive the exact operation transaction id they authored.
 *
 * Keeping the opaque, authenticated-scope correlation in the stored value is
 * load-bearing for crash recovery. A raw caller may choose or reuse an
 * operation transaction id; that value alone must never be able to satisfy a
 * different participant's queued receipt.
 */
export function encodeSourceEchoTransactionId(
  correlationId: string,
  transactionId: string,
): string {
  const tuple = sourceEchoTransactionIdTupleSchema.parse([
    correlationId,
    transactionId,
  ]);
  return `${SOURCE_ECHO_TRANSACTION_ID_PREFIX}${JSON.stringify(tuple)}`;
}

/** Decode a source-WAL transaction envelope, or return null for normal rows. */
export function decodeSourceEchoTransactionId(
  value: string | null,
): SourceEchoTransactionId | null {
  if (!value?.startsWith(SOURCE_ECHO_TRANSACTION_ID_PREFIX)) return null;
  try {
    const parsed: unknown = JSON.parse(
      value.slice(SOURCE_ECHO_TRANSACTION_ID_PREFIX.length),
    );
    const tuple = sourceEchoTransactionIdTupleSchema.safeParse(parsed);
    if (!tuple.success) return null;
    return sourceEchoTransactionIdSchema.parse({
      correlationId: tuple.data[0],
      transactionId: tuple.data[1],
    });
  } catch {
    return null;
  }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const encoded = JSON.stringify(value) as string | undefined;
    return encoded ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value
      .map((entry) => canonicalJson(entry === undefined ? null : entry))
      .join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
}

/** Canonical operations-only fallback for direct adapter use. */
export function sourceOperationsIntentHash(
  operations: readonly Operation[],
): string {
  return createHash('sha256')
    .update(canonicalJson(operations))
    .digest('hex');
}

/** Resolve the hash every newly-written customer ledger row must persist. */
export function sourceChangeIntentHash(change: ChangeSet): string {
  if (change.echo && !change.intentHash) {
    throw new AbloValidationError(
      'A WAL-correlated source commit requires Ablo intentHash evidence',
      { code: 'idempotency_conflict' },
    );
  }
  return change.intentHash ?? sourceOperationsIntentHash(change.operations);
}

/** Fail closed for changed intent and legacy rows that lack hash evidence. */
export function assertSourceIdempotencyIntent(
  cachedHash: unknown,
  requestHash: string,
): void {
  if (cachedHash !== requestHash) {
    throw new AbloValidationError(
      cachedHash == null
        ? 'The source idempotency row predates intent hashing and cannot be replayed safely'
        : 'The source idempotency key was already used with a different request intent',
      { code: 'idempotency_conflict' },
    );
  }
}

/**
 * Enforce the initial permanent-retention contract. New rows use Postgres
 * `infinity`; this check also fails explicitly if a future bounded-retention
 * policy leaves an expired tombstone. Missing expiry evidence is accepted only
 * for adapters reading rows written before the column existed.
 */
export function assertSourceIdempotencyRetention(
  expiresAt: unknown,
  now = Date.now(),
): void {
  if (
    expiresAt == null ||
    expiresAt === 'infinity' ||
    expiresAt === Infinity
  ) {
    return;
  }
  const timestamp =
    expiresAt instanceof Date
      ? expiresAt.getTime()
      : typeof expiresAt === 'number'
        ? expiresAt
        : typeof expiresAt === 'string'
          ? Date.parse(expiresAt)
          : Number.NaN;
  if (!Number.isFinite(timestamp)) {
    throw new AbloValidationError(
      'The source idempotency retention evidence is invalid',
      { code: 'idempotency_conflict' },
    );
  }
  if (timestamp <= now) {
    throw new AbloValidationError(
      'The source idempotency key has expired and cannot be executed again safely',
      { code: 'idempotency_key_expired' },
    );
  }
}
