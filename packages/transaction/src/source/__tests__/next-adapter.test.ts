/**
 * End-to-end: the Next adapter (`dataSourceNext`) + the core handler's first-class
 * `adapter` option + the in-memory reference adapter, exercised over signed HTTP
 * requests. Proves the whole paste-able route works: signature verify → adapter
 * dispatch → wire response, with no hand-written handlers.
 */

import { z } from 'zod';
import { defineSchema } from '@abloatai/transaction/schema/schema';
import { model } from '@abloatai/transaction/schema/model';
import {
  ABLO_SOURCE_CLIENT_TX_ID_MAX_LENGTH,
  signAbloSourceRequest,
} from '../index.js';
import { dataSourceNext } from '../next.js';
import { memoryDataSource } from '../adapters/memory.js';

class TestResponse {
  readonly status: number;
  private readonly text: string;
  constructor(body: string, init?: { status?: number }) {
    this.text = body;
    this.status = init?.status ?? 200;
  }
  async json(): Promise<unknown> {
    return JSON.parse(this.text);
  }
}
(globalThis as unknown as { Response: typeof Response }).Response =
  TestResponse as unknown as typeof Response;

const schema = defineSchema({
  task: model({
    title: z.string(),
    status: z.string().optional(),
  }),
});

const API_KEY = 'sk_test_adapter_key';

function makeHandler() {
  return dataSourceNext({ schema, apiKey: API_KEY, adapter: memoryDataSource() }).POST;
}

async function signedPost(
  handler: (request: Request) => Promise<Response>,
  body: unknown,
  apiKey = API_KEY,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const rawBody = JSON.stringify(body);
  const signed = await signAbloSourceRequest({ apiKey, body: rawBody, messageId: `msg_${Math.random()}` });
  const response = await handler({
    method: 'POST',
    text: async () => rawBody,
    headers: new Headers(signed.headers),
  } as Request);
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

describe('dataSourceNext + adapter (end to end)', () => {
  it('rejects an unsigned / wrong-key request before the adapter', async () => {
    const handler = makeHandler();
    const res = await signedPost(handler, { type: 'load', model: 'task', id: 't1' }, 'sk_wrong_key');
    expect(res.status).toBe(401);
  });

  it('commits through the adapter and returns canonical rows', async () => {
    const handler = makeHandler();
    const res = await signedPost(handler, {
      type: 'commit',
      clientTxId: 'tx1',
      operations: [
        {
          type: 'CREATE',
          model: 'task',
          id: 't1',
          input: { title: 'A' },
          transactionId: 'op1',
        },
      ],
    });
    expect(res.status).toBe(200);
    expect((res.body.rows as Record<string, unknown>[])[0]).toMatchObject({ id: 't1', title: 'A' });
  });

  it('accepts the explicit scoped correlation field', async () => {
    const handler = makeHandler();
    const res = await signedPost(handler, {
      type: 'commit',
      correlationId: 'corr_explicit',
      operations: [
        { type: 'CREATE', model: 'task', id: 't1', input: { title: 'A' } },
      ],
    });
    expect(res.status).toBe(200);
  });

  it('rejects a commit with no scoped correlation (idempotency key required)', async () => {
    const handler = makeHandler();
    const res = await signedPost(handler, {
      type: 'commit',
      operations: [{ type: 'CREATE', model: 'task', id: 't1', input: { title: 'A' } }],
    });
    expect(res.status).toBe(400);
  });

  it('rejects a clientTxId too long to correlate through the WAL protocol', async () => {
    const handler = makeHandler();
    const res = await signedPost(handler, {
      type: 'commit',
      clientTxId: 'x'.repeat(ABLO_SOURCE_CLIENT_TX_ID_MAX_LENGTH + 1),
      operations: [
        { type: 'CREATE', model: 'task', id: 't1', input: { title: 'A' } },
      ],
    });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: 'source_commit_invalid' });
  });

  it('fails closed when a non-Postgres adapter cannot emit the requested WAL echo', async () => {
    const handler = makeHandler();
    const res = await signedPost(handler, {
      type: 'commit',
      clientTxId: 'tx_echo_1',
      intentHash: 'a'.repeat(64),
      echo: { kind: 'postgres-wal', payload: 'echo-payload' },
      operations: [
        { type: 'CREATE', model: 'task', id: 't1', input: { title: 'A' } },
      ],
    });

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      error: 'source_commit_echo_not_supported',
    });
  });

  it('serves load + list reads from the adapter after a commit', async () => {
    const handler = makeHandler();
    await signedPost(handler, {
      type: 'commit',
      clientTxId: 'tx1',
      operations: [
        { type: 'CREATE', model: 'task', id: 't1', input: { title: 'A' } },
        { type: 'CREATE', model: 'task', id: 't2', input: { title: 'B' } },
      ],
    });

    const load = await signedPost(handler, { type: 'load', model: 'task', id: 't1' });
    expect((load.body.row as Record<string, unknown>).title).toBe('A');

    const list = await signedPost(handler, { type: 'list', model: 'task' });
    expect((list.body.rows as Record<string, unknown>[]).length).toBe(2);
  });

  it('exposes commits on the events feed with a cursor', async () => {
    const handler = makeHandler();
    await signedPost(handler, {
      type: 'commit',
      clientTxId: 'tx1',
      operations: [
        {
          type: 'CREATE',
          model: 'task',
          id: 't1',
          input: { title: 'A' },
          transactionId: 'op1',
        },
      ],
    });
    const events = await signedPost(handler, { type: 'events' });
    expect(events.status).toBe(200);
    const list = events.body.events as Record<string, unknown>[];
    expect(list[0]).toMatchObject({
      entityId: 't1',
      model: 'task',
      type: 'CREATE',
      correlationId: 'tx1',
      transactionId: 'op1',
    });
    expect(list[0]?.clientTxId).toBeUndefined();
    expect(typeof events.body.nextCursor).toBe('string');
  });

  it('is idempotent over the wire — replaying a clientTxId does not double-apply', async () => {
    const handler = makeHandler();
    const commit = {
      type: 'commit',
      clientTxId: 'tx_dup',
      operations: [{ type: 'CREATE', model: 'task', id: 't1', input: { title: 'A' } }],
    };
    await signedPost(handler, commit);
    await signedPost(handler, commit);
    const list = await signedPost(handler, { type: 'list', model: 'task' });
    expect((list.body.rows as unknown[]).length).toBe(1);
  });
});
