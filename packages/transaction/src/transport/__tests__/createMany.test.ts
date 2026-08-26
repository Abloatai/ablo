/**
 * Creating many rows as one commit.
 *
 * Seeding a workspace was 24 sequential creates, each its own round trip, so
 * the first screen an account ever saw waited on all of them. The way out was
 * to write the rows straight into Postgres and stamp the tenancy column by
 * hand, which puts them outside the chokepoint. This is the surface that makes
 * that unnecessary.
 *
 * Fresh rows come back from the commit itself. A durable idempotency replay
 * intentionally redacts them, so that path verifies every deterministic id
 * with a point read and refuses any incomplete answer.
 */
import { Ablo } from '../../client/ablo.js';
import { defineSchema, model, z } from '../../schema/index.js';
import {
  confirmedCommitReceiptResponse,
  modelReadResponse,
} from '../../testing/fixtures/httpResponses.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const schema = defineSchema({
  items: model({ title: z.string(), status: z.string().optional() }),
});

interface Call {
  path: string;
  method: string;
  body: Record<string, unknown> | undefined;
}

/** A client whose server confirms a batch and echoes a row per operation. */
function clientEchoingRows(
  calls: Call[],
  opts?: { rows?: 'reversed' | 'short' | 'none'; unreadable?: boolean },
) {
  const stored = new Map<string, Record<string, unknown>>();
  return Ablo({
    schema,
    apiKey: 'sk_test_create_many',
    baseURL: 'https://api.example.test',
    transport: 'http',
    fetch: (input, init) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const path = new URL(url).pathname;
      const method = init?.method ?? 'GET';
      const body = init?.body
        ? (JSON.parse(String(init.body)) as Record<string, unknown>)
        : undefined;
      calls.push({ path, method, body });

      if (method === 'POST' && path.endsWith('/v1/commits')) {
        // The receipt is correlated by the request's idempotency key, so the
        // stub has to echo the one the client actually sent.
        const headers = (init?.headers ?? {}) as Record<string, string>;
        const clientTxId = headers['Idempotency-Key'] ?? String(body?.clientTxId ?? 'batch');
        const operations = (body?.operations ?? []) as { id: string; data: Record<string, unknown> }[];
        const results = operations.map((op, index) => ({
          transactionId: `tx_${index}`,
          outcome: 'created' as const,
          // The server's own row: the caller's fields plus the framework
          // defaults it stamps.
          row: { ...op.data, id: op.id, createdAt: '2026-08-21T00:00:00.000Z' },
        }));
        for (const result of results) stored.set(String(result.row.id), result.row);
        return Promise.resolve(
          jsonResponse(
            confirmedCommitReceiptResponse({
              clientTxId,
              lastSyncId: 10,
              ops: operations.length,
              operationResults:
                opts?.rows === 'none'
                  ? undefined
                  : opts?.rows === 'reversed'
                  ? [...results].reverse()
                  : opts?.rows === 'short'
                    ? results.slice(0, -1)
                    : results,
            }),
          ),
        );
      }
      if (method === 'GET' && path.includes('/v1/models/items/')) {
        const id = decodeURIComponent(path.slice(path.lastIndexOf('/') + 1));
        return Promise.resolve(
          jsonResponse(
            modelReadResponse({
              model: 'items',
              id,
              data: opts?.unreadable ? null : stored.get(id) ?? null,
              stamp: 10,
            }),
          ),
        );
      }
      return Promise.reject(new Error(`unexpected fetch: ${method} ${url}`));
    },
  });
}

describe('create with a list of rows', () => {
  it('writes them as ONE commit rather than one request each', async () => {
    const calls: Call[] = [];
    const c = clientEchoingRows(calls);

    await c.items.create({
      data: [
        { title: 'first', status: 'todo' },
        { title: 'second', status: 'todo' },
        { title: 'third', status: 'todo' },
      ],
      idempotencyKey: 'seed-workspace',
    });

    const writes = calls.filter((call) => call.method !== 'GET');
    expect(writes).toHaveLength(1);
    expect(writes[0]?.path).toContain('/v1/commits');
    expect((writes[0]?.body?.operations as unknown[]).length).toBe(3);
  });

  it('returns the server rows, with the defaults it stamped', async () => {
    const c = clientEchoingRows([]);

    const rows = await c.items.create({
      data: [{ title: 'first' }, { title: 'second' }],
      idempotencyKey: 'seed-defaults',
    });

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ title: 'first', createdAt: '2026-08-21T00:00:00.000Z' });
    expect(rows[0]?.id).toBeTruthy();
  });

  it('answers in the order it was given, not the order the batch settled', async () => {
    const c = clientEchoingRows([], { rows: 'reversed' });

    const rows = await c.items.create({
      data: [{ title: 'first' }, { title: 'second' }, { title: 'third' }],
      idempotencyKey: 'seed-order',
    });

    expect(rows.map((r) => r.title)).toEqual(['first', 'second', 'third']);
  });

  it('carries an id written into a row', async () => {
    const calls: Call[] = [];
    const c = clientEchoingRows(calls);

    const rows = await c.items.create({
      data: [{ id: 'item_named', title: 'first' }],
      idempotencyKey: 'seed-named',
    });

    expect(rows[0]?.id).toBe('item_named');
  });

  it('writes nothing at all for an empty list', async () => {
    const calls: Call[] = [];
    const c = clientEchoingRows(calls);

    expect(await c.items.create({ data: [] })).toEqual([]);
    expect(calls.filter((call) => call.method !== 'GET')).toHaveLength(0);
  });

  it('recovers a durable replay that redacted every operation result', async () => {
    const calls: Call[] = [];
    const c = clientEchoingRows(calls, { rows: 'none' });

    const rows = await c.items.create({
      data: [{ title: 'first' }, { title: 'second' }],
      idempotencyKey: 'seed-replay',
    });

    expect(rows.map((row) => row.title)).toEqual(['first', 'second']);
    expect(calls.filter((call) => call.method === 'GET')).toHaveLength(2);
  });

  it('refuses a confirmation that cannot account for every row', async () => {
    const c = clientEchoingRows([], { rows: 'short' });

    await expect(
      c.items.create({
        data: [{ title: 'first' }, { title: 'second' }],
        idempotencyKey: 'seed-short',
      }),
    ).resolves.toHaveLength(2);

    const unreadable = clientEchoingRows([], { rows: 'none', unreadable: true });
    await expect(
      unreadable.items.create({
        data: [{ title: 'first' }, { title: 'second' }],
        idempotencyKey: 'seed-unreadable',
      }),
    ).rejects.toMatchObject({ code: 'commit_no_result' });
  });
});
