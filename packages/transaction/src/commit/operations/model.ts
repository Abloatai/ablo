import { AbloStaleContextError } from '../../errors.js';
import type { OperationDomain, OperationEdit, OperationHistory } from './contract.js';
import { foldOperationHistory, reconcileOperation } from './history.js';

/** Project queued intent without rewriting the requests retained by the outbox. */
export function projectFieldEdits<Value, Operation>(
  domain: OperationDomain<Value, Operation>,
  history: OperationHistory<Value, Operation>,
  edits: readonly OperationEdit<Operation>[],
): Value {
  let projected = domain.schemas.history.parse(history);
  let head = foldOperationHistory(domain, projected);
  for (const input of edits) {
    const edit = domain.schemas.edit.parse(input);
    const acceptedEdit = projected.edits.find((accepted) => accepted.id === edit.id);
    if (acceptedEdit) {
      if (acceptedEdit.epoch !== edit.epoch) throw new AbloStaleContextError('The accepted operation belongs to another epoch.', { code: 'stale_context' });
      continue;
    }
    const accepted = reconcileOperation(domain, projected, edit, head.value);
    projected = { ...projected, edits: [...projected.edits, accepted] };
    head = { epoch: accepted.epoch, version: accepted.version, value: domain.apply(head.value, accepted.operation) };
  }
  return head.value;
}

/** An inverse starts immediately after the actual accepted edit, not its submitted basis. */
export function invertAcceptedFieldEdit<Value, Operation>(
  domain: OperationDomain<Value, Operation>,
  input: OperationHistory<Value, Operation>,
  editId: string,
  inverseId: string,
): OperationEdit<Operation> {
  const history = domain.schemas.history.parse(input);
  foldOperationHistory(domain, history);
  let value = history.base.value;
  for (const edit of history.edits) {
    if (edit.id === editId) {
      return domain.schemas.edit.parse({
        id: inverseId, epoch: edit.epoch, baseVersion: edit.version,
        operation: domain.invert(value, edit.operation),
      });
    }
    value = domain.apply(value, edit.operation);
  }
  throw new AbloStaleContextError('The edit to reverse is not in retained history. Keep the undo entry for explicit recovery.', { code: 'stale_context' });
}
