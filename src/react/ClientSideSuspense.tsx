'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { useSyncStatus } from './useSyncStatus.js';

/**
 * Nested bootstrap gate for a subtree. `<AbloProvider>` already ships
 * its own built-in gate (via its `fallback` prop) that handles the
 * common "wait for first bootstrap" case. Use `ClientSideSuspense`
 * only when you need a SEPARATE gate inside an already-ready provider —
 * for example, rendering app chrome immediately while gating a single
 * heavy product surface on its own query resolving.
 *
 * Like the provider-level gate, this component latches open on the
 * first `connected` / `reconnecting` / `disconnected` transition and
 * stays open. Subsequent transient `connecting` states (hard reconnect
 * after offline) do NOT re-show the fallback — the app has already
 * rendered once and its own reconnect UI should take over.
 *
 * v0.3.x implementation is non-Suspense: reads `useSyncStatus()` and
 * conditionally renders. v0.3.x+ will ship a
 * `@ablo/sync-engine/react/suspense` subpath where `useQuery` / `useOne`
 * actually throw Promises; this component becomes a thin wrapper around
 * React's real `<Suspense>` at that point.
 *
 * @example
 * <AbloProvider fallback={<AppSkeleton />}>
 *   <AppChrome />
 *   <ClientSideSuspense fallback={<CanvasSkeleton />}>
 *     <HeavyCanvas />
 *   </ClientSideSuspense>
 * </AbloProvider>
 */
export interface ClientSideSuspenseProps {
  /** What to render while the nested subtree is waiting for first bootstrap. */
  fallback: ReactNode;
  /** What to render once the subtree is cleared to render. */
  children: ReactNode;
}

export function ClientSideSuspense({ fallback, children }: ClientSideSuspenseProps) {
  const status = useSyncStatus();
  const [everConnected, setEverConnected] = useState(false);

  useEffect(() => {
    if (
      status.name === 'connected' ||
      status.name === 'reconnecting' ||
      status.name === 'disconnected'
    ) {
      setEverConnected(true);
    }
  }, [status.name]);

  const showFallback = !everConnected && status.name === 'connecting';
  return <>{showFallback ? fallback : children}</>;
}
