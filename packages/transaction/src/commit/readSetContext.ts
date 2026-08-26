/**
 * Client-local opaque evidence for rows returned by authoritative reads.
 *
 * The name is retained internally to avoid churn across the two transports,
 * but this is not an execution context: it has no async carrier and no ambient
 * scope. Evidence is keyed only by the exact object returned to the caller.
 */
import { readDependencySchema, type ReadDependency } from '../coordination/schema.js';
import { AbloValidationError, type AbloStaleContextError } from '../errors.js';
import type { CommitRecord } from './contract.js';

type ClientIdentity = object;

/** @internal Symbol-keyed bridge used by additive SDK structures. */
export const kReadEvidence = Symbol.for('ablo.transaction.read-evidence');

/** @internal One exact returned-row assertion. */
export interface CapturedReadEvidence {
  readonly client: ClientIdentity;
  readonly entry: ReadDependency;
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

/** @internal The two client-local values needed to inspect captured reads. */
export interface ReadEvidenceBinding {
  readonly context: ReadSetContext;
  readonly client: ClientIdentity;
  /** @internal Transport-owned live check for the same exact reads. */
  readonly onChange?: (
    reads: readonly ReadDependency[],
    listener: (error: AbloStaleContextError) => void,
  ) => () => void;
}

/** @internal Reads the private evidence binding without occupying a model name. */
export function readEvidenceBinding(client: unknown): ReadEvidenceBinding | undefined {
  if ((typeof client !== 'object' && typeof client !== 'function') || client === null) {
    return undefined;
  }
  const binding = Reflect.get(client, kReadEvidence) as ReadEvidenceBinding | undefined;
  if (!binding || typeof binding !== 'object') return undefined;
  if (!binding.context || typeof binding.context.getStore !== 'function') return undefined;
  if (!binding.client || typeof binding.client !== 'object') return undefined;
  return binding;
}

/** @internal Returns evidence only for an exact row from the bound client. */
export function evidenceForRow(
  binding: ReadEvidenceBinding,
  row: unknown,
): CapturedReadEvidence | undefined {
  if (typeof row !== 'object' || row === null) return undefined;
  const evidence = binding.context.getStore().byRow.get(row);
  return evidence?.client === binding.client ? evidence : undefined;
}

export interface PreparedReadSet {
  readonly readAt?: number;
  readonly reads?: readonly ReadDependency[] | null;
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
    if (observed) {
      void Promise.resolve(observed).catch((error) => {
        // The observer is outside the transaction outcome by contract.
        void error;
      });
    }
  } catch (error) {
    // Observability must never change a commit's outcome.
    void error;
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
      model,
      id,
      readAt,
    },
  });
}

/** @internal Resolves only dependencies explicitly supplied through `reads`. */
export function prepareReadSet(
  context: ReadSetContext | undefined,
  client: ClientIdentity,
  explicitReadAt: number | null | undefined,
  explicitIdempotencyKey: string | null | undefined,
  reads: readonly unknown[] | null | undefined,
): PreparedReadSet {
  const registry = context?.getStore();
  const resolvedReads: ReadDependency[] = [];

  for (const entry of reads ?? []) {
    const captured =
      registry && typeof entry === 'object' && entry !== null
        ? registry.byRow.get(entry)
        : undefined;
    if (captured?.client === client) {
      if ('group' in captured.entry) {
        throw new AbloValidationError('Captured read evidence must name a row.', {
          code: 'write_options_invalid', param: 'reads',
        });
      }
      resolvedReads.push({
        model: captured.entry.model,
        id: captured.entry.id,
        readAt: captured.entry.readAt,
      });
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
    ...(reads !== undefined ? { reads: reads === null ? null : resolvedReads } : {}),
    ...(explicitIdempotencyKey != null ? { idempotencyKey: explicitIdempotencyKey } : {}),
  };
}
