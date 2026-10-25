import { AbloStaleContextError } from '@abloatai/transaction/errors';
import { foldOperationHistory, type AcceptedOperationReference, type OperationDomain } from '@abloatai/transaction/commit';

/** A history read may be ahead of the received frame; only its proved prefix belongs here. */
export function historyForAcceptedRow<Value, Operation>(
  domain: OperationDomain<Value, Operation>, input: unknown, value: unknown,
  reference?: AcceptedOperationReference,
) {
  let history = domain.schemas.history.parse(input);
  if (reference) {
    if (history.base.epoch !== reference.epoch || history.base.version > reference.version) {
      throw new AbloStaleContextError('The received operation is outside retained history. Preserve pending intent for recovery.', { code: 'stale_context' });
    }
    history = { ...history, edits: history.edits.filter((edit) => edit.version <= reference.version) };
  }
  const head = foldOperationHistory(domain, history);
  if (head.value !== value || (reference && (head.version !== reference.version ||
    (head.version > history.base.version && history.edits.at(-1)?.id !== reference.id)))) {
    throw new AbloStaleContextError('The received row disagrees with its operation history. Preserve pending intent for recovery.', { code: 'stale_context' });
  }
  return history;
}
