'use client';

import { useContext } from 'react';
import { AbloInternalContext } from './internalContext.js';
import { AbloValidationError } from '@ablo/transaction/errors';

/** Returns the application user id supplied to the nearest AbloProvider. */
export function useCurrentUserId(): string | null {
  const context = useContext(AbloInternalContext);
  if (!context) {
    throw new AbloValidationError(
      'useCurrentUserId: no <AbloProvider> mounted above this component.',
      { code: 'no_ablo_provider' },
    );
  }
  return context.currentUserId;
}
