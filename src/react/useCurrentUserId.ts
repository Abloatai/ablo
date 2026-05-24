'use client';

import { useContext } from 'react';
import { AbloInternalContext } from './internalContext.js';
import { AbloValidationError } from '../errors.js';

/**
 * Returns the app user ID passed to the nearest `<AbloProvider>`, when
 * the app chose to provide one.
 *
 * Hosted Ablo identity is resolved server-side from the API key, session,
 * or capability token. This hook is only for app-owned fields like
 * `assigneeId`; it is not required for Ablo sync to connect.
 *
 * Use this in leaf components that need the current user ID for
 * mutation payloads, presence labels, permission checks, etc.
 * @example
 * function TaskRow({ id }) {
 *   const userId = useCurrentUserId();
 *   const ablo = useAblo();
 *   if (!userId) return null;
 *   return <button onClick={() => ablo?.tasks.update(id, { assigneeId: userId })}>
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
        '@ablo/sync-engine/react.',
      { code: 'no_ablo_provider' },
    );
  }
  return ctx.currentUserId;
}
