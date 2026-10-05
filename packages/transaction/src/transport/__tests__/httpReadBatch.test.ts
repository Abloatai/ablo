import { createHttpTransport } from '../http/transport.js';
import {
  modelReadBatchRequestSchema,
  type ModelReadBatchItem,
  type ModelReadBatchResponse,
} from '../../wire/modelResponses.js';
import { modelListResponse, modelReadResponse } from '../../testing/fixtures/httpResponses.js';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json' },
});
const resultFor = (read: ModelReadBatchItem) => read.kind === 'read'
  ? modelReadResponse({ model: read.model, id: read.id, data: { id: read.id }, stamp: 37 })
  : modelListResponse({ model: read.model, data: [{ id: 'row' }], stamp: 37,
      hasMore: true, nextCursor: 'opaque-next', evidence: [{ id: 'row', stamp: 29 }] });

function make(reply?: (reads: ModelReadBatchItem[]) => Response) {
  const calls: { path: string; reads?: ModelReadBatchItem[] }[] = [];
  const client = createHttpTransport({
    apiKey: 'sk_test_batch', baseURL: 'https://api.example.test',
    fetch: async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === '/api/v1/reads') {
        const { reads } = modelReadBatchRequestSchema.parse(JSON.parse(String(init?.body)));
        calls.push({ path: url.pathname, reads });
        return reply?.(reads) ?? json({ results: reads.map(read => ({ result: resultFor(read) })) });
      }
      calls.push({ path: url.pathname });
      const parts = url.pathname.split('/');
      return json(resultFor(parts[5]
        ? { kind: 'read', model: parts[4]!, id: parts[5]! }
        : { kind: 'list', model: parts[4]!, query: Object.fromEntries(url.searchParams) }));
    },
  });
  return { client, calls };
}

describe('automatic HTTP model read batching', () => {
  it('turns six concurrent Coding-shaped reads into one request without losing protocol evidence', async () => {
    const { client, calls } = make();
    const reads = await Promise.all([
      client.model('workspaceRepositories').list({ where: { accountId: 'account' }, limit: 8 }),
      client.model('messages').list({ cursor: 'opaque-before', orderBy: { createdAt: 'desc' } }),
      client.model('githubAuthorizations').list(),
      client.model('githubInstallations').list(),
      client.model('workspaces').read({ id: 'workspace' }),
      client.model('workspaces').read({ id: 'workspace' }),
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.reads).toHaveLength(5);
    expect(calls[0]?.reads?.[1]).toMatchObject({ query: {
      cursor: 'opaque-before', order_by: 'createdAt', order: 'desc',
    } });
    expect(reads[0]).toMatchObject({ hasMore: true, nextCursor: 'opaque-next',
      evidence: [{ id: 'row', stamp: 29 }] });
    expect(reads[4]).toEqual({ data: { id: 'workspace' }, stamp: 37, claims: [] });
    expect(reads[5]).toEqual(reads[4]);
    expect(reads[5]?.data).not.toBe(reads[4]?.data);
  });

  it('preserves an absent row and rejects only the denied query', async () => {
    const { client } = make(reads => json({ results: reads.map(read => read.model === 'denied'
      ? { status: 403, error: { type: 'CapabilityError', code: 'capability_scope_denied',
          message: 'Denied', request_id: 'req-batch', event_id: 'event-batch' } }
      : { result: modelReadResponse({ model: read.model, id: 'missing', data: null, stamp: 41 }) })
    } satisfies ModelReadBatchResponse));
    const results = await Promise.allSettled([
      client.model('items').read({ id: 'missing' }), client.model('denied').read({ id: 'missing' }),
    ]);
    expect(results[0]).toEqual({ status: 'fulfilled', value: { data: undefined, stamp: 41, claims: [] } });
    expect(results[1]).toMatchObject({ status: 'rejected', reason: {
      code: 'capability_scope_denied', requestId: 'req-batch',
    } });
  });

  it('bounds batches to 50 and dispose waits for queued reads', async () => {
    const { client, calls } = make();
    const reads = Array.from({ length: 101 }, (_, index) => client.model('items').list({ where: { id: String(index) } }));
    await client.dispose();
    await Promise.all(reads);
    expect(calls.map(call => call.reads?.length ?? 1)).toEqual([50, 50, 1]);
  });

  it('falls back once for older servers, but never converts a permission failure into fallback reads', async () => {
    const { client, calls } = make(() => json({ type: 'AbloNotFoundError', code: 'entity_not_found', message: 'Not found' }, 404));
    await Promise.all([client.model('items').list(), client.model('other').list()]);
    await Promise.all([client.model('items').list(), client.model('other').list()]);
    expect(calls.filter(call => call.reads)).toHaveLength(1);
    expect(calls.filter(call => !call.reads)).toHaveLength(4);
    const denied = make(() => json({ type: 'AbloPermissionError', code: 'forbidden', message: 'Denied' }, 403));
    const results = await Promise.allSettled([denied.client.model('items').list(), denied.client.model('other').list()]);
    expect(results.every(result => result.status === 'rejected')).toBe(true);
    expect(denied.calls).toHaveLength(1);
  });

  it('splits large filters before they exceed the server body limit', async () => {
    const { client, calls } = make();
    await Promise.all(Array.from({ length: 3 }, (_, index) =>
      client.model('items').list({ where: { text: 'é'.repeat(100000), id: String(index) } })));
    expect(calls.map(call => call.reads?.length ?? 1)).toEqual([2, 1]);
    expect(new TextEncoder().encode(JSON.stringify({ reads: calls[0]?.reads })).length).toBeLessThan(1024 * 1024);
  });

  it('does not reuse a completed result for a later read', async () => {
    const { client, calls } = make();
    await Promise.all([client.model('items').read({ id: 'one' }), client.model('other').read({ id: 'two' })]);
    await client.model('items').read({ id: 'one' });
    expect(calls).toHaveLength(2);
    expect(calls[1]?.path).toBe('/api/v1/models/items/one');
  });

  it('keeps credential-provider reads separate and invokes the provider for each request', async () => {
    let credentials = 0;
    const headers: string[] = [];
    const client = createHttpTransport({ baseURL: 'https://api.example.test',
      apiKey: () => `sk_actor_${++credentials}`,
      fetch: async (_input, init) => {
        headers.push(new Headers(init?.headers).get('authorization') ?? '');
        return json(modelListResponse({ model: 'items', data: [] }));
      },
    });
    await Promise.all([client.model('items').list(), client.model('items').list()]);
    expect(headers).toEqual(['Bearer sk_actor_1', 'Bearer sk_actor_2']);
  });

  it('refuses every result in a mismatched batch rather than returning the wrong row', async () => {
    const { client } = make(reads => json({ results: reads.map((read, index) => ({
      result: resultFor(index ? { kind: 'read', model: read.model, id: 'wrong-id' } : read),
    })) }));
    const results = await Promise.allSettled([
      client.model('items').read({ id: 'one' }), client.model('items').read({ id: 'two' }),
    ]);
    expect(results).toEqual([
      expect.objectContaining({ status: 'rejected', reason: expect.objectContaining({ code: 'malformed_response' }) }),
      expect.objectContaining({ status: 'rejected', reason: expect.objectContaining({ code: 'malformed_response' }) }),
    ]);
  });
});
