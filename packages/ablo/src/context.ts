/**
 * Additive context assembly for one Ablo client.
 *
 * The caller chooses the data. This module awaits it, reports the exact Ablo
 * rows it contains, and leaves model execution and external retrieval alone.
 */
import { z } from 'zod';
import type { CapturedRow } from '@abloatai/transaction';
import { awaitDeep, type AwaitedDeep } from './context/await.js';
import { bindContextEvidence } from './context/evidence.js';
import { sourceFor, type ContextSource } from './context/sources.js';

export { contextSourceSchema, type ContextSource } from './context/sources.js';
export type { AwaitedDeep } from './context/await.js';

const contextDataSchema = z.record(z.string(), z.unknown());

export interface ContextOptions<TData extends Readonly<Record<string, unknown>>> {
  /** The client whose read evidence may guard a later write. */
  readonly ablo: object;
  /** Values selected by the application. Nested promises are accepted. */
  readonly data: TData;
}

export interface ContextResult<TData extends Readonly<Record<string, unknown>>> {
  readonly data: AwaitedDeep<TData>;
  /** Exact returned Ablo rows, ready to pass to a write's `reads` option. */
  readonly reads: readonly CapturedRow[];
  /** The greatest watermark among included authoritative reads. */
  readonly cursor: number | null;
  readonly sources: readonly ContextSource[];
}

/** Assemble selected application values and the Ablo evidence they retain. */
export async function context<const TData extends Readonly<Record<string, unknown>>>(
  options: ContextOptions<TData>,
): Promise<ContextResult<TData>> {
  const collectEvidence = bindContextEvidence(options.ablo);
  const data = await awaitDeep(options.data);
  const parsed = contextDataSchema.safeParse(data);
  if (!parsed.success) {
    throw new TypeError('context() requires `data` to be an object.', { cause: parsed.error });
  }

  const evidence = collectEvidence(data);
  const sources = Object.entries(data).map(([key, value]) =>
    sourceFor(key, evidence.inspect(value)),
  );
  const cursor = evidence.all.length === 0
    ? null
    : Math.max(...evidence.all.map((item) => item.entry.watermark));

  return {
    data: data as AwaitedDeep<TData>,
    reads: evidence.all.map((item) => item.row as CapturedRow),
    cursor,
    sources,
  };
}
