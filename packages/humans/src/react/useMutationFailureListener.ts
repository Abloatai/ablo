'use client';

import { useContext, useEffect, useRef } from 'react';
import {
  AbloInternalContext,
  type QueuedMutation,
} from '../reactRuntime.js';
import { AbloValidationError } from '@abloatai/transaction/errors';

export interface MutationFailurePayload {
  transaction: QueuedMutation;
  error: Error;
  permanent?: boolean;
}

/** Subscribe to optimistic mutation rollbacks and permanent write failures. */
export function useMutationFailureListener(
  listener: (payload: MutationFailurePayload) => void,
): void {
  const context = useContext(AbloInternalContext);
  if (!context) {
    throw new AbloValidationError(
      'useMutationFailureListener: no <AbloProvider> mounted above this component.',
      { code: 'no_ablo_provider' },
    );
  }
  const listenerRef = useRef(listener);
  listenerRef.current = listener;
  useEffect(() => {
    const engine = context.engine;
    if (!engine) return;
    return engine.onMutationFailure((payload) => { listenerRef.current(payload); });
  }, [context, context.engine]);
}
