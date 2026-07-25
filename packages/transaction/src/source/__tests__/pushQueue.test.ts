/**
 * `createPushQueue` invariants. Customer-facing helper, so the tests
 * lock in the contract: enqueue → deliver → ack on 200; reschedule on
 * 5xx/network/408/429; immediate DLQ on other 4xx; retries exhausted
 * → DLQ; signed envelope conforms to Standard Webhooks (`webhook-id`,
 * `webhook-timestamp`, `webhook-signature`).
 */

import {
  createPushQueue,
  InMemoryPushQueueStorage,
  STANDARD_WEBHOOKS_RETRY_SCHEDULE,
} from '../pushQueue.js';
import type { SourceEvent } from '../index.js';

class TestResponse {
  readonly status: number;
  readonly ok: boolean;
  constructor(status: number) {
    this.status = status;
    this.ok = status >= 200 && status < 300;
  }
}

const sampleEvent = (id = 'evt_1'): SourceEvent => ({
  id,
  model: 'files',
  entityId: 'src/x.ts',
  type: 'UPDATE',
});

function buildQueue(opts: {
  fetchImpl: jest.Mock;
  storage?: InMemoryPushQueueStorage;
  now?: () => number;
}) {
  const storage = opts.storage ?? new InMemoryPushQueueStorage();
  const queue = createPushQueue({
    endpoint: 'https://ablo.test/api/source/events',
    apiKey: 'sk_test_queue',
    storage,
    fetch: opts.fetchImpl,
    now: opts.now ?? Date.now,
    tickIntervalMs: 1,
    jitter: 0,
  });
  return { queue, storage };
}

async function runUntilQuiescent(
  queue: ReturnType<typeof createPushQueue>,
  abort: AbortController,
  ms: number,
): Promise<void> {
  const runPromise = queue.run(abort.signal);
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
  abort.abort();
  await runPromise;
}

