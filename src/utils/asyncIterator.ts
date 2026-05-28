/**
 * `asyncIteratorFrom` — adapt any callback-subscription primitive
 * into an async iterable.
 *
 * The inputs are two functions:
 *
 *   - `subscribe(onChange): unsubscribe` — the existing reactivity
 *     primitive on `PresenceStream` / `IntentStream`. We register a
 *     listener that enqueues a value every time the source mutates;
 *     we tear it down in `return()`.
 *   - `getSnapshot()` — read the latest value to hand to the
 *     consumer. Called on every mutation notification.
 *
 * Back-pressure: an unlimited queue. If the consumer is slower than
 * the producer (rare for presence — mutations are <1/s per peer),
 * memory grows monotonically inside the iterator. For the current
 * presence workload this is fine; if we ever surface a high-frequency
 * stream (deltas at full firehose) we can bound the queue or drop
 * coalescable values.
 *
 * Multiple iterators: each call to the returned factory creates an
 * independent iterator with its own subscription. Iterators don't
 * steal values from each other — two `for await` loops on the same
 * stream both observe every mutation.
 */
/**
 * Variant of `asyncIteratorFrom` for event-per-iteration streams.
 *
 * Unlike the snapshot variant (where every notification yields the
 * *current value* — coalescing bursts is fine because state is the
 * consumer's concern), this variant yields the *specific value*
 * pushed by each event. Use when the underlying stream delivers
 * discrete events that must not be dropped — e.g. `DeltaEnvelope`
 * firehose.
 *
 * The `subscribe(push): unsubscribe` signature takes a callback that
 * enqueues an event. The consumer's `for await` receives every
 * enqueued value in order.
 */
export function asyncIteratorFromEvents<T>(
  subscribe: (push: (value: T) => void) => () => void,
): AsyncIterableIterator<T> {
  const queue: T[] = [];
  const resolvers: Array<(result: IteratorResult<T>) => void> = [];
  let done = false;

  const push = (value: T) => {
    if (done) return;
    const resolver = resolvers.shift();
    if (resolver) {
      resolver({ value, done: false });
    } else {
      queue.push(value);
    }
  };

  const unsubscribe = subscribe(push);

  const finish = (): IteratorResult<T> => {
    done = true;
    unsubscribe();
    for (const r of resolvers) r({ value: undefined, done: true });
    resolvers.length = 0;
    queue.length = 0;
    return { value: undefined, done: true };
  };

  return {
    async next(): Promise<IteratorResult<T>> {
      if (done) return { value: undefined, done: true };
      if (queue.length > 0) {
        return { value: queue.shift()!, done: false };
      }
      return new Promise<IteratorResult<T>>((resolve) => {
        resolvers.push(resolve);
      });
    },
    async return(): Promise<IteratorResult<T>> {
      return finish();
    },
    async throw(err): Promise<IteratorResult<T>> {
      finish();
      throw err;
    },
    [Symbol.asyncIterator]() {
      return this;
    },
  };
}

export function asyncIteratorFrom<T>(
  subscribe: (listener: () => void) => () => void,
  getSnapshot: () => T,
): AsyncIterableIterator<T> {
  const queue: T[] = [];
  // Pending `next()` callers waiting for a value. Empty when the
  // consumer is keeping up; holds 0-or-1 resolver when they're
  // awaiting. We never hold more than one at a time — a consumer
  // that calls `next()` twice without awaiting the first breaks
  // the async-iterator contract.
  const resolvers: Array<(result: IteratorResult<T>) => void> = [];
  let done = false;

  const push = () => {
    if (done) return;
    const value = getSnapshot();
    const resolver = resolvers.shift();
    if (resolver) {
      resolver({ value, done: false });
    } else {
      queue.push(value);
    }
  };

  const unsubscribe = subscribe(push);

  const finish = (): IteratorResult<T> => {
    done = true;
    unsubscribe();
    // Resolve any dangling readers so their awaits don't leak.
    for (const r of resolvers) r({ value: undefined, done: true });
    resolvers.length = 0;
    queue.length = 0;
    return { value: undefined, done: true };
  };

  return {
    async next(): Promise<IteratorResult<T>> {
      if (done) return { value: undefined, done: true };
      if (queue.length > 0) {
        return { value: queue.shift()!, done: false };
      }
      return new Promise<IteratorResult<T>>((resolve) => {
        resolvers.push(resolve);
      });
    },
    async return(): Promise<IteratorResult<T>> {
      return finish();
    },
    async throw(err): Promise<IteratorResult<T>> {
      finish();
      throw err;
    },
    [Symbol.asyncIterator]() {
      return this;
    },
  };
}
