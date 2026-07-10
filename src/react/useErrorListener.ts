'use client';

import { useContext, useEffect, useRef } from 'react';
import { AbloInternalContext } from './internalContext.js';
import { AbloValidationError } from '../errors.js';

/**
 * Registers a callback that runs whenever the provider surfaces an error. This
 * covers engine errors such as bootstrap failures and mutation rejections,
 * WebSocket errors, and uncaught exceptions thrown inside `postBootstrap`
 * hooks.
 *
 * Use it for side effects that should not cause a re-render — telemetry,
 * logging, or a toast. The callback is held in a ref, so a re-render does not
 * resubscribe.
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
        'Wrap your tree with <AbloProvider ...> from @abloatai/ablo/react.',
      { code: 'no_ablo_provider' },
    );
  }

  // Hold the latest callback in a ref so the subscription stays stable across
  // renders. Late-binding the listener this way lets callers pass an inline
  // arrow without resubscribing on every render.
  const ref = useRef(listener);
  ref.current = listener;

  useEffect(() => {
    return ctx.subscribeError((err) => { ref.current(err); });
  }, [ctx]);
}