describe('createPushQueue', () => {
  it('delivers an enqueued batch on first attempt and marks delivered', async () => {
    const fetchMock = jest.fn(async () => new TestResponse(200));
    const { queue, storage } = buildQueue({ fetchImpl: fetchMock });

    const item = await queue.enqueue([sampleEvent()]);

    const abort = new AbortController();
    await runUntilQuiescent(queue, abort, 30);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const after = storage.snapshot().find((i) => i.id === item.id);
    expect(after?.status).toBe('delivered');
  });

  it('signs the request with Standard Webhooks headers', async () => {
    const seen: { headers: Record<string, string>; body: string }[] = [];
    const fetchMock = jest.fn(async (_url: string, init: { headers: Record<string, string>; body: string }) => {
      seen.push({ headers: init.headers, body: init.body });
      return new TestResponse(200);
    });
    const { queue } = buildQueue({ fetchImpl: fetchMock });
    const item = await queue.enqueue([sampleEvent()]);

    const abort = new AbortController();
    await runUntilQuiescent(queue, abort, 30);

    expect(seen).toHaveLength(1);
    const captured = seen[0];
    if (!captured) throw new Error('expected one captured request');
    const headers = captured.headers;
    expect(headers['webhook-id']).toBe(item.id);
    expect(headers['webhook-timestamp']).toMatch(/^\d+$/);
    expect(headers['webhook-signature']).toMatch(/^v1,[A-Za-z0-9+/=]+$/);
    // `Idempotency-Key` reuses the queue id so receivers can dedupe
    // independently of the webhook-id replay window.
    expect(headers['Idempotency-Key']).toBe(item.id);
  });

  it('reschedules on 5xx and reuses the same webhook-id across retries', async () => {
    const seenIds: string[] = [];
    let calls = 0;
    const fetchMock = jest.fn(async (_url: string, init: { headers: Record<string, string> }) => {
      calls++;
      const webhookId = init.headers['webhook-id'];
      if (!webhookId) throw new Error('expected a webhook-id header on the delivery');
      seenIds.push(webhookId);
      return new TestResponse(calls < 2 ? 503 : 200);
    });
    // Override schedule so retries are fast — first attempt immediate,
    // second retry 5ms later, then DLQ if a third attempt is needed.
    const storage = new InMemoryPushQueueStorage();
    const queue = createPushQueue({
      endpoint: 'https://ablo.test/api/source/events',
      apiKey: 'sk_test_queue',
      storage,
      fetch: fetchMock as unknown as typeof fetch,
      retrySchedule: [0, 5, 10],
      tickIntervalMs: 1,
      jitter: 0,
    });

    const item = await queue.enqueue([sampleEvent()]);

    const abort = new AbortController();
    await runUntilQuiescent(queue, abort, 80);

    expect(calls).toBeGreaterThanOrEqual(2);
    // Same webhook-id across both calls — receivers dedupe by it.
    expect(new Set(seenIds).size).toBe(1);
    expect(seenIds[0]).toBe(item.id);
    const after = storage.snapshot().find((i) => i.id === item.id);
    expect(after?.status).toBe('delivered');
  });

  it('moves to DLQ immediately on 400 (unrecoverable)', async () => {
    const fetchMock = jest.fn(async () => new TestResponse(400));
    const { queue, storage } = buildQueue({ fetchImpl: fetchMock });

    await queue.enqueue([sampleEvent()]);

    const abort = new AbortController();
    await runUntilQuiescent(queue, abort, 30);

    // Only one attempt — 400 is not retried.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const dlq = await storage.listDlq();
    expect(dlq).toHaveLength(1);
    expect(dlq[0]?.lastError).toContain('400');
  });

  it('retries on 429 (rate limited) and 408 (timeout)', async () => {
    let calls = 0;
    const fetchMock = jest.fn(async () => {
      calls++;
      if (calls === 1) return new TestResponse(429);
      if (calls === 2) return new TestResponse(408);
      return new TestResponse(200);
    });
    const storage = new InMemoryPushQueueStorage();
    const queue = createPushQueue({
      endpoint: 'https://ablo.test/api/source/events',
      apiKey: 'sk_test_queue',
      storage,
      fetch: fetchMock as unknown as typeof fetch,
      retrySchedule: [0, 5, 5],
      tickIntervalMs: 1,
      jitter: 0,
    });

    await queue.enqueue([sampleEvent()]);

    const abort = new AbortController();
    await runUntilQuiescent(queue, abort, 100);

    expect(calls).toBe(3);
    expect(storage.snapshot().every((i) => i.status === 'delivered')).toBe(
      true,
    );
  });

  it('lands in DLQ after the schedule is exhausted', async () => {
    const fetchMock = jest.fn(async () => new TestResponse(503));
    const storage = new InMemoryPushQueueStorage();
    const queue = createPushQueue({
      endpoint: 'https://ablo.test/api/source/events',
      apiKey: 'sk_test_queue',
      storage,
      fetch: fetchMock as unknown as typeof fetch,
      // 2-attempt schedule so the test runs fast.
      retrySchedule: [0, 5],
      tickIntervalMs: 1,
      jitter: 0,
    });

    await queue.enqueue([sampleEvent()]);

    const abort = new AbortController();
    await runUntilQuiescent(queue, abort, 80);

    const dlq = await storage.listDlq();
    expect(dlq).toHaveLength(1);
    expect(dlq[0]?.lastError).toContain('503');
  });

  it('redriveDlq re-enqueues every DLQ item', async () => {
    const fetchMock = jest.fn(async () => new TestResponse(400));
    const { queue, storage } = buildQueue({ fetchImpl: fetchMock });

    await queue.enqueue([sampleEvent('evt_a')]);
    await queue.enqueue([sampleEvent('evt_b')]);

    const abort = new AbortController();
    await runUntilQuiescent(queue, abort, 30);

    expect((await storage.listDlq()).length).toBe(2);
    const redriven = await queue.redriveDlq();
    expect(redriven).toBe(2);
    // After redrive there are 2 fresh pending items in addition to
    // the 2 that remain in DLQ (we don't auto-clear on redrive — the
    // customer's monitoring decides when to purge DLQ entries).
    expect(
      storage.snapshot().filter((i) => i.status === 'pending').length,
    ).toBe(2);
  });

  it('exposes the Standard Webhooks schedule as a constant', () => {
    // Sanity check — protocol clients may copy this verbatim into
    // their own retry tooling.
    expect(STANDARD_WEBHOOKS_RETRY_SCHEDULE.length).toBe(10);
    expect(STANDARD_WEBHOOKS_RETRY_SCHEDULE[0]).toBe(0);
    expect(STANDARD_WEBHOOKS_RETRY_SCHEDULE[1]).toBe(5_000);
  });
});
