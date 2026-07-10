'use client';

import { useContext, useEffect, useRef } from 'react';
import { AbloInternalContext } from './internalContext.js';
import { AbloValidationError } from '../errors.js';
import type { Transaction } from '../transactions/TransactionQueue.js';

export interface MutationFailurePayload {
  transaction: Transaction;
  error: Error;
  permanent?: boolean;
}

/**
 * Subscribes a listener to mutation failures. The callback fires whenever the
 * transaction queue rolls back an optimistic write — both permanent rejections
 * (a validation, foreign-key, or authorization error) and rollbacks after the
 * retries are exhausted (for example, the connection drops mid-write).
 *
 * A single listener mounted near the top of your component tree can turn these
 * otherwise-silent rollbacks into toasts or banners. The callback is held in a
 * ref, so re-renders do not tear down and re-create the underlying
 * subscription.
 *
 * @example
 * function MutationFailureBoundary() {
 *   useMutationFailureListener(({ transaction, error }) => {
 *     toast.error(`Couldn't save ${transaction.modelName}: ${error.message}`);
 *   });
 *   return null;
 * }
 */
export function useMutationFailureListener(
  listener: (payload: MutationFailurePayload) => void,
): void {
  const ctx = useContext(AbloInternalContext);
  if (!ctx) {
    throw new AbloValidationError(
      'useMutationFailureListener: no <AbloProvider> mounted above this component. ' +
        'Wrap your tree with <AbloProvider ...> from @abloatai/ablo/react.',
      { code: 'no_ablo_provider' },
    );
  }

  const ref = useRef(listener);
  ref.current = listener;

  useEffect(() => {
    const engine = ctx.engine;
    if (!engine) return;
    return engine.onMutationFailure((payload) => { ref.current(payload); });
  }, [ctx, ctx.engine]);
}
