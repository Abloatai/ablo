/**
 * OfflineFlush — Replays queued offline mutations on reconnect.
 *
 * SDK-generic version: delegates to MutationDispatcher from context.
 */

import { OfflineTransactionStore } from './OfflineTransactionStore';
import { getContext } from '../context';

let _offlineTxStore: OfflineTransactionStore | null = null;

function getOfflineTxStore(): OfflineTransactionStore {
  if (!_offlineTxStore) {
    _offlineTxStore = new OfflineTransactionStore();
  }
  return _offlineTxStore;
}

export async function flushOfflineQueueOnce(): Promise<{ processed: number; failed: number }> {
  const store = getOfflineTxStore();
  await store.init();
  const dispatcher = getContext().mutationDispatcher;
  return store.flush(async (tx) => {
    await dispatcher.dispatch(tx.opName, tx.request.variables || {});
  });
}
