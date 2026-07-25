/**
 * Asynchronous helpers for tests whose assertions depend on timing — for
 * flushing pending work, polling for a condition, or waiting a fixed delay.
 */

import { AbloConnectionError } from '@abloatai/transaction/errors';

/**
 * Flushes all pending microtasks, such as resolved promises and
 * `queueMicrotask` callbacks. Useful for testing work the transaction queue
 * batches on the microtask queue.
 */
export function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => {
    // Use setTimeout(0) to yield to the microtask queue
    setTimeout(resolve, 0);
  });
}

/**
 * Polls `condition` until it returns true, checking every `interval`
 * milliseconds. Rejects with an {@link AbloConnectionError} if `maxWait`
 * milliseconds pass first.
 */
export async function waitFor(
  condition: () => boolean,
  options: { maxWait?: number; interval?: number } = {}
): Promise<void> {
  const { maxWait = 5000, interval = 10 } = options;
  const start = Date.now();

  while (!condition()) {
    if (Date.now() - start > maxWait) {
      throw new AbloConnectionError(`waitFor timed out after ${maxWait}ms`, {
        code: 'wait_for_timeout',
      });
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}

/**
 * Waits for the given number of milliseconds. Use sparingly; prefer
 * {@link flushMicrotasks} or {@link waitFor}, which don't tie tests to
 * wall-clock time.
 */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Flushes pending microtasks, then runs `fn` and returns its result. Handy
 * for asserting state after the transaction queue processes a batch.
 */
export async function afterMicrotasks<T>(fn: () => T): Promise<T> {
  await flushMicrotasks();
  return fn();
}
