/**
 * Generic batch-scheduler contract. The headline guarantees: a synchronous
 * burst collapses to ONE dispatch; a dispatch failure rejects EVERY enqueued
 * promise in that batch; size/cost caps bound a batch; maxInFlight serializes;
 * and `compare` orders the dispatched items.
 */
import { createBatchScheduler, type BatchSchedulerHooks } from '../index.js';

interface Item {
  id: string;
  priority?: number;
}

interface Recorder<T> {
  hooks: BatchSchedulerHooks<T, { batch: number }>;
  calls: T[][];
  dispatch: jest.Mock;
}

function recorder<T>(extra?: Partial<BatchSchedulerHooks<T, { batch: number }>>): Recorder<T> {
  const calls: T[][] = [];
  let n = 0;
  const dispatch = jest.fn(async (items: T[]) => {
    calls.push([...items]);
    return { batch: n++ };
  });
  return { hooks: { dispatchBatch: dispatch, ...extra }, calls, dispatch };
}

const ids = (items: Item[]): string[] => items.map((i) => i.id);

describe('createBatchScheduler — coalescing', () => {
  it('collapses a synchronous burst into ONE dispatch with all items, in order', async () => {
    const { hooks, calls, dispatch } = recorder<Item>();
    const s = createBatchScheduler(hooks);
    const results = await Promise.all([
      s.enqueue({ id: 'a' }),
      s.enqueue({ id: 'b' }),
      s.enqueue({ id: 'c' }),
    ]);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(ids(calls[0] ?? [])).toEqual(['a', 'b', 'c']);
    expect(new Set(results.map((r) => r.batch))).toEqual(new Set([0])); // all get the same batch result
  });

  it('does NOT coalesce across separate awaited turns (microtask default)', async () => {
    const { hooks, dispatch } = recorder<Item>();
    const s = createBatchScheduler(hooks);
    await s.enqueue({ id: 'a' });
    await s.enqueue({ id: 'b' });
    expect(dispatch).toHaveBeenCalledTimes(2);
  });
});

