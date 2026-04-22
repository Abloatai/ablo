/**
 * Async-iterable ergonomics locks for `presence`, `intents`, `deltas`.
 *
 *   1. `for await` on presence yields the current snapshot on every
 *      mutation.
 *   2. `for await` on intents yields the current snapshot on every
 *      mutation.
 *   3. `for await` on deltas yields each individual delta envelope
 *      in order — no drops even on bursts.
 *   4. `break` tears down the underlying subscription (no leaks).
 *   5. Two independent `for await` loops on the same stream both see
 *      every update.
 *
 * The iterator helpers are pure adapters over the existing subscribe
 * callbacks, so these tests exercise the helpers plus the wiring.
 */

import { describe, it, expect, jest } from '@jest/globals';
import {
  asyncIteratorFrom,
  asyncIteratorFromEvents,
} from '../../../src/mesh/asyncIterator';

describe('asyncIteratorFrom — snapshot semantics', () => {
  it('yields the current snapshot on every mutation', async () => {
    const listeners = new Set<() => void>();
    let snapshot: number[] = [];

    const iter = asyncIteratorFrom<number[]>(
      (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      () => snapshot,
    );

    const fire = (next: number[]) => {
      snapshot = next;
      for (const l of listeners) l();
    };

    // Schedule three mutations, then read three values.
    setTimeout(() => {
      fire([1]);
      fire([1, 2]);
      fire([1, 2, 3]);
    }, 0);

    const results: number[][] = [];
    for await (const value of iter) {
      results.push(value);
      if (results.length === 3) break;
    }

    expect(results).toEqual([[1], [1, 2], [1, 2, 3]]);
  });

  it('tears down subscription on break', async () => {
    const listeners = new Set<() => void>();
    const iter = asyncIteratorFrom<number>(
      (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      () => 42,
    );
    setTimeout(() => {
      for (const l of listeners) l();
    }, 0);

    for await (const _ of iter) {
      break;
    }
    expect(listeners.size).toBe(0);
  });

  it('two concurrent iterators both receive every update', async () => {
    const listeners = new Set<() => void>();
    let snapshot = 0;
    const makeIter = () =>
      asyncIteratorFrom<number>(
        (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        () => snapshot,
      );

    const itA = makeIter();
    const itB = makeIter();
    expect(listeners.size).toBe(2);

    setTimeout(() => {
      snapshot = 1;
      for (const l of listeners) l();
      snapshot = 2;
      for (const l of listeners) l();
    }, 0);

    const a: number[] = [];
    const b: number[] = [];
    for await (const v of itA) {
      a.push(v);
      if (a.length === 2) break;
    }
    for await (const v of itB) {
      b.push(v);
      if (b.length === 2) break;
    }
    expect(a).toEqual([1, 2]);
    expect(b).toEqual([1, 2]);
  });
});

describe('asyncIteratorFromEvents — event-per-iteration semantics', () => {
  it('yields every pushed value in order, even bursts', async () => {
    let pushFn: ((v: string) => void) | null = null;
    const iter = asyncIteratorFromEvents<string>((push) => {
      pushFn = push;
      return () => {
        pushFn = null;
      };
    });

    setTimeout(() => {
      pushFn!('a');
      pushFn!('b');
      pushFn!('c');
    }, 0);

    const received: string[] = [];
    for await (const v of iter) {
      received.push(v);
      if (received.length === 3) break;
    }
    expect(received).toEqual(['a', 'b', 'c']);
  });

  it('buffers bursts that arrive before the consumer awaits', async () => {
    // Push multiple values synchronously, then consume. None should
    // be dropped — this is the whole point of event-per-iteration
    // semantics for the delta firehose.
    let pushFn: ((v: number) => void) | null = null;
    const iter = asyncIteratorFromEvents<number>((push) => {
      pushFn = push;
      return () => {};
    });

    pushFn!(1);
    pushFn!(2);
    pushFn!(3);

    const first = await iter.next();
    const second = await iter.next();
    const third = await iter.next();
    expect(first.value).toBe(1);
    expect(second.value).toBe(2);
    expect(third.value).toBe(3);
  });

  it('return() unsubscribes and resolves pending readers', async () => {
    const unsubscribe = jest.fn();
    const iter = asyncIteratorFromEvents<number>(() => unsubscribe);
    const pending = iter.next();
    await iter.return?.();
    const result = await pending;
    expect(result.done).toBe(true);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});
