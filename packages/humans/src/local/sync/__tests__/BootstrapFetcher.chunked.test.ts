/**
 * @jest-environment node
 *
 * Runs in node (not jsdom): the fetch mocks build real `Response` objects,
 * which jsdom 26 does not define.
 *
 * Chunked cold-start bootstrap: with a known instant-model list, a cold
 * start fetches one model per request instead of one giant snapshot, so a
 * single heavy model can't make the whole bootstrap undeliverable and a
 * dropped connection costs one model, not everything. The merge anchors at
 * the MINIMUM per-chunk sync position; the WS catch-up replays the skew.
 */
import { BootstrapFetcher, mergeBootstrapChunks, type BootstrapData } from '../BootstrapFetcher.js';
import { createTestContext } from '../../testing/mocks/MockSyncContext.js';

function jsonResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Resolve a fetch argument to its URL string (a `Request` carries it as `.url`). */
function requestUrl(input: unknown): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  if (input instanceof Request) return input.url;
  throw new Error('fetch was called without a URL argument');
}

/** Recorded calls of a `fetch` double — arity varies per test, so read them structurally. */
interface FetchCalls {
  readonly mock: { readonly calls: readonly (readonly unknown[])[] };
}

/** Parse the pagination-relevant params of each fetched URL. */
function requestedParams(
  mock: FetchCalls,
): { models: string | null; lastSyncId: string | null; limit: string | null; cursor: string | null }[] {
  return mock.mock.calls.map((call) => {
    const url = new URL(requestUrl(call[0]));
    return {
      models: url.searchParams.get('models'),
      lastSyncId: url.searchParams.get('lastSyncId'),
      limit: url.searchParams.get('limit'),
      cursor: url.searchParams.get('cursor'),
    };
  });
}

