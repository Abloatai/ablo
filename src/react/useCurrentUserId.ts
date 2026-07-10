'use client';

import { useContext } from 'react';
import { AbloInternalContext } from './internalContext.js';
import { AbloValidationError } from '../errors.js';

/**
 * Returns the application user id passed to the nearest `<AbloProvider>`, or
 * `null` when your app did not provide one.
 *
 * Sync identity is resolved on the server from the API key or session, so this
 * value is not required for sync to connect. It is here for your app's own
 * fields — an assignee id, a presence label, a permission check — where the
 * current user matters to your data rather than to the sync layer. Reach for it
 * in leaf components that need the id, for example to fill in a mutation
 * payload.
 *
 * @example
 * function TaskRow({ id }) {
 *   const userId = useCurrentUserId();
 *   const ablo = useAblo();
 *   if (!userId) return null;
 *   return <button onClick={() => ablo?.tasks.update({ id, data: { assigneeId: userId } })}>
 *     Assign to me
 *   </button>;
 * }
 */
export function useCurrentUserId(): string | null {
  const ctx = useContext(AbloInternalContext);
  if (!ctx) {
    throw new AbloValidationError(
      'useCurrentUserId: no <AbloProvider> mounted above this component. ' +
        'Wrap your tree with <AbloProvider ...> from ' +
        '@abloatai/ablo/react.',
      { code: 'no_ablo_provider' },
    );
  }
  return ctx.currentUserId;
}
