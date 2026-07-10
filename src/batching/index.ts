/**
 * A small, dependency-free primitive that coalesces work into batches.
 *
 * It accumulates items enqueued close together — the common case being a
 * synchronous burst such as `Promise.all([ a(), b(), c() ])` within one
 * event-loop tick — and dispatches them as a single batch rather than one call
 * each. It is a pure state machine: it stages items on the microtask queue,
 * flushes on size, cost, or time triggers, and applies in-flight backpressure,
 * with no dependency on any data model, storage layer, or network. You supply
 * the dispatch function through {@link BatchSchedulerHooks}.
 *
 * Guarantees:
 *   - each batch is a single `dispatchBatch(items)` call, applied atomically.
 *   - if a dispatch fails, every enqueued promise in that batch rejects with
 *     the same error.
 *   - items dispatch in enqueue order, optionally reordered by `compare` just
 *     before a batch is cut; batches run first-in, first-out under a
 *     `maxInFlight` cap.
 */

export interface BatchSchedulerOptions<T> {
  /** Master switch. When false, every `enqueue` dispatches solo immediately. Default true. */
  readonly enabled?: boolean;
  /** Coalescing window in ms. `0` (default) → flush on the next microtask (zero added latency). */
  readonly windowMs?: number;
  /** Max items per batch before a forced flush. Default 256. */
  readonly maxBatchSize?: number;
  /** Max accumulated `costOf` per batch before a forced flush. Default `Infinity` (disabled). */
  readonly maxBatchCost?: number;
  /** Per-item cost used by `maxBatchCost` (e.g. serialized bytes). Default `() => 0`. */
  readonly costOf?: (item: T) => number;
  /** Max dispatches in flight at once (backpressure). Default 1 → strictly ordered. */
  readonly maxInFlight?: number;
}

export interface BatchSchedulerHooks<T, R> {
  /** The single dispatch for one batch. One call → atomic at this layer. */
  dispatchBatch(items: T[]): Promise<R>;
  /**
   * Optional ordering applied to the staged items just before a batch is cut —
   * for example, to send parent rows ahead of the rows that reference them. Omit
   * for first-in, first-out order. This changes only the order of items within
   * the dispatched array, not which items share a batch.
   */
  compare?(a: T, b: T): number;
}

export interface BatchScheduler<T, R> {
  /** Stage one item; resolves with its batch's dispatch result, or rejects with the batch error. */
  enqueue(item: T): Promise<R>;
  /** Stage an item that must dispatch in a batch of its own — for example, one carrying an explicit idempotency key. */
  enqueueSolo(item: T): Promise<R>;
  /** Force-flush the pending batch and resolve once everything in flight has settled. */
  flush(): Promise<void>;
  /** Stop scheduling and clear timers. Pending/in-flight promises still settle. */
  dispose(): void;
}

interface Deferred<R> {
  resolve(result: R): void;
  reject(error: unknown): void;
}

interface Batch<T, R> {
  items: T[];
  deferreds: Deferred<R>[];
  cost: number;
}

export function createBatchScheduler<T, R>(
  hooks: BatchSchedulerHooks<T, R>,
  options?: BatchSchedulerOptions<T>,
): BatchScheduler<T, R> {
  const enabled = options?.enabled ?? true;
  const windowMs = options?.windowMs ?? 0;
  const maxBatchSize = options?.maxBatchSize ?? 256;
  const maxBatchCost = options?.maxBatchCost ?? Infinity;
  const costOf = options?.costOf ?? (() => 0);
  const maxInFlight = options?.maxInFlight ?? 1;

  let pending: Batch<T, R> | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let microtaskScheduled = false;
  const ready: Batch<T, R>[] = [];
  let inFlight = 0;
  let idleWaiters: (() => void)[] = [];
  let disposed = false;

  function scheduleFlush(): void {
    if (microtaskScheduled || timer) return;
    if (windowMs > 0) {
      timer = setTimeout(() => {
        timer = null;
        flushPending();
      }, windowMs);
    } else {
      microtaskScheduled = true;
      queueMicrotask(() => {
        microtaskScheduled = false;
        flushPending();
      });
    }
  }

  function flushPending(): void {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    microtaskScheduled = false;
    if (!pending) return;
    if (hooks.compare) pending.items.sort(hooks.compare);
    ready.push(pending);
    pending = null;
    pump();
  }

  function pump(): void {
    while (inFlight < maxInFlight && ready.length > 0) {
      const batch = ready.shift();
      if (!batch) break;
      inFlight++;
      let dispatched: Promise<R>;
      try {
        dispatched = hooks.dispatchBatch(batch.items);
      } catch (error) {
        dispatched = Promise.reject(error);
      }
      dispatched
        .then(
          (result) => {
            for (const d of batch.deferreds) d.resolve(result);
          },
          (error: unknown) => {
            for (const d of batch.deferreds) d.reject(error);
          },
        )
        .finally(() => {
          inFlight--;
          pump();
          notifyIdleIfDrained();
        });
    }
  }

  function notifyIdleIfDrained(): void {
    if (inFlight === 0 && ready.length === 0 && idleWaiters.length > 0) {
      const waiters = idleWaiters;
      idleWaiters = [];
      for (const w of waiters) w();
    }
  }

  function enqueueSolo(item: T): Promise<R> {
    return new Promise<R>((resolve, reject) => {
      ready.push({ items: [item], deferreds: [{ resolve, reject }], cost: costOf(item) });
      pump();
    });
  }

  function enqueue(item: T): Promise<R> {
    if (disposed) return Promise.reject(new Error('batch scheduler disposed'));
    if (!enabled) return enqueueSolo(item);
    const cost = costOf(item);
    return new Promise<R>((resolve, reject) => {
      const deferred: Deferred<R> = { resolve, reject };
      // Rollover: if appending would blow a cap, flush the current batch first.
      if (pending && (pending.items.length + 1 > maxBatchSize || pending.cost + cost > maxBatchCost)) {
        flushPending();
      }
      if (!pending) pending = { items: [], deferreds: [], cost: 0 };
      pending.items.push(item);
      pending.deferreds.push(deferred);
      pending.cost += cost;
      if (pending.items.length >= maxBatchSize || pending.cost >= maxBatchCost) {
        flushPending();
      } else {
        scheduleFlush();
      }
    });
  }

  async function flush(): Promise<void> {
    flushPending();
    while (ready.length > 0 || inFlight > 0) {
      await new Promise<void>((resolve) => idleWaiters.push(resolve));
    }
  }

  function dispose(): void {
    disposed = true;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    microtaskScheduled = false;
  }

  return { enqueue, enqueueSolo, flush, dispose };
}
