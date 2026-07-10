/**
 * A durable retry queue for delivering source events to the server.
 *
 * When your application changes a row, it can push the resulting event to
 * the server, which acknowledges delivery synchronously. If your process
 * crashes mid-call, the network drops, or the server returns a 5xx, that
 * event would be lost without a safety net. This queue is the safety net:
 * it persists each event first, then delivers it from a background worker
 * with automatic retries. (Polling the change feed is the slower fallback
 * for anything the queue never manages to deliver.)
 *
 * The queue follows a familiar enqueue-and-worker shape:
 *
 *   - `enqueue(events)` returns as soon as the events are persisted.
 *   - A background worker delivers them and retries on failure, following
 *     the Standard Webhooks schedule (0, 5s, 5m, 30m, 2h, 5h, 10h, 14h,
 *     20h, 24h — roughly three days in total).
 *   - Items that exhaust every retry move to a dead-letter queue you can
 *     monitor.
 *
 * Persistence is pluggable through {@link PushQueueStorage}. Use
 * {@link InMemoryPushQueueStorage} for a single process, or implement that
 * interface against your own outbox table for production durability.
 */

import { ABLO_SOURCE_HEADERS, signAbloSourceRequest } from './signing.js';
import type { SourceEvent } from './types.js';

/** One queued delivery: a batch of source events plus its retry bookkeeping. */
export interface PushQueueItem {
  readonly id: string;
  readonly events: readonly SourceEvent[];
  readonly attempts: number;
  /** When the next attempt is due, in epoch milliseconds. The worker skips items due later. */
  readonly nextAttemptAt: number;
  /** The most recent error message, set once an attempt has failed. */
  readonly lastError?: string;
  /** `pending` while awaiting delivery, `delivered` on success, `dlq` once retries are exhausted. */
  readonly status: 'pending' | 'delivered' | 'dlq';
}

/**
 * The persistence behind a {@link PushQueue}. Implement it against your own
 * durable table (or use {@link InMemoryPushQueueStorage}) so queued events
 * survive a process restart. The queue calls these methods; you decide where
 * the rows actually live.
 */
export interface PushQueueStorage {
  /**
   * Append a new item and return the persisted record. Generate a stable id
   * — it doubles as the `webhook-id` on the delivered request — and set
   * `nextAttemptAt` to the current time so the item is due immediately.
   */
  enqueue(events: readonly SourceEvent[]): Promise<PushQueueItem>;
  /** Return pending items whose `nextAttemptAt` is at or before `now`, up to `limit`. */
  due(now: number, limit: number): Promise<readonly PushQueueItem[]>;
  /** Increase the attempt count and set the next attempt time after a failed delivery. */
  reschedule(
    id: string,
    nextAttemptAt: number,
    lastError: string,
  ): Promise<void>;
  /** Mark the item delivered so no further attempts are made. */
  markDelivered(id: string): Promise<void>;
  /** Move the item to the dead-letter queue after its retries are exhausted. */
  markDlq(id: string, lastError: string): Promise<void>;
  /** Read the dead-letter queue. Your monitoring reads this to surface deliveries that never succeeded. */
  listDlq(): Promise<readonly PushQueueItem[]>;
}

/**
 * The default retry schedule, taken from the Standard Webhooks
 * specification. The index is the attempt number and the value is the delay
 * in milliseconds after the previous attempt failed. Once an item runs off
 * the end of this array, it moves to the dead-letter queue.
 *
 * See https://www.standardwebhooks.com/.
 */
export const STANDARD_WEBHOOKS_RETRY_SCHEDULE: readonly number[] = [
  0, // immediate
  5_000, // 5s
  5 * 60_000, // 5m
  30 * 60_000, // 30m
  2 * 60 * 60_000, // 2h
  5 * 60 * 60_000, // 5h
  10 * 60 * 60_000, // 10h
  14 * 60 * 60_000, // 14h
  20 * 60 * 60_000, // 20h
  24 * 60 * 60_000, // 24h
];

