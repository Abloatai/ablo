/**
 * Client-local opaque evidence for rows returned by authoritative reads.
 *
 * The name is retained internally to avoid churn across the two transports,
 * but this is not an execution context: it has no async carrier and no ambient
 * scope. Evidence is keyed only by the exact object returned to the caller.
 */
import {
  readDependencySchema,
  type CommitReadSetEntry,
  type OnStaleMode,
  type ReadDependency,
} from './coordination/schema.js';
import { AbloValidationError } from './errors.js';
import type { CommitRecord } from './wire/commit.js';

type ClientIdentity = object;

/** @internal One exact returned-row assertion. */
export interface CapturedReadEvidence {
  readonly client: ClientIdentity;
  readonly entry: CommitReadSetEntry;
  readonly row: object;
}

/** @internal Per-client registry. Weak keys do not retain application rows. */
export interface ReadRegistry {
  readonly byRow: WeakMap<object, CapturedReadEvidence>;
  readonly commitRecords: Map<string, CommitRecord>;
  onCommitRecord?: (record: CommitRecord) => void | Promise<void>;
}

/** @internal Client-local evidence registry handle. */
export interface ReadSetContext {
  getStore(): ReadRegistry;
}

export interface PreparedReadSet {
  readonly readAt?: number;
  readonly onStale?: OnStaleMode;
  readonly reads?: readonly ReadDependency[] | null;
  readonly consumed: readonly CapturedReadEvidence[];
  readonly automaticCommit: false;
  readonly idempotencyKey?: string;
}

/** @internal Creates one isolated evidence registry for one Ablo client. */
export function createReadSetContext(options?: {
  readonly onCommitRecord?: (record: CommitRecord) => void | Promise<void>;
}): ReadSetContext {
  const registry: ReadRegistry = {
    byRow: new WeakMap(),
    commitRecords: new Map(),
    ...(options?.onCommitRecord ? { onCommitRecord: options.onCommitRecord } : {}),
  };
  return { getStore: () => registry };
}

/** @internal Retains and reports one immutable logical commit snapshot. */
export function publishCommitRecord(
  context: ReadSetContext | undefined,
  record: CommitRecord,
): void {
  const registry = context?.getStore();
  if (!registry) return;
  registry.commitRecords.set(record.id, record);
  try {
    const observed = registry.onCommitRecord?.(record);
    if (observed) void Promise.resolve(observed).catch(() => undefined);
  } catch {
    // Observability must never change a commit's outcome.
  }
}

/** @internal Associates evidence with the exact row object returned to a caller. */
export function capturePointRead(
  context: ReadSetContext | undefined,
  client: ClientIdentity,
  model: string,
  id: string,
  row: unknown,
  readAt: number,
): void {
  if (!context || typeof row !== 'object' || row === null) return;
  const rowObject = row as object;
  context.getStore().byRow.set(rowObject, {
    client,
    row: rowObject,
    entry: {
      target: { scope: 'row', model, id },
      watermark: readAt,
      lifetime: 'commit',
      onStale: 'reject',
    },
  });
}

/** @internal Resolves only dependencies explicitly supplied through `reads`. */
export function prepareReadSet(
  context: ReadSetContext | undefined,
  client: ClientIdentity,
  explicitReadAt: number | null | undefined,
  explicitOnStale: OnStaleMode | null | undefined,
  explicitIdempotencyKey: string | null | undefined,
  reads: readonly unknown[] | null | undefined,
): PreparedReadSet {
  const registry = context?.getStore();
  const consumed: CapturedReadEvidence[] = [];
  const resolvedReads: ReadDependency[] = [];

  for (const entry of reads ?? []) {
    const captured =
      registry && typeof entry === 'object' && entry !== null
        ? registry.byRow.get(entry)
        : undefined;
    if (captured?.client === client) {
      const target = captured.entry.target;
      if (target.scope !== 'row') {
        throw new AbloValidationError('Captured read evidence must name a row.', {
          code: 'write_options_invalid', param: 'reads',
        });
      }
      resolvedReads.push({
        model: target.model,
        id: target.id,
        readAt: captured.entry.watermark,
      });
      consumed.push(captured);
      continue;
    }
    const canonical = readDependencySchema.safeParse(entry);
    if (canonical.success) {
      resolvedReads.push(canonical.data);
      continue;
    }
    throw new AbloValidationError(
      'A row passed through `reads` was not the exact object returned by this Ablo client. Re-read it and pass that object directly.',
      { code: 'write_options_invalid', param: 'reads' },
    );
  }

  return {
    ...(explicitReadAt != null ? { readAt: explicitReadAt } : {}),
    ...(explicitOnStale != null ? { onStale: explicitOnStale } : {}),
    ...(reads !== undefined ? { reads: reads === null ? null : resolvedReads } : {}),
    consumed,
    automaticCommit: false,
    ...(explicitIdempotencyKey != null ? { idempotencyKey: explicitIdempotencyKey } : {}),
  };
}

/** @internal Commit identity is the explicit request idempotency identity. */
export function commitRecordIdentity(
  _context: ReadSetContext | undefined,
  attemptId: string,
): { readonly id: string } {
  return { id: attemptId };
}

/** @internal Explicit row evidence is reusable; successful writes do not consume it. */
export function consumeReadSet(..._args: readonly unknown[]): void {}

/** @internal There is no ambient automatic-commit reservation to release. */
export function abortReadSetCommit(..._args: readonly unknown[]): void {}
