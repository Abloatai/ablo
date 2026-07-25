'use client';

import { useContext, useEffect, useRef } from 'react';
import { AbloInternalContext } from './internalContext.js';
import { AbloValidationError } from '@ablo/transaction/errors';

/** Subscribe to provider-level errors without causing component re-renders. */
export function useErrorListener(listener: (error: Error) => void): void {
  const context = useContext(AbloInternalContext);
  if (!context) {
    throw new AbloValidationError(
      'useErrorListener: no <AbloProvider> mounted above this component.',
      { code: 'no_ablo_provider' },
    );
  }
  const listenerRef = useRef(listener);
  listenerRef.current = listener;
  useEffect(
    () => context.subscribeError((error) => listenerRef.current(error)),
    [context],
  );
}
