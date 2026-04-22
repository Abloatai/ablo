/**
 * Async test helpers for timing-sensitive sync engine tests.
 */

import { AbloConnectionError } from '../../errors';

/**
 * Flush all pending microtasks (Promise.resolve, queueMicrotask).
 * Critical for testing TransactionQueue's microtask batching.
 */
export function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => {
    // Use setTimeout(0) to yield to the microtask queue
    setTimeout(resolve, 0);
  });
}

/**
 * Wait for a condition to become true, polling at intervals.
 * Times out after maxWait ms.
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
 * Wait for N milliseconds. Use sparingly — prefer flushMicrotasks() or waitFor().
 */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run a callback after flushing microtasks.
 * Useful for asserting state after TransactionQueue batch processing.
 */
export async function afterMicrotasks<T>(fn: () => T): Promise<T> {
  await flushMicrotasks();
  return fn();
}
