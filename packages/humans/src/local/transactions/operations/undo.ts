import { counterEditValueSchema, textEditValueSchema } from '@abloatai/transaction/commit';
import type { ModelMetadata } from '@abloatai/transaction/types';
import type { InverseOp } from '../../mutators/inverseOp.js';
import type { SyncStoreContract } from '../../storeContract.js';
import type { MutationOrigin } from '../mutations/commitPayload.js';

type Reversal = Extract<InverseOp, { kind: 'reverse-operation' }>;

export function fieldOperationUndo(modelKey: string, id: string, next: Record<string, unknown>, previous: Record<string, unknown>, fields: ModelMetadata['fields']): Reversal | null {
  for (const [field, value] of Object.entries(next)) {
    const domain = fields?.[field]?.merge;
    const editId = domain === 'text' ? textEditValueSchema.safeParse(value).data?.$text.id
      : domain === 'counter' ? counterEditValueSchema.safeParse(value).data?.$increment.id : undefined;
    if (!domain || !editId) continue;
    const patch = { ...previous };
    delete patch[field];
    delete patch.id;
    return { kind: 'reverse-operation', modelKey, id, field, domain, editId, patch };
  }
  return null;
}

/** Undo and redo themselves enter the normal model write and confirmation path. */
export async function reverseFieldOperation(store: SyncStoreContract, op: Reversal, origin?: MutationOrigin): Promise<Reversal> {
  const model = store.pool.get(op.id);
  if (!model || !store.write || !store.inverseModelOperation) throw new Error('Operation undo requires the model mutation runtime.');
  const inverse = await store.inverseModelOperation(op.domain, { model: model.getModelName(), id: op.id, field: op.field }, op.editId);
  const patch = Object.fromEntries(Object.keys(op.patch).map((field) => [field, Reflect.get(model, field)]));
  await store.write(model, { ...op.patch, [op.field]: inverse }, origin);
  const editId = '$text' in inverse ? inverse.$text.id : inverse.$increment.id;
  return { ...op, editId, patch };
}

/** Each replay's actual inverse replaces its paired semantic action, including grouped edits. */
export function replaceOperationReversals(paired: InverseOp[], reversals: Reversal[]): InverseOp[] {
  const remaining = [...reversals].reverse();
  return paired.map((op) => {
    const index = remaining.findIndex((reverse) => reverse.modelKey === op.modelKey &&
      (op.kind === 'reverse-operation' ? op.id === reverse.id && op.field === reverse.field
        : op.kind === 'update' && op.patch.id === reverse.id && Object.hasOwn(op.patch, reverse.field)));
    if (index < 0) return op;
    return remaining.splice(index, 1)[0] ?? op;
  });
}
