'use client';

import { type ReactNode } from 'react';
import { useSyncStatus } from './useSyncStatus';

/**
 * Render `fallback` until the nearest `<AbloProvider>` reports
 * `connected`. Mirrors Liveblocks' `<ClientSideSuspense>` — a thin
 * gate component that replaces ad-hoc `if (!isReady) return <Skeleton />`
 * checks scattered across the tree.
 *
 * v0.3.0 implementation is non-Suspense based: it reads
 * `useSyncStatus()` and conditionally renders. v0.3.1 will ship a
 * `@ablo/sync-engine/react/suspense` subpath where `useQuery` /
 * `useOne` actually throw Promises; at that point, this component
 * becomes a thin wrapper around `<Suspense>` and the gate logic
 * disappears.
 *
 * @example
 * <AbloProvider {...props}>
 *   <ClientSideSuspense fallback={<Skeleton />}>
 *     <App />
 *   </ClientSideSuspense>
 * </AbloProvider>
 */
export interface ClientSideSuspenseProps {
  /** What to render before the sync engine is ready. */
  fallback: ReactNode;
  /** What to render after the sync engine is ready. */
  children: ReactNode;
}

export function ClientSideSuspense({ fallback, children }: ClientSideSuspenseProps) {
  const status = useSyncStatus();
  // `connected`, `reconnecting`, and `disconnected` all mean the
  // store has already hydrated — UI can render. Only gate on
  // `initial` / `connecting` / `needs-auth` states.
  if (status.name === 'initial' || status.name === 'connecting' || status.name === 'needs-auth') {
    return <>{fallback}</>;
  }
  return <>{children}</>;
}
