import { AbloStaleContextError } from '../../errors.js';
import type { OperationDomain, OperationHistory, OperationSnapshot, OperationEdit } from './contract.js';
import { foldOperationHistory, reconcileOperation } from './history.js';
import { OperationSession } from './session.js';

/** The authoring context of one queued edit, retained in its primary mutation record. */
export interface OperationContext<Value, Operation> {
  snapshot: OperationSnapshot<Value>;
  pending: { id: string; operation: Operation }[];
}

/** Rebuild a projection from durable intent; this never seals or rewrites a request. */
export function rebaseOperationContext<Value, Operation>(
  domain: OperationDomain<Value, Operation>,
  input: OperationContext<Value, Operation>,
  accepted: OperationHistory<Value, Operation>,
): OperationContext<Value, Operation> {
  const history = domain.schemas.history.parse(accepted);
  const head = foldOperationHistory(domain, history);
  const context = domain.schemas.state.parse(input);
  if (context.snapshot.epoch !== head.epoch || context.snapshot.version < history.base.version || context.snapshot.version > head.version) {
    throw new AbloStaleContextError('The queued edit context is unavailable. Keep its mutation record for explicit recovery.', { code: 'stale_context' });
  }
  const basis = foldOperationHistory(domain, { ...history, edits: history.edits.filter((edit) => edit.version <= context.snapshot.version) });
  if (basis.value !== context.snapshot.value) {
    throw new AbloStaleContextError('The queued edit snapshot disagrees with accepted history.', { code: 'stale_context' });
  }
  const session = new OperationSession(domain, context);
  for (const edit of history.edits) {
    if (edit.version <= context.snapshot.version) continue;
    // An ancestor can have been dispatched after this descendant was journaled.
    // Its accepted identity and transformed result prove acknowledgement here.
    session.nextEdit();
    session.receive(edit);
  }
  const { snapshot, pending } = session.exportState();
  return { snapshot, pending };
}

export function appendContextOperation<Value, Operation>(
  domain: OperationDomain<Value, Operation>, context: OperationContext<Value, Operation>,
  id: string, operation: Operation,
): OperationContext<Value, Operation> {
  const session = new OperationSession(domain, context);
  session.edit(id, operation);
  const { snapshot, pending } = session.exportState();
  return { snapshot, pending };
}

/** An explicitly versioned model write is independent of earlier local edits. */
export function appendIndependentOperation<Value, Operation>(
  domain: OperationDomain<Value, Operation>, context: OperationContext<Value, Operation>,
  history: OperationHistory<Value, Operation>, input: OperationEdit<Operation>,
): OperationContext<Value, Operation> {
  const edit = domain.schemas.edit.parse(input);
  if (history.edits.some((accepted) => accepted.id === edit.id && accepted.epoch === edit.epoch)) return context;
  let operation = reconcileOperation(domain, history, edit, context.snapshot.value).operation;
  for (const previous of context.pending) operation = domain.transform(operation, previous.operation, 'right');
  return appendContextOperation(domain, context, edit.id, operation);
}

/** Only the causal head can acquire a server basis, immediately before sealing. */
export function prepareContextOperation<Value, Operation>(
  domain: OperationDomain<Value, Operation>, context: OperationContext<Value, Operation>,
  history: OperationHistory<Value, Operation>, id: string,
): OperationEdit<Operation> {
  const rebased = rebaseOperationContext(domain, context, history);
  const first = rebased.pending[0];
  if (!first || first.id !== id) {
    throw new AbloStaleContextError('An earlier local edit is not accepted. The dependent mutation is retained for recovery.', { code: 'stale_context' });
  }
  return domain.schemas.edit.parse({ ...first, epoch: rebased.snapshot.epoch, baseVersion: rebased.snapshot.version });
}
