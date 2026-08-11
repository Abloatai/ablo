import {
  evidenceForRow,
  readEvidenceBinding,
  type CapturedReadEvidence,
  type ReadEvidenceBinding,
} from '@abloatai/transaction/internal/read-set';

function isTraversable(value: object): value is Record<string, unknown> | readonly unknown[] {
  if (Array.isArray(value)) return true;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export interface ContextEvidenceSlice {
  readonly reads: readonly CapturedReadEvidence[];
  readonly includesInformational: boolean;
}

function inspectValue(
  binding: ReadEvidenceBinding,
  value: unknown,
): ContextEvidenceSlice {
  const found: CapturedReadEvidence[] = [];
  const seen = new WeakSet<object>();
  let includesInformational = false;

  const visit = (current: unknown): void => {
    if (typeof current !== 'object' || current === null) {
      includesInformational = true;
      return;
    }
    if (seen.has(current)) return;
    seen.add(current);
    const captured = evidenceForRow(binding, current);
    if (captured) {
      found.push(captured);
      return;
    }
    if (isTraversable(current)) {
      const children = Object.values(current);
      if (children.length === 0) includesInformational = true;
      for (const child of children) visit(child);
      return;
    }
    includesInformational = true;
  };

  visit(value);
  return {
    reads: [...new Map(found.map((item) => [item.row, item])).values()],
    includesInformational,
  };
}

export interface ContextEvidence {
  readonly all: readonly CapturedReadEvidence[];
  readonly inspect: (value: unknown) => ContextEvidenceSlice;
}

export function bindContextEvidence(client: object): (data: unknown) => ContextEvidence {
  const binding = readEvidenceBinding(client);
  if (!binding) throw new TypeError('context() requires an Ablo client in `ablo`.');

  return (data) => {
    const inspect = (value: unknown) => inspectValue(binding, value);
    return {
      all: inspect(data).reads,
      inspect,
    };
  };
}
