/**
 * @jest-environment node
 *
 * Runs in node (not jsdom): the fetch mock answers with real `Response`
 * objects, which jsdom 26 does not define.
 *
 * HTTP `track` registers a durable premise without writing.
 *
 * The protocol has always accepted a track-only commit — `POST /v1/commits`
 * with `track` and no `operations` — but only the reactive client could send
 * one, so a stateless agent had no typed way to say "keep telling me about this
 * row". These pin the body it sends and the notifications it hands back.
 */
import { createHttpTransport } from '@abloatai/transaction/transport/httpTransport';

type Json = Record<string, unknown>;

function resp(status: number, body: Json): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * `fetch` takes any of the three request spellings. Each carries its URL under a
 * different member, so read the member rather than stringifying — a `Request`
 * put through `String()` answers `[object Request]` and the assertions below
 * would match nothing.
 */
function requestUrl(url: string | URL | Request): string {
  if (typeof url === 'string') return url;
  return url instanceof URL ? url.href : url.url;
}

/**
 * The request body as this suite's transport always sends it — a JSON string.
 * `BodyInit` also admits blobs and streams; those never appear here, and
 * failing loudly beats parsing `[object FormData]` into a mystery assertion.
 */
function jsonBody(init: RequestInit | undefined): Json {
  const { body } = init ?? {};
  if (typeof body !== 'string') {
    throw new Error(`expected a JSON string body, got ${typeof body}`);
  }
  return JSON.parse(body) as Json;
}

type Handler = (url: string, method: string, init?: RequestInit) => Response;
function client(handler: Handler) {
  return createHttpTransport({
    apiKey: 'sk_test_unit',
    baseURL: 'https://api.test',
    transport: 'http',
    fetch: (url: string | URL | Request, init?: RequestInit) =>
      Promise.resolve(
        handler(requestUrl(url), (init?.method ?? 'GET').toUpperCase(), init),
      ),
    dangerouslyAllowBrowser: true,
  });
}

function receipt(init: RequestInit | undefined, extra: Json = {}): Json {
  const headers = init?.headers as Record<string, string> | undefined;
  return {
    object: 'commit_receipt',
    clientTxId: headers?.['Idempotency-Key'],
    serverTxId: 'tx_track',
    success: true,
    status: 'confirmed',
    lastSyncId: 0,
    ops: 0,
    ...extra,
  };
}

describe('http track', () => {
  it('posts a track-only commit naming the row', async () => {
    let body: Json | undefined;
    const docs = client((u, method, init) => {
      if (method === 'POST' && u.endsWith('/v1/commits')) {
        body = jsonBody(init);
        return resp(200, receipt(init));
      }
      return resp(200, { data: null });
    }).model('documents');

    const result = await docs.track({ id: 'doc-main' });

    expect(body).toEqual({ track: [{ model: 'documents', id: 'doc-main' }] });
    // No writes ride along — a track is a premise, not a mutation.
    expect(body?.operations).toBeUndefined();
    expect(result).toEqual({});
  });

  it('carries the readAt watermark the premise is baselined on', async () => {
    let body: Json | undefined;
    const docs = client((u, method, init) => {
      body = jsonBody(init);
      return resp(200, receipt(init));
    }).model('documents');

    await docs.track({ id: 'doc-main', readAt: 41 });

    expect(body).toEqual({ track: [{ model: 'documents', id: 'doc-main', readAt: 41 }] });
  });

  it('returns notifications for a track that had already fired', async () => {
    const fired = {
      model: 'Document',
      id: 'doc-main',
      readAt: 41,
      observedSyncId: 44,
      conflictingFields: ['title'],
      currentValues: { title: 'Renamed while you were away' },
      writtenBy: { kind: 'agent', id: 'agent_other' },
    };
    const docs = client((_u, _method, init) =>
      resp(200, receipt(init, { notifications: [fired] })),
    ).model('documents');

    const result = await docs.track({ id: 'doc-main', readAt: 41 });

    expect(result.notifications).toEqual([fired]);
  });
});
