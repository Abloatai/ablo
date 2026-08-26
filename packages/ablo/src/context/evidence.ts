import {
  evidenceForRow,
  readEvidenceBinding,
  type CapturedReadEvidence,
  type ReadEvidenceBinding,
} from '@abloatai/transaction/internal/read-set';
import type { ReadDependency } from '@abloatai/transaction/coordination';
import type { AbloStaleContextError } from '@abloatai/transaction';

function isTraversable(value: object): value is Record<string, unknown> | readonly unknown[] {
  if (Array.isArray(value)) return true;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function inspectValue(
  binding: ReadEvidenceBinding,
  value: unknown,
): readonly CapturedReadEvidence[] {
  const found: CapturedReadEvidence[] = [];
  const seen = new WeakSet<object>();

  const visit = (current: unknown): void => {
    if (typeof current !== 'object' || current === null) return;
    if (seen.has(current)) return;
    seen.add(current);
    const captured = evidenceForRow(binding, current);
    if (captured) {
      found.push(captured);
      return;
    }
    if (isTraversable(current)) {
      for (const child of Object.values(current)) visit(child);
    }
  };

  visit(value);
  return [...new Map(found.map((item) => [item.row, item])).values()];
}

export interface BoundContextEvidence {
  readonly collect: (data: unknown) => readonly CapturedReadEvidence[];
  readonly onChange?: (
    reads: readonly ReadDependency[],
    listener: (error: AbloStaleContextError) => void,
  ) => () => void;
}

export function bindContextEvidence(client: object): BoundContextEvidence {
  const binding = readEvidenceBinding(client);
  if (!binding) throw new TypeError('context() requires an Ablo client in `ablo`.');

  return {
    collect: (data) => inspectValue(binding, data),
    ...(binding.onChange ? { onChange: binding.onChange } : {}),
  };
}