describe('BootstrapFetcher chunked cold start', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('fetches one request per instant model and merges at the minimum sync position', async () => {
    createTestContext({});
    // Serve each model at a DIFFERENT sync position, as a real server under
    // concurrent writes would.
    const positions: Record<string, number> = { Collection: 100, Entry: 104, EntryDetail: 110 };
    const fetchMock = jest.fn((input: RequestInfo | URL) => {
      const model = new URL(requestUrl(input)).searchParams.get('models') ?? '';
      return Promise.resolve(
        jsonResponse({
          type: 'full',
          lastSyncId: positions[model] ?? 0,
          models: { [model]: [{ id: `${model}-row` }] },
          timestamp: positions[model] ?? 0,
        }),
      );
    });
    global.fetch = fetchMock;

    const fetcher = new BootstrapFetcher({
      baseUrl: 'http://test/api',
      maxRetries: 1,
      instantModels: ['Collection', 'Entry', 'EntryDetail'],
    });
    const data = await fetcher.fetchBootstrap();

    const params = requestedParams(fetchMock);
    expect(params.map((p) => p.models).sort()).toEqual(['Collection', 'Entry', 'EntryDetail']);
    expect(params.every((p) => p.lastSyncId === null)).toBe(true);

    expect(data.type).toBe('full');
    // Min anchor: the WS catch-up must be able to replay deltas 101–110 for
    // the chunk served earliest.
    expect(data.lastSyncId).toBe(100);
    expect(Object.keys(data.models ?? {}).sort()).toEqual(['Collection', 'Entry', 'EntryDetail']);
  });

  it('keeps a warm partial bootstrap on a single request', async () => {
    createTestContext({});
    const fetchMock = jest.fn(() =>
      Promise.resolve(
        jsonResponse({ type: 'partial', lastSyncId: 120, deltas: [], deltaCount: 0, timestamp: 1 }),
      ),
    );
    global.fetch = fetchMock;

    const fetcher = new BootstrapFetcher({
      baseUrl: 'http://test/api',
      maxRetries: 1,
      instantModels: ['Collection', 'Entry', 'EntryDetail'],
    });
    await fetcher.fetchBootstrap(115);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [params] = requestedParams(fetchMock);
    // No paging on the warm path: neither limit nor cursor is sent.
    expect(params).toEqual({
      models: 'Collection,Entry,EntryDetail',
      lastSyncId: '115',
      limit: null,
      cursor: null,
    });
  });

  it('fails the whole bootstrap when one chunk fails terminally', async () => {
    createTestContext({});
    global.fetch = jest.fn((input: RequestInfo | URL) => {
      const model = new URL(requestUrl(input)).searchParams.get('models') ?? '';
      if (model === 'Entry') {
        return Promise.resolve(jsonResponse({ error: { message: 'boom' } }, 500));
      }
      return Promise.resolve(
        jsonResponse({ type: 'full', lastSyncId: 1, models: { [model]: [] }, timestamp: 1 }),
      );
    });

    const fetcher = new BootstrapFetcher({
      baseUrl: 'http://test/api',
      maxRetries: 1,
      retryDelay: 1,
      instantModels: ['Collection', 'Entry', 'EntryDetail'],
    });

    // A partial snapshot must never masquerade as a full one.
    await expect(fetcher.fetchBootstrap()).rejects.toBeDefined();
  });

  it('pages a model whose server returns nextCursor, concatenating the pages', async () => {
    createTestContext({});
    // EntryDetail answers in two pages; Collection fits in one.
    const fetchMock = jest.fn((input: RequestInfo | URL) => {
      const url = new URL(requestUrl(input));
      const model = url.searchParams.get('models') ?? '';
      const cursor = url.searchParams.get('cursor');
      if (model === 'EntryDetail' && cursor === null) {
        return Promise.resolve(
          jsonResponse({
            type: 'full',
            lastSyncId: 100,
            models: { EntryDetail: [{ id: 'a' }, { id: 'b' }] },
            nextCursor: 'b',
            timestamp: 1,
          }),
        );
      }
      if (model === 'EntryDetail') {
        return Promise.resolve(
          jsonResponse({
            type: 'full',
            lastSyncId: 108,
            models: { EntryDetail: [{ id: 'c' }] },
            timestamp: 2,
          }),
        );
      }
      return Promise.resolve(
        jsonResponse({
          type: 'full',
          lastSyncId: 104,
          models: { Collection: [{ id: 'collection-1' }] },
          timestamp: 1,
        }),
      );
    });
    global.fetch = fetchMock;

    const fetcher = new BootstrapFetcher({
      baseUrl: 'http://test/api',
      maxRetries: 1,
      instantModels: ['Collection', 'EntryDetail'],
    });
    const data = await fetcher.fetchBootstrap();

    const params = requestedParams(fetchMock);
    const entryPages = params.filter((p) => p.models === 'EntryDetail');
    expect(entryPages).toHaveLength(2);
    expect(entryPages[0]?.cursor).toBeNull();
    expect(entryPages[1]?.cursor).toBe('b');
    // Every request is bounded to the page limit (the server's clamp ceiling).
    expect(params.every((p) => p.limit === '5000')).toBe(true);

    expect(data.models?.EntryDetail).toEqual([{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
    expect(data.models?.Collection).toEqual([{ id: 'collection-1' }]);
    // Min anchor across ALL pages and models — the earliest-served page
    // (sync 100) still gets its skew replayed.
    expect(data.lastSyncId).toBe(100);
    // The merged snapshot is complete: no page cursor may leak out of it.
    expect(data.nextCursor).toBeUndefined();
  });

  it('recovers a chunk that fails transiently and still merges', async () => {
    createTestContext({});
    let entryAttempts = 0;
    global.fetch = jest.fn((input: RequestInfo | URL) => {
      const model = new URL(requestUrl(input)).searchParams.get('models') ?? '';
      if (model === 'Entry' && entryAttempts++ === 0) {
        return Promise.resolve(jsonResponse({ error: { message: 'transient' } }, 503));
      }
      return Promise.resolve(
        jsonResponse({
          type: 'full',
          lastSyncId: 50,
          models: { [model]: [{ id: `${model}-row` }] },
          timestamp: 1,
        }),
      );
    });

    const fetcher = new BootstrapFetcher({
      baseUrl: 'http://test/api',
      maxRetries: 2,
      retryDelay: 1,
      instantModels: ['Collection', 'Entry'],
    });
    const data = await fetcher.fetchBootstrap();

    expect(entryAttempts).toBe(2);
    expect(Object.keys(data.models ?? {}).sort()).toEqual(['Collection', 'Entry']);
  });
});

describe('mergeBootstrapChunks', () => {
  it('anchors at the minimum sync position and unions failed models', () => {
    const chunks: BootstrapData[] = [
      { type: 'full', lastSyncId: 104, models: { Entry: [] }, timestamp: 2, schemaHash: 'h1' },
      { type: 'full', lastSyncId: 100, models: { Collection: [] }, failedModels: ['Collection'], timestamp: 1 },
      { type: 'full', lastSyncId: 110, models: { EntryDetail: [] }, failedModels: ['EntryDetail'], timestamp: 3 },
    ];
    const merged = mergeBootstrapChunks(chunks);

    expect(merged).toEqual({
      type: 'full',
      lastSyncId: 100,
      models: { Entry: [], Collection: [], EntryDetail: [] },
      failedModels: ['Collection', 'EntryDetail'],
      timestamp: 3,
      schemaHash: 'h1',
    });
  });

  it('returns an empty full snapshot for zero chunks', () => {
    expect(mergeBootstrapChunks([])).toEqual({
      type: 'full',
      lastSyncId: 0,
      models: {},
      timestamp: 0,
    });
  });
});
