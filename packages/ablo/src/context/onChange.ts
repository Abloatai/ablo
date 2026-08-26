import type { ReadDependency } from '@abloatai/transaction/coordination';
import type { AbloStaleContextError } from '@abloatai/transaction';

export type ContextChangeListener = (error: AbloStaleContextError) => void;
export type ContextOnChange = (listener: ContextChangeListener) => () => void;

type StartOnChange = (
  reads: readonly ReadDependency[],
  listener: ContextChangeListener,
) => () => void;

/** Share one transport subscription for every listener on one context. */
export function createContextOnChange(
  reads: readonly ReadDependency[],
  start: StartOnChange | undefined,
): ContextOnChange {
  const listeners = new Set<ContextChangeListener>();
  let stop: (() => void) | undefined;
  let stale: AbloStaleContextError | undefined;

  const changed = (error: AbloStaleContextError): void => {
    if (stale) return;
    stale = error;
    stop?.();
    stop = undefined;
    for (const listener of [...listeners]) listener(error);
  };

  return (listener) => {
    if (stale) {
      listener(stale);
      return () => undefined;
    }

    listeners.add(listener);
    if (reads.length > 0 && !stop) {
      if (!start) {
        listeners.delete(listener);
        throw new TypeError('This Ablo client does not support context().onChange.');
      }
      stop = start(reads, changed);
    }

    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) {
        stop?.();
        stop = undefined;
      }
    };
  };
}
