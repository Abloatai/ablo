import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineSchema } from './schema/schema.js';
import { model } from './schema/model.js';
import { createTransactionClient } from './headlessClient.js';
import type { PendingWrite } from './transactions/settlement/pendingWrite.js';

const schema = defineSchema({
  orders: model({
    status: z.string(),
  }),
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function receipt(
  clientTxId: string,
  status: 'queued' | 'confirmed',
): Record<string, unknown> {
  return {
    object: 'commit_receipt',
    clientTxId,
    serverTxId: 'server-1',
    success: true,
    status,
    correlationId: 'source-1',
    lastSyncId: status === 'confirmed' ? 12 : 0,
    ops: 1,
  };
}

function logEvent(id: number, recordId: string) {
  return {
    object: 'log_event',
    id,
    at: '2026-07-24T12:00:00.000Z',
    model: 'orders',
    op: 'update',
    recordId,
    actor: 'agent:worker-1',
    delta: {
      id,
      actionType: 'U',
      modelName: 'orders',
      modelId: recordId,
      data: { id: recordId, status: 'approved' },
      createdAt: '2026-07-24T12:00:00.000Z',
      actor: { kind: 'agent', id: 'worker-1' },
    },
  };
}

describe('createTransactionClient', () => {
  it('composes the transaction seam with the existing typed HTTP resources', () => {
    const client = createTransactionClient({
      schema,
      apiKey: 'sk_test',
      baseURL: 'https://api.example.test',
    });

    expect(typeof client.get).toBe('function');
    expect(typeof client.observe).toBe('function');
    expect(typeof client.orders.get).toBe('function');
    expect(typeof client.orders.update).toBe('function');
    expect(client.logs).toBeDefined();
  });

  it('settles by replaying the byte-equivalent commit through the commit resource', async () => {
    const requests: Array<{
      body: string;
      idempotencyKey: string | null;
    }> = [];
    const client = createTransactionClient({
      schema,
      apiKey: 'sk_test',
      baseURL: 'https://api.example.test',
      fetch: async (input, init) => {
        const url = new URL(
          typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.href
              : input.url,
        );
        if (url.pathname.endsWith('/v1/commits')) {
          const headers = new Headers(init?.headers);
          requests.push({
            body: String(init?.body),
            idempotencyKey: headers.get('Idempotency-Key'),
          });
          return json(receipt('approve:order-1', requests.length === 1 ? 'queued' : 'confirmed'));
        }
        throw new Error(`Unexpected request: ${url.pathname}`);
      },
    });

    const queued = await client.commit({
      clientTxId: 'approve:order-1',
      operations: [{
        type: 'UPDATE',
        model: 'orders',
        id: 'order-1',
        input: { status: 'approved' },
      }],
    });
    await client.settled(queued);

    expect(requests).toHaveLength(2);
    expect(requests[0]?.body).toBe(requests[1]?.body);
    expect(requests.map((request) => request.idempotencyKey)).toEqual([
      'approve:order-1',
      'approve:order-1',
    ]);
  });

  it('settles a queued receipt after restart through the durable write store', async () => {
    const writes = new Map<string, PendingWrite>();
    const durableWrites = {
      store: {
        async seal(write: PendingWrite): Promise<void> {
          writes.set(write.id, write);
        },
        async list(): Promise<readonly PendingWrite[]> {
          return [...writes.values()];
        },
        async remove(writeId: string): Promise<void> {
          writes.delete(writeId);
        },
      },
      namespace: 'worker',
    };
    let confirmed = false;
    const fetch = async (input: RequestInfo | URL): Promise<Response> => {
      const url = new URL(
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url,
      );
      if (!url.pathname.endsWith('/v1/commits')) {
        throw new Error(`Unexpected request: ${url.pathname}`);
      }
      return json(receipt('approve:order-2', confirmed ? 'confirmed' : 'queued'));
    };
    const common = {
      schema,
      apiKey: 'sk_test',
      baseURL: 'https://api.example.test',
      fetch,
      durableWrites,
      commitOutboxScope: {
        organizationId: 'org-1',
        participantId: 'agent-1',
        namespace: 'worker',
      },
    } as const;

    const first = createTransactionClient(common);
    const queued = await first.commit({
      clientTxId: 'approve:order-2',
      operations: [{
        type: 'UPDATE',
        model: 'orders',
        id: 'order-2',
        input: { status: 'approved' },
      }],
    });
    expect(writes.size).toBe(1);

    confirmed = true;
    const restarted = createTransactionClient(common);
    await restarted.settled(queued);

    expect(writes.size).toBe(0);
  });

  it('observes through the HTTP log resource and checkpoints after consumer success', async () => {
    const cursors: string[] = [];
    const urls: URL[] = [];
    const client = createTransactionClient({
      schema,
      apiKey: 'sk_test',
      baseURL: 'https://api.example.test',
      fetch: async (input) => {
        const url = new URL(
          typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.href
              : input.url,
        );
        urls.push(url);
        return json({
          object: 'list',
          data: [logEvent(42, 'order-1')],
          has_more: false,
          next_cursor: '42.7',
        });
      },
    });

    const iterator = client.observe({
      models: 'orders',
      after: '41.7',
      cursorStore: {
        load: async () => null,
        save: async (_key, cursor) => {
          cursors.push(cursor);
        },
      },
    })[Symbol.asyncIterator]();
    const result = await iterator.next();

    expect(result.value?.modelId).toBe('order-1');
    expect(result.value?.cursor).toBe('42.7');
    expect(cursors).toEqual([]);
    await result.value?.checkpoint();
    expect(cursors).toEqual(['42.7']);
    expect(urls[0]?.searchParams.get('after')).toBe('41.7');
    expect(urls[0]?.searchParams.get('model')).toBe('orders');
    await iterator.return?.();
  });

  it('replays an uncheckpointed delivery and resumes from a saved cursor', async () => {
    let storedCursor = '41.7';
    const requestedAfter: Array<string | null> = [];
    const client = createTransactionClient({
      schema,
      apiKey: 'sk_test',
      baseURL: 'https://api.example.test',
      fetch: async (input) => {
        const url = new URL(
          typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.href
              : input.url,
        );
        requestedAfter.push(url.searchParams.get('after'));
        return json({
          object: 'list',
          data: [logEvent(42, 'order-1')],
          has_more: false,
          next_cursor: '42.7',
        });
      },
    });
    const cursorStore = {
      load: async () => storedCursor,
      save: async (_key: string, cursor: string) => {
        storedCursor = cursor;
      },
    };

    const first = client.observe({ cursorStore })[Symbol.asyncIterator]();
    expect((await first.next()).value?.modelId).toBe('order-1');
    await first.return?.();

    const replay = client.observe({ cursorStore })[Symbol.asyncIterator]();
    const replayed = await replay.next();
    expect(replayed.value?.modelId).toBe('order-1');
    await replayed.value?.checkpoint();
    await replay.return?.();

    const resumed = client.observe({ cursorStore })[Symbol.asyncIterator]();
    await resumed.next();
    await resumed.return?.();

    expect(requestedAfter).toEqual(['41.7', '41.7', '42.7']);
  });

  it('deduplicates a replayed event within a page and stops a blocked poll', async () => {
    const controller = new AbortController();
    let requestCount = 0;
    const client = createTransactionClient({
      schema,
      apiKey: 'sk_test',
      baseURL: 'https://api.example.test',
      fetch: async () => {
        requestCount += 1;
        if (requestCount === 1) {
          return json({
            object: 'list',
            data: [
              logEvent(42, 'order-1'),
              logEvent(42, 'order-1'),
              logEvent(43, 'order-2'),
            ],
            has_more: false,
            next_cursor: '43.0',
          });
        }
        return json({
          object: 'list',
          data: [],
          has_more: false,
          next_cursor: '43.0',
        });
      },
    });
    const iterator = client.observe({
      signal: controller.signal,
      pollIntervalMs: 60_000,
    })[Symbol.asyncIterator]();

    expect((await iterator.next()).value?.modelId).toBe('order-1');
    expect((await iterator.next()).value?.modelId).toBe('order-2');
    const blocked = iterator.next();
    await Promise.resolve();
    controller.abort(new Error('stop observing'));

    await expect(blocked).rejects.toThrow('stop observing');
  });

  it('resolves rotating credentials through the shared transport on every request', async () => {
    const credentials = ['rk_first', 'rk_second'];
    const authorization: Array<string | null> = [];
    const client = createTransactionClient({
      schema,
      apiKey: async () => credentials.shift() ?? null,
      baseURL: 'https://api.example.test',
      fetch: async (_input, init) => {
        authorization.push(new Headers(init?.headers).get('Authorization'));
        return json({
          object: 'list',
          data: [],
          has_more: false,
          next_cursor: null,
        });
      },
    });

    await client.logs.list();
    await client.logs.list();

    expect(authorization).toEqual([
      'Bearer rk_first',
      'Bearer rk_second',
    ]);
  });
});
