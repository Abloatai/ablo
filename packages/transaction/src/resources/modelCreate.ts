/** Canonical create identity and result correlation shared by every client. */

import { v5 as uuidv5 } from 'uuid';
import { AbloConnectionError } from '../errors.js';
import type { CommitOperationResult } from '../wire/commit.js';

/** Resolve the two supported single-create id spellings. The sibling wins. */
export function resolveCreateId(
  explicitId: string | null | undefined,
  data: unknown,
): string | undefined {
  if (typeof explicitId === 'string' && explicitId.length > 0) return explicitId;
  const inData =
    typeof data === 'object' && data !== null
      ? (data as { readonly id?: unknown }).id
      : undefined;
  return typeof inData === 'string' && inData.length > 0 ? inData : undefined;
}

/** Stable across transports and client instances when an idempotency key is supplied. */
export function createModelId(
  modelName: string,
  idempotencyKey?: string | null,
): string {
  if (idempotencyKey) {
    return uuidv5(
      `${modelName}:${idempotencyKey}`,
      'aa4ba6d4-bf0b-5b38-9c45-116f79a6e548',
    );
  }
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `id_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Return server-authored create rows in input order.
 *
 * Fresh receipts carry operationResults. Durable idempotency replays redact
 * row data, so that path verifies every expected id with a point read. It may
 * fail under a write-only policy, but it can never report a partial collection
 * as success.
 */
export async function resolveCreatedRows<T>(input: {
  readonly modelName: string;
  readonly ids: readonly string[];
  readonly operationResults?: readonly CommitOperationResult[];
  readonly readRow: (id: string) => Promise<T | undefined>;
}): Promise<T[]> {
  if (input.operationResults?.length === input.ids.length) {
    const byId = new Map(
      input.operationResults.map((result) => [
        (result.row as { readonly id?: unknown }).id,
        result.row,
      ]),
    );
    const ordered = input.ids.map((id) => byId.get(id));
    if (ordered.every((row): row is Record<string, unknown> => row !== undefined)) {
      return ordered as T[];
    }
  }

  const rows = await Promise.all(input.ids.map((id) => input.readRow(id)));
  const missing = input.ids.filter((_id, index) => rows[index] === undefined);
  if (missing.length > 0) {
    throw new AbloConnectionError(
      `${input.modelName} create confirmed, but ${missing.length} of ${input.ids.length} ` +
        'server rows could not be recovered from its receipt or verified by id.',
      { code: 'commit_no_result', details: { missingIds: missing } },
    );
  }
  return rows as T[];
}
