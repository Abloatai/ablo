/**
 * Turns a callback-based subscription into an async iterable that yields the
 * latest snapshot each time the source changes. You supply two functions:
 * `subscribe(listener)`, which registers your listener and returns a teardown
 * function, and `getSnapshot()`, which reads the current value. On every change
 * notification the iterator calls `getSnapshot()` and hands the result to the
 * consumer's `for await` loop; when the loop ends, the iterator runs the
 * teardown function.
 *
 * Because each notification yields the current snapshot rather than a specific
 * event, bursts coalesce harmlessly — a consumer that falls behind still ends up
 * with the freshest value. The queue is unbounded, so a consumer that never
 * advances lets memory grow without limit. When individual events matter and
 * must not be dropped, use {@link asyncIteratorFromEvents} instead.
 *
 * Each call to the factory creates an independent iterator with its own
 * subscription. Two `for await` loops over the same source each observe every
 * change; they do not take values from one another.
 */
/**
 * Turns a callback-based subscription into an async iterable that yields each
 * discrete event, in order, with none dropped. You supply a single
 * `subscribe(push)` function: it registers your producer and returns a teardown
 * function, and your producer calls `push(value)` once per event. The consumer's
 * `for await` loop receives every pushed value.
 *
 * This is the counterpart to {@link asyncIteratorFrom}. Reach for that one when
 * you only need the latest state and coalescing bursts is fine; reach for this
 * one when every event is significant — for example a stream of change deltas
 * where skipping one would lose data. The queue is unbounded, so a consumer that
 * stops advancing lets memory grow without limit.
 */
export function asyncIteratorFromEvents<T>(
  subscribe: (push: (value: T) => void) => () => void,
): AsyncIterableIterator<T> {
  const queue: T[] = [];
  const resolvers: ((result: IteratorResult<T>) => void)[] = [];
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
  const resolvers: ((result: IteratorResult<T>) => void)[] = [];
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
