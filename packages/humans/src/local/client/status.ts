import type { SyncStoreContract } from '../storeContract.js';

/** The client lifecycle, shared by every framework binding. */
export type ClientStatus =
  | { readonly name: 'initial' }
  | { readonly name: 'connecting'; readonly progress: number }
  | { readonly name: 'connected'; readonly hasUnsyncedChanges: boolean }
  | { readonly name: 'reconnecting'; readonly reason?: string }
  | { readonly name: 'disconnected'; readonly reason?: string }
  | { readonly name: 'needs-auth' };

export function readStatus(store: SyncStoreContract): ClientStatus {
  const { state, progress, pendingChanges, isSessionError, error } = store.syncStatus;
  if (isSessionError) return { name: 'needs-auth' };
  if (state === 'reconnecting') return { name: 'reconnecting', reason: error?.message };
  if (state === 'offline') return { name: 'disconnected', reason: 'offline' };
  if (state === 'error') return { name: 'disconnected', reason: error?.message };
  if (store.isReady) return { name: 'connected', hasUnsyncedChanges: pendingChanges > 0 };
  return { name: 'connecting', progress };
}
