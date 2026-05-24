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
 * Register a side-effect listener for mutation failures. Fires whenever
 * the underlying transaction queue rolls back an optimistic write —
 * permanent rejections (validation, FK, auth) and exhausted-retry
 * rollbacks (connection lost mid-burst).
 *
 * Use this to mount a single `<MutationFailureBoundary>` near the app
 * shell that turns silent pool rollbacks into toasts / banners. The
 * listener is stored in a ref so re-renders don't thrash the
 * subscription — matches `useErrorListener`.
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
        'Wrap your tree with <AbloProvider ...> from @ablo/sync-engine/react.',
      { code: 'no_ablo_provider' },
    );
  }

  const ref = useRef(listener);
  ref.current = listener;

  useEffect(() => {
    const engine = ctx.engine;
    if (!engine) return;
    return engine.onMutationFailure((payload) => ref.current(payload));
  }, [ctx, ctx.engine]);
}
