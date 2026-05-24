'use client';

import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { AbloValidationError } from '../errors.js';

/**
 * Narrow context for a per-entity sync-group scope. Maps directly onto
 * Liveblocks' `<RoomProvider id="...">`: wrap a subtree, and any hooks
 * inside can read `useSyncGroup()` to discover "which entity am I
 * scoped to?" without threading the ID through props.
 *
 * Typical IDs follow the multiplayer sync-group convention: `matter:<id>`,
 * `deck:<id>`, `project:<id>`. The ID is an opaque string — the
 * provider doesn't parse it.
 *
 * v0.3.0 scope: this is a thin passthrough. Future versions will
 * scope `useQuery` / `useOne` results to the group automatically.
 */
const SyncGroupContext = createContext<string | null>(null);

export interface SyncGroupProviderProps {
  /** The sync-group identifier — e.g., `matter:abc-123`, `deck:xyz`. */
  id: string;
  children: ReactNode;
}

export function SyncGroupProvider({ id, children }: SyncGroupProviderProps) {
  // Stabilize the context value so consumers memoized on it don't
  // re-render when the provider re-renders for unrelated reasons.
  const value = useMemo(() => id, [id]);
  return <SyncGroupContext.Provider value={value}>{children}</SyncGroupContext.Provider>;
}

/**
 * Returns the ID of the nearest `<SyncGroupProvider>`. Throws if
 * called outside one — sync-group awareness is mandatory by design,
 * so the error points the consumer at the provider instead of
 * returning undefined and letting downstream code silently miss scope.
 *
 * If a component legitimately renders both inside and outside a
 * group, structure the tree so the hook is only called on the
 * inside path (e.g., split into two components). Silent nulls are
 * never the right answer.
 */
export function useSyncGroup(): string {
  const id = useContext(SyncGroupContext);
  if (!id) {
    throw new AbloValidationError(
      'useSyncGroup: no <SyncGroupProvider> mounted above this component. ' +
        'Wrap your tree with <SyncGroupProvider id="matter:..."> from ' +
        '@ablo/sync-engine/react.',
      { code: 'no_sync_group_provider' },
    );
  }
  return id;
}
