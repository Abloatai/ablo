import { z } from 'zod';
import { textDomain, counterDomain, textHistorySchema, counterHistorySchema, textEditValueSchema, counterEditValueSchema,
  appendIndependentOperation, rebaseOperationContext, foldOperationHistory,
  type OperationDomain, type OperationHistory, type OperationContext, type OperationEdit } from '@abloatai/transaction/commit';
import { AbloStaleContextError } from '@abloatai/transaction/errors';
import type { QueuedMutation } from '../mutations/commitPayload.js';

const target = { field: z.string().min(1), editId: z.string().min(1).max(255) };
/** Local journal metadata; never included in the server operation payload. */
export const fieldIntentSchema = z.discriminatedUnion('kind', [
  z.strictObject({ ...target, kind: z.literal('text'), context: textDomain.schemas.state.pick({ snapshot: true, pending: true }) }),
  z.strictObject({ ...target, kind: z.literal('counter'), context: counterDomain.schemas.state.pick({ snapshot: true, pending: true }) }),
]).refine((intent) => intent.context.pending.at(-1)?.id === intent.editId &&
  new Set(intent.context.pending.map((edit) => edit.id)).size === intent.context.pending.length,
  'The local field intent must end with its unique edit identity');

export type FieldIntent = z.infer<typeof fieldIntentSchema>;
export type FieldMutation = Pick<QueuedMutation, 'data' | 'fieldIntent'>;

export function containsFieldIntentAncestor(intent: FieldIntent, inputs: readonly (Record<string, unknown> | undefined)[]): boolean {
  const ancestors = new Set(intent.context.pending.filter((edit) => edit.id !== intent.editId).map((edit) => edit.id));
  return inputs.some((input) => {
    const id = intent.kind === 'text' ? textEditValueSchema.safeParse(input?.[intent.field]).data?.$text.id
      : counterEditValueSchema.safeParse(input?.[intent.field]).data?.$increment.id;
    return id !== undefined && ancestors.has(id);
  });
}

export function queuedTextContext(history: unknown, pending: readonly FieldMutation[], field: string, acceptedAncestors?: ReadonlySet<string>) {
  return queuedFieldContext(textDomain, textHistorySchema.parse(history), pending.map((tx) => ({
    input: textEditValueSchema.parse(tx.data?.[field]).$text,
    context: tx.fieldIntent?.kind === 'text' && tx.fieldIntent.field === field ? tx.fieldIntent.context : undefined,
  })), acceptedAncestors);
}

export function queuedCounterContext(history: unknown, pending: readonly FieldMutation[], field: string, acceptedAncestors?: ReadonlySet<string>) {
  return queuedFieldContext(counterDomain, counterHistorySchema.parse(history), pending.map((tx) => ({
    input: counterEditValueSchema.parse(tx.data?.[field]).$increment,
    context: tx.fieldIntent?.kind === 'counter' && tx.fieldIntent.field === field ? tx.fieldIntent.context : undefined,
  })), acceptedAncestors);
}

/** The latest record carries the authoring context of its pending ancestors. */
export function queuedFieldContext<Value, Operation>(domain: OperationDomain<Value, Operation>, history: OperationHistory<Value, Operation>, edits: readonly {
  input: OperationEdit<Operation>; context?: OperationContext<Value, Operation>;
}[], acceptedAncestors?: ReadonlySet<string>): OperationContext<Value, Operation> {
  let context: OperationContext<Value, Operation> = { snapshot: foldOperationHistory(domain, history), pending: [] };
  let start = 0;
  for (let index = edits.length - 1; index >= 0; index--) {
    const saved = edits[index]?.context;
    if (!saved) continue;
    context = rebaseOperationContext(domain, saved, history);
    start = index + 1;
    break;
  }
  const pendingIds = new Set(edits.map((edit) => edit.input.id));
  if (context.pending.some((edit) => !pendingIds.has(edit.id) && !acceptedAncestors?.has(edit.id))) {
    throw new AbloStaleContextError('An earlier local edit is missing or rejected. Keep the dependent mutation for recovery.', { code: 'stale_context' });
  }
  for (const edit of edits.slice(start)) context = appendIndependentOperation(domain, context, history, edit.input);
  return context;
}
