/**
 * Customer-side push retry queue.
 *
 * The push path (`POST /api/source/events` on Ablo Cloud) acks
 * synchronously. If the customer's app crashes mid-call, the network
 * drops, or Ablo returns 5xx, those events would otherwise be lost
 * — the poll path is the durability backstop, but it's higher
 * latency.
 *
 * `PushQueue` lives in the customer's process and gives them a
 * queue+worker pattern matching Stripe / Svix semantics:
 *
 *   - `enqueue(events)` returns immediately after persisting
 *   - background worker delivers and retries per the Standard
 *     Webhooks schedule (0, 5s, 5m, 30m, 2h, 5h, 10h, 14h, 20h, 24h
 *     — ~3 days total)
 *   - exhausted items move to DLQ for customer-owned monitoring
 *
 * Persistence is pluggable — `InMemoryPushQueueStorage` for single-
 * process customers, a SQL implementation against the customer's own
 * outbox table for production.
 */

import {
  ABLO_SOURCE_HEADERS,
  signAbloSourceRequest,
  type SourceEvent,
} from './index.js';

export interface PushQueueItem {
  readonly id: string;
  readonly events: readonly SourceEvent[];
  readonly attempts: number;
  /** Timestamp (ms) of the next attempt. Workers skip earlier items. */
  readonly nextAttemptAt: number;
  /** Most recent error message, when any attempt has failed. */
  readonly lastError?: string;
  /** `dlq` once retries exhausted. */
  readonly status: 'pending' | 'delivered' | 'dlq';
}

export interface PushQueueStorage {
  /**
   * Append a new item; returns the persisted record. Implementations
   * generate a stable id (used as the `webhook-id`) and set
   * `nextAttemptAt = now`.
   */
  enqueue(events: readonly SourceEvent[]): Promise<PushQueueItem>;
  /** Items whose `nextAttemptAt <= now` and `status === 'pending'`. */
  due(now: number, limit: number): Promise<readonly PushQueueItem[]>;
  /** Bump attempt count + reschedule. */
  reschedule(
    id: string,
    nextAttemptAt: number,
    lastError: string,
  ): Promise<void>;
  /** Mark the item delivered (no further attempts). */
  markDelivered(id: string): Promise<void>;
  /** Mark the item DLQ (retries exhausted). */
  markDlq(id: string, lastError: string): Promise<void>;
  /** Read DLQ contents — customer monitors this. */
  listDlq(): Promise<readonly PushQueueItem[]>;
}

/**
 * Standard Webhooks retry schedule. Index = attempt number; value =
 * delay-ms after the previous attempt. After the last entry, items
 * move to DLQ.
 *
 * Source: https://www.standardwebhooks.com/
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

export interface PushQueueOptions {
  readonly endpoint: string;
  readonly secret: string;
  readonly storage: PushQueueStorage;
  /**
   * Override the retry delays. Default: Standard Webhooks schedule.
   * The number of attempts equals the array length; the i-th entry
   * is the delay after attempt `i` failed.
   */
  readonly retrySchedule?: readonly number[];
  /** Worker poll interval. Default 1000ms. */
  readonly tickIntervalMs?: number;
  /** Max items pulled per tick. Default 50. */
  readonly batchSize?: number;
  /** Pluggable for tests / non-Node fetch impls. */
  readonly fetch?: typeof fetch;
  /** Pluggable for tests. */
  readonly now?: () => number;
  /** Random jitter on retry delays. Default ±10%. Set to 0 to disable. */
  readonly jitter?: number;
  readonly onError?: (item: PushQueueItem, err: unknown) => void;
}

export interface PushQueue {
  enqueue(events: readonly SourceEvent[]): Promise<PushQueueItem>;
  /** Run the worker loop until `signal` aborts. */
  run(signal: AbortSignal): Promise<void>;
  /** Drain the DLQ by re-enqueueing — customer-triggered redrive. */
  redriveDlq(): Promise<number>;
}

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
        secret: options.secret,
        body: rawBody,
        timestamp: now(),
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
    if (nextAttempt >= schedule.length) {
      await options.storage.markDlq(item.id, error);
      options.onError?.(item, new Error(error));
      return;
    }
    const delay = applyJitter(schedule[nextAttempt], jitter);
    await options.storage.reschedule(item.id, now() + delay, error);
  }
}

export class InMemoryPushQueueStorage implements PushQueueStorage {
  /**
   * Real implementation, not a mock. Suitable for low-volume single-
   * process customers; not durable across restarts (in-flight items
   * are lost). Production customers should swap in a SQL-backed
   * storage that writes to their existing outbox table.
   */
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