/** Configuration for {@link createPushQueue}. */
export interface PushQueueOptions {
  /** The URL the worker delivers events to. */
  readonly endpoint: string;
  /** The API key used to sign each delivery. */
  readonly apiKey: string;
  /** Where queued items are persisted. */
  readonly storage: PushQueueStorage;
  /**
   * Override the retry delays. Defaults to {@link STANDARD_WEBHOOKS_RETRY_SCHEDULE}.
   * The number of attempts equals the array length, and the i-th entry is the
   * delay after attempt `i` failed.
   */
  readonly retrySchedule?: readonly number[];
  /** How often the worker checks for due items, in milliseconds. Defaults to 1000. */
  readonly tickIntervalMs?: number;
  /** The most items the worker delivers per tick. Defaults to 50. */
  readonly batchSize?: number;
  /** A custom fetch implementation, for tests or runtimes without a global `fetch`. */
  readonly fetch?: typeof fetch;
  /** A custom clock source, mainly for tests. Defaults to `Date.now`. */
  readonly now?: () => number;
  /** Random jitter applied to each retry delay, as a fraction. Defaults to ±10%; set 0 to disable. */
  readonly jitter?: number;
  /** Called when an item is dead-lettered or the worker loop hits an error. */
  readonly onError?: (item: PushQueueItem, err: unknown) => void;
}

/** A running push queue: persist events, deliver them, and recover dead-lettered ones. */
export interface PushQueue {
  /** Persist a batch of events for delivery and return the queued item. */
  enqueue(events: readonly SourceEvent[]): Promise<PushQueueItem>;
  /** Run the delivery worker until `signal` aborts. */
  run(signal: AbortSignal): Promise<void>;
  /**
   * Re-enqueue every dead-lettered item for another round of delivery. Call
   * this yourself once you have fixed whatever caused the failures. Returns
   * the number of items re-enqueued.
   */
  redriveDlq(): Promise<number>;
}

/** Create a {@link PushQueue} from the given {@link PushQueueOptions}. */
export function createPushQueue(options: PushQueueOptions): PushQueue {
  const tickIntervalMs = options.tickIntervalMs ?? 1000;
  const batchSize = options.batchSize ?? 50;
  const fetchImpl = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const schedule = options.retrySchedule ?? STANDARD_WEBHOOKS_RETRY_SCHEDULE;
  const jitter = options.jitter ?? 0.1;

  return {
    async enqueue(events) {
      return options.storage.enqueue(events);
    },

    async run(signal) {
      while (!signal.aborted) {
        try {
          const due = await options.storage.due(now(), batchSize);
          for (const item of due) {
            if (signal.aborted) return;
            await deliver(item);
          }
        } catch (err) {
          // Storage failures shouldn't kill the loop; surface and
          // back off the tick interval.
          options.onError?.(
            { id: 'storage', events: [], attempts: 0, nextAttemptAt: 0, status: 'pending' },
            err,
          );
        }
        await sleep(tickIntervalMs, signal);
      }
    },

    async redriveDlq() {
      const items = await options.storage.listDlq();
      let redriven = 0;
      for (const item of items) {
        await options.storage.enqueue(item.events);
        redriven++;
      }
      return redriven;
    },
  };

  async function deliver(item: PushQueueItem): Promise<void> {
    const rawBody = JSON.stringify({ events: item.events });
    let signed: Awaited<ReturnType<typeof signAbloSourceRequest>>;
    try {
      signed = await signAbloSourceRequest({
        apiKey: options.apiKey,
        body: rawBody,
        timestamp: Math.floor(now() / 1000),
        // Reuse the queue id as the webhook-id across all retry
        // attempts so the receiver can dedupe replays per spec.
        messageId: item.id,
      });
    } catch (err) {
      // Signing should not fail in practice (no network, just HMAC).
      // If it does, treat as a permanent failure.
      await options.storage.markDlq(item.id, formatError(err));
      options.onError?.(item, err);
      return;
    }

    let response: Response;
    try {
      response = await fetchImpl(options.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...signed.headers,
          [ABLO_SOURCE_HEADERS.idempotencyKey]: item.id,
        },
        body: rawBody,
      });
    } catch (err) {
      await reschedule(item, formatError(err));
      return;
    }

    if (response.ok) {
      await options.storage.markDelivered(item.id);
      return;
    }

    // 4xx other than 408/429 are unrecoverable — don't retry. Move
    // straight to DLQ so the customer's monitoring catches the bad
    // request shape early instead of waiting 3 days for retries.
    if (
      response.status >= 400 &&
      response.status < 500 &&
      response.status !== 408 &&
      response.status !== 429
    ) {
      await options.storage.markDlq(
        item.id,
        `HTTP ${response.status}`,
      );
      return;
    }

    await reschedule(item, `HTTP ${response.status}`);
  }

  async function reschedule(
    item: PushQueueItem,
    error: string,
  ): Promise<void> {
    const nextAttempt = item.attempts + 1;
    // Past the end of the backoff schedule: no attempts left, so dead-letter
    // the item.
    const backoff = schedule[nextAttempt];
    if (backoff === undefined) {
      await options.storage.markDlq(item.id, error);
      options.onError?.(item, new Error(error));
      return;
    }
    const delay = applyJitter(backoff, jitter);
    await options.storage.reschedule(item.id, now() + delay, error);
  }
}

