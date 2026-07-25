'use client';

import { useCallback } from 'react';
import {
  useSyncContext,
  type SyncStoreContract,
} from './context.js';
import { useReactive } from '../useReactive.js';

export type SyncStatusSnapshot =
  | { readonly name: 'initial' }
  | { readonly name: 'connecting'; readonly progress: number }
  | { readonly name: 'connected'; readonly hasUnsyncedChanges: boolean }
  | { readonly name: 'reconnecting'; readonly reason?: string }
  | { readonly name: 'disconnected'; readonly reason?: string }
  | { readonly name: 'needs-auth' };

/** Reactively exposes the local store's connection and settlement status. */
export function useSyncStatus(): SyncStatusSnapshot {
  const { store } = useSyncContext();
  const compute = useCallback(() => deriveStatus(store), [store]);
  return useReactive(compute, sameSnapshot);
}

function deriveStatus(store: SyncStoreContract): SyncStatusSnapshot {
  const { state, progress, pendingChanges, isSessionError, error } = store.syncStatus;
  if (isSessionError) return { name: 'needs-auth' };
  if (state === 'reconnecting') return { name: 'reconnecting', reason: error?.message };
  if (state === 'offline') return { name: 'disconnected', reason: 'offline' };
  if (state === 'error') return { name: 'disconnected', reason: error?.message };
  if (store.isReady) return { name: 'connected', hasUnsyncedChanges: pendingChanges > 0 };
  if (state === 'idle' || state === 'syncing') return { name: 'connecting', progress };
  return { name: 'initial' };
}

function sameSnapshot(a: SyncStatusSnapshot, b: SyncStatusSnapshot): boolean {
  if (a.name !== b.name) return false;
  if (a.name === 'initial' || a.name === 'needs-auth') return true;
  if (a.name === 'connecting') return b.name === 'connecting' && a.progress === b.progress;
  if (a.name === 'connected') return b.name === 'connected' && a.hasUnsyncedChanges === b.hasUnsyncedChanges;
  return (b.name === 'reconnecting' || b.name === 'disconnected') && a.reason === b.reason;
}
