/**
 * Assemble the values selected for one action and retain the exact Ablo reads
 * they contain. Each read keeps its own `readAt`; context does not collapse
 * those independent premises into another watermark.
 */
import { z } from 'zod';
import type { CapturedRow } from '@abloatai/transaction';
import { awaitDeep, type AwaitedDeep } from './await.js';
import { bindContextEvidence } from './evidence.js';
import { createContextOnChange, type ContextOnChange } from './onChange.js';

export type { AwaitedDeep } from './await.js';
export type { ContextChangeListener, ContextOnChange } from './onChange.js';

const contextDataSchema = z.record(z.string(), z.unknown());

export interface ContextOptions<TData extends Readonly<Record<string, unknown>>> {
  /** The client whose read evidence may guard a later create, update, or delete. */
  readonly ablo: object;
  /** Values selected by the application. Nested promises are accepted. */
  readonly data: TData;
}

export interface ContextResult<TData extends Readonly<Record<string, unknown>>> {
  readonly data: AwaitedDeep<TData>;
  /**
   * Exact returned Ablo rows, ready to pass to create, update, or delete
   * through `reads`.
   */
  readonly reads: readonly CapturedRow[];
  /** Called once when any exact read in this context becomes stale. */
  readonly onChange: ContextOnChange;
}

export async function context<const TData extends Readonly<Record<string, unknown>>>(
  options: ContextOptions<TData>,
): Promise<ContextResult<TData>> {
  const evidenceBinding = bindContextEvidence(options.ablo);
  const data = await awaitDeep(options.data);
  const parsed = contextDataSchema.safeParse(data);
  if (!parsed.success) {
    throw new TypeError('context() requires `data` to be an object.', { cause: parsed.error });
  }

  const evidence = evidenceBinding.collect(data);
  const dependencies = evidence.map((item) => item.entry);

  return {
    data: data as AwaitedDeep<TData>,
    reads: evidence.map((item) => item.row as CapturedRow),
    onChange: createContextOnChange(dependencies, evidenceBinding.onChange),
  };
}