/**
 * A {@link PushQueueStorage} that keeps items in memory. It is not durable —
 * items are lost when the process restarts — so it suits development and
 * low-volume use. For production, implement {@link PushQueueStorage} against
 * your own table.
 */
export class InMemoryPushQueueStorage implements PushQueueStorage {
  private items = new Map<string, PushQueueItem>();
  private nextId = 0;
  private readonly now: () => number;

  constructor(options: { now?: () => number } = {}) {
    this.now = options.now ?? Date.now;
  }

  async enqueue(events: readonly SourceEvent[]): Promise<PushQueueItem> {
    const id = `q_${(++this.nextId).toString(36)}_${Math.random()
      .toString(36)
      .slice(2, 8)}`;
    const item: PushQueueItem = {
      id,
      events,
      attempts: 0,
      nextAttemptAt: this.now(),
      status: 'pending',
    };
    this.items.set(id, item);
    return item;
  }

  async due(now: number, limit: number): Promise<readonly PushQueueItem[]> {
    const out: PushQueueItem[] = [];
    for (const item of this.items.values()) {
      if (out.length >= limit) break;
      if (item.status !== 'pending') continue;
      if (item.nextAttemptAt > now) continue;
      out.push(item);
    }
    return out;
  }

  async reschedule(
    id: string,
    nextAttemptAt: number,
    lastError: string,
  ): Promise<void> {
    const item = this.items.get(id);
    if (!item) return;
    this.items.set(id, {
      ...item,
      attempts: item.attempts + 1,
      nextAttemptAt,
      lastError,
    });
  }

  async markDelivered(id: string): Promise<void> {
    const item = this.items.get(id);
    if (!item) return;
    this.items.set(id, { ...item, status: 'delivered' });
  }

  async markDlq(id: string, lastError: string): Promise<void> {
    const item = this.items.get(id);
    if (!item) return;
    this.items.set(id, {
      ...item,
      attempts: item.attempts + 1,
      status: 'dlq',
      lastError,
    });
  }

  async listDlq(): Promise<readonly PushQueueItem[]> {
    return Array.from(this.items.values()).filter((i) => i.status === 'dlq');
  }

  /** Test helper — read all items regardless of status. */
  snapshot(): readonly PushQueueItem[] {
    return Array.from(this.items.values());
  }
}

function applyJitter(delayMs: number, factor: number): number {
  if (factor <= 0 || delayMs === 0) return delayMs;
  const swing = delayMs * factor;
  return Math.max(0, delayMs + (Math.random() * 2 - 1) * swing);
}

function formatError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolve();
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
