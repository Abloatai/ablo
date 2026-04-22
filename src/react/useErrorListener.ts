'use client';

import { useContext, useEffect, useRef } from 'react';
import { AbloInternalContext } from './internalContext';
import { AbloValidationError } from '../errors';

/**
 * Register an imperative callback that fires whenever the provider
 * surfaces an error. Covers engine errors (bootstrap failures,
 * mutation rejections), WebSocket errors, and uncaught exceptions
 * inside `postBootstrap` hooks.
 *
 * Use this for telemetry (Sentry, Datadog), user-facing toasts, or
 * any side effect that should NOT trigger a re-render. The listener
 * is stored in a ref, so re-renders don't thrash the subscription.
 *
 * @example
 * function ErrorToaster() {
 *   useErrorListener((err) => {
 *     toast.error(err.message);
 *     Sentry.captureException(err);
 *   });
 *   return null;
 * }
 */
export function useErrorListener(listener: (error: Error) => void): void {
  const ctx = useContext(AbloInternalContext);
  if (!ctx) {
    throw new AbloValidationError(
      'useErrorListener: no <AbloProvider> mounted above this component. ' +
        'Wrap your tree with <AbloProvider ...> from @ablo/sync-engine/react.',
      { code: 'no_ablo_provider' },
    );
  }

  // Stash the latest callback in a ref so the effect subscription
  // stays stable across renders. Matches the `useEventCallback`
  // pattern: late-bind the listener so callers can pass inline
  // arrows without thrashing the subscription.
  const ref = useRef(listener);
  ref.current = listener;

  useEffect(() => {
    return ctx.subscribeError((err) => ref.current(err));
  }, [ctx]);
}
