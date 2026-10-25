import { AbloStaleContextError, AbloValidationError } from '../../errors.js';
import type { OperationDomain, OperationHistory, OperationSnapshot, OperationEdit, AcceptedOperation } from './contract.js';

function stale(message: string): never {
  throw new AbloStaleContextError(message, { code: 'stale_context' });
}

/** Fold only a contiguous history within one base epoch. Missing edits are unsafe. */
export function foldOperationHistory<Value, Operation>(domain: OperationDomain<Value, Operation>, input: OperationHistory<Value, Operation>): OperationSnapshot<Value> {
  const history = domain.schemas.history.parse(input);
  let snapshot = history.base;
  const ids = new Set<string>();
  for (const edit of history.edits) {
    if (edit.epoch !== snapshot.epoch || edit.version !== snapshot.version + 1 || ids.has(edit.id)) {
      stale('Operation history is incomplete or belongs to a different base.');
    }
    ids.add(edit.id);
    snapshot = {
      epoch: edit.epoch,
      version: edit.version,
      value: domain.apply(snapshot.value, edit.operation),
    };
  }
  return snapshot;
}

/** Caller must lock, validate, persist the edit and write its resulting value atomically. */
export function reconcileOperation<Value, Operation>(
  domain: OperationDomain<Value, Operation>,
  history: OperationHistory<Value, Operation>,
  input: OperationEdit<Operation>,
  authoritativeValue: Value,
): AcceptedOperation<Operation> {
  const edit = domain.schemas.edit.parse(input);
  const head = foldOperationHistory(domain, history);
  if (head.value !== authoritativeValue) stale('The stored value changed outside its edit history.');
  if (
    edit.epoch !== head.epoch || edit.baseVersion < history.base.version ||
    edit.baseVersion > head.version
  ) {
    stale('The operation edit basis is unavailable. Reload before editing.');
  }
  if (history.edits.some((accepted) => accepted.id === edit.id)) {
    throw new AbloValidationError('Operation edit was already accepted; replay its original receipt.', { code: 'invalid_input' });
  }
  if (head.version === Number.MAX_SAFE_INTEGER) stale('Operation revision limit reached. Reload from a new base.');

  let operation = edit.operation;
  if (domain.requiresHistory) {
    const prefix = history.edits.slice(0, edit.baseVersion - history.base.version);
    const basis = foldOperationHistory(domain, { base: history.base, edits: prefix });
    domain.apply(basis.value, edit.operation);
    for (const accepted of history.edits.slice(prefix.length)) {
      operation = domain.transform(operation, accepted.operation, 'right');
    }
  }
  domain.apply(head.value, operation);
  return { id: edit.id, epoch: edit.epoch, version: head.version + 1, operation };
}
