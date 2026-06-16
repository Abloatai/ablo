'use client';

import { useCallback } from 'react';
import { useSyncContext } from './context.js';
import type { SyncStoreContract } from './context.js';
import { useReactive } from './useReactive.js';

/**
 * Reactive sync-status snapshot as a discriminated union. Impossible
 * states (e.g., "connected AND offline") are unrepresentable — each
 * variant carries only the fields that make sense in that state.
 *
 * Inspired by Liveblocks' `useStatus()` and Zero's `useConnectionState()`:
 * one hook, one switch, no six-boolean guessing games.
 *
 * Variants:
 * - `initial` — the provider just mounted; no connection attempt yet.
 * - `connecting` — bootstrap in progress. `progress` is 0–100 and
 *    can drive a determinate progress bar.
 * - `connected` — hydrated and listening. `hasUnsyncedChanges` is
 *    true while local writes are waiting for server ack; flip it into
 *    "Saving…" UI.
 * - `reconnecting` — WebSocket dropped and the client is retrying.
 *    `reason` carries the human-readable close reason when available.
 * - `disconnected` — network failure, server error, or the retry loop
 *    gave up. Show the offline / error UI.
 * - `needs-auth` — server rejected the auth token (1008/4001/4003). The
 *    consumer's `onSessionExpired` callback has already been invoked
 *    by `<AbloProvider>`; this variant exists for UI that wants to
 *    reflect the auth state itself.
 */
export type SyncStatusSnapshot =
  | { readonly name: 'initial' }
  | { readonly name: 'connecting'; readonly progress: number }
  | { readonly name: 'connected'; readonly hasUnsyncedChanges: boolean }
  | { readonly name: 'reconnecting'; readonly reason?: string }
  | { readonly name: 'disconnected'; readonly reason?: string }
  | { readonly name: 'needs-auth' };

/**
 * Reactive sync-status hook. Bridges MobX `store.syncStatus` +
 * `store.isReady` into React via `useReactive` — concurrent-render
 * safe and immune to the React #185 "getSnapshot should be cached"
 * infinite-loop class of bugs.
 *
 * @example
 * function StatusPill() {
 *   const status = useSyncStatus();
 *   switch (status.name) {
 *     case 'initial':
 *     case 'connecting':     return <Pill progress={status.name === 'connecting' ? status.progress : 0}>Loading…</Pill>;
 *     case 'connected':      return status.hasUnsyncedChanges ? <Pill>Saving…</Pill> : null;
 *     case 'reconnecting':   return <Pill title={status.reason}>Reconnecting…</Pill>;
 *     case 'disconnected':   return <Pill title={status.reason}>Offline</Pill>;
 *     case 'needs-auth':     return null;
 *   }
 * }
 */
export function useSyncStatus(): SyncStatusSnapshot {
  const { store } = useSyncContext();
  // `useReactive` tracks the MobX observables read inside deriveStatus
  // (syncStatus.state/progress/pendingChanges/isSessionError/error +
  // the computed isReady), caches the result by shape, and only
  // notifies React when a variant transition actually occurs.
  //
  // Stabilize the closure on `store` identity so useReactive's
  // swap-detection doesn't see a "swap" every render and unnecessarily
  // re-subscribe its MobX reaction.
  const compute = useCallback(() => deriveStatus(store), [store]);
  return useReactive(compute, sameSnapshot);
}

/** Map the current store state into the discriminated union. */
function deriveStatus(store: SyncStoreContract): SyncStatusSnapshot {
  const { state, progress, pendingChanges, isSessionError, error } = store.syncStatus;

  if (isSessionError) {
    return { name: 'needs-auth' };
  }
  if (state === 'reconnecting') {
    return { name: 'reconnecting', reason: error?.message };
  }
  if (state === 'offline') {
    return { name: 'disconnected', reason: 'offline' };
  }
  if (state === 'error') {
    return { name: 'disconnected', reason: error?.message };
  }
  if (store.isReady) {
    return { name: 'connected', hasUnsyncedChanges: pendingChanges > 0 };
  }
  // state is 'idle' or 'syncing' and not yet ready — bootstrap underway.
  if (state === 'idle' || state === 'syncing') {
    return { name: 'connecting', progress };
  }
  return { name: 'initial' };
}

function sameSnapshot(a: SyncStatusSnapshot, b: SyncStatusSnapshot): boolean {
  if (a.name !== b.name) return false;
  switch (a.name) {
    case 'initial':
    case 'needs-auth':
      return true;
    case 'connecting':
      return a.progress === (b as { progress: number }).progress;
    case 'connected':
      return a.hasUnsyncedChanges === (b as { hasUnsyncedChanges: boolean }).hasUnsyncedChanges;
    case 'reconnecting':
    case 'disconnected':
      return a.reason === (b as { reason?: string }).reason;
  }
}