describe('createBatchScheduler — atomicity & failure', () => {
  it('rejects EVERY enqueued promise when the batch dispatch fails', async () => {
    const { hooks, dispatch } = recorder<Item>();
    dispatch.mockRejectedValueOnce(new Error('boom'));
    const s = createBatchScheduler(hooks);
    const p1 = s.enqueue({ id: 'a' });
    const p2 = s.enqueue({ id: 'b' });
    await expect(p1).rejects.toThrow('boom');
    await expect(p2).rejects.toThrow('boom');
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('propagates a synchronous throw from dispatchBatch to all deferreds', async () => {
    const calls: Item[][] = [];
    const s = createBatchScheduler<Item, void>({
      dispatchBatch: () => {
        throw new Error('sync-throw');
      },
    });
    await expect(s.enqueue({ id: 'a' })).rejects.toThrow('sync-throw');
    expect(calls).toHaveLength(0);
  });
});

describe('createBatchScheduler — size & cost caps', () => {
  it('flushes when maxBatchSize is reached', async () => {
    const { hooks, calls, dispatch } = recorder<Item>();
    const s = createBatchScheduler(hooks, { maxBatchSize: 2 });
    await Promise.all([s.enqueue({ id: 'a' }), s.enqueue({ id: 'b' }), s.enqueue({ id: 'c' })]);
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(ids(calls[0] ?? [])).toEqual(['a', 'b']);
    expect(ids(calls[1] ?? [])).toEqual(['c']);
  });

  it('flushes when maxBatchCost is reached (costOf)', async () => {
    const { hooks, calls, dispatch } = recorder<Item>();
    // each item costs 6; cap 10 → one item per batch
    const s = createBatchScheduler(hooks, { maxBatchCost: 10, costOf: () => 6 });
    await Promise.all([s.enqueue({ id: 'a' }), s.enqueue({ id: 'b' })]);
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(ids(calls[0] ?? [])).toEqual(['a']);
    expect(ids(calls[1] ?? [])).toEqual(['b']);
  });
});

describe('createBatchScheduler — ordering hooks', () => {
  it('applies compare to order items within a batch', async () => {
    const { hooks, calls } = recorder<Item>({ compare: (a, b) => (a.priority ?? 0) - (b.priority ?? 0) });
    const s = createBatchScheduler(hooks);
    await Promise.all([
      s.enqueue({ id: 'c', priority: 3 }),
      s.enqueue({ id: 'a', priority: 1 }),
      s.enqueue({ id: 'b', priority: 2 }),
    ]);
    expect(ids(calls[0] ?? [])).toEqual(['a', 'b', 'c']);
  });

  it('serializes batches under maxInFlight=1 (second waits for first)', async () => {
    let releaseFirst!: () => void;
    const order: string[] = [];
    let call = 0;
    const s = createBatchScheduler<Item, void>(
      {
        dispatchBatch: async (items) => {
          const first = items[0];
          if (!first) throw new Error('expected a non-empty batch');
          const mine = call++;
          order.push(`start:${first.id}`);
          if (mine === 0) await new Promise<void>((r) => (releaseFirst = r));
          order.push(`end:${first.id}`);
        },
      },
      { maxInFlight: 1, maxBatchSize: 1 },
    );
    const p1 = s.enqueue({ id: 'first' });
    const p2 = s.enqueue({ id: 'second' });
    // give microtasks a chance: only the first batch should have started
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(['start:first']);
    releaseFirst();
    await Promise.all([p1, p2]);
    expect(order).toEqual(['start:first', 'end:first', 'start:second', 'end:second']);
  });
});

describe('createBatchScheduler — escape hatches', () => {
  it('enqueueSolo always dispatches in its own batch', async () => {
    const { hooks, calls, dispatch } = recorder<Item>();
    const s = createBatchScheduler(hooks);
    await Promise.all([s.enqueueSolo({ id: 'a' }), s.enqueue({ id: 'b' }), s.enqueue({ id: 'c' })]);
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(ids(calls.find((c) => c[0]?.id === 'a') ?? [])).toEqual(['a']);
    expect(ids(calls.find((c) => c.length === 2) ?? [])).toEqual(['b', 'c']);
  });

  it('dispatches each item solo when disabled', async () => {
    const { hooks, dispatch } = recorder<Item>();
    const s = createBatchScheduler(hooks, { enabled: false });
    await Promise.all([s.enqueue({ id: 'a' }), s.enqueue({ id: 'b' })]);
    expect(dispatch).toHaveBeenCalledTimes(2);
  });

  it('flush() forces a pending batch out and resolves once settled', async () => {
    const { hooks, dispatch } = recorder<Item>();
    const s = createBatchScheduler(hooks);
    const p = s.enqueue({ id: 'a' });
    await s.flush();
    expect(dispatch).toHaveBeenCalledTimes(1);
    await expect(p).resolves.toBeDefined();
  });

  it('coalesces a timer window instead of a microtask', async () => {
    jest.useFakeTimers();
    try {
      const { hooks, dispatch } = recorder<Item>();
      const s = createBatchScheduler(hooks, { windowMs: 50 });
      const pa = s.enqueue({ id: 'a' });
      const pb = s.enqueue({ id: 'b' });
      expect(dispatch).not.toHaveBeenCalled();
      jest.advanceTimersByTime(50);
      expect(dispatch).toHaveBeenCalledTimes(1);
      jest.useRealTimers();
      await Promise.all([pa, pb]);
    } finally {
      jest.useRealTimers();
    }
  });

  it('rejects enqueue after dispose', async () => {
    const { hooks } = recorder<Item>();
    const s = createBatchScheduler(hooks);
    s.dispose();
    await expect(s.enqueue({ id: 'a' })).rejects.toThrow('disposed');
  });
});
