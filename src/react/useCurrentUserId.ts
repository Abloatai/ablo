'use client';

import { useContext } from 'react';
import { AbloInternalContext } from './internalContext';
import { AbloValidationError } from '../errors';

/**
 * Returns the user ID passed to the nearest `<AbloProvider>`.
 *
 * Stable until the provider remounts (which happens when the
 * `userId` prop changes — in that case the whole sync engine is
 * rotated anyway).
 *
 * Use this in leaf components that need the current user ID for
 * mutation payloads, presence labels, permission checks, etc.
 * Prefer this over reading `store.currentUserId` because:
 *
 *   1. It's sourced from the provider's props, not from a mutable
 *      field on the store — no risk of "current user ID out of sync
 *      with the active session" bugs.
 *   2. It's a plain string, not an observable — no MobX tracking
 *      overhead and no need to wrap the consumer in `observer()`.
 *
 * @example
 * function TaskRow({ id }) {
 *   const userId = useCurrentUserId();
 *   const mutate = useMutate('tasks');
 *   return <button onClick={() => mutate.update({ id, assigneeId: userId })}>
 *     Assign to me
 *   </button>;
 * }
 */
export function useCurrentUserId(): string {
  const ctx = useContext(AbloInternalContext);
  if (!ctx) {
    throw new AbloValidationError(
      'useCurrentUserId: no <AbloProvider> mounted above this component. ' +
        'Wrap your tree with <AbloProvider userId={...} ...> from ' +
        '@ablo/sync-engine/react.',
      { code: 'no_ablo_provider' },
    );
  }
  return ctx.currentUserId;
}
